#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    #[cfg(target_os = "linux")]
    {
        // Must run before Tauri/GTK starts threads or initializes WebKit.
        // NVIDIA's GBM path can fail on Wayland, leaving a blank webview or
        // crashing WebKitWebProcess. Use the renderer fallback verified on
        // Fedora/KDE Wayland with NVIDIA, while preserving explicit overrides.
        if std::path::Path::new("/sys/module/nvidia").is_dir()
            && std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none()
        {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
            eprintln!("email: NVIDIA erkannt; WebKit-DMA-BUF-Renderer deaktiviert.");
        }
    }
    email_lib::run();
}
