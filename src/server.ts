/**
 * The dsh-gal HTTP server: serves the visual-novel frontend, streams
 * conversation events over SSE, and accepts user input via POST /send.
 * Binds 127.0.0.1 only; optional shared-token auth (header x-gal-token,
 * ?token=). Static files come from the plugin's own web/ and assets/ dirs.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize, sep } from 'node:path'

export interface GalEvent {
  type: 'user' | 'assistant' | 'status' | 'busy' | 'emotion' | 'snapshot'
  [key: string]: unknown
}

export interface GalServerOptions {
  port: number
  token: string
  webRoot: string
  assetsRoot: string
  manifest: () => unknown
  onSend: (text: string) => Promise<void>
  log: (message: string) => void
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.svg': 'image/svg+xml',
}

export class GalServer {
  private readonly clients = new Set<ServerResponse>()
  private readonly backlog: GalEvent[] = []
  private server: Server | undefined

  constructor(private readonly options: GalServerOptions) {}

  /** Push one event to every connected client and remember it for replays. */
  broadcast(event: GalEvent): void {
    if (event.type === 'user' || event.type === 'assistant') this.backlog.push(event)
    const line = `data: ${JSON.stringify(event)}\n\n`
    for (const client of this.clients) client.write(line)
  }

  get url(): string {
    const token = this.options.token
    return `http://127.0.0.1:${this.options.port}/${token === '' ? '' : `?token=${token}`}`
  }

  start(): Promise<void> {
    const server = createServer((req, res) => {
      this.handle(req, res).catch((error: unknown) => {
        this.options.log(`request failed: ${String(error)}`)
        if (!res.headersSent) res.writeHead(500)
        res.end()
      })
    })
    this.server = server
    return new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.options.port, '127.0.0.1', () => resolve())
    })
  }

  stop(): void {
    for (const client of this.clients) client.end()
    this.clients.clear()
    this.server?.close()
    this.server = undefined
  }

  private authorized(req: IncomingMessage): boolean {
    const token = this.options.token
    if (token === '') return true
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const presented = req.headers['x-gal-token'] ?? url.searchParams.get('token') ?? ''
    return presented === token
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (!this.authorized(req)) {
      res.writeHead(401, { 'content-type': 'text/plain' })
      res.end('unauthorized')
      return
    }

    if (url.pathname === '/events') { this.handleEvents(res); return }
    if (url.pathname === '/manifest.json') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(this.options.manifest()))
      return
    }
    if (url.pathname === '/send' && req.method === 'POST') { await this.handleSend(req, res); return }

    // static: /assets/** from assetsRoot, everything else from webRoot
    const fromAssets = url.pathname.startsWith('/assets/')
    const root = fromAssets ? this.options.assetsRoot : this.options.webRoot
    const rel = fromAssets ? url.pathname.slice('/assets/'.length) : url.pathname.replace(/^\/+/, '') || 'index.html'
    const path = normalize(join(root, rel))
    if (!path.startsWith(normalize(root) + sep) && path !== normalize(root)) {
      res.writeHead(403)
      res.end()
      return
    }
    if (!existsSync(path) || !statSync(path).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
      return
    }
    res.writeHead(200, {
      'content-type': MIME[extname(path)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    })
    createReadStream(path).pipe(res)
  }

  private handleEvents(res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    res.write(': connected\n\n')
    // replay the conversation so far as one snapshot
    const entries = this.backlog.map(event => ({
      role: event.type,
      text: String(event['text'] ?? ''),
    }))
    res.write(`data: ${JSON.stringify({ type: 'snapshot', entries })}\n\n`)
    this.clients.add(res)
    const keepalive = setInterval(() => res.write(': ping\n\n'), 25_000)
    res.on('close', () => {
      clearInterval(keepalive)
      this.clients.delete(res)
    })
  }

  private async handleSend(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    let size = 0
    await new Promise<void>((resolve, reject) => {
      req.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > 256 * 1024) { reject(new Error('body too large')); req.destroy(); return }
        chunks.push(chunk)
      })
      req.on('end', resolve)
      req.on('error', reject)
    })
    let text = ''
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { text?: unknown }
      if (typeof body.text === 'string') text = body.text.trim()
    } catch { /* fall through to the empty-text rejection */ }
    if (text === '') {
      res.writeHead(400, { 'content-type': 'text/plain' })
      res.end('text required')
      return
    }
    try {
      await this.options.onSend(text)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    } catch (error) {
      res.writeHead(502, { 'content-type': 'text/plain' })
      res.end(String(error instanceof Error ? error.message : error))
    }
  }
}
