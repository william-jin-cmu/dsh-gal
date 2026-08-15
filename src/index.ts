/**
 * dsh-gal: a galgame / visual-novel UI for the DeepSeek Harness.
 *
 * The plugin mirrors the live conversation onto a local web page where a
 * whale-girl companion "speaks" every assistant reply one scene at a time:
 *   - observes `session/event` for user prompts, assistant replies, and tool
 *     activity (subagent sessions are filtered out),
 *   - judges which expression to show via a tiny side `ctx.llm.stream` call
 *     (keyword heuristic as fallback),
 *   - serves the frontend + expression micro-animations over 127.0.0.1,
 *   - feeds input from the page back into the live agent via
 *     `agent.followup(createUserMessage(...))`.
 * @module dsh-gal
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context as CordisContext } from '@deepseek-ai/cordis'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import z from 'schemastery'
import { EMOTIONS, heuristicEmotion, isEmotion, classifierPrompt, type Emotion } from './emotion.js'
import { GalServer } from './server.js'

/** The agent surface this plugin consumes (`ctx.agents`). */
interface AgentLike {
  readonly id: string
  readonly options: { provider?: string; model?: string }
  readonly status: 'idle' | 'running'
  followup(message: ReturnType<typeof createUserMessage>): void
}

interface AgentRegistryLike {
  get(id: ReturnType<typeof SessionId>): AgentLike | undefined
  roots(): AgentLike[]
}

type Context = CordisContext & {
  agents: AgentRegistryLike
  agentLoop: { create(id: ReturnType<typeof SessionId>, options?: object, meta?: { cwd?: string }): AgentLike }
  llm: { stream(options: GenerateOptions): AsyncIterable<unknown> }
}

export const name = 'dsh-gal'
export const inject = ['agents', 'agentLoop', 'sessions', 'llm']

export interface Config {
  /** Listen port on 127.0.0.1 for the visual-novel UI. */
  port?: number
  /** Optional shared token (x-gal-token header or ?token=). */
  token?: string
  /** Name shown on the dialogue nameplate. */
  characterName?: string
  /** First line she speaks when the page opens. */
  greeting?: string
  /** Judge each reply's expression with a small LLM call (heuristic fallback otherwise). */
  judgeEnabled?: boolean
  /** Deadline for the emotion judge before falling back to keywords. */
  judgeTimeoutMs?: number
  /** Judge route override; defaults to the replying agent's own route. */
  judgeProvider?: string
  judgeModel?: string
}

export const Config: z<Config> = z.object({
  port: z.number().step(1).min(0).max(65_535).default(4877),
  token: z.string().role('secret').default(''),
  characterName: z.string().default('Cetus'),
  greeting: z.string().default('Welcome back! I am all ears — say something below and I will get to work.'),
  judgeEnabled: z.boolean().default(true),
  judgeTimeoutMs: z.number().step(1).min(200).default(8000),
  judgeProvider: z.string(),
  judgeModel: z.string(),
})

const HERE = dirname(fileURLToPath(import.meta.url))
/** Package root: works from lib/index.js (built) and src/index.ts (dev). */
const PKG_ROOT = existsSync(join(HERE, '../web')) ? join(HERE, '..') : join(HERE, '../..')

function textOf(content: readonly { type: string; text?: string }[]): string {
  return content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
}

