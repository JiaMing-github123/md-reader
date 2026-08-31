import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { open as openPathDialog } from "@tauri-apps/plugin-dialog";
import { AlertCircle, FileDown, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  DecisionDialog,
  type DialogAction,
} from "./components/DecisionDialog";
import { EmptyState } from "./components/EmptyState";
import { MarkdownEditor } from "./components/MarkdownEditor";
import { MarkdownView } from "./components/MarkdownView";
import { SearchBar } from "./components/SearchBar";
import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { useDocumentSearch } from "./hooks/useDocumentSearch";
import { extractTableOfContents, isMarkdownPath } from "./lib/markdown";
import {
  addRecentFile,
  loadSettings,
  rememberScrollPosition,
  saveSettings,
} from "./lib/settings";
import type {
  FileTreeNode,
  MarkdownDocument,
  ReaderMode,
  ReaderSettings,
  ResolvedTheme,
  SidebarTab,
  ThemeMode,
} from "./types";

const FONT_SIZE_MIN = 14;
const FONT_SIZE_MAX = 24;
const SCROLL_SAVE_DEBOUNCE_MS = 180;
const ACTIVE_HEADING_OFFSET = 110;
const themeOrder: ThemeMode[] = ["system", "light", "dark"];

type SaveErrorKind =
  | "conflict"
  | "permission_denied"
  | "file_missing"
  | "invalid_extension"
  | "write_failure";

interface SaveCommandError {
  kind: SaveErrorKind;
  message: string;
}

interface OpenDocumentOptions {
  keepFilesTab?: boolean;
  silent?: boolean;
}

interface OpenFolderOptions {
  silent?: boolean;
}

interface DecisionState {
  title: string;
  message: string;
  detail?: string;
  actions: DialogAction[];
  cancelValue: string;
}

type SaveOutcome = "saved" | "reloaded" | "cancelled" | "failed";

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "Something went wrong while opening the file.";
}

function saveCommandError(error: unknown): SaveCommandError | null {
  if (error && typeof error === "object") {
    const candidate = error as { kind?: unknown; message?: unknown };
    if (typeof candidate.kind === "string" && typeof candidate.message === "string") {
      return candidate as SaveCommandError;
    }
  }

  if (typeof error === "string") {
    try {
      const parsed = JSON.parse(error) as { kind?: unknown; message?: unknown };
      if (typeof parsed.kind === "string" && typeof parsed.message === "string") {
        return parsed as SaveCommandError;
      }
    } catch {
      // Some desktop bridge errors are plain strings rather than serialized objects.
    }
  }

  return null;
}

