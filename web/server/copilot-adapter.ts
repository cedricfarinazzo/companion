/**
 * Copilot CLI Adapter
 *
 * Integrates the GitHub Copilot CLI (`copilot`) as a backend for The Companion.
 *
 * Architecture: ONE persistent `copilot --allow-all-tools --silent` process is kept
 * alive for the lifetime of the session, with stdin/stdout pipes.  User messages are
 * written to stdin; responses are collected from stdout using an idle-timeout
 * (RESPONSE_IDLE_MS of silence after the last chunk = response complete).
 * Because the process never exits between turns, Copilot maintains full conversation
 * context natively — no `--resume` session-file tricks required.
 *
 * Install: npm install -g @github/copilot
 * Auth:    GH_TOKEN or GITHUB_TOKEN env var, or run `copilot /login` once.
 *
 * Limitations vs Claude Code:
 * - No streaming mid-response: response text is buffered and emitted in one shot.
 * - No tool permission approval flow (--allow-all-tools bypasses all prompts).
 * - No model switching at runtime.
 * - No Docker container support (runs on host only).
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
  /** Whether to pass --resume when starting the process (for server-restart recovery). */
  resume?: boolean;
  /** Extra env vars to pass to the copilot process */
  env?: Record<string, string>;
}

// ─── Idle-timeout response detector ──────────────────────────────────────────

/**
 * Milliseconds of stdout silence after which we consider the current response
 * complete and ready to emit.  3 s is generous enough for long code responses
 * while still feeling snappy on short answers.
 */
const RESPONSE_IDLE_MS = 3_000;

/**
 * Hard upper bound on how long we wait for ANY output after sending a prompt.
 * If Copilot is still "thinking" after 5 minutes, we give up and emit an error.
 */
const RESPONSE_MAX_MS = 5 * 60_000;

/**
 * Maximum wait for startup output before we consider the process ready.
 * If the trust/login prompt takes longer than this, we bail.
 */
const STARTUP_MAX_MS = 15_000;

// ─── Strip ANSI escape codes ─────────────────────────────────────────────────

