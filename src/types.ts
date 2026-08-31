export type ThemeMode = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";
export type ReaderMode = "read" | "edit";
export type EditLayout = "editor" | "split" | "preview";

export interface RecentFile {
  path: string;
  name: string;
  openedAt: number;
}

export interface WindowSize {
  width: number;
  height: number;
}

export interface ReaderSettings {
  theme: ThemeMode;
  fontSize: number;
  autoSaveEnabled: boolean;
  autoSaveDelayMs: number;
  editLayout: EditLayout;
  editorSplitRatio: number;
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  windowSize: WindowSize;
  recentFiles: RecentFile[];
  lastFolderPath: string | null;
  lastFilePath: string | null;
  scrollPositions: Record<string, number>;
}

export interface MarkdownDocument {
  path: string;
  name: string;
  content: string;
  revision: string;
}

export interface RecoveryDraft {
  canonicalPath: string;
  filename: string;
  draftContent: string;
  baseRevision: string;
  updatedTimestamp: number;
  appVersion: string;
  schemaVersion: number;
}

export interface FileRevision {
  status: "exists" | "missing";
  revision: string | null;
}

export interface TocItem {
  id: string;
  text: string;
  level: 1 | 2 | 3;
}

export interface FileTreeNode {
  name: string;
  path: string;
  kind: "folder" | "file";
  children: FileTreeNode[];
}

export type SidebarTab = "files" | "contents";
