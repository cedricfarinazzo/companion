/**
 * Discover available models from the GitHub Copilot CLI via ACP.
 *
 * Spawns `copilot --acp --stdio` briefly, performs the ACP handshake, extracts
 * the model list from the `session/new` response (a Copilot-specific extension),
 * then kills the process.
 */

import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
} from "@agentclientprotocol/sdk";
import { resolveBinary } from "./path-resolver.js";

export interface CopilotModelInfo {
  modelId: string;
  name: string;
  description?: string;
}

/** Cached result so repeated calls don't re-spawn. */
let modelCache: CopilotModelInfo[] | null = null;
let cacheTs = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Discover available Copilot models via ACP `session/new`.
 * Returns cached results if called within TTL.
 * Throws if `copilot` binary is not found or the ACP handshake fails.
 */
export async function discoverCopilotModels(): Promise<CopilotModelInfo[]> {
  if (modelCache && Date.now() - cacheTs < CACHE_TTL_MS) {
    return modelCache;
  }

  const binary = resolveBinary("copilot");
  if (!binary) {
    throw new Error("copilot binary not found in PATH");
  }

  const proc = Bun.spawn([binary, "--acp", "--stdio"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });

  const killProc = () => {
    try { proc.kill("SIGTERM"); } catch {}
  };

  try {
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        (proc.stdin as { write(data: Uint8Array): number }).write(chunk);
      },
    });

    const stream = ndJsonStream(writable, proc.stdout as ReadableStream<Uint8Array>);

    // Minimal no-op client — we only need initialize + session/new
    const client: Client = {
      async sessionUpdate() {},
      async requestPermission() { return { outcome: { outcome: "cancelled" } as never }; },
      async readTextFile() { throw new Error("not supported"); },
      async writeTextFile() { throw new Error("not supported"); },
    };

    const connection = new ClientSideConnection((_agent) => client, stream);

    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), 10_000),
    );

    const models = await Promise.race([
      (async () => {
        await connection.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
          clientInfo: { name: "the-companion-model-discovery", version: "1.0.0" },
        });

        const result = await connection.newSession({ cwd: process.cwd(), mcpServers: [] }) as {
          sessionId: string;
          models?: {
            availableModels?: Array<{ modelId: string; name: string; description?: string }>;
            currentModelId?: string;
          };
        };

        return result.models?.availableModels ?? [];
      })(),
      timeout,
    ]);

    killProc();

    modelCache = models;
    cacheTs = Date.now();
    return models;
  } catch (err) {
    killProc();
    throw err;
  }
}
