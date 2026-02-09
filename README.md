# Widget Launcher (Tauri + Rust + Bun)

A lightweight Windows desktop widget built with the Tauri + Rust stack.

Features:
- Always-on-top window with live local time
- Frameless transparent desktop overlay (not a normal app window)
- Resizable down to a very small footprint
- Triple-tap time display opens settings in a separate window
- Saving settings restarts the widget to apply changes
- Theme presets: Midnight, Dark Purple, Forest, Rose, Amber, Slate
- Time format options (12h/24h + seconds)
- Weekday/weekend schedules and per-day overrides
- Real-time day progress based on active schedule
- Settings persisted locally

## Run

```bash
bun install
bun run tauri dev
```

## Build

```bash
bun run tauri build
```