export function apply(ctx: Context, config: Config): void {
  const port = config.port ?? 4877
  if (port === 0) return // explicitly disabled

  const characterName = config.characterName ?? 'Cetus'
  const assetsRoot = join(PKG_ROOT, 'assets')

  /** Discover available expression assets: motion loop preferred, sprite fallback. */
  const manifest = (): unknown => {
    const emotions: Record<string, { video?: string; image?: string }> = {}
    for (const emotion of EMOTIONS) {
      const entry: { video?: string; image?: string } = {}
      if (existsSync(join(assetsRoot, 'motion', `${emotion}.mp4`))) entry.video = `/assets/motion/${emotion}.mp4`
      if (existsSync(join(assetsRoot, 'sprites', `${emotion}.png`))) entry.image = `/assets/sprites/${emotion}.png`
      if (entry.video !== undefined || entry.image !== undefined) emotions[emotion] = entry
    }
    return {
      characterName,
      greeting: config.greeting,
      defaultEmotion: 'neutral' in emotions ? 'neutral' : Object.keys(emotions)[0] ?? 'neutral',
      emotions,
    }
  }

  /** The session the UI mirrors and drives: the root session with the latest activity. */
  let activeSessionId: string | undefined

  const resolveAgent = (): AgentLike | undefined => {
    if (activeSessionId !== undefined) {
      const active = ctx.agents.get(SessionId(activeSessionId))
      if (active !== undefined) return active
    }
    return ctx.agents.roots().at(-1)
  }

  const server = new GalServer({
    port,
    token: config.token ?? '',
    webRoot: join(PKG_ROOT, 'web'),
    assetsRoot,
    manifest,
    log: message => ctx.logger.warn(`dsh-gal: ${message}`),
    onSend: async (text) => {
      let agent = resolveAgent()
      if (agent === undefined) {
        // No live session yet: open one of our own so the novel is playable
        // standalone. The route must be explicit — persona assembly needs it.
        const selection = (ctx.get('agentDefaultModel') as {
          currentSelection?: () => { provider: string; model: string; reasoningEffort?: string }
        } | undefined)?.currentSelection?.()
        if (selection === undefined) throw new Error('no live dsh session and no default model configured')
        agent = ctx.agentLoop.create(
          SessionId(`dsh-gal-session-${crypto.randomUUID()}`),
          { provider: selection.provider, model: selection.model },
          { cwd: process.cwd() },
        )
        ctx.logger.info(`dsh-gal: opened session ${agent.id}`)
      }
      activeSessionId = agent.id
      agent.followup(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }))
    },
  })

  /** Tiny side LLM call that picks her expression for a reply. */
  const judgeEmotion = async (reply: string, agent: AgentLike | undefined): Promise<{ emotion: Emotion; judge: 'llm' | 'heuristic'; judgeError?: string }> => {
    if (config.judgeEnabled === false) return { emotion: heuristicEmotion(reply), judge: 'heuristic' }
    const provider = config.judgeProvider ?? agent?.options.provider
      ?? (ctx.get('agentDefaultModel') as { currentSelection?: () => { provider: string; model: string } } | undefined)?.currentSelection?.().provider
    const model = config.judgeModel ?? agent?.options.model
      ?? (ctx.get('agentDefaultModel') as { currentSelection?: () => { provider: string; model: string } } | undefined)?.currentSelection?.().model
    if (provider === undefined || model === undefined) return { emotion: heuristicEmotion(reply), judge: 'heuristic' }
    try {
      const timeoutMs = config.judgeTimeoutMs ?? 8000
      const assembler = new BlockAssembler()
      const options: GenerateOptions = {
        provider,
        model,
        // Generous cap: reasoning-capable routes burn thinking tokens before
        // the one-word answer; text blocks alone are parsed below.
        maxTokens: 512,
        signal: AbortSignal.timeout(timeoutMs),
        messages: [createUserMessage({
          content: [{ type: 'text', text: classifierPrompt(reply) }],
          source: { kind: 'plugin', plugin: name },
        })],
      }
      // Hard deadline around the whole stream: a reply must never be lost to a
      // judge that outlives its abort signal.
      await Promise.race([
        (async () => { for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk as never) })(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`judge deadline ${timeoutMs * 2}ms exceeded`)), timeoutMs * 2)),
      ])
      const answer = assembler.blocks()
        .map(block => block.type === 'text' ? block.text : '').join('')
        .trim().toLowerCase().replace(/[^a-z]/g, '')
      if (isEmotion(answer)) return { emotion: answer, judge: 'llm' }
      const found = EMOTIONS.find(emotion => answer.includes(emotion))
      if (found !== undefined) return { emotion: found, judge: 'llm' }
      return { emotion: heuristicEmotion(reply), judge: 'heuristic', judgeError: `unparsable answer: ${answer.slice(0, 60)}` }
    } catch (error) {
      ctx.logger.debug(`dsh-gal: emotion judge fell back (${String(error)})`)
      return { emotion: heuristicEmotion(reply), judge: 'heuristic', judgeError: String(error).slice(0, 300) }
    }
  }

  // ---- observe the conversation ----
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    const header = session.header as { origin?: string }
    if (header.origin === 'subagent') return
    switch (event.type) {
      case 'user/message': {
        const message = event.data
        if (message.source.kind !== 'user') return
        const text = textOf(message.content)
        if (text.trim() === '') return
        activeSessionId = session.id
        server.broadcast({ type: 'user', text })
        break
      }
      case 'assistant/message': {
        const text = textOf(event.data.message.content)
        if (text.trim() === '') return
        if (activeSessionId !== undefined && session.id !== activeSessionId) return
        const agent = ctx.agents.get(SessionId(session.id))
        void judgeEmotion(text, agent).then(({ emotion, judge, judgeError }) => {
          server.broadcast({ type: 'assistant', text, emotion, judge, ...judgeError === undefined ? {} : { judgeError } })
        })
        break
      }
      case 'tool/call': {
        if (activeSessionId !== undefined && session.id !== activeSessionId) return
        server.broadcast({ type: 'status', text: `${event.data.name}…` })
        break
      }
      case 'turn/start': {
        if (activeSessionId === undefined || session.id === activeSessionId) {
          server.broadcast({ type: 'busy', value: true })
        }
        break
      }
      case 'turn/end': {
        if (activeSessionId === undefined || session.id === activeSessionId) {
          server.broadcast({ type: 'busy', value: false })
        }
        break
      }
    }
  })

  // ---- serve the UI ----
  ctx.effect(() => {
    server.start().then(
      () => ctx.logger.info(`dsh-gal: visual novel at ${server.url}`),
      (error: unknown) => ctx.logger.warn(`dsh-gal: failed to listen on ${port}: ${String(error)}`),
    )
    return () => server.stop()
  }, 'dsh-gal.server')
}
