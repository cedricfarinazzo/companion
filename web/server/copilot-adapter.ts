/**
 * Copilot CLI Adapter
 *
 * Integrates the GitHub Copilot CLI (`copilot`) as a backend for The Companion.
 * 
 * The Copilot CLI is an interactive terminal tool. For programmatic use, it
 * supports `-p <prompt>` (execute a prompt and exit) and `-s` (silent mode:
 * output only the agent response). Session continuity is achieved via
 * `--resume` which resumes the most recent session.
 *
 * Limitations vs Claude Code:
 * - No streaming mid-response: the full response is buffered and emitted when
 *   the process exits (unless --stream on is used, but output format varies).
 * - Each user turn spawns a new short-lived process.
 * - No tool permission approval flow in the web UI (--allow-all-tools is used).
 * - No model switching at runtime.
 *
 * Install: npm install -g @github/copilot
 * Auth: GH_TOKEN or GITHUB_TOKEN env var, or `copilot /login`
 */

import { randomUUID } from "node:crypto";
import type { Subprocess } from "bun";
import type {
  BrowserIncomingMessage,
  BrowserOutgoingMessage,
  SessionState,
} from "./session-types.js";

// ─── Adapter Options ──────────────────────────────────────────────────────────

export interface CopilotAdapterOptions {
  cwd?: string;
  /** Path to the copilot binary (default: "copilot") */
  binary?: string;
  /** Whether to resume the most recent Copilot session */
  resume?: boolean;
  /** Extra env vars to pass to the copilot process */
  env?: Record<string, string>;
}

// ─── Copilot Adapter ──────────────────────────────────────────────────────────

export class CopilotAdapter {
  private sessionId: string;
  private options: CopilotAdapterOptions;

  private browserMessageCb: ((msg: BrowserIncomingMessage) => void) | null = null;
  private sessionMetaCb: ((meta: { cliSessionId?: string; model?: string; cwd?: string }) => void) | null = null;
  private disconnectCb: (() => void) | null = null;

  /** Whether the adapter is active (not permanently disconnected). */
  private _connected = true;
  /** Currently running copilot subprocess (one per user turn). */
  private currentProc: Subprocess | null = null;
  /** Whether any turn has been completed (so we can use --resume). */
  private hasPriorSession = false;
  /** Queue of user messages waiting for the current turn to complete. */
  private pendingUserMessages: string[] = [];
  /** Whether a turn is currently in progress. */
  private turnInProgress = false;
  /** Buffer for pending outgoing messages during adapter startup. */
  private pendingOutgoing: BrowserOutgoingMessage[] = [];

