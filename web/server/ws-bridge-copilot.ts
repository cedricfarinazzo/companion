import type {
  BrowserIncomingMessage,
  BrowserOutgoingMessage,
  PermissionRequest,
} from "./session-types.js";
import type { CopilotAdapter } from "./copilot-adapter.js";
import type { Session } from "./ws-bridge-types.js";
import { validatePermission } from "./ai-validator.js";
import { getEffectiveAiValidation } from "./ai-validation-settings.js";

export interface CopilotAttachDeps {
  persistSession: (session: Session) => void;
  refreshGitInfo: (
    session: Session,
    options?: { broadcastUpdate?: boolean; notifyPoller?: boolean },
  ) => void;
  broadcastToBrowsers: (session: Session, msg: BrowserIncomingMessage) => void;
  onCLISessionId: ((sessionId: string, cliSessionId: string) => void) | null;
  onFirstTurnCompleted: ((sessionId: string, firstUserMessage: string) => void) | null;
  autoNamingAttempted: Set<string>;
}

export function attachCopilotAdapterHandlers(
  sessionId: string,
  session: Session,
  adapter: CopilotAdapter,
  deps: CopilotAttachDeps,
): void {
  adapter.onBrowserMessage((msg) => {
    if (msg.type === "session_init") {
      session.state = { ...session.state, ...msg.session, backend_type: "copilot" };
      deps.refreshGitInfo(session, { notifyPoller: true });
      deps.persistSession(session);
    } else if (msg.type === "session_update") {
      session.state = { ...session.state, ...msg.session, backend_type: "copilot" };
      deps.refreshGitInfo(session, { notifyPoller: true });
      deps.persistSession(session);
    }

    if (msg.type === "assistant") {
      session.messageHistory.push({ ...msg, timestamp: msg.timestamp || Date.now() });
      deps.persistSession(session);
    } else if (msg.type === "result") {
      session.messageHistory.push(msg);
      deps.persistSession(session);
    }

    if (msg.type === "permission_request") {
      const perm = msg.request;

      // AI Validation for Copilot sessions
      const aiSettings = getEffectiveAiValidation(session.state);
      if (aiSettings.enabled && aiSettings.anthropicApiKey) {
        handleCopilotAiValidation(session, adapter, perm, deps).catch((err) => {
          console.warn(
            `[ws-bridge-copilot] AI validation error for tool=${perm.tool_name} request_id=${perm.request_id} session=${session.id}, falling through to manual:`,
            err,
          );
          session.pendingPermissions.set(perm.request_id, perm);
          deps.persistSession(session);
          deps.broadcastToBrowsers(session, msg);
        });
        return;
      }

      session.pendingPermissions.set(perm.request_id, perm);
      deps.persistSession(session);
    }

    deps.broadcastToBrowsers(session, msg);

    if (
      msg.type === "result" &&
      !(msg.data as { is_error?: boolean }).is_error &&
      deps.onFirstTurnCompleted &&
      !deps.autoNamingAttempted.has(session.id)
    ) {
      deps.autoNamingAttempted.add(session.id);
      const firstUserMsg = session.messageHistory.find((m) => m.type === "user_message");
      if (firstUserMsg && firstUserMsg.type === "user_message") {
        deps.onFirstTurnCompleted(session.id, firstUserMsg.content);
      }
    }
  });

  adapter.onSessionMeta((meta) => {
    if (meta.cliSessionId && deps.onCLISessionId) {
      deps.onCLISessionId(session.id, meta.cliSessionId);
    }
    if (meta.model) session.state.model = meta.model;
    if (meta.cwd) session.state.cwd = meta.cwd;
    session.state.backend_type = "copilot";
    deps.refreshGitInfo(session, { broadcastUpdate: true, notifyPoller: true });
    deps.persistSession(session);
  });

  adapter.onDisconnect(() => {
    if (session.copilotAdapter !== adapter) {
      console.log(`[ws-bridge] Ignoring stale disconnect for session ${sessionId} (adapter replaced)`);
      return;
    }
    for (const [reqId] of session.pendingPermissions) {
      deps.broadcastToBrowsers(session, { type: "permission_cancelled", request_id: reqId });
    }
    session.pendingPermissions.clear();
    session.copilotAdapter = null;
    deps.persistSession(session);
    console.log(`[ws-bridge] Copilot adapter disconnected for session ${sessionId}`);
    deps.broadcastToBrowsers(session, { type: "cli_disconnected" });
  });

  if (session.pendingMessages.length > 0) {
    console.log(`[ws-bridge] Flushing ${session.pendingMessages.length} queued message(s) to Copilot adapter for session ${sessionId}`);
    const queued = session.pendingMessages.splice(0);
    for (const raw of queued) {
      try {
        const msg = JSON.parse(raw) as BrowserOutgoingMessage;
        adapter.sendBrowserMessage(msg);
      } catch {
        console.warn(`[ws-bridge] Failed to parse queued message for Copilot: ${raw.substring(0, 100)}`);
      }
    }
  }

  deps.broadcastToBrowsers(session, { type: "cli_connected" });
  console.log(`[ws-bridge] Copilot adapter attached for session ${sessionId}`);
}

async function handleCopilotAiValidation(
  session: Session,
  adapter: CopilotAdapter,
  perm: PermissionRequest,
  deps: CopilotAttachDeps,
): Promise<void> {
  const aiSettings = getEffectiveAiValidation(session.state);
  const result = await validatePermission(perm.tool_name, perm.input, perm.description);

  perm.ai_validation = {
    verdict: result.verdict,
    reason: result.reason,
    ruleBasedOnly: result.ruleBasedOnly,
  };

  if (result.verdict === "safe" && aiSettings.autoApprove) {
    deps.broadcastToBrowsers(session, {
      type: "permission_auto_resolved",
      request: perm,
      behavior: "allow",
      reason: result.reason,
    });
    adapter.sendBrowserMessage({ type: "permission_response", request_id: perm.request_id, behavior: "allow" });
    return;
  }

  if (result.verdict === "dangerous" && aiSettings.autoDeny) {
    deps.broadcastToBrowsers(session, {
      type: "permission_auto_resolved",
      request: perm,
      behavior: "deny",
      reason: result.reason,
    });
    adapter.sendBrowserMessage({ type: "permission_response", request_id: perm.request_id, behavior: "deny" });
    return;
  }

  session.pendingPermissions.set(perm.request_id, perm);
  deps.persistSession(session);
  deps.broadcastToBrowsers(session, { type: "permission_request", request: perm });
}
