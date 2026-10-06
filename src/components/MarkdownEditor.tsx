import {
  forwardRef,
  memo,
  useCallback,
  useImperativeHandle,
  useRef,
} from "react";

const TAB_TEXT = "  ";

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  visible: boolean;
}

export interface MarkdownEditorViewState {
  selectionStart: number;
  selectionEnd: number;
  scrollTop: number;
}

export interface MarkdownEditorHandle {
  getViewState: () => MarkdownEditorViewState;
  restoreViewState: (state: MarkdownEditorViewState, focus?: boolean) => void;
  resetViewState: () => void;
}

const EMPTY_VIEW_STATE: MarkdownEditorViewState = {
  selectionStart: 0,
  selectionEnd: 0,
  scrollTop: 0,
};

export const MarkdownEditor = memo(forwardRef<MarkdownEditorHandle, MarkdownEditorProps>(
  function MarkdownEditor({ value, onChange, visible }, ref) {
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    useImperativeHandle(
      ref,
      () => ({
        getViewState: () => {
          const textarea = textareaRef.current;
          if (!textarea) return EMPTY_VIEW_STATE;
          return {
            selectionStart: textarea.selectionStart,
            selectionEnd: textarea.selectionEnd,
            scrollTop: textarea.scrollTop,
          };
        },
        restoreViewState: (state, focus = false) => {
          const textarea = textareaRef.current;
          if (!textarea) return;
          const maximum = textarea.value.length;
          textarea.selectionStart = Math.min(state.selectionStart, maximum);
          textarea.selectionEnd = Math.min(state.selectionEnd, maximum);
          textarea.scrollTop = state.scrollTop;
          if (focus) textarea.focus({ preventScroll: true });
        },
        resetViewState: () => {
          const textarea = textareaRef.current;
          if (!textarea) return;
          textarea.selectionStart = 0;
          textarea.selectionEnd = 0;
          textarea.scrollTop = 0;
        },
      }),
      [],
    );

    const handleKeyDown = useCallback(
      (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (event.key !== "Tab" || event.ctrlKey || event.altKey || event.metaKey) return;

        event.preventDefault();
        const textarea = event.currentTarget;
        const selectionStart = textarea.selectionStart;
        const selectionEnd = textarea.selectionEnd;
        const nextValue = `${value.slice(0, selectionStart)}${TAB_TEXT}${value.slice(selectionStart)}`;
        onChange(nextValue);

        requestAnimationFrame(() => {
          const nextTextarea = textareaRef.current;
          if (!nextTextarea) return;
          nextTextarea.selectionStart = selectionStart + TAB_TEXT.length;
          nextTextarea.selectionEnd = selectionEnd + TAB_TEXT.length;
        });
      },
      [onChange, value],
    );

    return (
      <div className="markdown-editor">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => onChange(event.currentTarget.value)}
          onKeyDown={handleKeyDown}
          aria-label="Markdown editor"
          autoFocus={visible}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          tabIndex={visible ? 0 : -1}
        />
      </div>
    );
  },
));