  constructor(sessionId: string, options: CopilotAdapterOptions = {}) {
    this.sessionId = sessionId;
    this.options = options;
    this.hasPriorSession = options.resume === true;

    // Emit initial session state so the browser knows we're connected
    // Use a microtask so callers can register callbacks first
    Promise.resolve().then(() => {
      const state: SessionState = {
        session_id: this.sessionId,
        backend_type: "copilot",
        model: "",
        cwd: this.options.cwd || "",
        tools: [],
        permissionMode: "bypassPermissions",
        claude_code_version: "",
        mcp_servers: [],
        agents: [],
        slash_commands: [],
        skills: [],
        total_cost_usd: 0,
        num_turns: 0,
        context_used_percent: 0,
        is_compacting: false,
        git_branch: "",
        is_worktree: false,
        is_containerized: false,
        repo_root: "",
        git_ahead: 0,
        git_behind: 0,
        total_lines_added: 0,
        total_lines_removed: 0,
      };
      this.emit({ type: "session_init", session: state });
      this.sessionMetaCb?.({ cwd: this.options.cwd });

      // Flush any messages queued before callbacks were registered
      if (this.pendingOutgoing.length > 0) {
        const queued = this.pendingOutgoing.splice(0);
        for (const msg of queued) {
          this.dispatchOutgoing(msg);
        }
      }
    });
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  sendBrowserMessage(msg: BrowserOutgoingMessage): boolean {
    if (!this._connected) return false;
    return this.dispatchOutgoing(msg);
  }

  onBrowserMessage(cb: (msg: BrowserIncomingMessage) => void): void {
    this.browserMessageCb = cb;
  }

  onSessionMeta(cb: (meta: { cliSessionId?: string; model?: string; cwd?: string }) => void): void {
    this.sessionMetaCb = cb;
  }

  onDisconnect(cb: () => void): void {
    this.disconnectCb = cb;
  }

  isConnected(): boolean {
    return this._connected;
  }

  async disconnect(): Promise<void> {
    this._connected = false;
    if (this.currentProc) {
      try {
        this.currentProc.kill("SIGTERM");
        await Promise.race([
          this.currentProc.exited,
          new Promise((r) => setTimeout(r, 3000)),
        ]);
      } catch {}
      this.currentProc = null;
    }
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  private dispatchOutgoing(msg: BrowserOutgoingMessage): boolean {
    switch (msg.type) {
      case "user_message":
        this.handleUserMessage(msg.content);
        return true;
      case "interrupt":
        this.handleInterrupt();
        return true;
      // Silently ignore unsupported message types
      default:
        return false;
    }
  }

  private handleInterrupt(): void {
    if (this.currentProc) {
      try {
        this.currentProc.kill("SIGINT");
      } catch {}
    }
  }

  private handleUserMessage(content: string): void {
    if (this.turnInProgress) {
      // Queue if a turn is already running
      this.pendingUserMessages.push(content);
      return;
    }
    this.runTurn(content);
  }

  private async runTurn(prompt: string): Promise<void> {
    if (!this._connected) return;
    this.turnInProgress = true;

    const binary = this.options.binary || "copilot";

    // Build args: programmatic mode with silent output
    // --allow-all-tools: bypass permission prompts (required for non-interactive use)
    // -s / --silent: output only the agent response, no usage stats
    // -p: execute the prompt and exit
    const args: string[] = [];
    if (this.hasPriorSession) {
      // Resume the most recent session so context is preserved across turns
      args.push("--resume");
    }
    // Suppress the interactive banner which would block programmatic use
    // Note: --no-color is not documented but --silent already suppresses most UI noise
    args.push(
      "--allow-all-tools",
      "--silent",
      "--prompt", prompt,
    );

    const spawnEnv: Record<string, string | undefined> = {
      ...process.env,
      ...this.options.env,
      // Ensure no TTY tricks from the parent environment
      TERM: "dumb",
    };

    console.log(`[copilot-adapter] Running turn for session ${this.sessionId}: copilot ${args.slice(0, -1).join(" ")} --prompt "<...>"`);

    let proc: Subprocess;
    try {
      proc = Bun.spawn([binary, ...args], {
        cwd: this.options.cwd,
        env: spawnEnv,
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[copilot-adapter] Failed to spawn copilot: ${msg}`);
      this.emit({
        type: "error",
        message: `Failed to launch Copilot CLI: ${msg}. Make sure "copilot" is installed (npm install -g @github/copilot).`,
      });
      this.turnInProgress = false;
      this._connected = false;
      this.disconnectCb?.();
      return;
    }

    this.currentProc = proc;

    // Emit "running" status to browser
    this.emit({ type: "status_change", status: "running" });

    // Accumulate stdout for the complete response
    let responseText = "";
    let errorText = "";

    // Read stdout/stderr - Bun subprocess streams may be ReadableStream or number (when inherited)
    const rawStdout = proc.stdout;
    const rawStderr = proc.stderr;
    const stdoutReader = rawStdout && typeof rawStdout !== "number" ? rawStdout.getReader() : null;
    const stderrReader = rawStderr && typeof rawStderr !== "number" ? rawStderr.getReader() : null;
    const decoder = new TextDecoder();

    // Stream stdout to responseText
    const stdoutDone = (async () => {
      if (!stdoutReader) return;
      try {
        while (true) {
          const { done, value } = await stdoutReader.read();
          if (done) break;
          responseText += decoder.decode(value, { stream: true });
        }
      } catch {
        // stream closed
      }
    })();

    // Stream stderr to errorText (for debugging)
    const stderrDone = (async () => {
      if (!stderrReader) return;
      const errDecoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await stderrReader.read();
          if (done) break;
          const chunk = errDecoder.decode(value, { stream: true });
          errorText += chunk;
          if (chunk.trim()) {
            console.error(`[copilot-adapter:${this.sessionId}:stderr] ${chunk.trimEnd()}`);
          }
        }
      } catch {
        // stream closed
      }
    })();

    const exitCode = await proc.exited;
    await Promise.all([stdoutDone, stderrDone]);
    this.currentProc = null;

    // Trim the accumulated response
    responseText = responseText.trim();

    if (exitCode !== 0 || !responseText) {
      // Detect common errors and provide helpful messages
      const combinedOutput = (responseText + errorText).toLowerCase();
      let errorMessage: string;

      if (combinedOutput.includes("not logged in") || combinedOutput.includes("login") || combinedOutput.includes("authentication")) {
        errorMessage = "Copilot CLI is not authenticated. Run `copilot /login` in your terminal to authenticate, or set the GH_TOKEN / GITHUB_TOKEN environment variable.";
      } else if (exitCode === 127 || combinedOutput.includes("command not found") || combinedOutput.includes("not found")) {
        errorMessage = "Copilot CLI is not installed. Install it with: npm install -g @github/copilot";
      } else if (!responseText && errorText) {
        errorMessage = `Copilot CLI error (exit ${exitCode}): ${errorText.trim().slice(0, 500)}`;
      } else if (!responseText) {
        errorMessage = `Copilot CLI exited with code ${exitCode} and produced no output.`;
      } else {
        // We have some text even on non-zero exit — use it
        errorMessage = "";
      }

      if (errorMessage) {
        console.error(`[copilot-adapter] Turn failed for session ${this.sessionId}: ${errorMessage}`);
        this.emit({ type: "error", message: errorMessage });
        this.emit({ type: "status_change", status: "idle" });
        this.turnInProgress = false;

        // Drain pending messages
        const next = this.pendingUserMessages.shift();
        if (next && this._connected) {
          this.runTurn(next);
        }
        return;
      }
    }

    // Mark that we now have a prior session to resume
    this.hasPriorSession = true;

    // Emit the response as an assistant message
    const msgId = randomUUID();
    const assistantMsg: BrowserIncomingMessage = {
      type: "assistant",
      message: {
        id: msgId,
        type: "message",
        role: "assistant",
        model: "copilot",
        content: [{ type: "text", text: responseText }],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
      parent_tool_use_id: null,
      timestamp: Date.now(),
    };
    this.emit(assistantMsg);

    // Emit a result to signal the turn is done
    this.emit({
      type: "result",
      data: {
        type: "result",
        subtype: "success",
        is_error: false,
        result: responseText,
        duration_ms: 0,
        duration_api_ms: 0,
        num_turns: 1,
        total_cost_usd: 0,
        stop_reason: "end_turn",
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        uuid: msgId,
        session_id: this.sessionId,
      },
    });

    this.emit({ type: "status_change", status: "idle" });

    this.turnInProgress = false;

    // Process any queued messages
    const next = this.pendingUserMessages.shift();
    if (next && this._connected) {
      this.runTurn(next);
    }
  }

  private emit(msg: BrowserIncomingMessage): void {
    this.browserMessageCb?.(msg);
  }
}
