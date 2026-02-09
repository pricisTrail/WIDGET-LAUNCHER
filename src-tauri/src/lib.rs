use tauri::{Manager, PhysicalPosition, PhysicalSize, Position};
use tauri_plugin_autostart::MacosLauncher;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None::<Vec<&str>>,
        ))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_always_on_top(true);
                if let Ok(Some(monitor)) = window.current_monitor() {
                    let monitor_pos = monitor.position();
                    let monitor_size = monitor.size();
                    let window_size = window.outer_size().unwrap_or(PhysicalSize::new(210, 56));
                    let margin = 14_i32;

                    let x = monitor_pos.x + monitor_size.width as i32 - window_size.width as i32 - margin;
                    let y = monitor_pos.y + monitor_size.height as i32 - window_size.height as i32 - margin;
                    let _ = window.set_position(Position::Physical(PhysicalPosition::new(x, y)));
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
