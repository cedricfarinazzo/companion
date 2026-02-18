import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { useStore } from "../store.js";
import { api } from "../api.js";
import type { GitStatusFile } from "../api.js";
import { DiffViewer } from "./DiffViewer.js";

const STATUS_BADGE: Record<string, { label: string; className: string }> = {
  modified: { label: "M", className: "text-cc-warning" },
  added: { label: "A", className: "text-cc-success" },
  deleted: { label: "D", className: "text-cc-danger" },
  renamed: { label: "R", className: "text-cc-primary" },
  untracked: { label: "?", className: "text-cc-muted" },
};

export function DiffPanel({ sessionId }: { sessionId: string }) {
  const session = useStore((s) => s.sessions.get(sessionId));
  const sdkSession = useStore((s) => s.sdkSessions.find((sdk) => sdk.sessionId === sessionId));
  const selectedFile = useStore((s) => s.diffPanelSelectedFile.get(sessionId) ?? null);
  const setSelectedFile = useStore((s) => s.setDiffPanelSelectedFile);
  const changedFilesSet = useStore((s) => s.changedFiles.get(sessionId));

  const cwd = session?.cwd || sdkSession?.cwd;

  const [diffContent, setDiffContent] = useState<string>("");
  const [diffLoading, setDiffLoading] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth >= 640 : true,
  );
  const [gitStatusFiles, setGitStatusFiles] = useState<GitStatusFile[]>([]);
  const [isGitRepo, setIsGitRepo] = useState<boolean | null>(null);
  const [gitRepoRoot, setGitRepoRoot] = useState<string | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const changedFiles = useMemo(() => changedFilesSet ?? new Set<string>(), [changedFilesSet]);

  const relativeChangedFiles = useMemo(() => {
    if (!changedFiles.size || !cwd) return [];
    const cwdPrefix = `${cwd}/`;
    return [...changedFiles]
      .filter((fp) => fp === cwd || fp.startsWith(cwdPrefix))
      .map((fp) => ({ abs: fp, rel: fp.startsWith(cwd + "/") ? fp.slice(cwd.length + 1) : fp }))
      .sort((a, b) => a.rel.localeCompare(b.rel));
  }, [changedFiles, cwd]);

  // Build merged file list: git status is primary (when available), changedFiles as fallback/supplement
  const mergedFiles = useMemo(() => {
    const byRel = new Map<string, { abs: string; rel: string; status?: string }>();

    // Seed with tool-call-tracked changed files
    for (const { abs, rel } of relativeChangedFiles) {
      byRel.set(rel, { abs, rel });
    }

    // Augment/override with git status data (authoritative for status badges).
    // Paths from git status are relative to the repo root.
    const root = gitRepoRoot || cwd;
    if (root && gitStatusFiles.length > 0) {
      for (const gf of gitStatusFiles) {
        const abs = `${root}/${gf.path}`;
        const existing = byRel.get(gf.path);
        if (existing) {
          byRel.set(gf.path, { ...existing, status: gf.status });
        } else {
          byRel.set(gf.path, { abs, rel: gf.path, status: gf.status });
        }
      }
    }

    return [...byRel.values()].sort((a, b) => a.rel.localeCompare(b.rel));
  }, [relativeChangedFiles, gitStatusFiles, gitRepoRoot, cwd]);

  // Poll git status
  const fetchGitStatus = useCallback(() => {
    if (!cwd) return;
    setStatusLoading(true);
    api
      .getWorktreeDiff(cwd)
      .then((res) => {
        setIsGitRepo(res.isGitRepo);
        setGitRepoRoot(res.repoRoot ?? null);
        setGitStatusFiles(res.files);
        setStatusLoading(false);
      })
      .catch(() => {
        setStatusLoading(false);
      });
  }, [cwd]);

  useEffect(() => {
    if (!cwd) return;
    fetchGitStatus();
    refreshTimerRef.current = setInterval(fetchGitStatus, 5000);
    return () => {
      if (refreshTimerRef.current) clearInterval(refreshTimerRef.current);
    };
  }, [cwd, fetchGitStatus]);

  // Auto-select first changed file if none selected
  useEffect(() => {
    if (!selectedFile && mergedFiles.length > 0) {
      setSelectedFile(sessionId, mergedFiles[0].abs);
    }
  }, [selectedFile, mergedFiles, sessionId, setSelectedFile]);

  // If the selected file falls out of scope, clear or reselect.
  useEffect(() => {
    if (!selectedFile) return;
    if (mergedFiles.some((f) => f.abs === selectedFile)) return;
    setSelectedFile(sessionId, mergedFiles[0]?.abs ?? null);
  }, [selectedFile, mergedFiles, sessionId, setSelectedFile]);

  // Fetch diff when selected file changes
  useEffect(() => {
    if (!selectedFile) {
      setDiffContent("");
      return;
    }
    let cancelled = false;
    setDiffLoading(true);
    api
      .getFileDiff(selectedFile)
      .then((res) => {
        if (!cancelled) {
          setDiffContent(res.diff);
          setDiffLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDiffContent("");
          setDiffLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [selectedFile]);

  const handleFileSelect = useCallback(
    (path: string) => {
      setSelectedFile(sessionId, path);
      if (typeof window !== "undefined" && window.innerWidth < 640) {
        setSidebarOpen(false);
      }
    },
    [sessionId, setSelectedFile],
  );

  const selectedRelPath = useMemo(() => {
    if (!selectedFile) return selectedFile;
    // Try stripping cwd prefix first, then repo root prefix
    const base = cwd && selectedFile.startsWith(cwd + "/")
      ? selectedFile.slice(cwd.length + 1)
      : gitRepoRoot && selectedFile.startsWith(gitRepoRoot + "/")
        ? selectedFile.slice(gitRepoRoot.length + 1)
        : selectedFile;
    return base;
  }, [selectedFile, cwd, gitRepoRoot]);

  if (!cwd) {
    return (
      <div className="flex-1 flex items-center justify-center h-full">
        <p className="text-cc-muted text-sm">Waiting for session to initialize...</p>
      </div>
    );
  }

  if (isGitRepo === false) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-4 select-none px-6">
        <div className="w-14 h-14 rounded-2xl bg-cc-card border border-cc-border flex items-center justify-center">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-7 h-7 text-cc-muted">
            <circle cx="12" cy="12" r="3" />
            <path d="M3 12a9 9 0 1018 0A9 9 0 003 12z" />
          </svg>
        </div>
        <div className="text-center">
          <p className="text-sm text-cc-fg font-medium mb-1">Not a git repository</p>
          <p className="text-xs text-cc-muted leading-relaxed">{cwd}</p>
        </div>
      </div>
    );
  }

  if (mergedFiles.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-4 select-none px-6">
        <div className="w-14 h-14 rounded-2xl bg-cc-card border border-cc-border flex items-center justify-center">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-7 h-7 text-cc-muted">
            <path d="M12 3v18M3 12h18" strokeLinecap="round" />
          </svg>
        </div>
        <div className="text-center">
          <p className="text-sm text-cc-fg font-medium mb-1">No changes yet</p>
          <p className="text-xs text-cc-muted leading-relaxed">
            File changes from Edit and Write tool calls will appear here.
          </p>
        </div>
        <button
          onClick={fetchGitStatus}
          disabled={statusLoading}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer disabled:opacity-50"
        >
          <svg viewBox="0 0 16 16" fill="currentColor" className={`w-3.5 h-3.5 ${statusLoading ? "animate-spin" : ""}`}>
            <path fillRule="evenodd" d="M8 3a5 5 0 104.546 2.914.5.5 0 01.908-.417A6 6 0 118 2v1z" clipRule="evenodd" />
            <path d="M8 4.466V.534a.25.25 0 01.41-.192l2.36 1.966c.12.1.12.284 0 .384L8.41 4.658A.25.25 0 018 4.466z" />
          </svg>
          Refresh
        </button>
      </div>
    );
  }

  return (
    <div className="h-full flex bg-cc-bg relative">
      {/* Mobile backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/30 z-20 sm:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Changed files sidebar */}
      <div
        className={`
          ${sidebarOpen ? "w-[220px] translate-x-0" : "w-0 -translate-x-full"}
          fixed sm:relative z-30 sm:z-auto
          ${sidebarOpen ? "sm:w-[220px]" : "sm:w-0 sm:-translate-x-full"}
          shrink-0 h-full flex flex-col bg-cc-sidebar border-r border-cc-border transition-all duration-200 overflow-hidden
        `}
      >
        <div className="w-[220px] px-4 py-3 text-[11px] font-semibold text-cc-fg uppercase tracking-wider border-b border-cc-border shrink-0 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-cc-warning" />
            <span>Changed ({mergedFiles.length})</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={fetchGitStatus}
              disabled={statusLoading}
              className="w-5 h-5 flex items-center justify-center rounded-md text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer disabled:opacity-50"
              title="Refresh git status"
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className={`w-3 h-3 ${statusLoading ? "animate-spin" : ""}`}>
                <path fillRule="evenodd" d="M8 3a5 5 0 104.546 2.914.5.5 0 01.908-.417A6 6 0 118 2v1z" clipRule="evenodd" />
                <path d="M8 4.466V.534a.25.25 0 01.41-.192l2.36 1.966c.12.1.12.284 0 .384L8.41 4.658A.25.25 0 018 4.466z" />
              </svg>
            </button>
            <button
              onClick={() => setSidebarOpen(false)}
              className="w-5 h-5 flex items-center justify-center rounded-md text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer sm:hidden"
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" className="w-3 h-3">
                <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto overflow-x-hidden py-1">
          {mergedFiles.map(({ abs, rel, status }) => {
            const badge = status ? STATUS_BADGE[status] : null;
            return (
              <button
                key={abs}
                onClick={() => handleFileSelect(abs)}
                className={`flex items-center gap-2 w-full mx-1 px-2 py-1.5 text-[13px] rounded-[10px] hover:bg-cc-hover transition-colors cursor-pointer whitespace-nowrap ${
                  abs === selectedFile ? "bg-cc-active text-cc-fg" : "text-cc-fg/70"
                }`}
                style={{ width: "calc(100% - 8px)" }}
              >
                {badge ? (
                  <span className={`text-[11px] font-bold w-3.5 text-center shrink-0 ${badge.className}`}>
                    {badge.label}
                  </span>
                ) : (
                  <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5 text-cc-warning shrink-0">
                    <path
                      fillRule="evenodd"
                      d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z"
                      clipRule="evenodd"
                    />
                  </svg>
                )}
                <span className="truncate leading-snug">{rel}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Diff area */}
      <div className="flex-1 min-w-0 h-full flex flex-col">
        {/* Top bar */}
        {selectedFile && (
          <div className="shrink-0 flex items-center gap-2 sm:gap-2.5 px-2 sm:px-4 py-2.5 bg-cc-card border-b border-cc-border">
            {!sidebarOpen && (
              <button
                onClick={() => setSidebarOpen(true)}
                className="flex items-center justify-center w-6 h-6 rounded-md text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer shrink-0"
                title="Show file list"
              >
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                  <path d="M1 3.5A1.5 1.5 0 012.5 2h3.379a1.5 1.5 0 011.06.44l.622.621a.5.5 0 00.353.146H13.5A1.5 1.5 0 0115 4.707V12.5a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 12.5v-9z" />
                </svg>
              </button>
            )}
            <div className="flex-1 min-w-0">
              <span className="text-cc-fg text-[13px] font-medium truncate block">
                {selectedRelPath?.split("/").pop()}
              </span>
              <span className="text-cc-muted truncate text-[11px] hidden sm:block font-mono-code">
                {selectedRelPath}
              </span>
            </div>
            <span className="text-cc-muted text-[11px] shrink-0 hidden sm:inline">
              Compared to default branch
            </span>
          </div>
        )}

        {/* Diff content */}
        <div className="flex-1 overflow-auto">
          {diffLoading ? (
            <div className="h-full flex items-center justify-center">
              <div className="w-5 h-5 border-2 border-cc-primary border-t-transparent rounded-full animate-spin" />
            </div>
          ) : selectedFile ? (
            <div className="p-4">
              <DiffViewer unifiedDiff={diffContent} fileName={selectedRelPath || undefined} mode="full" />
            </div>
          ) : (
            <div className="h-full flex flex-col items-center justify-center">
              {!sidebarOpen && (
                <button
                  onClick={() => setSidebarOpen(true)}
                  className="mb-4 flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
                >
                  <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
                    <path d="M1 3.5A1.5 1.5 0 012.5 2h3.379a1.5 1.5 0 011.06.44l.622.621a.5.5 0 00.353.146H13.5A1.5 1.5 0 0115 4.707V12.5a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 12.5v-9z" />
                  </svg>
                  Show file list
                </button>
              )}
              <p className="text-cc-muted text-sm">Select a file to view changes</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
