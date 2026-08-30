import type { ReaderSettings, RecentFile, ThemeMode } from "../types";

const STORAGE_KEY = "md-reader.settings.v1";
const MAX_RECENT_FILES = 10;

export const DEFAULT_SETTINGS: ReaderSettings = {
  theme: "system",
  fontSize: 17,
  sidebarWidth: 272,
  sidebarCollapsed: false,
  windowSize: { width: 1180, height: 760 },
  recentFiles: [],
};

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(Math.max(value, minimum), maximum);

const isTheme = (value: unknown): value is ThemeMode =>
  value === "system" || value === "light" || value === "dark";

const isRecentFile = (value: unknown): value is RecentFile => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RecentFile>;
  return (
    typeof candidate.path === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.openedAt === "number"
  );
};

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

