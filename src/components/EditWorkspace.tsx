import {
  Component,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import type { EditLayout, ResolvedTheme } from "../types";
import {
  MarkdownEditor,
  type MarkdownEditorHandle,
  type MarkdownEditorViewState,
} from "./MarkdownEditor";
import { MarkdownView } from "./MarkdownView";

const MIN_SPLIT_RATIO = 0.3;
const MAX_SPLIT_RATIO = 0.7;
const DEFAULT_SPLIT_RATIO = 0.5;
const SPLITTER_SIZE = 8;
const STACKED_BREAKPOINT = 720;
const KEYBOARD_RATIO_STEP = 0.02;

const EMPTY_EDITOR_VIEW: MarkdownEditorViewState = {
  selectionStart: 0,
  selectionEnd: 0,
  scrollTop: 0,
};

const clampSplitRatio = (ratio: number) =>
  Math.min(Math.max(ratio, MIN_SPLIT_RATIO), MAX_SPLIT_RATIO);

interface PreviewErrorBoundaryProps {
  children: ReactNode;
  resetKey: string;
}

interface PreviewErrorBoundaryState {
  failed: boolean;
}

class PreviewErrorBoundary extends Component<
  PreviewErrorBoundaryProps,
  PreviewErrorBoundaryState
> {
  state: PreviewErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): PreviewErrorBoundaryState {
    return { failed: true };
  }

  componentDidUpdate(previous: PreviewErrorBoundaryProps) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) {
      this.setState({ failed: false });
    }
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="edit-preview__error" role="alert">
          Preview could not be updated. Your Markdown draft is unchanged.
        </div>
      );
    }
    return this.props.children;
  }
}

interface EditWorkspaceProps {
  content: string;
  previewContent: string;
  documentPath: string;
  theme: ResolvedTheme;
  layout: EditLayout;
  splitRatio: number;
  autoSaveEnabled: boolean;
  autoSaveDelayMs: number;
  saveStatus: string;
  onChange: (content: string) => void;
  onLayoutChange: (layout: EditLayout) => void;
  onSplitRatioCommit: (ratio: number) => void;
  onAutoSaveEnabledChange: (enabled: boolean) => void;
  onAutoSaveDelayChange: (delayMs: number) => void;
  onOpenMarkdown: (path: string) => void;
}

