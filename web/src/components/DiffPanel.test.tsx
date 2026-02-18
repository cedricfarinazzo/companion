// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockApi = {
  getFileDiff: vi.fn().mockResolvedValue({ path: "/repo/file.ts", diff: "" }),
  getWorktreeDiff: vi.fn().mockResolvedValue({ isGitRepo: true, files: [] }),
};

vi.mock("../api.js", () => ({
  api: {
    getFileDiff: (...args: unknown[]) => mockApi.getFileDiff(...args),
    getWorktreeDiff: (...args: unknown[]) => mockApi.getWorktreeDiff(...args),
  },
}));

// ─── Store mock ─────────────────────────────────────────────────────────────

interface MockStoreState {
  sessions: Map<string, { cwd?: string }>;
  sdkSessions: { sessionId: string; cwd?: string }[];
  diffPanelSelectedFile: Map<string, string>;
  changedFiles: Map<string, Set<string>>;
  setDiffPanelSelectedFile: ReturnType<typeof vi.fn>;
}

let storeState: MockStoreState;

function resetStore(overrides: Partial<MockStoreState> = {}) {
  storeState = {
    sessions: new Map([["s1", { cwd: "/repo" }]]),
    sdkSessions: [],
    diffPanelSelectedFile: new Map(),
    changedFiles: new Map(),
    setDiffPanelSelectedFile: vi.fn(),
    ...overrides,
  };
}

vi.mock("../store.js", () => ({
  useStore: (selector: (s: MockStoreState) => unknown) => selector(storeState),
}));

import { DiffPanel } from "./DiffPanel.js";

// ─── Tests ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
});

