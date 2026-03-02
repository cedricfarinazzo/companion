/**
 * Copilot ACP Adapter
 *
 * Translates between the GitHub Copilot CLI Agent Client Protocol (ACP, JSON-RPC 2.0 over stdio)
 * and The Companion's BrowserIncomingMessage/BrowserOutgoingMessage types.
 *
 * Uses the @agentclientprotocol/sdk ClientSideConnection to handle the protocol.
 */

import { randomUUID } from "node:crypto";
import type { Subprocess } from "bun";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type SessionNotification,
  type SessionUpdate,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type RequestPermissionOutcome,
  type PermissionOption,
  type ToolCall,
  type ToolCallUpdate,
  type ContentBlock,
  type McpServer,
} from "@agentclientprotocol/sdk";
import type {
  BrowserIncomingMessage,
  BrowserOutgoingMessage,
  SessionState,
  CLIResultMessage,
} from "./session-types.js";
import type { RecorderManager } from "./recorder.js";

// ─── Mode ID constants ────────────────────────────────────────────────────────

const ACP_MODE_AGENT = "https://agentclientprotocol.com/protocol/session-modes#agent";
const ACP_MODE_PLAN = "https://agentclientprotocol.com/protocol/session-modes#plan";
const ACP_MODE_AUTOPILOT = "https://agentclientprotocol.com/protocol/session-modes#autopilot";

/** Map a Companion permission mode string to an ACP mode ID. */
function companionModeToAcpMode(mode: string): string {
  if (mode === "plan") return ACP_MODE_PLAN;
  if (mode === "bypassPermissions" || mode === "acceptEdits") return ACP_MODE_AUTOPILOT;
  return ACP_MODE_AGENT; // "default" and everything else
}

/** Map an ACP mode ID to a Companion permission mode string. */
function acpModeToCompanionMode(modeId: string): string {
  if (modeId === ACP_MODE_PLAN) return "plan";
  if (modeId === ACP_MODE_AUTOPILOT) return "bypassPermissions";
  return "default";
}

// ─── Adapter options ─────────────────────────────────────────────────────────

export interface CopilotAdapterOptions {
  model?: string;
  cwd?: string;
  permissionMode?: string;
  /** ACP session ID to resume (session/load). If absent, session/new is used. */
  acpSessionId?: string;
  recorder?: RecorderManager;
  killProcess?: () => Promise<void> | void;
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

export class CopilotAdapter {
  private companionSessionId: string;
  private options: CopilotAdapterOptions;

  // ACP connection (established during initialize())
  private connection: ClientSideConnection | null = null;
  // ACP session ID returned by session/new or session/load
  private acpSessionId: string | null = null;

  // Lifecycle state
  private connected = false;
  private initDone = false;
  private initFailed = false;

  // Callbacks registered by the bridge
  private browserMessageCb: ((msg: BrowserIncomingMessage) => void) | null = null;
  private sessionMetaCb: ((meta: { cliSessionId?: string; model?: string; cwd?: string }) => void) | null = null;
  private disconnectCb: (() => void) | null = null;

  // Messages queued before init completes
  private pendingOutgoing: BrowserOutgoingMessage[] = [];

  // Pending permission requests from the agent: keyed by our internal request_id
  private pendingPermissions = new Map<string, {
    resolve: (outcome: RequestPermissionOutcome) => void;
    reject: (err: Error) => void;
    options: PermissionOption[];
  }>();

  // Pending interrupt (cancel) resolver
  private cancelCurrentTurn: (() => void) | null = null;

  // Streaming accumulator for the current agent message
  private streamingText = "";
  private streamingThinking = "";
  private hasStreamingText = false;
  private hasStreamingThinking = false;

  // Tool call tracking: acpToolCallId → { toolUseId, title, input }
  private toolCalls = new Map<string, { toolUseId: string; title: string; input: Record<string, unknown> }>();

  // Available models from the agent
  private availableModels: Array<{ modelId: string; name: string }> = [];
  private currentModel = "";

