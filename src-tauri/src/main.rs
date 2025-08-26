#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf, process::{Stdio, Command}};
use tauri::{Emitter, Manager, WebviewWindowBuilder};

#[derive(Debug, Serialize, Deserialize, Clone)]
struct CookieConfig {
    name: String,
    domain: Option<String>,
    path: Option<String>,
    #[serde(rename = "sameSite")]
    same_site: Option<String>,
    secure: Option<bool>,
    #[serde(rename = "httpOnly")]
    http_only: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct BehaviorFlags {
    #[serde(rename = "sendAcceptLanguage")]
    send_accept_language: Option<bool>,
    #[serde(rename = "urlTemplate")]
    url_template: Option<String>,
    #[serde(rename = "useUrlTemplate")]
    use_url_template: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct RunManifest {
    id: String,
    url: String,
    breakpoints: Vec<u32>,
    locales: Vec<String>,
    cookie: CookieConfig,
    behavior: BehaviorFlags,
    out_dir: String,
}

#[tauri::command]
async fn run_screenshot_job(
    app: tauri::AppHandle,
    url: String,
    breakpoints: Vec<u32>,
    locales: Vec<String>,
    cookie: CookieConfig,
    behavior: BehaviorFlags,
) -> Result<String, String> {
    // Ensure gallery window exists early so the user sees it opening immediately
    if app.get_webview_window("gallery").is_none() {
        let _ = WebviewWindowBuilder::new(&app, "gallery", tauri::WebviewUrl::App("/gallery".into()))
            .title("Gallery")
            .build();
    }

    let run_id = format!("{}", chrono::Utc::now().timestamp());
    let runs_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let out_dir = runs_dir.join("runs").join(&run_id);
    fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;

    let cfg = serde_json::json!({
        "url": url,
        "breakpoints": breakpoints,
        "locales": locales,
        "cookie": cookie,
        "behavior": behavior,
        "outDir": out_dir.to_string_lossy(),
    });

    let cfg_path: PathBuf = out_dir.join("config.json");
    fs::write(&cfg_path, serde_json::to_vec_pretty(&cfg).unwrap()).map_err(|e| e.to_string())?;

    // Resolve the Playwright script robustly in dev/build
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let mut candidates: Vec<PathBuf> = Vec::new();
    // common locations
    candidates.push(cwd.join("scripts/screenshot.ts")); // when cwd is repo root
    candidates.push(cwd.join("..").join("scripts/screenshot.ts")); // when cwd is src-tauri
    if let Ok(p) = app.path().resolve("scripts/screenshot.ts", tauri::path::BaseDirectory::Resource) {
        candidates.push(p);
    }
    if let Ok(p) = app.path().resolve("..\\scripts\\screenshot.ts", tauri::path::BaseDirectory::Resource) {
        candidates.push(p);
    }
    let script = candidates
        .into_iter()
        .find(|p| p.exists())
        .unwrap_or_else(|| cwd.join("..").join("scripts/screenshot.ts"));
    println!("Using screenshot script at {}", script.to_string_lossy());

    let child = Command::new("bun")
        .args([
            "run",
            script.to_string_lossy().as_ref(),
            cfg_path.to_string_lossy().as_ref(),
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        // Show gallery window even on error
        if let Some(gallery_err) = app.get_webview_window("gallery") {
            let _ = gallery_err.show();
            let _ = gallery_err.set_focus();
        }
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    let manifest_path = out_dir.join("manifest.json");
    let manifest_str = fs::read_to_string(&manifest_path).map_err(|e| e.to_string())?;
    let manifest_json: serde_json::Value = serde_json::from_str(&manifest_str).map_err(|e| e.to_string())?;

    if let Some(gallery) = app.get_webview_window("gallery") {
        let _ = gallery.emit("shots:loaded", &manifest_json);
        let _ = gallery.show();
        let _ = gallery.set_focus();
    } else {
        // Fallback (should rarely happen because we create it above)
        let _ = WebviewWindowBuilder::new(&app, "gallery", tauri::WebviewUrl::App("/gallery".into()))
            .title("Gallery")
            .build();
        if let Some(gallery2) = app.get_webview_window("gallery") {
            let _ = gallery2.emit("shots:loaded", &manifest_json);
            let _ = gallery2.show();
            let _ = gallery2.set_focus();
        }
    }

    Ok(out_dir.to_string_lossy().to_string())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![run_screenshot_job])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}