describe("DiffPanel", () => {
  it("shows empty state when no files changed", () => {
    const { container } = render(<DiffPanel sessionId="s1" />);
    expect(screen.getByText("No changes yet")).toBeInTheDocument();
  });

  it("displays changed files in sidebar", () => {
    resetStore({
      changedFiles: new Map([["s1", new Set(["/repo/src/app.ts", "/repo/src/utils.ts"])]]),
    });

    const { container } = render(<DiffPanel sessionId="s1" />);
    expect(screen.getByText("Changed (2)")).toBeInTheDocument();
    expect(screen.getByText("src/app.ts")).toBeInTheDocument();
    expect(screen.getByText("src/utils.ts")).toBeInTheDocument();
  });

  it("hides changed files outside the session cwd", () => {
    resetStore({
      changedFiles: new Map([
        ["s1", new Set(["/repo/src/app.ts", "/Users/stan/.claude/plans/plan.md"])],
      ]),
    });

    const { container } = render(<DiffPanel sessionId="s1" />);
    expect(screen.getByText("Changed (1)")).toBeInTheDocument();
    expect(screen.getByText("src/app.ts")).toBeInTheDocument();
    expect(screen.queryByText("/Users/stan/.claude/plans/plan.md")).not.toBeInTheDocument();
  });

  it("fetches diff when a file is selected", async () => {
    // Validates that file diffs are fetched and rendered, including the baseline context label in the header.
    const diffOutput = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,3 @@
 line1
-old line
+new line
 line3`;

    mockApi.getFileDiff.mockResolvedValueOnce({ path: "/repo/src/app.ts", diff: diffOutput });

    resetStore({
      changedFiles: new Map([["s1", new Set(["/repo/src/app.ts"])]]),
      diffPanelSelectedFile: new Map([["s1", "/repo/src/app.ts"]]),
    });

    const { container } = render(<DiffPanel sessionId="s1" />);

    await waitFor(() => {
      expect(mockApi.getFileDiff).toHaveBeenCalledWith("/repo/src/app.ts");
    });

    // DiffViewer should render the diff content (may appear in top bar + DiffViewer header)
    await waitFor(() => {
      expect(container.querySelector(".diff-line-add")).toBeTruthy();
    });
    expect(screen.getByText("Compared to default branch")).toBeInTheDocument();
  });

  it("shows 'No changes' when diff is empty for selected file", async () => {
    mockApi.getFileDiff.mockResolvedValueOnce({ path: "/repo/file.ts", diff: "" });

    resetStore({
      changedFiles: new Map([["s1", new Set(["/repo/file.ts"])]]),
      diffPanelSelectedFile: new Map([["s1", "/repo/file.ts"]]),
    });

    render(<DiffPanel sessionId="s1" />);

    await waitFor(() => {
      expect(screen.getByText("No changes")).toBeInTheDocument();
    });
  });

  it("shows waiting message when session has no cwd", () => {
    resetStore({
      sessions: new Map([["s1", {}]]),
    });

    render(<DiffPanel sessionId="s1" />);
    expect(screen.getByText("Waiting for session to initialize...")).toBeInTheDocument();
  });

  it("reselects when selected file is outside cwd scope", async () => {
    resetStore({
      changedFiles: new Map([["s1", new Set(["/repo/src/inside.ts"])]]),
      diffPanelSelectedFile: new Map([["s1", "/Users/stan/.claude/plans/plan.md"]]),
    });

    render(<DiffPanel sessionId="s1" />);
    await waitFor(() => {
      expect(storeState.setDiffPanelSelectedFile).toHaveBeenCalledWith("s1", "/repo/src/inside.ts");
    });
  });

  it("shows 'Not a git repository' message when workdir is not a git repo", async () => {
    // Validates that DiffPanel shows an informative error when the session cwd is not inside a git repo.
    mockApi.getWorktreeDiff.mockResolvedValueOnce({ isGitRepo: false, files: [] });

    render(<DiffPanel sessionId="s1" />);

    await waitFor(() => {
      expect(screen.getByText("Not a git repository")).toBeInTheDocument();
    });
  });

  it("shows git status badges (M/A/D/?) from getWorktreeDiff when available", async () => {
    // Validates that the DiffPanel shows status badges from git status --porcelain alongside the file list.
    mockApi.getWorktreeDiff.mockResolvedValue({
      isGitRepo: true,
      files: [
        { path: "src/app.ts", status: "modified", staged: false },
        { path: "src/new.ts", status: "added", staged: true },
        { path: "src/old.ts", status: "deleted", staged: false },
        { path: "src/untracked.ts", status: "untracked", staged: false },
      ],
    });

    render(<DiffPanel sessionId="s1" />);

    await waitFor(() => {
      // Status badges: M=modified, A=added, D=deleted, ?=untracked
      expect(screen.getByText("M")).toBeInTheDocument();
      expect(screen.getByText("A")).toBeInTheDocument();
      expect(screen.getByText("D")).toBeInTheDocument();
      expect(screen.getByText("?")).toBeInTheDocument();
      // File names should be visible
      expect(screen.getByText("src/app.ts")).toBeInTheDocument();
      expect(screen.getByText("src/new.ts")).toBeInTheDocument();
    });
  });

  it("merges git status files with tool-call-tracked changed files", async () => {
    // Validates that files from both changedFiles (tool calls) and git status are shown in the list,
    // and that git status status info is applied to overlapping entries.
    mockApi.getWorktreeDiff.mockResolvedValue({
      isGitRepo: true,
      files: [
        { path: "src/app.ts", status: "modified", staged: false },
        // git-only file (not in changedFiles)
        { path: "src/git-only.ts", status: "added", staged: true },
      ],
    });

    resetStore({
      changedFiles: new Map([["s1", new Set(["/repo/src/app.ts", "/repo/src/tool-only.ts"])]]),
    });

    render(<DiffPanel sessionId="s1" />);

    await waitFor(() => {
      // All three files should appear
      expect(screen.getByText("src/app.ts")).toBeInTheDocument();
      expect(screen.getByText("src/git-only.ts")).toBeInTheDocument();
      expect(screen.getByText("src/tool-only.ts")).toBeInTheDocument();
      // Changed (3) in sidebar header
      expect(screen.getByText("Changed (3)")).toBeInTheDocument();
    });
  });

  it("shows refresh button in empty state and calls getWorktreeDiff on click", async () => {
    // Validates that the empty state shows a Refresh button that triggers a git status re-fetch.
    mockApi.getWorktreeDiff.mockResolvedValue({ isGitRepo: true, files: [] });

    render(<DiffPanel sessionId="s1" />);

    await waitFor(() => {
      expect(screen.getByText("No changes yet")).toBeInTheDocument();
    });

    const refreshBtn = screen.getByRole("button", { name: /refresh/i });
    expect(refreshBtn).toBeInTheDocument();

    mockApi.getWorktreeDiff.mockClear();
    fireEvent.click(refreshBtn);

    await waitFor(() => {
      expect(mockApi.getWorktreeDiff).toHaveBeenCalledWith("/repo");
    });
  });
});
