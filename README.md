<p align="center">
  <img src="screenshot.png" alt="The Companion" width="100%" />
</p>

<h1 align="center">The Companion</h1>
<p align="center"><strong>Web UI for Claude Code and Codex sessions.</strong></p>
<p align="center">Run multiple agents, inspect every tool call, and gate risky actions with explicit approvals.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/the-companion"><img src="https://img.shields.io/npm/v/the-companion.svg" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/the-companion"><img src="https://img.shields.io/npm/dm/the-companion.svg" alt="npm downloads" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT License" /></a>
</p>

## Quick start
Requirements:
- Bun
- Claude Code and/or Codex CLI available on your machine

Run:
```bash
bunx the-companion
```
Open `http://localhost:3456`.

Alternative foreground command:
```bash
the-companion serve
```

## Why this is useful
- **Parallel sessions**: work on multiple tasks without juggling terminals.
- **Full visibility**: see streaming output, tool calls, and tool results in one timeline.
- **Permission control**: approve/deny sensitive operations from the UI.
- **Session recovery**: restore work after process/server restarts.
- **Dual-engine support**: designed for both Claude Code and Codex-backed flows.

## Screenshots
| Chat + tool timeline | Permission flow |
|---|---|
| <img src="screenshot.png" alt="Main workspace" width="100%" /> | <img src="web/docs/screenshots/notification-section.png" alt="Permission and notifications" width="100%" /> |

## Architecture (simple)
```text
Browser (React)
  <-> ws://localhost:3456/ws/browser/:session
Companion server (Bun + Hono)
  <-> ws://localhost:3456/ws/cli/:session
Claude Code / Codex CLI
```

The bridge uses the CLI `--sdk-url` websocket path and NDJSON events.

## Development
```bash
make dev
```

Manual:
```bash
cd web
bun install
bun run dev
```

Checks:
```bash
cd web
bun run typecheck
bun run test
```

## Voice Input (offline speech-to-text)

The chat input bar includes a 🎤 microphone button that transcribes speech fully offline using [whisper.cpp](https://github.com/ggerganov/whisper.cpp) via [`nodejs-whisper`](https://github.com/ChetanXpro/nodejs-whisper).

**Requirements**

- `nodejs-whisper` must be installed: `cd web && bun add nodejs-whisper`
- Build tools (`make`, `gcc`) must be present for the native compilation step
- The Whisper model is downloaded automatically on first use (~150 MB for `base.en`)

**Configuration**

| Variable | Default | Description |
|---|---|---|
| `WHISPER_MODEL` | `base.en` | Model to use. Options: `tiny`, `tiny.en`, `base`, `base.en`, `small`, `small.en`, `medium`, `medium.en`, `large-v1`, `large`, `large-v3-turbo` |

```bash
WHISPER_MODEL=small.en bun run start
```

The endpoint `POST /api/transcribe` accepts a `multipart/form-data` body with an `audio` WAV file field and returns `{ text: string, duration_ms: number }`. It returns `{ status: "loading" }` with HTTP 503 while the model is downloading (the browser retries automatically).

## Docs
- Protocol reverse engineering: [`WEBSOCKET_PROTOCOL_REVERSED.md`](WEBSOCKET_PROTOCOL_REVERSED.md)
- Contributor and architecture guide: [`CLAUDE.md`](CLAUDE.md)

## License
MIT
