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
import { EditWorkspace } from "./components/EditWorkspace";
import { EmptyState } from "./components/EmptyState";
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
  EditLayout,
  FileRevision,
  FileTreeNode,
  MarkdownDocument,
  RecoveryDraft,
  ReaderMode,
  ReaderSettings,
  ResolvedTheme,
  SidebarTab,
  ThemeMode,
} from "./types";

const FONT_SIZE_MIN = 14;
const FONT_SIZE_MAX = 24;
const SCROLL_SAVE_DEBOUNCE_MS = 180;
const PREVIEW_DEBOUNCE_MS = 150;
const RECOVERY_DEBOUNCE_MS = 1000;
const EXTERNAL_CHECK_INTERVAL_MS = 2000;
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
type SaveAttempt = "saved" | "conflict" | "failed" | "stale" | "busy";
type SaveSignal = "saved" | "unsaved" | "draft-protected" | "save-failed";

interface ExternalChangeState {
  kind: "changed" | "missing";
  observedRevision: string | null;
  dismissed: boolean;
  recoveryBaseMismatch?: boolean;
}

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
  const [previewContent, setPreviewContent] = useState("");
  const [readerMode, setReaderMode] = useState<ReaderMode>("read");
  const [saving, setSaving] = useState(false);
  const [saveSignal, setSaveSignal] = useState<SaveSignal>("saved");
  const [externalChange, setExternalChange] = useState<ExternalChangeState | null>(null);
  const [recoveryWarning, setRecoveryWarning] = useState("");
  const [notice, setNotice] = useState("");
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
  const diskRevisionRef = useRef("");
  const documentTokenRef = useRef(0);
  const draftVersionRef = useRef(0);
  const previewTimerRef = useRef<number | undefined>(undefined);
  const previewUpdateEpochRef = useRef(0);
  const dirtyRef = useRef(false);
  const readerModeRef = useRef<ReaderMode>("read");
  const savingRef = useRef(false);
  const saveInFlightRef = useRef<Promise<SaveAttempt> | null>(null);
  const recoveryTimerRef = useRef<number | undefined>(undefined);
  const recoveryQueueRef = useRef<Promise<void>>(Promise.resolve());
  const externalChangeRef = useRef<ExternalChangeState | null>(null);
  const pendingActionRef = useRef(false);
  const decisionRef = useRef<DecisionState | null>(null);
  const decisionResolverRef = useRef<((value: string) => void) | null>(null);

  const isDirty = draftContent !== diskContent;
  const resolvedTheme: ResolvedTheme =
    settings.theme === "system" ? (systemDark ? "dark" : "light") : settings.theme;
  const saveStatus = saving
    ? "Saving…"
    : externalChange
      ? settings.autoSaveEnabled && isDirty
        ? "Auto Save paused"
        : "File changed externally"
      : saveSignal === "save-failed"
        ? "Save failed"
        : isDirty && saveSignal === "draft-protected"
          ? "Draft protected"
          : isDirty
            ? "Unsaved"
            : "Saved";

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

  const updateExternalChange = useCallback((change: ExternalChangeState | null) => {
    externalChangeRef.current = change;
    setExternalChange(change);
  }, []);

  const queueRecoveryOperation = useCallback((operation: () => Promise<void>) => {
    const next = recoveryQueueRef.current.catch(() => undefined).then(operation);
    recoveryQueueRef.current = next.catch(() => undefined);
    return next;
  }, []);

  const deleteRecoveryDraft = useCallback(
    async (path: string): Promise<boolean> => {
      try {
        await queueRecoveryOperation(() =>
          invoke<void>("delete_recovery_draft", { path }),
        );
        return true;
      } catch (deleteError) {
        setRecoveryWarning(
          `The recovery draft could not be deleted and was left in place: ${errorMessage(deleteError)}`,
        );
        return false;
      }
    },
    [queueRecoveryOperation],
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

  const cancelPendingPreview = useCallback(() => {
    window.clearTimeout(previewTimerRef.current);
    previewTimerRef.current = undefined;
    previewUpdateEpochRef.current += 1;
  }, []);

  const syncPreviewContent = useCallback(
    (content: string) => {
      cancelPendingPreview();
      setPreviewContent(content);
    },
    [cancelPendingPreview],
  );

  const schedulePreviewContent = useCallback((content: string) => {
    window.clearTimeout(previewTimerRef.current);
    const updateEpoch = ++previewUpdateEpochRef.current;
    const documentPath = documentFileRef.current?.path ?? "";

    if (!documentPath) {
      previewTimerRef.current = undefined;
      setPreviewContent("");
      return;
    }

    previewTimerRef.current = window.setTimeout(() => {
      if (
        updateEpoch !== previewUpdateEpochRef.current ||
        comparablePath(documentFileRef.current?.path ?? "") !== comparablePath(documentPath)
      ) {
        return;
      }
      previewTimerRef.current = undefined;
      setPreviewContent(content);
    }, PREVIEW_DEBOUNCE_MS);
  }, []);

  useEffect(() => () => cancelPendingPreview(), [cancelPendingPreview]);

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

  const applyOpenedDocument = useCallback(
    (opened: MarkdownDocument) => {
      documentTokenRef.current += 1;
      draftVersionRef.current += 1;
      documentFileRef.current = opened;
      diskContentRef.current = opened.content;
      draftContentRef.current = opened.content;
      diskRevisionRef.current = opened.revision;
      dirtyRef.current = false;
      readerModeRef.current = "read";
      updateExternalChange(null);
      setDocumentFile(opened);
      setDiskContent(opened.content);
      setDraftContent(opened.content);
      syncPreviewContent(opened.content);
      setReaderMode("read");
      setSaveSignal("saved");
      setActiveHeading("");
      closeSearch();
    },
    [closeSearch, syncPreviewContent, updateExternalChange],
  );

  const updateDraftContent = useCallback((content: string) => {
    draftVersionRef.current += 1;
    draftContentRef.current = content;
    dirtyRef.current = content !== diskContentRef.current;
    setDraftContent(content);
    setSaveSignal(content === diskContentRef.current ? "saved" : "unsaved");
    const observedChange = externalChangeRef.current;
    if (observedChange?.dismissed && content !== diskContentRef.current) {
      updateExternalChange({ ...observedChange, dismissed: false });
    }
    schedulePreviewContent(content);
  }, [schedulePreviewContent, updateExternalChange]);

  const discardDraft = useCallback(async (): Promise<boolean> => {
    const path = documentFileRef.current?.path;
    if (path && !(await deleteRecoveryDraft(path))) return false;
    draftVersionRef.current += 1;
    const content = diskContentRef.current;
    draftContentRef.current = content;
    dirtyRef.current = false;
    setDraftContent(content);
    syncPreviewContent(content);
    setSaveSignal("saved");
    return true;
  }, [deleteRecoveryDraft, syncPreviewContent]);

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
        let opened: MarkdownDocument;
        try {
          opened = await invoke<MarkdownDocument>("read_markdown_file", { path });
        } catch (openError) {
          if (requestId !== openRequestId.current) return false;
          try {
            const revision = await invoke<FileRevision>("get_file_revision", { path });
            const recovery = await invoke<RecoveryDraft | null>("load_recovery_draft", {
              path,
            });
            if (revision.status === "missing" && recovery) {
              const choice = await askDecision({
                title: "File no longer exists on disk",
                message: `${recovery.filename} was moved or deleted, but its recovery draft is still protected.`,
                detail: "Copy keeps the recovery record. Only Discard Draft deletes it.",
                cancelValue: "cancel",
                actions: [
                  { label: "Copy Draft", value: "copy", tone: "primary" },
                  { label: "Discard Draft", value: "discard", tone: "danger" },
                  { label: "Cancel", value: "cancel", autoFocus: true },
                ],
              });
              if (choice === "copy") {
                try {
                  await navigator.clipboard.writeText(recovery.draftContent);
                  setNotice("Recovery draft copied. The protected recovery record was kept.");
                } catch (copyError) {
                  setRecoveryWarning(
                    `The draft could not be copied; its recovery record was kept: ${errorMessage(copyError)}`,
                  );
                }
              } else if (choice === "discard") {
                await deleteRecoveryDraft(recovery.canonicalPath);
              }
              return false;
            }
          } catch (recoveryError) {
            setRecoveryWarning(errorMessage(recoveryError));
          }
          throw openError;
        }
        if (requestId !== openRequestId.current) return false;

        let recovery: RecoveryDraft | null = null;
        try {
          recovery = await invoke<RecoveryDraft | null>("load_recovery_draft", {
            path: opened.path,
          });
        } catch (recoveryError) {
          setRecoveryWarning(errorMessage(recoveryError));
        }
        if (requestId !== openRequestId.current) return false;

        let recoveryChoice: "recover" | "discard" | null = null;
        if (recovery) {
          if (recovery.draftContent === opened.content) {
            await deleteRecoveryDraft(opened.path);
            recovery = null;
          } else {
            const diskAlsoChanged = recovery.baseRevision !== opened.revision;
            const choice = await askDecision({
              title: "Recovery draft found",
              message: `${recovery.filename} has a protected draft from ${new Date(
                recovery.updatedTimestamp * 1000,
              ).toLocaleString()}.`,
              detail: diskAlsoChanged
                ? "The disk file was also modified after this draft was created. Recover loads the draft as unsaved and requires explicit conflict resolution before writing."
                : "Recover loads the draft as unsaved and does not write it to the Markdown file.",
              cancelValue: "cancel",
              actions: [
                { label: "Recover Draft", value: "recover", tone: "primary" },
                { label: "Discard Draft", value: "discard", tone: "danger" },
                { label: "Cancel", value: "cancel", autoFocus: true },
              ],
            });
            if (choice === "cancel") return false;
            recoveryChoice = choice === "recover" ? "recover" : "discard";
            if (recoveryChoice === "discard") {
              if (!(await deleteRecoveryDraft(opened.path))) return false;
              recovery = null;
            }
          }
        }

        flushCurrentScrollPosition();
        pendingScrollRestoreRef.current = {
          path: opened.path,
          position: scrollPositionsRef.current[opened.path] ?? 0,
        };
        applyOpenedDocument(opened);
        if (recovery && recoveryChoice === "recover") {
          draftVersionRef.current += 1;
          draftContentRef.current = recovery.draftContent;
          dirtyRef.current = true;
          readerModeRef.current = "edit";
          setDraftContent(recovery.draftContent);
          syncPreviewContent(recovery.draftContent);
          setReaderMode("edit");
          setSaveSignal("draft-protected");
          if (recovery.baseRevision !== opened.revision) {
            updateExternalChange({
              kind: "changed",
              observedRevision: opened.revision,
              dismissed: false,
              recoveryBaseMismatch: true,
            });
          }
        }
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
    [
      applyOpenedDocument,
      askDecision,
      deleteRecoveryDraft,
      flushCurrentScrollPosition,
      syncPreviewContent,
      updateExternalChange,
      updateSettings,
    ],
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

  const performSave = useCallback(
    (overwriteConflict: boolean): Promise<SaveAttempt> => {
      const targetDocument = documentFileRef.current;
      if (!targetDocument || !dirtyRef.current) return Promise.resolve("saved");
      if (saveInFlightRef.current) return Promise.resolve("busy");

      const targetPath = targetDocument.path;
      const targetToken = documentTokenRef.current;
      const contentSnapshot = draftContentRef.current;
      const expectedContent = diskContentRef.current;
      const draftVersion = draftVersionRef.current;
      savingRef.current = true;
      setSaving(true);
      setSaveSignal("unsaved");
      setError("");

      let task: Promise<SaveAttempt>;
      task = (async () => {
        try {
          const saved = await invoke<MarkdownDocument>("write_markdown_file", {
            path: targetPath,
            content: contentSnapshot,
            expectedContent,
            overwriteConflict,
          });
          const current = documentFileRef.current;
          if (
            !current ||
            documentTokenRef.current !== targetToken ||
            comparablePath(current.path) !== comparablePath(targetPath)
          ) {
            return "stale";
          }

          const updated = { ...current, ...saved };
          documentFileRef.current = updated;
          diskContentRef.current = saved.content;
          diskRevisionRef.current = saved.revision;
          dirtyRef.current = draftContentRef.current !== saved.content;
          setDocumentFile(updated);
          setDiskContent(saved.content);
          updateExternalChange(null);
          if (
            draftVersionRef.current === draftVersion &&
            draftContentRef.current === saved.content
          ) {
            setSaveSignal("saved");
            void deleteRecoveryDraft(targetPath);
          } else {
            setSaveSignal("unsaved");
          }
          return "saved";
        } catch (saveError) {
          const structuredError = saveCommandError(saveError);
          if (structuredError?.kind === "conflict") {
            updateExternalChange({
              kind: "changed",
              observedRevision: null,
              dismissed: false,
            });
            setSaveSignal("unsaved");
            return "conflict";
          }
          setError(structuredError?.message ?? errorMessage(saveError));
          setSaveSignal("save-failed");
          return "failed";
        } finally {
          saveInFlightRef.current = null;
          savingRef.current = false;
          setSaving(false);
        }
      })();
      saveInFlightRef.current = task;
      return task;
    },
    [deleteRecoveryDraft, updateExternalChange],
  );

  const reloadCurrentDocument = useCallback(
    async (targetPath: string, targetToken: number): Promise<SaveOutcome> => {
      try {
        const scrollPosition = scrollRef.current?.scrollTop ?? 0;
        const reloaded = await invoke<MarkdownDocument>("read_markdown_file", {
          path: targetPath,
        });
        const current = documentFileRef.current;
        if (
          !current ||
          documentTokenRef.current !== targetToken ||
          comparablePath(current.path) !== comparablePath(targetPath)
        ) {
          return "cancelled";
        }
        if (!(await deleteRecoveryDraft(targetPath))) return "failed";
        draftVersionRef.current += 1;
        documentFileRef.current = reloaded;
        diskContentRef.current = reloaded.content;
        draftContentRef.current = reloaded.content;
        diskRevisionRef.current = reloaded.revision;
        dirtyRef.current = false;
        updateExternalChange(null);
        setDocumentFile(reloaded);
        setDiskContent(reloaded.content);
        setDraftContent(reloaded.content);
        syncPreviewContent(reloaded.content);
        setSaveSignal("saved");
        if (readerModeRef.current === "read") {
          pendingScrollRestoreRef.current = {
            path: reloaded.path,
            position: scrollPosition,
          };
        }
        closeSearch();
        return "reloaded";
      } catch (reloadError) {
        setError(errorMessage(reloadError));
        setSaveSignal("save-failed");
        return "failed";
      }
    },
    [closeSearch, deleteRecoveryDraft, syncPreviewContent, updateExternalChange],
  );

  const resolveExternalConflict = useCallback(async (): Promise<SaveOutcome> => {
    const target = documentFileRef.current;
    const conflict = externalChangeRef.current;
    if (!target || !conflict) return "cancelled";
    if (conflict.kind === "missing") {
      setError("The file no longer exists on disk. Your draft remains protected; Save As is not available in this version.");
      return "failed";
    }

    const targetPath = target.path;
    const targetToken = documentTokenRef.current;
    const conflictChoice = await askDecision({
      title: "Resolve external file change",
      message:
        "The disk file and this document are no longer the same. Your recovery draft will be kept unless a chosen action succeeds.",
      detail: "Overwrite only runs after you explicitly select it; Auto Save never overwrites a conflict.",
      cancelValue: "cancel",
      actions: [
        { label: "Reload", value: "reload" },
        { label: "Overwrite", value: "overwrite", tone: "danger" },
        { label: "Cancel", value: "cancel", autoFocus: true },
      ],
    });
    if (conflictChoice === "cancel") return "cancelled";

    if (conflictChoice === "reload") {
      if (dirtyRef.current) {
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
      }
      return reloadCurrentDocument(targetPath, targetToken);
    }

    if (saveInFlightRef.current) await saveInFlightRef.current;
    const result = await performSave(true);
    return result === "saved" ? "saved" : result === "stale" ? "cancelled" : "failed";
  }, [askDecision, performSave, reloadCurrentDocument]);

  const saveCurrentDocument = useCallback(async (): Promise<SaveOutcome> => {
    if (saveInFlightRef.current) await saveInFlightRef.current;
    if (!documentFileRef.current || !dirtyRef.current) return "saved";
    if (externalChangeRef.current) return resolveExternalConflict();

    const result = await performSave(false);
    if (result === "conflict") return resolveExternalConflict();
    if (result === "saved") return "saved";
    return result === "stale" ? "cancelled" : "failed";
  }, [performSave, resolveExternalConflict]);

  const reloadExternalChange = useCallback(async () => {
    const target = documentFileRef.current;
    if (!target) return;
    if (dirtyRef.current) {
      await resolveExternalConflict();
      return;
    }
    await reloadCurrentDocument(target.path, documentTokenRef.current);
  }, [reloadCurrentDocument, resolveExternalConflict]);

  const dismissExternalChange = useCallback(() => {
    const current = externalChangeRef.current;
    if (current) updateExternalChange({ ...current, dismissed: true });
  }, [updateExternalChange]);

  const runGuardedAction = useCallback(
    async (action: () => Promise<boolean | void>): Promise<boolean> => {
      if (pendingActionRef.current) return false;
      pendingActionRef.current = true;

      try {
        if (saveInFlightRef.current) await saveInFlightRef.current;
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
            if (!(await discardDraft())) return false;
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

  const changeEditLayout = useCallback(
    (editLayout: EditLayout) => {
      if (editLayout !== "editor") syncPreviewContent(draftContentRef.current);
      updateSettings((current) =>
        current.editLayout === editLayout ? current : { ...current, editLayout },
      );
    },
    [syncPreviewContent, updateSettings],
  );

  const commitEditorSplitRatio = useCallback(
    (editorSplitRatio: number) => {
      updateSettings((current) =>
        current.editorSplitRatio === editorSplitRatio
          ? current
          : { ...current, editorSplitRatio },
      );
    },
    [updateSettings],
  );

  const changeAutoSaveEnabled = useCallback(
    (autoSaveEnabled: boolean) => {
      updateSettings((current) => ({ ...current, autoSaveEnabled }));
    },
    [updateSettings],
  );

  const changeAutoSaveDelay = useCallback(
    (autoSaveDelayMs: number) => {
      if (![2000, 3000, 5000, 10000].includes(autoSaveDelayMs)) return;
      updateSettings((current) => ({ ...current, autoSaveDelayMs }));
    },
    [updateSettings],
  );

  const changeReaderMode = useCallback(
    (mode: ReaderMode) => {
      if (mode === "edit" && !documentFileRef.current) return;
      if (readerModeRef.current === mode) return;

      if (mode === "edit") {
        flushCurrentScrollPosition();
        closeSearch();
        if (settingsRef.current.editLayout !== "editor") {
          syncPreviewContent(draftContentRef.current);
        }
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
    [closeSearch, flushCurrentScrollPosition, folderTree, syncPreviewContent],
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
    window.clearTimeout(recoveryTimerRef.current);
    recoveryTimerRef.current = undefined;
    const current = documentFile;
    if (!current) return;

    const path = current.path;
    const token = documentTokenRef.current;
    if (draftContent === diskContent) {
      void deleteRecoveryDraft(path);
      return;
    }

    const draftSnapshot = draftContent;
    const draftVersion = draftVersionRef.current;
    const baseRevision = diskRevisionRef.current;
    recoveryTimerRef.current = window.setTimeout(() => {
      if (
        documentTokenRef.current !== token ||
        comparablePath(documentFileRef.current?.path ?? "") !== comparablePath(path) ||
        draftVersionRef.current !== draftVersion ||
        draftContentRef.current !== draftSnapshot ||
        draftContentRef.current === diskContentRef.current
      ) {
        return;
      }

      recoveryTimerRef.current = undefined;
      void queueRecoveryOperation(() =>
        invoke<RecoveryDraft>("save_recovery_draft", {
          path,
          draftContent: draftSnapshot,
          baseRevision,
        }).then(() => undefined),
      )
        .then(() => {
          if (
            documentTokenRef.current === token &&
            draftVersionRef.current === draftVersion &&
            dirtyRef.current
          ) {
            setRecoveryWarning("");
            setSaveSignal("draft-protected");
          }
        })
        .catch((recoveryError) => {
          if (documentTokenRef.current === token) {
            setRecoveryWarning(
              `Recovery draft protection failed; editing and manual Save are still available: ${errorMessage(
                recoveryError,
              )}`,
            );
          }
        });
    }, RECOVERY_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(recoveryTimerRef.current);
      recoveryTimerRef.current = undefined;
    };
  }, [
    deleteRecoveryDraft,
    diskContent,
    documentFile,
    draftContent,
    queueRecoveryOperation,
  ]);

  useEffect(() => {
    let timer: number | undefined;
    if (
      settings.autoSaveEnabled &&
      documentFile &&
      isDirty &&
      !saving &&
      !externalChange &&
      !decision
    ) {
      const token = documentTokenRef.current;
      const version = draftVersionRef.current;
      timer = window.setTimeout(() => {
        if (
          documentTokenRef.current !== token ||
          draftVersionRef.current !== version ||
          !dirtyRef.current ||
          savingRef.current ||
          externalChangeRef.current ||
          decisionRef.current
        ) {
          return;
        }
        void performSave(false);
      }, settings.autoSaveDelayMs);
    }
    return () => window.clearTimeout(timer);
  }, [
    decision,
    documentFile,
    draftContent,
    externalChange,
    isDirty,
    performSave,
    saving,
    settings.autoSaveDelayMs,
    settings.autoSaveEnabled,
  ]);

  useEffect(() => {
    const current = documentFile;
    if (!current) return;
    const path = current.path;
    const token = documentTokenRef.current;
    let interval: number | undefined;
    let checkInProgress = false;
    let stopped = false;

    const check = async () => {
      if (stopped || checkInProgress || document.visibilityState !== "visible") return;
      checkInProgress = true;
      try {
        const latest = await invoke<FileRevision>("get_file_revision", { path });
        if (
          stopped ||
          documentTokenRef.current !== token ||
          comparablePath(documentFileRef.current?.path ?? "") !== comparablePath(path)
        ) {
          return;
        }

        const observed = externalChangeRef.current;
        if (latest.status === "missing") {
          if (observed?.kind !== "missing") {
            updateExternalChange({
              kind: "missing",
              observedRevision: null,
              dismissed: false,
            });
          }
          return;
        }

        if (latest.revision === diskRevisionRef.current) {
          if (observed && !observed.recoveryBaseMismatch) updateExternalChange(null);
          return;
        }
        if (
          observed?.kind === "changed" &&
          observed.observedRevision === latest.revision
        ) {
          return;
        }
        updateExternalChange({
          kind: "changed",
          observedRevision: latest.revision,
          dismissed: false,
        });
      } catch {
        // A transient revision check failure must not interrupt editing or saving.
      } finally {
        checkInProgress = false;
      }
    };

    const start = () => {
      window.clearInterval(interval);
      if (document.visibilityState !== "visible") return;
      void check();
      interval = window.setInterval(() => void check(), EXTERNAL_CHECK_INTERVAL_MS);
    };
    const handleVisibility = () => start();
    const handleFocus = () => void check();
    start();
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("focus", handleFocus);
    return () => {
      stopped = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("focus", handleFocus);
    };
  }, [documentFile, updateExternalChange]);

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

      if (dirtyRef.current) {
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
          event.preventDefault();
          const shouldClose =
            !dirtyRef.current || (await runGuardedAction(async () => true));
          if (shouldClose) await invoke<void>("exit_application");
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
        saveStatus={saveStatus}
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

          {recoveryWarning && (
            <div className="error-banner recovery-warning" role="status">
              <AlertCircle size={17} />
              <span>{recoveryWarning}</span>
              <button
                type="button"
                onClick={() => setRecoveryWarning("")}
                aria-label="Dismiss recovery warning"
              >
                <X size={16} />
              </button>
            </div>
          )}

          {notice && (
            <div className="file-change-banner is-notice" role="status">
              <span>{notice}</span>
              <button type="button" onClick={() => setNotice("")}>Dismiss</button>
            </div>
          )}

          {externalChange && !externalChange.dismissed && (
            <div className="file-change-banner" role="status" aria-live="polite">
              <span>
                {externalChange.kind === "missing"
                  ? "File no longer exists on disk. Your draft and recovery data are being kept."
                  : isDirty
                    ? settings.autoSaveEnabled
                      ? "File changed externally — Auto Save paused"
                      : "File changed externally — resolve before saving"
                    : "File changed on disk"}
              </span>
              {externalChange.kind === "changed" && (
                <button type="button" onClick={() => void reloadExternalChange()}>
                  {isDirty ? "Resolve" : "Reload"}
                </button>
              )}
              <button type="button" onClick={dismissExternalChange}>Dismiss</button>
            </div>
          )}

          {documentFile ? (
            readerMode === "edit" ? (
              <EditWorkspace
                content={draftContent}
                previewContent={previewContent}
                documentPath={documentFile.path}
                theme={resolvedTheme}
                layout={settings.editLayout}
                splitRatio={settings.editorSplitRatio}
                autoSaveEnabled={settings.autoSaveEnabled}
                autoSaveDelayMs={settings.autoSaveDelayMs}
                saveStatus={saveStatus}
                onChange={updateDraftContent}
                onLayoutChange={changeEditLayout}
                onSplitRatioCommit={commitEditorSplitRatio}
                onAutoSaveEnabledChange={changeAutoSaveEnabled}
                onAutoSaveDelayChange={changeAutoSaveDelay}
                onOpenMarkdown={(path) => void openDocument(path)}
              />
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
