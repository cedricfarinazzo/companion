<p align="center">
  <img src="screenshot.png" alt="The Companion" width="100%" />
</p>

<h1 align="center">The Companion</h1>
<p align="center"><strong>Web UI for Claude Code, Codex, and GitHub Copilot sessions.</strong></p>
<p align="center">Run multiple agents, inspect every tool call, and gate risky actions with explicit approvals.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/the-companion"><img src="https://img.shields.io/npm/v/the-companion.svg" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/the-companion"><img src="https://img.shields.io/npm/dm/the-companion.svg" alt="npm downloads" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT License" /></a>
</p>

## Quick start
Requirements:
- Bun
- Claude Code and/or Codex CLI and/or GitHub Copilot CLI available on your machine

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
- **Multi-engine support**: supports Claude Code, Codex, and GitHub Copilot CLI.

## Screenshots
| Chat + tool timeline | Permission flow |
|---|---|
| <img src="screenshot.png" alt="Main workspace" width="100%" /> | <img src="web/docs/screenshots/notification-section.png" alt="Permission and notifications" width="100%" /> |

## Architecture (simple)
```text
Browser (React)
  <-> ws://localhost:3456/ws/browser/:session
Companion server (Bun + Hono)
  <-> ws://localhost:3456/ws/cli/:session  (Claude Code / Codex)
  <-> stdio (GitHub Copilot CLI via -p flag)
Claude Code / Codex / GitHub Copilot CLI
```

The bridge uses the CLI `--sdk-url` websocket path and NDJSON events for Claude Code, JSON-RPC stdio for Codex, and `-p`/`--silent` programmatic mode for Copilot CLI.

## GitHub Copilot CLI Integration

The Companion supports [GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/install-copilot-cli) as a third backend alongside Claude Code and Codex.

### Prerequisites

1. **GitHub Copilot subscription** — requires an active Copilot plan.
2. **Install Copilot CLI** — install via npm (requires Node.js 22+):
   ```bash
   npm install -g @github/copilot
   ```
   Or via Homebrew (macOS/Linux):
   ```bash
   brew install copilot-cli
   ```
3. **Authenticate** — on first use, run `copilot /login` in your terminal, or set `GH_TOKEN` / `GITHUB_TOKEN` environment variable with a fine-grained token that has the "Copilot Requests" permission.

### How it works

When you create a Copilot session, The Companion runs:
```bash
copilot --resume --allow-all-tools --silent --prompt "<your message>"
```

Each user message spawns a new short-lived `copilot` process. The `--resume` flag reuses the most recent session for conversation continuity. Responses are captured from stdout and displayed in the chat UI.

### Limitations

- **No streaming mid-response**: The full response is buffered and displayed when the process exits (Copilot CLI does not expose a streaming API for programmatic use).
- **No tool permission UI**: `--allow-all-tools` is always passed, bypassing permission prompts. All tool use is approved automatically.
- **No model selection**: The Copilot CLI uses its own model routing; you cannot choose a specific model from the UI.
- **No Docker container support**: Copilot sessions run on the host only.
- **Authentication is local**: The Copilot CLI must be authenticated on the host machine.

### Troubleshooting

| Error | Solution |
|---|---|
| `"copilot" not found` | Install with `npm install -g @github/copilot` |
| `not authenticated` / `login` error | Run `copilot /login` or set `GH_TOKEN` |
| Empty response | Check that your Copilot subscription is active |

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

## Docs
- Protocol reverse engineering: [`WEBSOCKET_PROTOCOL_REVERSED.md`](WEBSOCKET_PROTOCOL_REVERSED.md)
- Contributor and architecture guide: [`CLAUDE.md`](CLAUDE.md)

## License
MIT