function comparablePath(path: string): string {
  return path.replace(/\//g, "\\").replace(/\\+$/, "").toLocaleLowerCase();
}

export default function App() {
  const [settings, setSettings] = useState<ReaderSettings>(loadSettings);
  const [documentFile, setDocumentFile] = useState<MarkdownDocument | null>(null);
  const [diskContent, setDiskContent] = useState("");
  const [draftContent, setDraftContent] = useState("");
  const [readerMode, setReaderMode] = useState<ReaderMode>("read");
  const [saving, setSaving] = useState(false);
  const [folderTree, setFolderTree] = useState<FileTreeNode | null>(null);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("contents");
  const [fileLoading, setFileLoading] = useState(false);
  const [folderLoading, setFolderLoading] = useState(false);
  const [error, setError] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchFocusRequest, setSearchFocusRequest] = useState(0);
  const [decision, setDecision] = useState<DecisionState | null>(null);
  const [systemDark, setSystemDark] = useState(() =>
    window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  const [activeHeading, setActiveHeading] = useState("");

  const articleRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLElement>(null);
  const openRequestId = useRef(0);
  const folderRequestId = useRef(0);
  const externalOpenEpoch = useRef(0);
  const initialSettings = useRef(settings);
  const settingsRef = useRef(settings);
  const scrollPositionsRef = useRef(settings.scrollPositions);
  const visibleDocumentPathRef = useRef("");
  const lastScrollPositionRef = useRef<{ path: string; position: number } | null>(null);
  const pendingScrollRestoreRef = useRef<{ path: string; position: number } | null>(null);
  const documentFileRef = useRef<MarkdownDocument | null>(null);
  const diskContentRef = useRef("");
  const draftContentRef = useRef("");
  const dirtyRef = useRef(false);
  const readerModeRef = useRef<ReaderMode>("read");
  const savingRef = useRef(false);
  const pendingActionRef = useRef(false);
  const allowWindowCloseRef = useRef(false);
  const decisionRef = useRef<DecisionState | null>(null);
  const decisionResolverRef = useRef<((value: string) => void) | null>(null);

  const isDirty = draftContent !== diskContent;
  const resolvedTheme: ResolvedTheme =
    settings.theme === "system" ? (systemDark ? "dark" : "light") : settings.theme;

  const tableOfContents = useMemo(
    () => extractTableOfContents(draftContent),
    [draftContent],
  );

  const search = useDocumentSearch(
    articleRef,
    scrollRef,
    readerMode === "read" && searchOpen ? searchQuery : "",
    documentFile?.path ?? "",
    draftContent,
    `${resolvedTheme}:${readerMode}`,
  );

  const updateSettings = useCallback(
    (update: (current: ReaderSettings) => ReaderSettings) => {
      setSettings((current) => {
        const next = update(current);
        settingsRef.current = next;
        return next;
      });
    },
    [],
  );

  const storeScrollPosition = useCallback(
    (path: string, position: number) => {
      const scrollPositions = rememberScrollPosition(
        scrollPositionsRef.current,
        path,
        position,
      );
      scrollPositionsRef.current = scrollPositions;
      updateSettings((current) => ({ ...current, scrollPositions }));
    },
    [updateSettings],
  );

  const flushCurrentScrollPosition = useCallback(() => {
    const current = lastScrollPositionRef.current;
    if (current) storeScrollPosition(current.path, current.position);
  }, [storeScrollPosition]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery("");
  }, []);

  const applyOpenedDocument = useCallback(
    (opened: MarkdownDocument) => {
      documentFileRef.current = opened;
      diskContentRef.current = opened.content;
      draftContentRef.current = opened.content;
      dirtyRef.current = false;
      readerModeRef.current = "read";
      setDocumentFile(opened);
      setDiskContent(opened.content);
      setDraftContent(opened.content);
      setReaderMode("read");
      setActiveHeading("");
      closeSearch();
    },
    [closeSearch],
  );

  const updateDraftContent = useCallback((content: string) => {
    draftContentRef.current = content;
    dirtyRef.current = content !== diskContentRef.current;
    setDraftContent(content);
  }, []);

  const discardDraft = useCallback(() => {
    const content = diskContentRef.current;
    draftContentRef.current = content;
    dirtyRef.current = false;
    setDraftContent(content);
  }, []);

  const loadDocument = useCallback(
    async (path: string, options: OpenDocumentOptions = {}): Promise<boolean> => {
      if (!isMarkdownPath(path)) {
        if (!options.silent) setError("Only .md and .markdown files can be opened.");
        return false;
      }

      flushCurrentScrollPosition();
      const requestId = ++openRequestId.current;
      setFileLoading(true);
      if (!options.silent) setError("");

      try {
        const opened = await invoke<MarkdownDocument>("read_markdown_file", { path });
        if (requestId !== openRequestId.current) return false;
        flushCurrentScrollPosition();
        pendingScrollRestoreRef.current = {
          path: opened.path,
          position: scrollPositionsRef.current[opened.path] ?? 0,
        };
        applyOpenedDocument(opened);
        if (!options.keepFilesTab) setSidebarTab("contents");
        updateSettings((current) => ({
          ...current,
          lastFilePath: opened.path,
          recentFiles: addRecentFile(current.recentFiles, {
            path: opened.path,
            name: opened.name,
          }),
        }));
        return true;
      } catch (openError) {
        if (requestId === openRequestId.current && !options.silent) {
          setError(errorMessage(openError));
        }
        return false;
      } finally {
        if (requestId === openRequestId.current) setFileLoading(false);
      }
    },
    [applyOpenedDocument, flushCurrentScrollPosition, updateSettings],
  );

  const loadFolder = useCallback(
    async (path: string, options: OpenFolderOptions = {}): Promise<boolean> => {
      const requestId = ++folderRequestId.current;
      setFolderLoading(true);
      if (!options.silent) setError("");

      try {
        const opened = await invoke<FileTreeNode>("scan_markdown_folder", { path });
        if (requestId !== folderRequestId.current) return false;
        setFolderTree(opened);
        setSidebarTab("files");
        updateSettings((current) => ({
          ...current,
          lastFolderPath: opened.path,
        }));
        return true;
      } catch (openError) {
        if (requestId === folderRequestId.current && !options.silent) {
          setError(errorMessage(openError));
        }
        return false;
      } finally {
        if (requestId === folderRequestId.current) setFolderLoading(false);
      }
    },
    [updateSettings],
  );

  const chooseDecision = useCallback((value: string) => {
    const resolve = decisionResolverRef.current;
    if (!resolve) return;
    decisionResolverRef.current = null;
    decisionRef.current = null;
    setDecision(null);
    resolve(value);
  }, []);

  const askDecision = useCallback((nextDecision: DecisionState): Promise<string> => {
    if (decisionResolverRef.current) return Promise.resolve(nextDecision.cancelValue);
    (document.activeElement as HTMLElement | null)?.blur();
    decisionRef.current = nextDecision;
    setDecision(nextDecision);
    return new Promise((resolve) => {
      decisionResolverRef.current = resolve;
    });
  }, []);

  const saveCurrentDocument = useCallback(async (): Promise<SaveOutcome> => {
    const targetDocument = documentFileRef.current;
    if (!targetDocument || !dirtyRef.current) return "saved";
    if (savingRef.current) return "cancelled";

    const targetPath = targetDocument.path;
    const contentToSave = draftContentRef.current;
    const expectedContent = diskContentRef.current;
    savingRef.current = true;
    setSaving(true);
    setError("");

    const applySavedDocument = (saved: MarkdownDocument): SaveOutcome => {
      const current = documentFileRef.current;
      if (!current || comparablePath(current.path) !== comparablePath(targetPath)) {
        return "cancelled";
      }

      const updated = { ...current, ...saved };
      documentFileRef.current = updated;
      diskContentRef.current = saved.content;
      dirtyRef.current = draftContentRef.current !== saved.content;
      setDocumentFile(updated);
      setDiskContent(saved.content);
      return "saved";
    };

    const write = (overwriteConflict: boolean) =>
      invoke<MarkdownDocument>("write_markdown_file", {
        path: targetPath,
        content: contentToSave,
        expectedContent,
        overwriteConflict,
      });

    try {
      try {
        return applySavedDocument(await write(false));
      } catch (saveError) {
        const structuredError = saveCommandError(saveError);
        if (structuredError?.kind !== "conflict") {
          setError(structuredError?.message ?? errorMessage(saveError));
          return "failed";
        }
      }

      const conflictChoice = await askDecision({
        title: "File changed on disk",
        message:
          "Another program changed this file after it was opened. Your draft has not been written.",
        detail: "Reload uses the disk version. Overwrite is only performed if you choose it explicitly.",
        cancelValue: "cancel",
        actions: [
          { label: "Reload", value: "reload" },
          { label: "Overwrite", value: "overwrite", tone: "danger" },
          { label: "Cancel", value: "cancel", autoFocus: true },
        ],
      });

      if (conflictChoice === "cancel") return "cancelled";

      if (conflictChoice === "reload") {
        const reloadChoice = await askDecision({
          title: "Discard your unsaved draft?",
          message:
            "Reloading will permanently replace the current unsaved draft with the latest disk version.",
          cancelValue: "cancel",
          actions: [
            { label: "Reload and Lose Draft", value: "reload", tone: "danger" },
            { label: "Keep Draft", value: "cancel", autoFocus: true },
          ],
        });
        if (reloadChoice !== "reload") return "cancelled";

        try {
          const reloaded = await invoke<MarkdownDocument>("read_markdown_file", {
            path: targetPath,
          });
          const current = documentFileRef.current;
          if (!current || comparablePath(current.path) !== comparablePath(targetPath)) {
            return "cancelled";
          }
          documentFileRef.current = reloaded;
          diskContentRef.current = reloaded.content;
          draftContentRef.current = reloaded.content;
          dirtyRef.current = false;
          setDocumentFile(reloaded);
          setDiskContent(reloaded.content);
          setDraftContent(reloaded.content);
          closeSearch();
          return "reloaded";
        } catch (reloadError) {
          setError(errorMessage(reloadError));
          return "failed";
        }
      }

      try {
        return applySavedDocument(await write(true));
      } catch (overwriteError) {
        const structuredError = saveCommandError(overwriteError);
        setError(structuredError?.message ?? errorMessage(overwriteError));
        return "failed";
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [askDecision, closeSearch]);

  const runGuardedAction = useCallback(
    async (action: () => Promise<boolean | void>): Promise<boolean> => {
      if (pendingActionRef.current || savingRef.current) return false;
      pendingActionRef.current = true;

      try {
        if (dirtyRef.current) {
          const filename = documentFileRef.current?.name ?? "this document";
          const choice = await askDecision({
            title: "Unsaved changes",
            message: `${filename} has changes that have not been saved.`,
            detail: "Save writes the draft safely before continuing. Discard loses the draft.",
            cancelValue: "cancel",
            actions: [
              { label: "Save", value: "save", tone: "primary" },
              { label: "Discard", value: "discard", tone: "danger" },
              { label: "Cancel", value: "cancel", autoFocus: true },
            ],
          });

          if (choice === "cancel") return false;
          if (choice === "save") {
            const outcome = await saveCurrentDocument();
            if (outcome !== "saved" || dirtyRef.current) return false;
          } else {
            discardDraft();
          }
        }

        return (await action()) !== false;
      } catch (actionError) {
        setError(errorMessage(actionError));
        return false;
      } finally {
        pendingActionRef.current = false;
      }
    },
    [askDecision, discardDraft, saveCurrentDocument],
  );

  const openDocument = useCallback(
    (path: string, options: OpenDocumentOptions = {}) =>
      runGuardedAction(() => loadDocument(path, options)),
    [loadDocument, runGuardedAction],
  );

  const openFolder = useCallback(
    (path: string, options: OpenFolderOptions = {}) =>
      runGuardedAction(() => loadFolder(path, options)),
    [loadFolder, runGuardedAction],
  );

  const chooseFile = useCallback(async () => {
    try {
      const selected = await openPathDialog({
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

  const chooseFolder = useCallback(async () => {
    try {
      const selected = await openPathDialog({
        multiple: false,
        directory: true,
        title: "Open Markdown Folder",
      });
      if (typeof selected === "string") await openFolder(selected);
    } catch (dialogError) {
      setError(errorMessage(dialogError));
    }
  }, [openFolder]);

  const changeReaderMode = useCallback(
    (mode: ReaderMode) => {
      if (mode === "edit" && !documentFileRef.current) return;
      if (readerModeRef.current === mode) return;

      if (mode === "edit") {
        flushCurrentScrollPosition();
        closeSearch();
        if (folderTree) setSidebarTab("files");
      } else {
        const path = documentFileRef.current?.path;
        if (path) {
          pendingScrollRestoreRef.current = {
            path,
            position: scrollPositionsRef.current[path] ?? 0,
          };
        }
      }

      readerModeRef.current = mode;
      setReaderMode(mode);
    },
    [closeSearch, flushCurrentScrollPosition, folderTree],
  );

  const openSearch = useCallback(() => {
    if (!documentFileRef.current) return;
    if (readerModeRef.current === "edit") changeReaderMode("read");
    setSearchOpen(true);
    setSearchFocusRequest((request) => request + 1);
  }, [changeReaderMode]);

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
    const title = documentFile ? `${documentFile.name} — MD Reader` : "MD Reader";
    document.title = isDirty ? `● ${title}` : title;
  }, [documentFile, isDirty]);

  useLayoutEffect(() => {
    const scrollContainer = scrollRef.current;
    const path = documentFile?.path ?? "";
    if (!scrollContainer || !path || readerMode !== "read") {
      visibleDocumentPathRef.current = "";
      lastScrollPositionRef.current = null;
      return;
    }

    const pending = pendingScrollRestoreRef.current;
    const requestedPosition =
      pending?.path === path ? pending.position : (scrollPositionsRef.current[path] ?? 0);
    const maximumPosition = Math.max(
      scrollContainer.scrollHeight - scrollContainer.clientHeight,
      0,
    );
    const restoredPosition = Math.min(Math.max(requestedPosition, 0), maximumPosition);

    visibleDocumentPathRef.current = path;
    scrollContainer.scrollTop = restoredPosition;
    lastScrollPositionRef.current = { path, position: scrollContainer.scrollTop };
    pendingScrollRestoreRef.current = null;

    if (
      restoredPosition !== requestedPosition &&
      Object.prototype.hasOwnProperty.call(scrollPositionsRef.current, path)
    ) {
      storeScrollPosition(path, restoredPosition);
    }
  }, [documentFile?.path, readerMode, storeScrollPosition]);

  useEffect(() => {
    const scrollContainer = scrollRef.current;
    const path = documentFile?.path;
    if (!scrollContainer || !path || readerMode !== "read") return;

    let saveTimer: number | undefined;
    const handleScroll = () => {
      if (visibleDocumentPathRef.current !== path) return;
      const position = scrollContainer.scrollTop;
      lastScrollPositionRef.current = { path, position };
      window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => {
        storeScrollPosition(path, position);
      }, SCROLL_SAVE_DEBOUNCE_MS);
    };

    scrollContainer.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      window.clearTimeout(saveTimer);
      scrollContainer.removeEventListener("scroll", handleScroll);
    };
  }, [documentFile?.path, readerMode, storeScrollPosition]);

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      const current = lastScrollPositionRef.current;
      if (current) {
        const scrollPositions = rememberScrollPosition(
          scrollPositionsRef.current,
          current.path,
          current.position,
        );
        saveSettings({ ...settingsRef.current, scrollPositions });
      }

      if (dirtyRef.current && !allowWindowCloseRef.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unlistenRequested: (() => void) | undefined;

    const connect = async () => {
      try {
        unlistenRequested = await listen<string>("open-file-requested", (event) => {
          externalOpenEpoch.current += 1;
          folderRequestId.current += 1;
          setFolderLoading(false);
          void openDocument(event.payload);
        });
        const restoreEpoch = externalOpenEpoch.current;
        const startupFile = await invoke<string | null>("get_startup_file");
        if (cancelled) return;

        if (startupFile) {
          externalOpenEpoch.current += 1;
          await loadDocument(startupFile);
          return;
        }

        if (restoreEpoch !== externalOpenEpoch.current) return;
        const saved = initialSettings.current;

        if (saved.lastFolderPath) {
          const restoredFolder = await loadFolder(saved.lastFolderPath, { silent: true });
          if (cancelled || restoreEpoch !== externalOpenEpoch.current) return;
          if (!restoredFolder) {
            updateSettings((current) => ({ ...current, lastFolderPath: null }));
          }
        }

        if (saved.lastFilePath) {
          const restoredFile = await loadDocument(saved.lastFilePath, { silent: true });
          if (cancelled || restoreEpoch !== externalOpenEpoch.current) return;
          if (!restoredFile) {
            updateSettings((current) => ({ ...current, lastFilePath: null }));
          }
        }
      } catch {
        // Vite's browser-only preview has no desktop bridge.
      }
    };

    void connect();
    return () => {
      cancelled = true;
      unlistenRequested?.();
    };
  }, [loadDocument, loadFolder, openDocument, updateSettings]);

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
            const droppedPaths = event.payload.paths;
            void (async () => {
              try {
                for (const path of droppedPaths) {
                  const pathKind = await invoke<"folder" | "markdown" | "unsupported">(
                    "classify_path",
                    { path },
                  );
                  if (pathKind === "folder") {
                    await openFolder(path);
                    return;
                  }
                  if (pathKind === "markdown") {
                    await openDocument(path);
                    return;
                  }
                }
                setError("Drop a Markdown file or a folder to open it.");
              } catch {
                setError("This dropped path could not be opened.");
              }
            })();
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
  }, [openDocument, openFolder]);

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
    let cancelled = false;
    let unlistenClose: (() => void) | undefined;

    const connect = async () => {
      try {
        const appWindow = getCurrentWindow();
        unlistenClose = await appWindow.onCloseRequested(async (event) => {
          if (allowWindowCloseRef.current || !dirtyRef.current) return;
          event.preventDefault();
          await runGuardedAction(async () => {
            allowWindowCloseRef.current = true;
            await appWindow.close();
          });
        });
        if (cancelled) unlistenClose();
      } catch {
        // Close interception only applies to the desktop window.
      }
    };

    void connect();
    return () => {
      cancelled = true;
      unlistenClose?.();
    };
  }, [runGuardedAction]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const controlShortcut = event.ctrlKey && !event.altKey;
      const key = event.key.toLocaleLowerCase();

      if (controlShortcut && key === "s") {
        event.preventDefault();
        if (!decisionRef.current) void saveCurrentDocument();
        return;
      }

      if (decisionRef.current) {
        if (controlShortcut && ["o", "f", "+", "=", "-", "0"].includes(key)) {
          event.preventDefault();
        }
        return;
      }

      if (event.key === "F3" && !event.ctrlKey && !event.altKey && !event.metaKey) {
        if (documentFileRef.current && searchOpen && readerModeRef.current === "read") {
          event.preventDefault();
          event.shiftKey ? search.previous() : search.next();
        }
        return;
      }

      if (!controlShortcut) {
        if (event.key === "Escape" && searchOpen) closeSearch();
        return;
      }

      if (key === "o") {
        event.preventDefault();
        if (event.shiftKey) void chooseFolder();
        else void chooseFile();
      } else if (key === "f") {
        event.preventDefault();
        if (documentFileRef.current) openSearch();
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
  }, [
    changeFontSize,
    chooseFile,
    chooseFolder,
    closeSearch,
    openSearch,
    saveCurrentDocument,
    search.next,
    search.previous,
    searchOpen,
  ]);

  useEffect(() => {
    const scrollContainer = scrollRef.current;
    const article = articleRef.current;
    if (
      readerMode !== "read" ||
      !scrollContainer ||
      !article ||
      tableOfContents.length === 0
    ) {
      setActiveHeading("");
      return;
    }

    const tocIds = new Set(tableOfContents.map((heading) => heading.id));
    const headingElements = Array.from(
      article.querySelectorAll<HTMLElement>("h1[id], h2[id], h3[id]"),
    ).filter((heading) => tocIds.has(heading.id));

    if (headingElements.length === 0) {
      setActiveHeading("");
      return;
    }

    let positions: { id: string; top: number }[] = [];
    let scrollFrame = 0;
    let resizeFrame = 0;

    const updateActiveHeading = () => {
      const target = scrollContainer.scrollTop + ACTIVE_HEADING_OFFSET;
      let low = 0;
      let high = positions.length - 1;
      let activeIndex = 0;

      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        if (positions[middle].top <= target) {
          activeIndex = middle;
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }

      const active = positions[activeIndex]?.id ?? "";
      setActiveHeading((current) => (current === active ? current : active));
    };

    const rebuildHeadingPositions = () => {
      const containerTop = scrollContainer.getBoundingClientRect().top;
      const currentScrollTop = scrollContainer.scrollTop;
      positions = headingElements.map((heading) => ({
        id: heading.id,
        top: currentScrollTop + heading.getBoundingClientRect().top - containerTop,
      }));
      updateActiveHeading();
    };

    const handleScroll = () => {
      cancelAnimationFrame(scrollFrame);
      scrollFrame = requestAnimationFrame(updateActiveHeading);
    };

    rebuildHeadingPositions();
    scrollContainer.addEventListener("scroll", handleScroll, { passive: true });

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            cancelAnimationFrame(resizeFrame);
            resizeFrame = requestAnimationFrame(rebuildHeadingPositions);
          });
    resizeObserver?.observe(article);
    resizeObserver?.observe(scrollContainer);

    return () => {
      cancelAnimationFrame(scrollFrame);
      cancelAnimationFrame(resizeFrame);
      resizeObserver?.disconnect();
      scrollContainer.removeEventListener("scroll", handleScroll);
    };
  }, [documentFile?.path, error, readerMode, searchOpen, tableOfContents]);

  const navigateToHeading = useCallback((id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  return (
    <div className="app-shell">
      <TopBar
        filename={documentFile?.name}
        filePath={documentFile?.path}
        theme={settings.theme}
        readerMode={readerMode}
        dirty={isDirty}
        saving={saving}
        canSearch={Boolean(documentFile)}
        canEdit={Boolean(documentFile)}
        onOpenFile={chooseFile}
        onOpenFolder={chooseFolder}
        onSearch={openSearch}
        onSave={() => void saveCurrentDocument()}
        onModeChange={changeReaderMode}
        onCycleTheme={cycleTheme}
      />

      <div className="workspace">
        {(folderTree || (documentFile && readerMode === "read")) && (
          <Sidebar
            fileTree={folderTree}
            items={readerMode === "read" ? tableOfContents : []}
            width={settings.sidebarWidth}
            collapsed={settings.sidebarCollapsed}
            activeId={readerMode === "read" ? activeHeading : ""}
            activeFilePath={documentFile?.path ?? ""}
            activeTab={readerMode === "edit" ? "files" : sidebarTab}
            showContents={readerMode === "read"}
            refreshing={folderLoading}
            onToggle={() =>
              updateSettings((current) => ({
                ...current,
                sidebarCollapsed: !current.sidebarCollapsed,
              }))
            }
            onWidthChange={(sidebarWidth) =>
              updateSettings((current) => ({ ...current, sidebarWidth }))
            }
            onTabChange={setSidebarTab}
            onOpenFile={(path) => void openDocument(path, { keepFilesTab: true })}
            onRefresh={() => {
              if (folderTree) void loadFolder(folderTree.path);
            }}
            onNavigate={navigateToHeading}
          />
        )}

        <main
          ref={scrollRef}
          className={`reader-scroll${readerMode === "edit" ? " is-editing" : ""}`}
          style={{ "--reader-font-size": `${settings.fontSize}px` } as React.CSSProperties}
        >
          {readerMode === "read" && searchOpen && documentFile && (
            <SearchBar
              query={searchQuery}
              currentMatch={search.currentMatch}
              matchCount={search.matchCount}
              matchLimitExceeded={search.matchLimitExceeded}
              focusRequest={searchFocusRequest}
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
            readerMode === "edit" ? (
              <MarkdownEditor value={draftContent} onChange={updateDraftContent} />
            ) : (
              <MarkdownView
                content={draftContent}
                documentPath={documentFile.path}
                theme={resolvedTheme}
                articleRef={articleRef}
                onOpenMarkdown={(path) => void openDocument(path)}
              />
            )
          ) : (
            <EmptyState
              recentFiles={settings.recentFiles}
              onOpen={chooseFile}
              onSelectRecent={(path) => void openDocument(path)}
            />
          )}
        </main>
      </div>

      {(fileLoading || folderLoading) && (
        <div className="loading-indicator" role="status">
          <span />
          {folderLoading ? "Scanning folder…" : "Opening document…"}
        </div>
      )}

      {dragActive && (
        <div className="drop-overlay">
          <div>
            <FileDown size={34} />
            <strong>Drop to open</strong>
            <span>Markdown files or folders</span>
          </div>
        </div>
      )}

      {decision && (
        <DecisionDialog
          title={decision.title}
          message={decision.message}
          detail={decision.detail}
          actions={decision.actions}
          cancelValue={decision.cancelValue}
          onChoose={chooseDecision}
        />
      )}
    </div>
  );
}
