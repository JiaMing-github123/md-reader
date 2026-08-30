import { FileText, FolderOpen, Monitor, Moon, Search, Sun } from "lucide-react";
import type { ThemeMode } from "../types";

const themeDetails = {
  system: { label: "System theme", icon: Monitor },
  light: { label: "Light theme", icon: Sun },
  dark: { label: "Dark theme", icon: Moon },
} satisfies Record<ThemeMode, { label: string; icon: typeof Monitor }>;

interface TopBarProps {
  filename?: string;
  filePath?: string;
  theme: ThemeMode;
  canSearch: boolean;
  onOpenFile: () => void;
  onOpenFolder: () => void;
  onSearch: () => void;
  onCycleTheme: () => void;
}

export function TopBar({
  filename,
  filePath,
  theme,
  canSearch,
  onOpenFile,
  onOpenFolder,
  onSearch,
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
        {filename ?? "No document open"}
      </div>
      <div className="top-bar__actions">
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
