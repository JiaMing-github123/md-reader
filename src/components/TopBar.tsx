import {
  BookOpen,
  FileText,
  FolderOpen,
  LoaderCircle,
  Monitor,
  Moon,
  Pencil,
  Save,
  Search,
  Sun,
} from "lucide-react";
import type { ReaderMode, ThemeMode } from "../types";

const themeDetails = {
  system: { label: "System theme", icon: Monitor },
  light: { label: "Light theme", icon: Sun },
  dark: { label: "Dark theme", icon: Moon },
} satisfies Record<ThemeMode, { label: string; icon: typeof Monitor }>;

interface TopBarProps {
  filename?: string;
  filePath?: string;
  theme: ThemeMode;
  readerMode: ReaderMode;
  dirty: boolean;
  saving: boolean;
  canSearch: boolean;
  canEdit: boolean;
  onOpenFile: () => void;
  onOpenFolder: () => void;
  onSearch: () => void;
  onSave: () => void;
  onModeChange: (mode: ReaderMode) => void;
  onCycleTheme: () => void;
}

export function TopBar({
  filename,
  filePath,
  theme,
  readerMode,
  dirty,
  saving,
  canSearch,
  canEdit,
  onOpenFile,
  onOpenFolder,
  onSearch,
  onSave,
  onModeChange,
  onCycleTheme,
}: TopBarProps) {
  const ThemeIcon = themeDetails[theme].icon;

  return (
    <header className="top-bar">
      <div className="top-bar__brand" aria-label="MD Reader">
        <FileText size={19} />
        <span>MD Reader</span>
      </div>
      <button
        className="top-bar__primary"
        type="button"
        onClick={onOpenFile}
        title="Open file (Ctrl+O)"
      >
        <FileText size={16} />
        <span>Open File</span>
      </button>
      <button
        className="top-bar__primary"
        type="button"
        onClick={onOpenFolder}
        title="Open folder (Ctrl+Shift+O)"
      >
        <FolderOpen size={16} />
        <span>Open Folder</span>
      </button>
      <div className="top-bar__filename" title={filePath}>
        <span>{filename ?? "No document open"}</span>
        {dirty && (
          <span className="top-bar__dirty" title="Unsaved changes" aria-label="Unsaved changes">
            ●
          </span>
        )}
      </div>
      <div className="top-bar__mode" role="group" aria-label="Reader mode">
        <button
          type="button"
          className={readerMode === "read" ? "is-active" : undefined}
          aria-pressed={readerMode === "read"}
          onClick={() => onModeChange("read")}
          title="Read and preview the current draft"
        >
          <BookOpen size={15} />
          <span>Read</span>
        </button>
        <button
          type="button"
          className={readerMode === "edit" ? "is-active" : undefined}
          aria-pressed={readerMode === "edit"}
          disabled={!canEdit}
          onClick={() => onModeChange("edit")}
          title="Edit Markdown"
        >
          <Pencil size={14} />
          <span>Edit</span>
        </button>
      </div>
      <div className="top-bar__actions">
        <button
          type="button"
          onClick={onSave}
          disabled={!dirty || saving}
          title={saving ? "Saving…" : "Save (Ctrl+S)"}
          aria-label={saving ? "Saving document" : "Save document"}
        >
          {saving ? <LoaderCircle className="is-spinning" size={17} /> : <Save size={17} />}
        </button>
        <button
          type="button"
          onClick={onSearch}
          disabled={!canSearch}
          title="Find in document (Ctrl+F)"
          aria-label="Find in document"
        >
          <Search size={17} />
        </button>
        <button
          type="button"
          onClick={onCycleTheme}
          title={`${themeDetails[theme].label} — click to change`}
          aria-label={`${themeDetails[theme].label}. Change theme.`}
        >
          <ThemeIcon size={17} />
        </button>
      </div>
    </header>
  );
}
