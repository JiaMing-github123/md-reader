export type ThemeMode = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

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
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  windowSize: WindowSize;
  recentFiles: RecentFile[];
}

export interface MarkdownDocument {
  path: string;
  name: string;
  content: string;
}

export interface TocItem {
  id: string;
  text: string;
  level: 1 | 2 | 3;
}

