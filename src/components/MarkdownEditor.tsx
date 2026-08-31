import { useCallback, useRef } from "react";

const TAB_TEXT = "  ";

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
}

export function MarkdownEditor({ value, onChange }: MarkdownEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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
        autoFocus
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
      />
    </div>
  );
}