// Covers CSI sequences, OSC, and carriage returns that pollute the response text.
const ANSI_PATTERN = /(\x9b|\x1b\[)[0-9;]*[a-zA-Z]|\x1b[^[]/g;

function stripAnsi(raw: string): string {
  return raw
    .replace(ANSI_PATTERN, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
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
  /** The single long-running copilot process. */
  private proc: Subprocess | null = null;

  /** Queue of user messages waiting for the current turn to complete. */
  private pendingUserMessages: string[] = [];
  /** Whether a turn is currently in progress. */
  private turnInProgress = false;
  /** Buffer for pending outgoing messages during adapter startup. */
  private pendingOutgoing: BrowserOutgoingMessage[] = [];

  // ── Stdout accumulator shared between reader loop and response detector ──

  /** Raw text chunks arriving from stdout, consumed by the response waiter. */
  private stdoutChunks: string[] = [];
  /** Notify the current response waiter that a new chunk arrived. */
  private onChunk: (() => void) | null = null;

  constructor(sessionId: string, options: CopilotAdapterOptions = {}) {
    this.sessionId = sessionId;
    this.options = options;

    // Start the persistent process asynchronously so callers can register
    // callbacks before we emit session_init.
    this.startProcess().catch((err) => {
      console.error(`[copilot-adapter] Startup failed for session ${sessionId}:`, err);
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
    if (this.proc) {
      try {
        this.proc.kill("SIGTERM");
        await Promise.race([
          this.proc.exited,
          new Promise((r) => setTimeout(r, 3000)),
        ]);
      } catch {}
      this.proc = null;
    }
  }

  // ── Startup ─────────────────────────────────────────────────────────────────

  private async startProcess(): Promise<void> {
    const binary = this.options.binary || "copilot";

    // Persistent process flags:
    //   --allow-all-tools  bypass per-tool permission prompts
    //   --silent           suppress UI noise; output only the assistant response
    // --resume is passed when recovering a server-restart (session already has history)
    const args: string[] = ["--allow-all-tools", "--silent"];
    if (this.options.resume) {
      args.unshift("--resume");
    }

    const spawnEnv: Record<string, string | undefined> = {
      ...process.env,
      ...this.options.env,
      // Suppress colour escape codes — we strip them anyway, but this keeps
      // the output cleaner and avoids terminal-detection branches in Copilot.
      NO_COLOR: "1",
      TERM: "dumb",
    };

    console.log(`[copilot-adapter] Starting persistent Copilot process for session ${this.sessionId}: copilot ${args.join(" ")}`);

    let proc: Subprocess;
    try {
      proc = Bun.spawn([binary, ...args], {
        cwd: this.options.cwd,
        env: spawnEnv,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[copilot-adapter] Failed to spawn copilot: ${msg}`);
      const errMsg = `Failed to launch Copilot CLI: ${msg}. Make sure "copilot" is installed (npm install -g @github/copilot).`;
      this._connected = false;
      // Emit via microtask so that the caller has time to register onBrowserMessage
      await Promise.resolve();
      this.emit({ type: "error", message: errMsg });
      this.disconnectCb?.();
      return;
    }

    this.proc = proc;

    // ── Start the continuous stdout reader loop ──
    this.startStdoutLoop(proc);

    // ── Watch for process exit ──
    proc.exited.then((code) => {
      if (this.proc !== proc) return; // already replaced / disconnected
      console.log(`[copilot-adapter] Copilot process exited (code=${code}) for session ${this.sessionId}`);
      this.proc = null;
      if (this._connected) {
        this._connected = false;
        this.disconnectCb?.();
      }
    });

    // ── Read startup output ──
    // Copilot may print a trust-directory prompt or a login prompt before it
    // is ready. We read for up to STARTUP_MAX_MS to detect these cases.
    const startupText = await this.readUntilIdle(STARTUP_MAX_MS, 1500);
    const cleanStartup = stripAnsi(startupText);

    if (cleanStartup.toLowerCase().includes("not logged in") || cleanStartup.toLowerCase().includes("login")) {
      const errMsg = "Copilot CLI is not authenticated. Run `copilot /login` in your terminal, or set GH_TOKEN / GITHUB_TOKEN.";
      console.error(`[copilot-adapter] ${errMsg}`);
      this._connected = false;
      await Promise.resolve();
      this.emit({ type: "error", message: errMsg });
      this.disconnectCb?.();
      return;
    }

    if (cleanStartup.toLowerCase().includes("trust")) {
      // Send "1" to approve: "Yes, proceed (this session only)"
      console.log(`[copilot-adapter] Responding to trust prompt for session ${this.sessionId}`);
      await this.writeToStdin("1\n");
      // Drain follow-up output (welcome message etc.)
      await this.readUntilIdle(STARTUP_MAX_MS, 2000);
    }

    // ── Emit session_init ──
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

    // Flush any messages that arrived while we were starting up
    if (this.pendingOutgoing.length > 0) {
      const queued = this.pendingOutgoing.splice(0);
      for (const msg of queued) {
        this.dispatchOutgoing(msg);
      }
    }
  }

  // ── Stdout reader loop ───────────────────────────────────────────────────────

  private startStdoutLoop(proc: Subprocess): void {
    const rawStdout = proc.stdout;
    const rawStderr = proc.stderr;
    const decoder = new TextDecoder();
    const errDecoder = new TextDecoder();

    // Stdout: push chunks into stdoutChunks and wake any pending waiter
    if (rawStdout && typeof rawStdout !== "number") {
      (async () => {
        const reader = rawStdout.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            this.stdoutChunks.push(decoder.decode(value, { stream: true }));
            this.onChunk?.();
          }
        } catch {
          // stream closed — process exited
        }
      })();
    }

    // Stderr: log for debugging
    if (rawStderr && typeof rawStderr !== "number") {
      (async () => {
        const reader = rawStderr.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = errDecoder.decode(value, { stream: true });
            if (chunk.trim()) {
              console.error(`[copilot-adapter:${this.sessionId}:stderr] ${chunk.trimEnd()}`);
            }
          }
        } catch {
          // stream closed
        }
      })();
    }
  }

  // ── Idle-based response collection ──────────────────────────────────────────

  /**
   * Collect stdout text until either:
   *   - `idleMs` have passed with no new chunks, OR
   *   - `maxMs` have passed since we started waiting (hard cap)
   *
   * Returns everything accumulated so far.
   */
  private readUntilIdle(maxMs: number, idleMs: number): Promise<string> {
    return new Promise((resolve) => {
      let accumulated = "";
      let idleTimer: ReturnType<typeof setTimeout>;
      const maxTimer = setTimeout(() => {
        clearTimeout(idleTimer);
        this.onChunk = null;
        resolve(accumulated);
      }, maxMs);

      const resetIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          clearTimeout(maxTimer);
          this.onChunk = null;
          resolve(accumulated);
        }, idleMs);
      };

      // Drain any chunks already in the buffer
      while (this.stdoutChunks.length > 0) {
        accumulated += this.stdoutChunks.shift()!;
      }
      // If we already have content, start the idle timer immediately
      if (accumulated.length > 0) {
        resetIdle();
      } else {
        resetIdle(); // also start timer (with empty buffer) to handle fast resolve
      }

      // Register for future chunks
      this.onChunk = () => {
        while (this.stdoutChunks.length > 0) {
          accumulated += this.stdoutChunks.shift()!;
        }
        resetIdle();
      };
    });
  }

  // ── stdin writer ─────────────────────────────────────────────────────────────

  private writeToStdin(text: string): void {
    if (!this.proc) return;
    const rawStdin = this.proc.stdin;
    if (!rawStdin || typeof rawStdin === "number") return;
    try {
      (rawStdin as { write(data: Uint8Array): number }).write(new TextEncoder().encode(text));
    } catch (err) {
      console.error(`[copilot-adapter] stdin write failed:`, err);
    }
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  private dispatchOutgoing(msg: BrowserOutgoingMessage): boolean {
    if (!this.proc && msg.type === "user_message") {
      // Process not yet started — queue for after startup
      this.pendingOutgoing.push(msg);
      return true;
    }
    switch (msg.type) {
      case "user_message":
        this.handleUserMessage(msg.content);
        return true;
      case "interrupt":
        this.handleInterrupt();
        return true;
      default:
        return false;
    }
  }

  private handleInterrupt(): void {
    if (this.proc) {
      try {
        this.proc.kill("SIGINT");
      } catch {}
    }
  }

  private handleUserMessage(content: string): void {
    if (this.turnInProgress) {
      this.pendingUserMessages.push(content);
      return;
    }
    this.runTurn(content);
  }

  private async runTurn(prompt: string): Promise<void> {
    if (!this._connected || !this.proc) return;
    this.turnInProgress = true;

    console.log(`[copilot-adapter] Sending turn to Copilot for session ${this.sessionId}: ${prompt.slice(0, 80)}${prompt.length > 80 ? "…" : ""}`);

    // Emit "running" status to browser
    this.emit({ type: "status_change", status: "running" });

    // Write the prompt to the persistent process's stdin, followed by a newline
    // so Copilot treats it as a submitted message.
    this.writeToStdin(prompt + "\n");

    // Collect the response using idle-based timeout
    const rawResponse = await this.readUntilIdle(RESPONSE_MAX_MS, RESPONSE_IDLE_MS);
    const responseText = stripAnsi(rawResponse).trim();

    if (!responseText) {
      // If no response came through, the process may have crashed
      if (!this.proc) {
        this.emit({ type: "error", message: "Copilot process exited unexpectedly while waiting for a response." });
      }
      this.emit({ type: "status_change", status: "idle" });
      this.turnInProgress = false;
      const next = this.pendingUserMessages.shift();
      if (next && this._connected) this.runTurn(next);
      return;
    }

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

