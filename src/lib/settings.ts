import type { EditLayout, ReaderSettings, RecentFile, ThemeMode } from "../types";

const STORAGE_KEY = "md-reader.settings.v1";
const MAX_RECENT_FILES = 10;
const MAX_SCROLL_POSITIONS = 50;
export const AUTO_SAVE_DELAYS = [2000, 3000, 5000, 10000] as const;

export const DEFAULT_SETTINGS: ReaderSettings = {
  theme: "system",
  fontSize: 17,
  autoSaveEnabled: false,
  autoSaveDelayMs: 3000,
  editLayout: "split",
  editorSplitRatio: 0.5,
  sidebarWidth: 272,
  sidebarCollapsed: false,
  windowSize: { width: 1180, height: 760 },
  recentFiles: [],
  lastFolderPath: null,
  lastFilePath: null,
  scrollPositions: {},
};

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(Math.max(value, minimum), maximum);

const isTheme = (value: unknown): value is ThemeMode =>
  value === "system" || value === "light" || value === "dark";

const isEditLayout = (value: unknown): value is EditLayout =>
  value === "editor" || value === "split" || value === "preview";

const isRecentFile = (value: unknown): value is RecentFile => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RecentFile>;
  return (
    typeof candidate.path === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.openedAt === "number"
  );
};

function loadScrollPositions(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  const validEntries = Object.entries(value)
    .filter(
      (entry): entry is [string, number] =>
        entry[0].trim().length > 0 &&
        typeof entry[1] === "number" &&
        Number.isFinite(entry[1]) &&
        entry[1] >= 0,
    )
    .slice(-MAX_SCROLL_POSITIONS)
    .map(([path, position]) => [path, Math.round(position)] as const);

  return Object.fromEntries(validEntries);
}

export function loadSettings(): ReaderSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;

    const stored = JSON.parse(raw) as Partial<ReaderSettings>;
    return {
      theme: isTheme(stored.theme) ? stored.theme : DEFAULT_SETTINGS.theme,
      fontSize:
        typeof stored.fontSize === "number"
          ? clamp(stored.fontSize, 14, 24)
          : DEFAULT_SETTINGS.fontSize,
      autoSaveEnabled:
        typeof stored.autoSaveEnabled === "boolean"
          ? stored.autoSaveEnabled
          : DEFAULT_SETTINGS.autoSaveEnabled,
      autoSaveDelayMs: AUTO_SAVE_DELAYS.includes(
        stored.autoSaveDelayMs as (typeof AUTO_SAVE_DELAYS)[number],
      )
        ? (stored.autoSaveDelayMs as (typeof AUTO_SAVE_DELAYS)[number])
        : DEFAULT_SETTINGS.autoSaveDelayMs,
      editLayout: isEditLayout(stored.editLayout)
        ? stored.editLayout
        : DEFAULT_SETTINGS.editLayout,
      editorSplitRatio:
        typeof stored.editorSplitRatio === "number" &&
        Number.isFinite(stored.editorSplitRatio)
          ? clamp(stored.editorSplitRatio, 0.3, 0.7)
          : DEFAULT_SETTINGS.editorSplitRatio,
      sidebarWidth:
        typeof stored.sidebarWidth === "number"
          ? clamp(stored.sidebarWidth, 200, 420)
          : DEFAULT_SETTINGS.sidebarWidth,
      sidebarCollapsed:
        typeof stored.sidebarCollapsed === "boolean"
          ? stored.sidebarCollapsed
          : DEFAULT_SETTINGS.sidebarCollapsed,
      windowSize: {
        width:
          typeof stored.windowSize?.width === "number"
            ? clamp(stored.windowSize.width, 720, 3840)
            : DEFAULT_SETTINGS.windowSize.width,
        height:
          typeof stored.windowSize?.height === "number"
            ? clamp(stored.windowSize.height, 480, 2160)
            : DEFAULT_SETTINGS.windowSize.height,
      },
      recentFiles: Array.isArray(stored.recentFiles)
        ? stored.recentFiles.filter(isRecentFile).slice(0, MAX_RECENT_FILES)
        : [],
      lastFolderPath:
        typeof stored.lastFolderPath === "string" && stored.lastFolderPath.trim()
          ? stored.lastFolderPath
          : null,
      lastFilePath:
        typeof stored.lastFilePath === "string" && stored.lastFilePath.trim()
          ? stored.lastFilePath
          : null,
      scrollPositions: loadScrollPositions(stored.scrollPositions),
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: ReaderSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // The reader remains usable if storage is unavailable.
  }
}

export function rememberScrollPosition(
  scrollPositions: Record<string, number>,
  canonicalPath: string,
  position: number,
): Record<string, number> {
  const path = canonicalPath.trim();
  if (!path || !Number.isFinite(position)) return scrollPositions;

  const entries = Object.entries(scrollPositions).filter(([storedPath]) => storedPath !== path);
  entries.push([path, Math.max(0, Math.round(position))]);
  return Object.fromEntries(entries.slice(-MAX_SCROLL_POSITIONS));
}

export function addRecentFile(
  recentFiles: RecentFile[],
  file: Omit<RecentFile, "openedAt">,
): RecentFile[] {
  const normalizedPath = file.path.toLocaleLowerCase();
  return [
    { ...file, openedAt: Date.now() },
    ...recentFiles.filter(
      (recent) => recent.path.toLocaleLowerCase() !== normalizedPath,
    ),
  ].slice(0, MAX_RECENT_FILES);
}