export function EditWorkspace({
  content,
  previewContent,
  documentPath,
  theme,
  layout,
  splitRatio,
  autoSaveEnabled,
  autoSaveDelayMs,
  saveStatus,
  onChange,
  onLayoutChange,
  onSplitRatioCommit,
  onAutoSaveEnabledChange,
  onAutoSaveDelayChange,
  onOpenMarkdown,
}: EditWorkspaceProps) {
  const [displayRatio, setDisplayRatio] = useState(() => clampSplitRatio(splitRatio));
  const [stacked, setStacked] = useState(false);
  const panesRef = useRef<HTMLDivElement>(null);
  const previewScrollRef = useRef<HTMLDivElement>(null);
  const previewArticleRef = useRef<HTMLElement>(null);
  const editorRef = useRef<MarkdownEditorHandle>(null);
  const editorViewRef = useRef<MarkdownEditorViewState>(EMPTY_EDITOR_VIEW);
  const previewScrollTopRef = useRef(0);
  const ratioRef = useRef(displayRatio);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const previousDocumentPathRef = useRef(documentPath);

  useEffect(() => {
    const nextRatio = clampSplitRatio(splitRatio);
    ratioRef.current = nextRatio;
    setDisplayRatio(nextRatio);
  }, [splitRatio]);

  useLayoutEffect(() => {
    if (previousDocumentPathRef.current === documentPath) return;
    previousDocumentPathRef.current = documentPath;
    editorViewRef.current = EMPTY_EDITOR_VIEW;
    previewScrollTopRef.current = 0;
    editorRef.current?.resetViewState();
    if (previewScrollRef.current) previewScrollRef.current.scrollTop = 0;
  }, [documentPath]);

  useLayoutEffect(() => {
    const panes = panesRef.current;
    if (!panes || typeof ResizeObserver === "undefined") return;

    const updateOrientation = () => {
      setStacked(panes.clientWidth < STACKED_BREAKPOINT);
    };
    updateOrientation();
    const observer = new ResizeObserver(updateOrientation);
    observer.observe(panes);
    return () => observer.disconnect();
  }, []);

  useEffect(
    () => () => {
      dragCleanupRef.current?.();
    },
    [],
  );

  const captureViewState = useCallback(() => {
    if (layout !== "preview" && editorRef.current) {
      editorViewRef.current = editorRef.current.getViewState();
    }
    if (layout !== "editor" && previewScrollRef.current) {
      previewScrollTopRef.current = previewScrollRef.current.scrollTop;
    }
  }, [layout]);

  const restoreVisibleViewState = useCallback((nextLayout: EditLayout) => {
    requestAnimationFrame(() => {
      if (nextLayout !== "preview") {
        editorRef.current?.restoreViewState(editorViewRef.current, nextLayout === "editor");
      }
      if (nextLayout !== "editor" && previewScrollRef.current) {
        previewScrollRef.current.scrollTop = previewScrollTopRef.current;
      }
    });
  }, []);

  const changeLayout = useCallback(
    (nextLayout: EditLayout) => {
      if (nextLayout === layout) return;
      captureViewState();
      onLayoutChange(nextLayout);
      restoreVisibleViewState(nextLayout);
    }, [captureViewState, layout, onLayoutChange, restoreVisibleViewState],
  );

  const setTransientRatio = useCallback((ratio: number) => {
    const nextRatio = clampSplitRatio(ratio);
    ratioRef.current = nextRatio;
    setDisplayRatio(nextRatio);
  }, []);

  const commitRatio = useCallback(
    (ratio: number) => {
      const nextRatio = clampSplitRatio(ratio);
      setTransientRatio(nextRatio);
      onSplitRatioCommit(nextRatio);
    },
    [onSplitRatioCommit, setTransientRatio],
  );

  const handleSplitterPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      const panes = panesRef.current;
      if (!panes) return;

      event.preventDefault();
      event.currentTarget.focus({ preventScroll: true });
      dragCleanupRef.current?.();

      const pointerId = event.pointerId;
      const bounds = panes.getBoundingClientRect();
      document.documentElement.classList.add("is-resizing-editor-split");

      const handlePointerMove = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== pointerId) return;
        moveEvent.preventDefault();
        const availableSize = Math.max(
          (stacked ? bounds.height : bounds.width) - SPLITTER_SIZE,
          1,
        );
        const pointerPosition = stacked
          ? moveEvent.clientY - bounds.top - SPLITTER_SIZE / 2
          : moveEvent.clientX - bounds.left - SPLITTER_SIZE / 2;
        setTransientRatio(pointerPosition / availableSize);
      };

      function cleanupPointerDrag() {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", finishPointerDrag);
        window.removeEventListener("pointercancel", finishPointerDrag);
        document.documentElement.classList.remove("is-resizing-editor-split");
        dragCleanupRef.current = null;
      }

      function finishPointerDrag(upEvent: PointerEvent) {
        if (upEvent.pointerId !== pointerId) return;
        cleanupPointerDrag();
        commitRatio(ratioRef.current);
      }

      dragCleanupRef.current = cleanupPointerDrag;
      window.addEventListener("pointermove", handlePointerMove, { passive: false });
      window.addEventListener("pointerup", finishPointerDrag);
      window.addEventListener("pointercancel", finishPointerDrag);
    },
    [commitRatio, setTransientRatio, stacked],
  );

  const handleSplitterKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      let change = 0;
      if (event.key === "ArrowLeft" || (stacked && event.key === "ArrowUp")) {
        change = -KEYBOARD_RATIO_STEP;
      } else if (event.key === "ArrowRight" || (stacked && event.key === "ArrowDown")) {
        change = KEYBOARD_RATIO_STEP;
      }
      if (!change) return;
      event.preventDefault();
      commitRatio(ratioRef.current + change);
    },
    [commitRatio, stacked],
  );

  const editorPaneSize = `calc(${displayRatio * 100}% - ${
    SPLITTER_SIZE * displayRatio
  }px)`;
  const panesStyle = { "--editor-pane-size": editorPaneSize } as CSSProperties;

  return (
    <section className="edit-workspace" aria-label="Markdown editing workspace">
      <div className="edit-layout-toolbar">
        <div className="edit-layout-toolbar__group">
          <span>Edit layout</span>
          <div className="edit-layout-toolbar__options" role="group" aria-label="Edit layout">
            {(["editor", "split", "preview"] as const).map((option) => (
              <button
                key={option}
                type="button"
                className={layout === option ? "is-active" : undefined}
                aria-pressed={layout === option}
                onClick={() => changeLayout(option)}
              >
                {option[0].toUpperCase() + option.slice(1)}
              </button>
            ))}
          </div>
        </div>
        <div className="edit-layout-toolbar__autosave">
          <label>
            <input
              type="checkbox"
              checked={autoSaveEnabled}
              onChange={(event) => onAutoSaveEnabledChange(event.currentTarget.checked)}
            />
            <span>Auto Save</span>
          </label>
          <select
            value={autoSaveDelayMs}
            disabled={!autoSaveEnabled}
            aria-label="Auto Save delay"
            onChange={(event) => onAutoSaveDelayChange(Number(event.currentTarget.value))}
          >
            <option value={2000}>2s</option>
            <option value={3000}>3s</option>
            <option value={5000}>5s</option>
            <option value={10000}>10s</option>
          </select>
          <span className="edit-layout-toolbar__status" aria-live="polite">
            {saveStatus}
          </span>
        </div>
      </div>

      <div
        ref={panesRef}
        className={`edit-panes is-${layout}${stacked ? " is-stacked" : ""}`}
        style={panesStyle}
      >
        <div className="edit-pane edit-pane--editor" aria-hidden={layout === "preview"}>
          <MarkdownEditor
            ref={editorRef}
            value={content}
            onChange={onChange}
            visible={layout !== "preview"}
          />
        </div>

        <div
          className="edit-splitter"
          role="separator"
          aria-label="Resize editor and preview"
          aria-orientation={stacked ? "horizontal" : "vertical"}
          aria-valuemin={30}
          aria-valuemax={70}
          aria-valuenow={Math.round(displayRatio * 100)}
          tabIndex={layout === "split" ? 0 : -1}
          onPointerDown={handleSplitterPointerDown}
          onKeyDown={handleSplitterKeyDown}
          onDoubleClick={() => commitRatio(DEFAULT_SPLIT_RATIO)}
        />

        <div
          ref={previewScrollRef}
          className="edit-pane edit-pane--preview"
          aria-label="Markdown preview"
          aria-hidden={layout === "editor"}
          onScroll={(event) => {
            // Unmounting the hidden article may reset its pane's scroll position.
            if (layout !== "editor") {
              previewScrollTopRef.current = event.currentTarget.scrollTop;
            }
          }}
        >
          {layout !== "editor" && (
            <PreviewErrorBoundary resetKey={`${documentPath}\u0000${previewContent}`}>
              <MarkdownView
                content={previewContent}
                documentPath={documentPath}
                theme={theme}
                articleRef={previewArticleRef}
                scrollRef={previewScrollRef}
                onOpenMarkdown={onOpenMarkdown}
              />
            </PreviewErrorBoundary>
          )}
        </div>
      </div>
    </section>
  );
}
