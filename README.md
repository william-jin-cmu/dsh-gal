# dsh-gal

A galgame / visual-novel UI for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh), packaged as a dsh plugin.

Your agent becomes a whale girl. Each reply plays as a dialogue scene — typewriter text, one turn at a time, no scrolling wall of history — while she reacts with animated expressions chosen by an emotion judge. The backlog is one click away, just like a real visual novel.

![dsh-gal](assets/screenshot.png)

## What it does

- **Scene-at-a-time dialogue** — only the latest exchange is on screen, rendered with a typewriter effect. Long replies page like VN text boxes (`click` / `Space` to advance, `Auto` mode available).
- **Animated whale girl** — six expressions (`neutral`, `happy`, `thinking`, `surprised`, `sad`, `excited`), each a looping micro-animation generated with Seedance 2.0 mini on fal.ai from a gpt-image-2 base sprite; layers cross-fade on emotion change.
- **Emotion judge** — after each assistant turn, a tiny side LLM call classifies the reply's tone into one of the six expressions; a keyword heuristic covers fallback. While the agent works, she switches to `thinking` and a status ticker shows tool activity.
- **Backlog** — press `L` or click **History** for the full scrollable conversation log.
- **Drive the session from the UI** — the input box sends real user turns into the live dsh session.

## Install

```bash
git clone https://github.com/dsh-external/dsh-gal
cd dsh-gal && pnpm install && pnpm build
```

Register it in `~/.dsh/config.yaml`:

```yaml
- insert:
    - id: dsh-gal
      name: /absolute/path/to/dsh-gal/lib/index.js
      config:
        port: 4877          # UI at http://127.0.0.1:4877/
        characterName: Cetus
```

Start `dsh` as usual, open the printed URL, and talk to her.

## Configuration

| key | default | description |
| --- | --- | --- |
| `port` | `4877` | Listen port on 127.0.0.1 |
| `token` | `""` | Optional shared token appended to the URL |
| `characterName` | `Cetus` | Name shown on the dialogue nameplate |
| `judgeEnabled` | `true` | Use an LLM call to pick the expression (heuristic fallback otherwise) |
| `judgeTimeoutMs` | `4000` | Deadline for the emotion judge before falling back |

## Regenerating the art

The sprites and motion loops ship with the repo, but everything is reproducible:

- Base sprite + expression variants: image generation (gpt-image-2 class model), prompts in `scripts/`
- Micro-animations: `scripts/animate.sh <sprite.png> <out.mp4> "<motion prompt>"` — Seedance 2.0 mini image-to-video on fal.ai (`bytedance/seedance-2.0/mini/image-to-video`, 480p ≈ $0.07/s; MiniMax `minimax/h3/image-to-video` supported via a fourth arg `h3`)

## License

BSD-3-Clause