  constructor(proc: Subprocess, sessionId: string, options: CopilotAdapterOptions = {}) {
    this.companionSessionId = sessionId;
    this.options = options;

    const stdout = proc.stdout;
    const stdin = proc.stdin;

    if (!stdout || !stdin || typeof stdout === "number" || typeof stdin === "number") {
      throw new Error("Copilot process must have stdio pipes");
    }

    // Wrap Bun's subprocess stdin into a WHATWG WritableStream
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        (stdin as { write(data: Uint8Array): number }).write(chunk);
      },
    });

    const stream = ndJsonStream(writable, stdout as ReadableStream<Uint8Array>);

    // Wire raw recording if provided
    if (options.recorder) {
      const recorder = options.recorder;
      const cwd = options.cwd || "";
      // We intercept raw lines via the stream — not available directly through the SDK.
      // Recording is best-effort; the SDK doesn't expose raw message hooks.
      // TODO: wrap the stream to intercept raw lines for recording
      void recorder; void cwd;
    }

    // The ACP Client interface: receives incoming calls/notifications from the agent
    const self = this;
    const client: Client = {
      async sessionUpdate(params) {
        self.handleSessionUpdate(params);
      },
      async requestPermission(params) {
        return self.handleRequestPermission(params);
      },
      async readTextFile(params) {
        // Not implemented — the agent shouldn't need this for basic chat
        throw new Error("fs/read_text_file not supported");
      },
      async writeTextFile(params) {
        throw new Error("fs/write_text_file not supported");
      },
    };

    this.connection = new ClientSideConnection((_agent) => client, stream);

    // Kill process and fire disconnectCb when connection closes
    this.connection.closed.then(() => {
      this.connected = false;
      // Cancel any pending permissions
      for (const [, { reject }] of this.pendingPermissions) {
        reject(new Error("Connection closed"));
      }
      this.pendingPermissions.clear();
      this.disconnectCb?.();
    });

    if (!options.killProcess) {
      options.killProcess = async () => {
        try {
          proc.kill("SIGTERM");
          await Promise.race([proc.exited, new Promise((r) => setTimeout(r, 5000))]);
        } catch {}
      };
    }

    proc.exited.then(() => {
      this.connected = false;
      for (const [, { reject }] of this.pendingPermissions) {
        reject(new Error("Process exited"));
      }
      this.pendingPermissions.clear();
      this.disconnectCb?.();
    });

    // Start initialization asynchronously
    this.initialize();
  }

  // ── Public API ────────────────────────────────────────────────────────────

  isConnected(): boolean {
    return this.connected;
  }

  getRateLimits() {
    return null; // ACP doesn't expose rate limits
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

  async disconnect(): Promise<void> {
    await this.options.killProcess?.();
  }

  /**
   * Send a browser message to the Copilot backend.
   * Returns false if the message cannot be handled (init failed, not connected, etc.)
   */
  sendBrowserMessage(msg: BrowserOutgoingMessage): boolean {
    if (this.initFailed) return false;

    if (!this.initDone || !this.acpSessionId) {
      if (msg.type === "user_message" || msg.type === "interrupt") {
        this.pendingOutgoing.push(msg);
      }
      return true;
    }

    this.dispatchBrowserMessage(msg);
    return true;
  }

  // ── Initialization ────────────────────────────────────────────────────────

  private async initialize(): Promise<void> {
    if (!this.connection) return;

    try {
      // 1. Handshake
      const initResult = await this.connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "the-companion", version: "1.0.0" },
      });

      this.connected = true;

      // 2. Create or load session
      let sessionId: string;
      let models: { availableModels?: Array<{ modelId: string; name: string }>; currentModelId?: string } | undefined;
      let modes: { availableModes?: Array<{ id: string; name: string }>; currentModeId?: string } | undefined;

      const cwd = this.options.cwd || process.cwd();
      const mcpServers: McpServer[] = [];

      if (this.options.acpSessionId && initResult.agentCapabilities?.loadSession) {
        // Resume existing session
        const loadResult = await this.connection.loadSession({
          sessionId: this.options.acpSessionId,
          cwd,
          mcpServers,
        });
        sessionId = this.options.acpSessionId;
        void loadResult;
      } else {
        // New session
        const newResult = await this.connection.newSession({ cwd, mcpServers }) as {
          sessionId: string;
          models?: { availableModels?: Array<{ modelId: string; name: string }>; currentModelId?: string };
          modes?: { availableModes?: Array<{ id: string; name: string }>; currentModeId?: string };
        };
        sessionId = newResult.sessionId;
        models = newResult.models;
        modes = newResult.modes;
      }

      this.acpSessionId = sessionId;

      // Store available models (Copilot-specific extension)
      if (models?.availableModels) {
        this.availableModels = models.availableModels;
      }
      const resolvedModel = this.options.model
        || models?.currentModelId
        || this.availableModels[0]?.modelId
        || "";
      this.currentModel = resolvedModel;

      // If a specific model was requested, try to set it
      if (this.options.model && models?.currentModelId && this.options.model !== models.currentModelId) {
        try {
          await (this.connection as ClientSideConnection & {
            unstable_setSessionModel?: (p: { sessionId: string; modelId: string }) => Promise<unknown>;
          }).unstable_setSessionModel?.({ sessionId, modelId: this.options.model });
        } catch (err) {
          console.warn(`[copilot-adapter] Could not set model ${this.options.model}:`, err);
        }
      }

      // Set permission mode if not default
      const initialMode = companionModeToAcpMode(this.options.permissionMode || "default");
      if (initialMode !== ACP_MODE_AGENT && modes?.currentModeId !== initialMode) {
        try {
          await this.connection.setSessionMode({ sessionId, modeId: initialMode });
        } catch (err) {
          console.warn(`[copilot-adapter] Could not set initial mode ${initialMode}:`, err);
        }
      }
      const permissionMode = acpModeToCompanionMode(modes?.currentModeId || ACP_MODE_AGENT);

      // Emit session_init to browser
      const state = this.buildInitialSessionState(sessionId, resolvedModel, cwd, permissionMode);
      this.emit({ type: "session_init", session: state });

      // Notify bridge of the ACP session ID (used for session resume)
      this.sessionMetaCb?.({
        cliSessionId: sessionId,
        model: resolvedModel,
        cwd,
      });

      this.initDone = true;

      // Flush any queued messages
      const queued = this.pendingOutgoing.splice(0);
      for (const msg of queued) {
        this.dispatchBrowserMessage(msg);
      }
    } catch (err) {
      console.error("[copilot-adapter] Initialization failed:", err);
      this.initFailed = true;
      this.connected = false;
      this.emit({ type: "error", message: `Failed to initialize Copilot ACP session: ${err}` });
      this.disconnectCb?.();
    }
  }

  private buildInitialSessionState(
    _acpSessionId: string,
    model: string,
    cwd: string,
    permissionMode: string,
  ): SessionState {
    return {
      session_id: this.companionSessionId,
      backend_type: "copilot",
      model,
      cwd,
      permissionMode,
      tools: [],
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
      claude_code_version: "",
    };
  }

  // ── ACP Client callbacks ──────────────────────────────────────────────────

  private handleSessionUpdate(params: SessionNotification): void {
    const update = params.update as SessionUpdate & { sessionUpdate: string };

    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const chunk = update as SessionUpdate & { content: { type: string; text?: string } };
        if (chunk.content?.type === "text" && typeof chunk.content.text === "string") {
          const text = chunk.content.text;
          this.streamingText += text;
          this.hasStreamingText = true;
          // Emit live text delta for streaming UI
          this.emit({
            type: "stream_event",
            event: {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text },
            },
            parent_tool_use_id: null,
          });
        }
        break;
      }

      case "agent_thought_chunk": {
        const chunk = update as SessionUpdate & { content: { type: string; text?: string } };
        if (chunk.content?.type === "text" && typeof chunk.content.text === "string") {
          this.streamingThinking += chunk.content.text;
          this.hasStreamingThinking = true;
        }
        break;
      }

      case "tool_call": {
        const toolCall = update as SessionUpdate & ToolCall & { sessionUpdate: string };
        this.handleToolCallStarted(toolCall);
        break;
      }

      case "tool_call_update": {
        const toolUpdate = update as SessionUpdate & ToolCallUpdate & { sessionUpdate: string };
        this.handleToolCallUpdated(toolUpdate);
        break;
      }

      case "current_mode_update": {
        const modeUpdate = update as { sessionUpdate: string; currentModeId: string };
        const companionMode = acpModeToCompanionMode(modeUpdate.currentModeId);
        this.emit({ type: "session_update", session: { permissionMode: companionMode } });
        break;
      }

      case "usage_update": {
        // Optional: extract cost/token information if available
        break;
      }

      case "user_message_chunk": {
        // Replayed during session/load — emit as user_message for history
        const chunk = update as SessionUpdate & { content: { type: string; text?: string } };
        if (chunk.content?.type === "text" && typeof chunk.content.text === "string") {
          this.emit({
            type: "user_message",
            content: chunk.content.text,
            timestamp: Date.now(),
          });
        }
        break;
      }

      default:
        break;
    }
  }

  private handleToolCallStarted(toolCall: ToolCall & { sessionUpdate: string }): void {
    // Flush any pending text before the tool call
    this.flushStreamingText();

    const toolUseId = randomUUID();
    const title = toolCall.title || "Tool";
    const input = (toolCall.rawInput as Record<string, unknown>) || {};

    // Track for later (result association)
    this.toolCalls.set(toolCall.toolCallId, { toolUseId, title, input });

    // Emit assistant message with tool_use block
    this.emit({
      type: "assistant",
      message: {
        id: randomUUID(),
        type: "message",
        role: "assistant",
        model: this.currentModel,
        content: [{ type: "tool_use", id: toolUseId, name: title, input }],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: Date.now(),
    });
  }

  private handleToolCallUpdated(toolUpdate: ToolCallUpdate & { sessionUpdate: string }): void {
    const tracked = this.toolCalls.get(toolUpdate.toolCallId);

    if (toolUpdate.status === "in_progress") {
      if (tracked) {
        this.emit({
          type: "tool_progress",
          tool_use_id: tracked.toolUseId,
          tool_name: tracked.title,
          elapsed_time_seconds: 0,
        });
      }
      return;
    }

    if (toolUpdate.status === "completed" || toolUpdate.status === "failed") {
      if (!tracked) return;

      // Extract result text from content
      let resultText = "";
      const content = toolUpdate.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c.type === "content" && (c as { content?: { type: string; text?: string } }).content?.type === "text") {
            resultText += (c as { content: { text: string } }).content.text;
          } else if (c.type === "diff") {
            const d = c as { path?: string; oldText?: string; newText?: string };
            resultText += `File changed: ${d.path || "unknown"}\n`;
          }
        }
      }
      if (!resultText && toolUpdate.rawOutput) {
        resultText = typeof toolUpdate.rawOutput === "string"
          ? toolUpdate.rawOutput
          : JSON.stringify(toolUpdate.rawOutput);
      }

      const isError = toolUpdate.status === "failed";
      this.emit({
        type: "assistant",
        message: {
          id: randomUUID(),
          type: "message",
          role: "assistant",
          model: this.currentModel,
          content: [{
            type: "tool_result",
            tool_use_id: tracked.toolUseId,
            content: resultText || (isError ? "Tool failed" : "Done"),
            is_error: isError,
          }],
          stop_reason: null,
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        timestamp: Date.now(),
      });

      this.toolCalls.delete(toolUpdate.toolCallId);
    }
  }

  private async handleRequestPermission(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const requestId = randomUUID();
    const toolCallId = params.toolCall?.toolCallId || "";
    const tracked = this.toolCalls.get(toolCallId);

    // Build a PermissionRequest for the browser
    const permRequest = {
      request_id: requestId,
      tool_name: tracked?.title || params.toolCall?.title || "Tool",
      input: tracked?.input || (params.toolCall?.rawInput as Record<string, unknown>) || {},
      description: params.toolCall?.title ?? undefined,
      tool_use_id: tracked?.toolUseId || randomUUID(),
      timestamp: Date.now(),
    };

    this.emit({ type: "permission_request", request: permRequest });

    // Wait for the browser to respond
    return new Promise<RequestPermissionResponse>((resolve, reject) => {
      this.pendingPermissions.set(requestId, {
        resolve: (outcome) => resolve({ outcome }),
        reject,
        options: params.options || [],
      });
    });
  }

  // ── Browser message dispatch ──────────────────────────────────────────────

  private dispatchBrowserMessage(msg: BrowserOutgoingMessage): void {
    if (!this.connection || !this.acpSessionId) return;

    switch (msg.type) {
      case "user_message":
        this.handleUserMessage(msg.content, msg.images);
        break;

      case "interrupt":
        this.handleInterrupt();
        break;

      case "permission_response":
        this.handlePermissionResponse(msg.request_id, msg.behavior);
        break;

      case "set_model":
        this.handleSetModel(msg.model);
        break;

      case "set_permission_mode":
        this.handleSetPermissionMode(msg.mode);
        break;

      default:
        // Other messages (MCP control, etc.) are not supported by ACP
        break;
    }
  }

  private handleUserMessage(content: string, images?: Array<{ media_type: string; data: string }>): void {
    if (!this.connection || !this.acpSessionId) return;

    // Emit user_message to browser (for local history mirroring)
    this.emit({ type: "user_message", content, timestamp: Date.now() });

    // Build ACP prompt content blocks
    const prompt: ContentBlock[] = [{ type: "text", text: content }];
    if (images) {
      for (const img of images) {
        prompt.push({
          type: "image",
          mimeType: img.media_type,
          data: img.data,
        } as ContentBlock);
      }
    }

    const sessionId = this.acpSessionId;

    // Run the prompt turn asynchronously
    this.connection.prompt({ sessionId, prompt }).then((result) => {
      this.onTurnComplete(result.stopReason as string);
    }).catch((err: unknown) => {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes("cancelled") || errMsg.includes("cancel")) {
        this.onTurnComplete("cancelled");
      } else {
        console.error("[copilot-adapter] prompt error:", err);
        this.emit({ type: "error", message: `Copilot error: ${errMsg}` });
        this.onTurnComplete("error");
      }
    });
  }

  private onTurnComplete(stopReason: string): void {
    // Flush any remaining streamed thinking
    if (this.hasStreamingThinking && this.streamingThinking) {
      this.emit({
        type: "assistant",
        message: {
          id: randomUUID(),
          type: "message",
          role: "assistant",
          model: this.currentModel,
          content: [{ type: "thinking", thinking: this.streamingThinking }],
          stop_reason: null,
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        parent_tool_use_id: null,
        timestamp: Date.now(),
      });
    }
    this.streamingThinking = "";
    this.hasStreamingThinking = false;

    // Flush remaining streamed text as a final assistant message
    this.flushStreamingText(stopReason);

    // Emit result
    const resultMsg: CLIResultMessage = {
      type: "result",
      subtype: stopReason === "end_turn" ? "success" : "error_during_execution",
      is_error: stopReason !== "end_turn" && stopReason !== "cancelled",
      duration_ms: 0,
      duration_api_ms: 0,
      num_turns: 1,
      total_cost_usd: 0,
      stop_reason: stopReason,
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      uuid: randomUUID(),
      session_id: this.companionSessionId,
    };
    this.emit({ type: "result", data: resultMsg });

    this.cancelCurrentTurn = null;
    this.toolCalls.clear();
  }

  private flushStreamingText(stopReason = "end_turn"): void {
    if (!this.hasStreamingText) return;

    const text = this.streamingText;

    // Close the streaming content block
    this.emit({
      type: "stream_event",
      event: { type: "content_block_stop", index: 0 },
      parent_tool_use_id: null,
    });
    this.emit({
      type: "stream_event",
      event: {
        type: "message_delta",
        delta: { stop_reason: stopReason === "end_turn" ? "end_turn" : null },
        usage: { output_tokens: 0 },
      },
      parent_tool_use_id: null,
    });

    // Emit the complete assistant message
    this.emit({
      type: "assistant",
      message: {
        id: randomUUID(),
        type: "message",
        role: "assistant",
        model: this.currentModel,
        content: [{ type: "text", text }],
        stop_reason: "end_turn",
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
      parent_tool_use_id: null,
      timestamp: Date.now(),
    });

    this.streamingText = "";
    this.hasStreamingText = false;
  }

  private handleInterrupt(): void {
    if (!this.connection || !this.acpSessionId) return;
    this.connection.cancel({ sessionId: this.acpSessionId }).catch((err) => {
      console.warn("[copilot-adapter] cancel error:", err);
    });
  }

  private handlePermissionResponse(requestId: string, behavior: "allow" | "deny"): void {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return;

    this.pendingPermissions.delete(requestId);

    // Map allow/deny to the matching ACP permission option
    const targetKind = behavior === "allow" ? "allow_once" : "reject_once";
    const option = pending.options.find((o) => o.kind === targetKind)
      || pending.options.find((o) => (behavior === "allow" ? o.kind?.startsWith("allow") : o.kind?.startsWith("reject")))
      || pending.options[behavior === "allow" ? 0 : pending.options.length - 1];

    if (option) {
      pending.resolve({ outcome: "selected", optionId: option.optionId } as RequestPermissionOutcome);
    } else {
      pending.resolve({ outcome: "cancelled" } as RequestPermissionOutcome);
    }
  }

  private handleSetModel(modelId: string): void {
    if (!this.connection || !this.acpSessionId) return;
    this.currentModel = modelId;
    const conn = this.connection as ClientSideConnection & {
      unstable_setSessionModel?: (p: { sessionId: string; modelId: string }) => Promise<unknown>;
    };
    conn.unstable_setSessionModel?.({ sessionId: this.acpSessionId, modelId }).catch((err) => {
      console.warn("[copilot-adapter] set model error:", err);
    });
    this.emit({ type: "session_update", session: { model: modelId } });
  }

  private handleSetPermissionMode(mode: string): void {
    if (!this.connection || !this.acpSessionId) return;
    const modeId = companionModeToAcpMode(mode);
    this.connection.setSessionMode({ sessionId: this.acpSessionId, modeId }).then(() => {
      this.emit({ type: "session_update", session: { permissionMode: mode } });
    }).catch((err) => {
      console.warn("[copilot-adapter] set mode error:", err);
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private emit(msg: BrowserIncomingMessage): void {
    this.browserMessageCb?.(msg);
  }
}
