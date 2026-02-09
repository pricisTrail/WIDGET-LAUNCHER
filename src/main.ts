import { emitTo, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";

type ThemeId = "midnight" | "dark-purple" | "forest" | "rose" | "amber" | "slate";
type TimeFormat = "12h" | "24h";

type DayWindow = {
  startMinutes: number;
  endMinutes: number;
};

type DayOverride = DayWindow & {
  enabled: boolean;
};

type WidgetSettings = {
  theme: ThemeId;
  timeFormat: TimeFormat;
  showSeconds: boolean;
  showPercent: boolean;
  runOnStartup: boolean;
  weekday: DayWindow;
  weekend: DayWindow;
  overrides: DayOverride[];
};

type OverrideRow = {
  enabled: HTMLInputElement;
  start: HTMLInputElement;
  end: HTMLInputElement;
};

type ResizeDirection =
  | "East"
  | "North"
  | "NorthEast"
  | "NorthWest"
  | "South"
  | "SouthEast"
  | "SouthWest"
  | "West";

const THEME_IDS = ["midnight", "dark-purple", "forest", "rose", "amber", "slate"] as const;
const RESIZE_DIRECTIONS = [
  "East",
  "North",
  "NorthEast",
  "NorthWest",
  "South",
  "SouthEast",
  "SouthWest",
  "West",
] as const;

const STORAGE_KEY = "widget-launcher.settings.v2";
const LEGACY_STORAGE_KEY = "widget-launcher.settings.v1";
const MAIN_WINDOW_LABEL = "main";
const SETTINGS_WINDOW_LABEL = "settings";
const SETTINGS_REFRESH_EVENT = "settings-window:refresh";
const WIDGET_RESTART_EVENT = "widget:restart";
const AUTOSTART_ENABLE_COMMAND = "plugin:autostart|enable";
const AUTOSTART_DISABLE_COMMAND = "plugin:autostart|disable";
const AUTOSTART_IS_ENABLED_COMMAND = "plugin:autostart|is_enabled";
const SETTINGS_WINDOW_TITLE = "Widget Settings";
const SETTINGS_WIDTH = 430;
const SETTINGS_HEIGHT = 640;
const DRAG_THRESHOLD_PX = 5;
const TAP_WINDOW_MS = 550;

const DEFAULT_WEEKDAY: DayWindow = {
  startMinutes: 9 * 60,
  endMinutes: 18 * 60,
};

const DEFAULT_WEEKEND: DayWindow = {
  startMinutes: 10 * 60,
  endMinutes: 17 * 60 + 30,
};

function defaultOverrides(): DayOverride[] {
  return Array.from({ length: 7 }, (_, day) => ({
    enabled: false,
    ...(day === 0 || day === 6 ? DEFAULT_WEEKEND : DEFAULT_WEEKDAY),
  }));
}

const DEFAULT_SETTINGS: WidgetSettings = {
  theme: "midnight",
  timeFormat: "12h",
  showSeconds: false,
  showPercent: true,
  runOnStartup: false,
  weekday: { ...DEFAULT_WEEKDAY },
  weekend: { ...DEFAULT_WEEKEND },
  overrides: defaultOverrides(),
};

function queryElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing element: ${selector}`);
  }
  return element;
}

function parseTimeToMinutes(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) {
    return null;
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

function minutesToTime(value: number): string {
  const normalized = ((value % 1440) + 1440) % 1440;
  const hours = String(Math.floor(normalized / 60)).padStart(2, "0");
  const minutes = String(normalized % 60).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function isValidMinutes(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value < 1440;
}

function cloneSettings(source: WidgetSettings): WidgetSettings {
  return {
    theme: source.theme,
    timeFormat: source.timeFormat,
    showSeconds: source.showSeconds,
    showPercent: source.showPercent,
    runOnStartup: source.runOnStartup,
    weekday: { ...source.weekday },
    weekend: { ...source.weekend },
    overrides: source.overrides.map((entry) => ({ ...entry })),
  };
}

function parseTheme(value: unknown): ThemeId {
  if (typeof value === "string" && (THEME_IDS as readonly string[]).includes(value)) {
    return value as ThemeId;
  }
  return DEFAULT_SETTINGS.theme;
}

function parseTimeFormat(value: unknown): TimeFormat {
  return value === "24h" ? "24h" : "12h";
}

function normalizeDayWindow(candidate: unknown, fallback: DayWindow): DayWindow {
  if (!candidate || typeof candidate !== "object") {
    return { ...fallback };
  }

  const entry = candidate as Partial<DayWindow>;
  const start = Number(entry.startMinutes);
  const end = Number(entry.endMinutes);

  if (isValidMinutes(start) && isValidMinutes(end) && start !== end) {
    return { startMinutes: start, endMinutes: end };
  }

  return { ...fallback };
}

function normalizeOverride(candidate: unknown, fallback: DayWindow): DayOverride {
  if (!candidate || typeof candidate !== "object") {
    return { enabled: false, ...fallback };
  }

  const entry = candidate as Partial<DayOverride>;
  const window = normalizeDayWindow(entry, fallback);
  return { enabled: entry.enabled === true, ...window };
}

function parseModernSettings(value: unknown): WidgetSettings | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const source = value as Record<string, unknown>;
  const weekday = normalizeDayWindow(source.weekday, DEFAULT_WEEKDAY);
  const weekend = normalizeDayWindow(source.weekend, DEFAULT_WEEKEND);
  const overridesSource = Array.isArray(source.overrides) ? source.overrides : [];

  return {
    theme: parseTheme(source.theme),
    timeFormat: parseTimeFormat(source.timeFormat),
    showSeconds: source.showSeconds === true,
    showPercent: source.showPercent !== false,
    runOnStartup: source.runOnStartup === true,
    weekday,
    weekend,
    overrides: Array.from({ length: 7 }, (_, day) => {
      const fallback = day === 0 || day === 6 ? weekend : weekday;
      return normalizeOverride(overridesSource[day], fallback);
    }),
  };
}

function parseLegacySettings(value: unknown): WidgetSettings | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const source = value as Record<string, unknown>;
  const start = Number(source.startMinutes);
  const end = Number(source.endMinutes);
  if (!isValidMinutes(start) || !isValidMinutes(end) || start === end) {
    return null;
  }

  const migrated = cloneSettings(DEFAULT_SETTINGS);
  migrated.weekday = { startMinutes: start, endMinutes: end };
  migrated.weekend = { startMinutes: start, endMinutes: end };
  migrated.overrides = defaultOverrides().map((entry) => ({
    ...entry,
    startMinutes: start,
    endMinutes: end,
  }));
  return migrated;
}

function loadSettings(): WidgetSettings {
  try {
    const modernRaw = localStorage.getItem(STORAGE_KEY);
    if (modernRaw) {
      const parsed = parseModernSettings(JSON.parse(modernRaw));
      if (parsed) {
        return parsed;
      }
    }
  } catch {
    // Ignore invalid persisted data.
  }

  try {
    const legacyRaw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacyRaw) {
      const parsed = parseLegacySettings(JSON.parse(legacyRaw));
      if (parsed) {
        return parsed;
      }
    }
  } catch {
    // Ignore invalid legacy data.
  }

  return cloneSettings(DEFAULT_SETTINGS);
}

function saveSettings(settings: WidgetSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

function isWeekendDay(day: number): boolean {
  return day === 0 || day === 6;
}

function getConfiguredWindow(day: number, settings: WidgetSettings): DayWindow {
  const override = settings.overrides[day];
  if (override?.enabled) {
    return { startMinutes: override.startMinutes, endMinutes: override.endMinutes };
  }
  return isWeekendDay(day) ? settings.weekend : settings.weekday;
}

function getBoundsForDate(date: Date, window: DayWindow): { start: Date; end: Date } {
  const dayAnchor = new Date(date);
  dayAnchor.setHours(0, 0, 0, 0);

  const start = new Date(dayAnchor);
  start.setMinutes(window.startMinutes);

  const end = new Date(dayAnchor);
  end.setMinutes(window.endMinutes);

  if (window.endMinutes <= window.startMinutes) {
    end.setDate(end.getDate() + 1);
  }

  return { start, end };
}

function isWithinBounds(now: Date, bounds: { start: Date; end: Date }): boolean {
  const nowTime = now.getTime();
  return nowTime >= bounds.start.getTime() && nowTime <= bounds.end.getTime();
}

function getActiveSchedule(now: Date, settings: WidgetSettings): { bounds: { start: Date; end: Date }; window: DayWindow } {
  const todayWindow = getConfiguredWindow(now.getDay(), settings);
  const todayBounds = getBoundsForDate(now, todayWindow);
  if (isWithinBounds(now, todayBounds)) {
    return { bounds: todayBounds, window: todayWindow };
  }

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayWindow = getConfiguredWindow(yesterday.getDay(), settings);
  const yesterdayBounds = getBoundsForDate(yesterday, yesterdayWindow);
  if (isWithinBounds(now, yesterdayBounds)) {
    return { bounds: yesterdayBounds, window: yesterdayWindow };
  }

  return { bounds: todayBounds, window: todayWindow };
}

function getDayProgress(now: Date, settings: WidgetSettings): number {
  const { bounds } = getActiveSchedule(now, settings);
  const durationMs = bounds.end.getTime() - bounds.start.getTime();
  if (durationMs <= 0) {
    return 0;
  }

  const elapsedMs = now.getTime() - bounds.start.getTime();
  const rawProgress = (elapsedMs / durationMs) * 100;
  return Math.min(100, Math.max(0, rawProgress));
}

function timeFormatter(settings: WidgetSettings): Intl.DateTimeFormat {
  const key = `${settings.timeFormat}-${settings.showSeconds ? "sec" : "no-sec"}`;
  if (timeFormatterCache.key === key) {
    return timeFormatterCache.formatter;
  }

  const formatter = new Intl.DateTimeFormat(undefined, {
    hour: settings.timeFormat === "24h" ? "2-digit" : "numeric",
    minute: "2-digit",
    second: settings.showSeconds ? "2-digit" : undefined,
    hour12: settings.timeFormat === "12h",
  });

  timeFormatterCache = { key, formatter };
  return formatter;
}

let timeFormatterCache: { key: string; formatter: Intl.DateTimeFormat } = {
  key: "",
  formatter: new Intl.DateTimeFormat(undefined),
};

const appWindow = getCurrentWindow();
const isSettingsWindow = appWindow.label === SETTINGS_WINDOW_LABEL;

const timeElement = queryElement<HTMLElement>("#clock-time");
const percentElement = queryElement<HTMLElement>("#progress-percent");
const windowLabelElement = queryElement<HTMLElement>("#progress-window");
const widgetElement = queryElement<HTMLElement>(".widget");
const displayElement = queryElement<HTMLElement>("#display-hitbox");
const settingsPanel = queryElement<HTMLElement>("#settings-panel");
const settingsForm = queryElement<HTMLFormElement>("#settings-form");
const themeSelect = queryElement<HTMLSelectElement>("#theme-select");
const timeFormat12Input = queryElement<HTMLInputElement>("#time-format-12");
const timeFormat24Input = queryElement<HTMLInputElement>("#time-format-24");
const showSecondsInput = queryElement<HTMLInputElement>("#show-seconds");
const showPercentInput = queryElement<HTMLInputElement>("#show-percent");
const runOnStartupInput = queryElement<HTMLInputElement>("#run-on-startup");
const weekdayStartInput = queryElement<HTMLInputElement>("#weekday-start");
const weekdayEndInput = queryElement<HTMLInputElement>("#weekday-end");
const weekendStartInput = queryElement<HTMLInputElement>("#weekend-start");
const weekendEndInput = queryElement<HTMLInputElement>("#weekend-end");
const resetButton = queryElement<HTMLButtonElement>("#reset-default");
const closeSettingsButton = queryElement<HTMLButtonElement>("#close-settings");
const statusElement = queryElement<HTMLElement>("#status-message");

const resizeHandleElements = Array.from(document.querySelectorAll<HTMLElement>(".resize-handle"));

const overrideRows: OverrideRow[] = Array.from({ length: 7 }, (_, day) => ({
  enabled: queryElement<HTMLInputElement>(`[data-override-enabled="${day}"]`),
  start: queryElement<HTMLInputElement>(`[data-override-start="${day}"]`),
  end: queryElement<HTMLInputElement>(`[data-override-end="${day}"]`),
}));

let settings = loadSettings();
let tapCount = 0;
let lastTapAtMs = 0;
let pointerStartX = 0;
let pointerStartY = 0;
let pointerMoved = false;
let statusTimeoutId: number | null = null;

function setStatus(message: string, clearAfterMs?: number): void {
  if (statusTimeoutId !== null) {
    window.clearTimeout(statusTimeoutId);
    statusTimeoutId = null;
  }

  statusElement.textContent = message;

  if (clearAfterMs && clearAfterMs > 0) {
    statusTimeoutId = window.setTimeout(() => {
      statusElement.textContent = "";
      statusTimeoutId = null;
    }, clearAfterMs);
  }
}

function applyTheme(theme: ThemeId): void {
  document.documentElement.dataset.theme = theme;
}

function syncInputs(source: WidgetSettings): void {
  themeSelect.value = source.theme;
  timeFormat12Input.checked = source.timeFormat === "12h";
  timeFormat24Input.checked = source.timeFormat === "24h";
  showSecondsInput.checked = source.showSeconds;
  showPercentInput.checked = source.showPercent;
  runOnStartupInput.checked = source.runOnStartup;

  weekdayStartInput.value = minutesToTime(source.weekday.startMinutes);
  weekdayEndInput.value = minutesToTime(source.weekday.endMinutes);
  weekendStartInput.value = minutesToTime(source.weekend.startMinutes);
  weekendEndInput.value = minutesToTime(source.weekend.endMinutes);

  for (let day = 0; day < overrideRows.length; day += 1) {
    const row = overrideRows[day];
    const override = source.overrides[day];
    row.enabled.checked = override.enabled;
    row.start.value = minutesToTime(override.startMinutes);
    row.end.value = minutesToTime(override.endMinutes);
  }
}

function readWindow(startValue: string, endValue: string, label: string): DayWindow | null {
  const start = parseTimeToMinutes(startValue);
  const end = parseTimeToMinutes(endValue);

  if (start === null || end === null) {
    setStatus(`${label}: invalid time format.`, 2000);
    return null;
  }

  if (start === end) {
    setStatus(`${label}: start and end cannot be the same.`, 2000);
    return null;
  }

  return { startMinutes: start, endMinutes: end };
}

function refreshSettingsFromStorage(): void {
  settings = loadSettings();
  applyTheme(settings.theme);
  syncInputs(settings);
  render();
}

async function applyRunOnStartupPreference(enabled: boolean): Promise<boolean> {
  try {
    const currentlyEnabled = await invoke<boolean>(AUTOSTART_IS_ENABLED_COMMAND);
    if (currentlyEnabled === enabled) {
      return true;
    }

    await invoke<void>(enabled ? AUTOSTART_ENABLE_COMMAND : AUTOSTART_DISABLE_COMMAND);
    return true;
  } catch {
    return false;
  }
}

async function openSettingsWindow(): Promise<void> {
  if (isSettingsWindow) {
    return;
  }

  const existing = await WebviewWindow.getByLabel(SETTINGS_WINDOW_LABEL);
  if (existing) {
    try {
      await existing.show();
      await existing.setFocus();
      await emitTo(SETTINGS_WINDOW_LABEL, SETTINGS_REFRESH_EVENT);
    } catch {
      setStatus("Unable to focus settings window.", 2000);
    }
    return;
  }

  try {
    const settingsWindow = new WebviewWindow(SETTINGS_WINDOW_LABEL, {
      title: SETTINGS_WINDOW_TITLE,
      width: SETTINGS_WIDTH,
      height: SETTINGS_HEIGHT,
      minWidth: SETTINGS_WIDTH,
      minHeight: SETTINGS_HEIGHT,
      center: true,
      resizable: false,
      decorations: true,
      transparent: false,
      alwaysOnTop: false,
      skipTaskbar: false,
    });

    settingsWindow.once("tauri://created", () => {
      void emitTo(SETTINGS_WINDOW_LABEL, SETTINGS_REFRESH_EVENT);
    });
    settingsWindow.once("tauri://error", () => {
      setStatus("Unable to open settings window.", 2000);
    });
  } catch {
    setStatus("Unable to open settings window.", 2000);
  }
}

function render(): void {
  const now = new Date();
  const progress = getDayProgress(now, settings);
  const activeSchedule = getActiveSchedule(now, settings);

  timeElement.textContent = timeFormatter(settings).format(now);
  percentElement.textContent = `${Math.round(progress)}%`;
  percentElement.hidden = !settings.showPercent;

  windowLabelElement.textContent = `${minutesToTime(activeSchedule.window.startMinutes)} - ${minutesToTime(activeSchedule.window.endMinutes)}`;
}

function tick(): void {
  render();
  const delayMs = 1000 - (Date.now() % 1000) + 5;
  window.setTimeout(tick, delayMs);
}

settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const weekday = readWindow(weekdayStartInput.value, weekdayEndInput.value, "Weekday schedule");
  const weekend = readWindow(weekendStartInput.value, weekendEndInput.value, "Weekend schedule");
  if (!weekday || !weekend) {
    return;
  }

  const overrides: DayOverride[] = [];
  for (let day = 0; day < overrideRows.length; day += 1) {
    const row = overrideRows[day];
    const parsed = readWindow(row.start.value, row.end.value, `Override ${day}`);
    if (!parsed) {
      return;
    }
    overrides.push({ enabled: row.enabled.checked, ...parsed });
  }

  settings = {
    theme: parseTheme(themeSelect.value),
    timeFormat: timeFormat24Input.checked ? "24h" : "12h",
    showSeconds: showSecondsInput.checked,
    showPercent: showPercentInput.checked,
    runOnStartup: runOnStartupInput.checked,
    weekday,
    weekend,
    overrides,
  };

  const autostartApplied = await applyRunOnStartupPreference(settings.runOnStartup);
  saveSettings(settings);
  applyTheme(settings.theme);
  render();

  if (isSettingsWindow) {
    try {
      await emitTo(MAIN_WINDOW_LABEL, WIDGET_RESTART_EVENT);
      setStatus(
        autostartApplied
          ? "Settings saved. Restarting widget..."
          : "Settings saved. Startup setting could not be applied.",
        autostartApplied ? 1000 : 2200,
      );
      window.setTimeout(() => {
        void appWindow.close();
      }, autostartApplied ? 180 : 1200);
    } catch {
      setStatus(
        autostartApplied
          ? "Settings saved, but widget restart failed."
          : "Settings saved, but startup setting and widget restart failed.",
        2400,
      );
    }
    return;
  }

  setStatus(
    autostartApplied ? "Settings saved." : "Settings saved, but startup setting could not be applied.",
    autostartApplied ? 1200 : 2200,
  );
});

resetButton.addEventListener("click", async () => {
  settings = cloneSettings(DEFAULT_SETTINGS);
  const autostartApplied = await applyRunOnStartupPreference(settings.runOnStartup);
  saveSettings(settings);
  applyTheme(settings.theme);
  syncInputs(settings);
  render();
  setStatus(
    autostartApplied ? "Reset to defaults." : "Reset done, but startup setting could not be applied.",
    autostartApplied ? 1200 : 2200,
  );
});

closeSettingsButton.addEventListener("click", () => {
  if (!isSettingsWindow) {
    return;
  }
  void appWindow.close();
});

const isResizeDirection = (value: string): value is ResizeDirection =>
  (RESIZE_DIRECTIONS as readonly string[]).includes(value);

if (isSettingsWindow) {
  settingsPanel.hidden = false;
  widgetElement.classList.add("settings-window-mode");
  void listen(SETTINGS_REFRESH_EVENT, () => {
    refreshSettingsFromStorage();
  });
} else {
  settingsPanel.hidden = true;
  widgetElement.classList.remove("settings-window-mode");

  void listen(WIDGET_RESTART_EVENT, () => {
    window.location.reload();
  });

  displayElement.addEventListener("pointerdown", (event) => {
    pointerStartX = event.clientX;
    pointerStartY = event.clientY;
    pointerMoved = false;
  });

  displayElement.addEventListener("pointermove", (event) => {
    if (pointerMoved) {
      return;
    }

    const deltaX = Math.abs(event.clientX - pointerStartX);
    const deltaY = Math.abs(event.clientY - pointerStartY);
    if (deltaX < DRAG_THRESHOLD_PX && deltaY < DRAG_THRESHOLD_PX) {
      return;
    }

    pointerMoved = true;
    tapCount = 0;
    void appWindow.startDragging().catch(() => {
      pointerMoved = false;
      setStatus("Unable to move widget.", 2000);
    });
  });

  displayElement.addEventListener("pointerup", () => {
    if (pointerMoved) {
      pointerMoved = false;
      return;
    }

    const nowMs = Date.now();
    if (nowMs - lastTapAtMs > TAP_WINDOW_MS) {
      tapCount = 0;
    }

    tapCount += 1;
    lastTapAtMs = nowMs;

    if (tapCount >= 3) {
      tapCount = 0;
      void openSettingsWindow();
    }
  });

  for (const handle of resizeHandleElements) {
    handle.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();

      const direction = handle.dataset.direction;
      if (!direction || !isResizeDirection(direction)) {
        return;
      }

      void appWindow.startResizeDragging(direction).catch(() => {
        setStatus("Unable to resize widget.", 2000);
      });
    });
  }
}

applyTheme(settings.theme);
syncInputs(settings);
render();
if (!isSettingsWindow) {
  void applyRunOnStartupPreference(settings.runOnStartup).then((applied) => {
    if (!applied) {
      setStatus("Startup setting could not be applied.", 2200);
    }
  });
}
if (isSettingsWindow) {
  setStatus("Save to apply and restart the widget.", 2400);
} else {
  setStatus("Triple tap to open settings.", 2200);
  tick();
}
