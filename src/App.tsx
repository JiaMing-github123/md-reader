import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { AlertCircle, FileDown, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EmptyState } from "./components/EmptyState";
import { MarkdownView } from "./components/MarkdownView";
import { SearchBar } from "./components/SearchBar";
import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { useDocumentSearch } from "./hooks/useDocumentSearch";
import { extractTableOfContents, isMarkdownPath } from "./lib/markdown";
import { addRecentFile, loadSettings, saveSettings } from "./lib/settings";
import type {
  MarkdownDocument,
  ReaderSettings,
  ResolvedTheme,
  ThemeMode,
} from "./types";

const FONT_SIZE_MIN = 14;
const FONT_SIZE_MAX = 24;
const themeOrder: ThemeMode[] = ["system", "light", "dark"];

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "Something went wrong while opening the file.";
}

export default function App() {
  const [settings, setSettings] = useState<ReaderSettings>(loadSettings);
  const [documentFile, setDocumentFile] = useState<MarkdownDocument | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [systemDark, setSystemDark] = useState(() =>
    window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  const [activeHeading, setActiveHeading] = useState("");
  const articleRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLElement>(null);
  const openRequestId = useRef(0);

  const resolvedTheme: ResolvedTheme =
    settings.theme === "system" ? (systemDark ? "dark" : "light") : settings.theme;

  const tableOfContents = useMemo(
    () => extractTableOfContents(documentFile?.content ?? ""),
    [documentFile?.content],
  );

  const search = useDocumentSearch(
    articleRef,
    scrollRef,
    searchOpen ? searchQuery : "",
    documentFile?.path ?? "",
  );

  const updateSettings = useCallback(
    (update: (current: ReaderSettings) => ReaderSettings) => {
      setSettings((current) => update(current));
    },
    [],
  );

  const openDocument = useCallback(
    async (path: string) => {
      if (!isMarkdownPath(path)) {
        setError("Only .md and .markdown files can be opened.");
        return;
      }

      const requestId = ++openRequestId.current;
      setLoading(true);
      setError("");

      try {
        const opened = await invoke<MarkdownDocument>("read_markdown_file", { path });
        if (requestId !== openRequestId.current) return;
        setDocumentFile(opened);
        setSearchOpen(false);
        setSearchQuery("");
        scrollRef.current?.scrollTo({ top: 0 });
        updateSettings((current) => ({
          ...current,
          recentFiles: addRecentFile(current.recentFiles, {
            path: opened.path,
            name: opened.name,
          }),
        }));
      } catch (openError) {
        if (requestId === openRequestId.current) setError(errorMessage(openError));
      } finally {
        if (requestId === openRequestId.current) setLoading(false);
      }
    },
    [updateSettings],
  );

  const chooseFile = useCallback(async () => {
    try {
      const selected = await openFileDialog({
        multiple: false,
        directory: false,
        title: "Open Markdown File",
        filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
      });
      if (typeof selected === "string") await openDocument(selected);
    } catch (dialogError) {
      setError(errorMessage(dialogError));
    }
  }, [openDocument]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery("");
  }, []);

  const changeFontSize = useCallback(
    (change: number | "reset") => {
      updateSettings((current) => ({
        ...current,
        fontSize:
          change === "reset"
            ? 17
            : Math.min(Math.max(current.fontSize + change, FONT_SIZE_MIN), FONT_SIZE_MAX),
      }));
    },
    [updateSettings],
  );

  const cycleTheme = useCallback(() => {
    updateSettings((current) => {
      const index = themeOrder.indexOf(current.theme);
      return { ...current, theme: themeOrder[(index + 1) % themeOrder.length] };
    });
  }, [updateSettings]);

  useEffect(() => saveSettings(settings), [settings]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.style.colorScheme = resolvedTheme;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", resolvedTheme === "dark" ? "#18191b" : "#f7f7f8");
  }, [resolvedTheme]);

  useEffect(() => {
    document.title = documentFile ? `${documentFile.name} — MD Reader` : "MD Reader";
  }, [documentFile]);

  useEffect(() => {
    let cancelled = false;
    let unlistenRequested: (() => void) | undefined;

    const connect = async () => {
      try {
        unlistenRequested = await listen<string>("open-file-requested", (event) => {
          void openDocument(event.payload);
        });
        const startupFile = await invoke<string | null>("get_startup_file");
        if (!cancelled && startupFile) await openDocument(startupFile);
      } catch {
        // Vite's browser-only preview has no desktop bridge.
      }
    };

    void connect();
    return () => {
      cancelled = true;
      unlistenRequested?.();
    };
  }, [openDocument]);

  useEffect(() => {
    let unlistenDragDrop: (() => void) | undefined;
    let cancelled = false;

    const connect = async () => {
      try {
        unlistenDragDrop = await getCurrentWebview().onDragDropEvent((event) => {
          if (event.payload.type === "enter") setDragActive(true);
          if (event.payload.type === "leave") setDragActive(false);
          if (event.payload.type === "drop") {
            setDragActive(false);
            const markdownFile = event.payload.paths.find(isMarkdownPath);
            if (markdownFile) void openDocument(markdownFile);
            else setError("Drop a .md or .markdown file to open it.");
          }
        });
        if (cancelled) unlistenDragDrop();
      } catch {
        // Drag and drop is available in the Tauri window, not a plain browser tab.
      }
    };

    void connect();
    return () => {
      cancelled = true;
      unlistenDragDrop?.();
    };
  }, [openDocument]);

  useEffect(() => {
    let cancelled = false;
    let unlistenResize: (() => void) | undefined;
    let resizeTimer: number | undefined;

    const connect = async () => {
      try {
        const appWindow = getCurrentWindow();
        await appWindow.setSize(
          new LogicalSize(settings.windowSize.width, settings.windowSize.height),
        );
        unlistenResize = await appWindow.onResized(({ payload }) => {
          window.clearTimeout(resizeTimer);
          resizeTimer = window.setTimeout(async () => {
            try {
              const scale = await appWindow.scaleFactor();
              const width = Math.round(payload.width / scale);
              const height = Math.round(payload.height / scale);
              if (!cancelled && width >= 720 && height >= 480) {
                updateSettings((current) => ({
                  ...current,
                  windowSize: { width, height },
                }));
              }
            } catch {
              // Ignore size persistence failures without affecting reading.
            }
          }, 250);
        });
      } catch {
        // Window sizing is only available inside Tauri.
      }
    };

    void connect();
    return () => {
      cancelled = true;
      window.clearTimeout(resizeTimer);
      unlistenResize?.();
    };
    // The saved size should only be restored once when the app starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [updateSettings]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey) {
        if (event.key === "Escape" && searchOpen) closeSearch();
        return;
      }

      const key = event.key.toLocaleLowerCase();
      if (key === "o") {
        event.preventDefault();
        void chooseFile();
      } else if (key === "f") {
        event.preventDefault();
        if (documentFile) setSearchOpen(true);
      } else if (key === "+" || key === "=") {
        event.preventDefault();
        changeFontSize(1);
      } else if (key === "-") {
        event.preventDefault();
        changeFontSize(-1);
      } else if (key === "0") {
        event.preventDefault();
        changeFontSize("reset");
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [changeFontSize, chooseFile, closeSearch, documentFile, searchOpen]);

  useEffect(() => {
    const scrollContainer = scrollRef.current;
    if (!scrollContainer || tableOfContents.length === 0) {
      setActiveHeading("");
      return;
    }

    let frame = 0;
    const updateActiveHeading = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const containerTop = scrollContainer.getBoundingClientRect().top;
        let active = tableOfContents[0]?.id ?? "";
        for (const heading of tableOfContents) {
          const element = document.getElementById(heading.id);
          if (element && element.getBoundingClientRect().top <= containerTop + 110) {
            active = heading.id;
          } else {
            break;
          }
        }
        setActiveHeading(active);
      });
    };

    updateActiveHeading();
    scrollContainer.addEventListener("scroll", updateActiveHeading, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      scrollContainer.removeEventListener("scroll", updateActiveHeading);
    };
  }, [documentFile?.path, tableOfContents]);

  const navigateToHeading = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="app-shell">
      <TopBar
        filename={documentFile?.name}
        filePath={documentFile?.path}
        theme={settings.theme}
        canSearch={Boolean(documentFile)}
        onOpen={chooseFile}
        onSearch={() => setSearchOpen(true)}
        onCycleTheme={cycleTheme}
      />

      <div className="workspace">
        {documentFile && (
          <Sidebar
            items={tableOfContents}
            width={settings.sidebarWidth}
            collapsed={settings.sidebarCollapsed}
            activeId={activeHeading}
            onToggle={() =>
              updateSettings((current) => ({
                ...current,
                sidebarCollapsed: !current.sidebarCollapsed,
              }))
            }
            onWidthChange={(sidebarWidth) =>
              updateSettings((current) => ({ ...current, sidebarWidth }))
            }
            onNavigate={navigateToHeading}
          />
        )}

        <main
          ref={scrollRef}
          className="reader-scroll"
          style={{ "--reader-font-size": `${settings.fontSize}px` } as React.CSSProperties}
        >
          {searchOpen && documentFile && (
            <SearchBar
              query={searchQuery}
              currentMatch={search.currentMatch}
              matchCount={search.matchCount}
              onQueryChange={setSearchQuery}
              onNext={search.next}
              onPrevious={search.previous}
              onClose={closeSearch}
            />
          )}

          {error && (
            <div className="error-banner" role="alert">
              <AlertCircle size={17} />
              <span>{error}</span>
              <button type="button" onClick={() => setError("")} aria-label="Dismiss error">
                <X size={16} />
              </button>
            </div>
          )}

          {documentFile ? (
            <MarkdownView
              content={documentFile.content}
              documentPath={documentFile.path}
              theme={resolvedTheme}
              articleRef={articleRef}
              onOpenMarkdown={openDocument}
            />
          ) : (
            <EmptyState
              recentFiles={settings.recentFiles}
              onOpen={chooseFile}
              onSelectRecent={openDocument}
            />
          )}
        </main>
      </div>

      {loading && (
        <div className="loading-indicator" role="status">
          <span />
          Opening document…
        </div>
      )}

      {dragActive && (
        <div className="drop-overlay">
          <div>
            <FileDown size={34} />
            <strong>Drop to open Markdown</strong>
            <span>.md and .markdown files</span>
          </div>
        </div>
      )}
    </div>
  );
}

