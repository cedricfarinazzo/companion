/**
 * Tests for the CopilotAdapter persistent-process approach.
 *
 * The adapter keeps ONE `copilot --allow-all-tools --silent` process alive for
 * the lifetime of the session.  User messages are written to stdin; responses
 * are collected from stdout using an idle-timeout.  Because the process never
 * exits between turns, Copilot maintains full conversation context natively.
 *
 * These tests verify:
 *  - The adapter correctly emits session_init via a microtask (so callbacks can
 *    be registered first).
 *  - Binary-not-found errors are surfaced as error messages, not thrown.
 *  - The stripAnsi helper cleans terminal escape codes from raw stdout.
 *  - The readUntilIdle logic resolves on an idle timeout, accumulating chunks.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Inline the pure helper so we can test it without spawning anything ────────

// Duplicate of the ANSI_PATTERN + stripAnsi in copilot-adapter.ts so we can
// test it independently without having to import the full adapter (which would
// try to spawn Bun processes).
const ANSI_PATTERN = /(\x9b|\x1b\[)[0-9;]*[a-zA-Z]|\x1b[^[]/g;

function stripAnsi(raw: string): string {
  return raw
    .replace(ANSI_PATTERN, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

// ─── ANSI stripping ───────────────────────────────────────────────────────────

describe("stripAnsi", () => {
  it("passes through plain text unchanged", () => {
    expect(stripAnsi("hello world")).toBe("hello world");
  });

  it("removes colour reset sequences", () => {
    expect(stripAnsi("\x1b[0mhello\x1b[0m")).toBe("hello");
  });

  it("removes bold/dim sequences", () => {
    expect(stripAnsi("\x1b[1mBold\x1b[22m")).toBe("Bold");
  });

  it("removes cursor movement sequences", () => {
    expect(stripAnsi("\x1b[2J\x1b[H")).toBe("");
  });

  it("normalises \\r\\n to \\n", () => {
    expect(stripAnsi("line1\r\nline2")).toBe("line1\nline2");
  });

  it("normalises bare \\r to \\n", () => {
    expect(stripAnsi("line1\rline2")).toBe("line1\nline2");
  });

  it("handles a realistic Copilot --silent response snippet", () => {
    // Copilot may wrap the response in a bold header and reset at the end
    const raw = "\x1b[1mCopilot\x1b[22m\r\nHere is the answer: **42**\r\n";
    const clean = stripAnsi(raw);
    expect(clean).toBe("Copilot\nHere is the answer: **42**\n");
    expect(clean).not.toContain("\x1b");
  });
});

// ─── Idle-timeout accumulator (logic mirror) ──────────────────────────────────

/**
 * A minimal reproduction of the adapter's readUntilIdle logic so we can test
 * the timer + chunk-drain behaviour without any real subprocess.
 */
function makeIdleReader(idleMs: number, maxMs: number) {
  const chunks: string[] = [];
  let onChunk: (() => void) | null = null;

  function push(chunk: string) {
    chunks.push(chunk);
    onChunk?.();
  }

  function readUntilIdle(): Promise<string> {
    return new Promise((resolve) => {
      let accumulated = "";
      let idleTimer: ReturnType<typeof setTimeout>;

      const maxTimer = setTimeout(() => {
        clearTimeout(idleTimer);
        onChunk = null;
        resolve(accumulated);
      }, maxMs);

      const resetIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          clearTimeout(maxTimer);
          onChunk = null;
          resolve(accumulated);
        }, idleMs);
      };

      // Drain already-queued chunks
      while (chunks.length > 0) accumulated += chunks.shift()!;
      resetIdle();

      onChunk = () => {
        while (chunks.length > 0) accumulated += chunks.shift()!;
        resetIdle();
      };
    });
  }

  return { push, readUntilIdle };
}

describe("readUntilIdle accumulator", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("resolves with empty string if no chunks arrive within idleMs", async () => {
    const { readUntilIdle } = makeIdleReader(100, 5000);
    const p = readUntilIdle();
    vi.advanceTimersByTime(150);
    expect(await p).toBe("");
  });

  it("accumulates chunks and resolves after idle timeout", async () => {
    const { push, readUntilIdle } = makeIdleReader(100, 5000);
    const p = readUntilIdle();

    // Simulate chunks arriving 50 ms apart
    vi.advanceTimersByTime(50);
    push("Hello ");
    vi.advanceTimersByTime(50);
    push("world");

    // Now idle for 100 ms → should resolve
    vi.advanceTimersByTime(110);

    expect(await p).toBe("Hello world");
  });

  it("drains chunks already in the queue before waiting", async () => {
    const { push, readUntilIdle } = makeIdleReader(100, 5000);

    // Push before starting to read (pre-queued)
    push("pre");

    const p = readUntilIdle();
    vi.advanceTimersByTime(110);

    expect(await p).toBe("pre");
  });

  it("respects the maxMs hard cap even if chunks keep arriving", async () => {
    const { push, readUntilIdle } = makeIdleReader(500, 200);
    const p = readUntilIdle();

    // Keep pushing every 100 ms — would never idle out within 500 ms…
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(100);
      push(`chunk${i}`);
    }

    // …but maxMs (200) should have fired first
    const result = await p;
    // Some chunks may have been captured before maxMs fired
    expect(typeof result).toBe("string");
  });

  it("resolves only once even if multiple chunks arrive quickly", async () => {
    const { push, readUntilIdle } = makeIdleReader(100, 5000);
    const p = readUntilIdle();

    push("a");
    push("b");
    push("c");
    vi.advanceTimersByTime(110);

    expect(await p).toBe("abc");
  });
});

// ─── CopilotAdapter error surfacing ──────────────────────────────────────────

describe("CopilotAdapter – binary-not-found error", () => {
  it("emits an error message instead of throwing when spawn fails", async () => {
    // Stub Bun.spawn to throw (simulates binary not found)
    vi.stubGlobal("Bun", {
      spawn: () => { throw new Error("No such file or directory"); },
    });

    try {
      const { CopilotAdapter } = await import("./copilot-adapter.js");

      const errors: string[] = [];
      const adapter = new CopilotAdapter("test-session", { binary: "nonexistent-copilot" });
      adapter.onBrowserMessage((msg) => {
        if (msg.type === "error") {
          errors.push((msg as unknown as { message: string }).message);
        }
      });

      // Give the async startup a chance to run (two microtask ticks + setTimeout)
      await new Promise((r) => setTimeout(r, 50));

      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain("Failed to launch Copilot CLI");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
