#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::{fs, path::{Path, PathBuf}, process::{Stdio, Command}};
use tauri::{Emitter, Manager, WebviewWindowBuilder};
use walkdir::WalkDir;

// Embed the screenshot script at compile time so we don't rely on locating it at runtime
const SCREENSHOT_TS: &str = include_str!("../../scripts/screenshot.ts");
// Embed the lightweight Bun server that serves a run directory for the Figma plugin
const SERVE_RUN_TS: &str = include_str!("../../scripts/serve-run.ts");

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
    // Optional tuning (argument names must match keys from the frontend)
    profile_dir: Option<String>,
    max_concurrent_pages: Option<u32>,
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
        "profileDir": profile_dir,
        "maxConcurrentPages": max_concurrent_pages,
    });

    let cfg_path: PathBuf = out_dir.join("config.json");
    fs::write(&cfg_path, serde_json::to_vec_pretty(&cfg).unwrap()).map_err(|e| e.to_string())?;

    // Materialize the embedded script into the run directory
    let script = out_dir.join("screenshot.ts");
    fs::write(&script, SCREENSHOT_TS).map_err(|e| format!("failed to write embedded script: {}", e))?;
    println!("Using embedded screenshot script at {}", script.to_string_lossy());

    // Try to find bun explicitly if PATH isn't available in production
    let mut bun_cmd_candidates: Vec<PathBuf> = vec![
        PathBuf::from("bun"),
        PathBuf::from("/opt/homebrew/bin/bun"),
        PathBuf::from("/usr/local/bin/bun"),
        PathBuf::from("/usr/bin/bun"),
    ];
    // Also consider bundling an env var override
    if let Ok(custom) = std::env::var("BUN_PATH") { bun_cmd_candidates.insert(0, PathBuf::from(custom)); }
    let bun_cmd = bun_cmd_candidates.into_iter().find(|p| {
        if p.components().count() == 1 { true } else { p.exists() }
    }).unwrap_or_else(|| PathBuf::from("bun"));

    // Set the working directory to the application resource dir if available
    let work_dir = app.path().resource_dir().ok();

    let mut cmd = Command::new(bun_cmd);
    // Prepend common Homebrew path to PATH so bun is discoverable in sandboxed envs
    if let Ok(mut path_var) = std::env::var("PATH") {
        if !path_var.split(':').any(|p| p == "/opt/homebrew/bin") {
            path_var = format!("{}:{}", "/opt/homebrew/bin", path_var);
        }
        cmd.env("PATH", path_var);
    }
    let child = cmd
        .args(["run", script.to_string_lossy().as_ref(), cfg_path.to_string_lossy().as_ref()])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .current_dir(work_dir.unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))))
        .spawn()
        .map_err(|e| e.to_string())?;
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        // Show gallery window even on error
        if let Some(gallery_err) = app.get_webview_window("gallery") {
            let _ = gallery_err.show();
            let _ = gallery_err.set_focus();
        }
        let mut msg = String::new();
        if !output.stderr.is_empty() {
            msg.push_str(&String::from_utf8_lossy(&output.stderr));
        }
        if !output.stdout.is_empty() {
            if !msg.is_empty() { msg.push_str("\n"); }
            msg.push_str(&String::from_utf8_lossy(&output.stdout));
        }
        if msg.is_empty() {
            msg = "Screenshot process failed with unknown error".to_string();
        }
        return Err(msg);
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

#[derive(Debug, Deserialize)]
struct ExportArgs {
    #[serde(alias = "runDir")] run_dir: String,
    #[serde(alias = "destZip")] dest_zip: String,
}

#[tauri::command]
async fn export_gallery(app: tauri::AppHandle, args: ExportArgs) -> Result<(), String> {
    let run_path = PathBuf::from(args.run_dir);
    if !run_path.exists() { return Err("run_dir does not exist".into()); }
    let file = fs::File::create(&args.dest_zip).map_err(|e| e.to_string())?;
    let mut zipw = zip::ZipWriter::new(file);
    let options = zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let base = run_path.clone();
    for entry in WalkDir::new(&run_path).into_iter().filter_map(|e| e.ok()) {
        let p = entry.path();
        let rel = p.strip_prefix(&base).unwrap_or(p);
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        if p.is_dir() {
            if !rel_str.is_empty() { zipw.add_directory(rel_str, options).map_err(|e| e.to_string())?; }
        } else if p.is_file() {
            zipw.start_file(rel_str, options).map_err(|e| e.to_string())?;
            let bytes = fs::read(p).map_err(|e| e.to_string())?;
            use std::io::Write;
            zipw.write_all(&bytes).map_err(|e| e.to_string())?;
        }
    }
    zipw.finish().map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Debug, Deserialize)]
struct ImportArgs {
    #[serde(alias = "srcZip")] src_zip: String,
}

#[tauri::command]
async fn import_gallery(app: tauri::AppHandle, args: ImportArgs) -> Result<String, String> {
    let runs_dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("runs");
    fs::create_dir_all(&runs_dir).map_err(|e| e.to_string())?;
    let file = fs::File::open(&args.src_zip).map_err(|e| e.to_string())?;
    let mut zipr = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let run_id = format!("import-{}", chrono::Utc::now().timestamp());
    let out_dir = runs_dir.join(&run_id);
    fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
    for i in 0..zipr.len() {
        let mut f = zipr.by_index(i).map_err(|e| e.to_string())?;
        let out_path = out_dir.join(Path::new(f.name()));
        if f.name().ends_with('/') {
            fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
        } else {
            if let Some(parent) = out_path.parent() { fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
            use std::io::Write;
            let mut outfile = fs::File::create(&out_path).map_err(|e| e.to_string())?;
            std::io::copy(&mut f, &mut outfile).map_err(|e| e.to_string())?;
        }
    }
    Ok(out_dir.to_string_lossy().to_string())
}

#[derive(Debug, Deserialize)]
struct OpenDirArgs {
    #[serde(alias = "runDir")] run_dir: String,
}

#[tauri::command]
async fn open_gallery_from_dir(app: tauri::AppHandle, args: OpenDirArgs) -> Result<(), String> {
    // Ensure gallery window exists
    if app.get_webview_window("gallery").is_none() {
        let _ = WebviewWindowBuilder::new(&app, "gallery", tauri::WebviewUrl::App("/gallery".into()))
            .title("Gallery")
            .build();
    }
    let manifest_path = PathBuf::from(&args.run_dir).join("manifest.json");
    let manifest_str = fs::read_to_string(&manifest_path).map_err(|e| e.to_string())?;
    let manifest_json: serde_json::Value = serde_json::from_str(&manifest_str).map_err(|e| e.to_string())?;
    if let Some(gallery) = app.get_webview_window("gallery") {
        let _ = gallery.emit("shots:loaded", &manifest_json);
        let _ = gallery.show();
        let _ = gallery.set_focus();
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
struct OpenZipArgs {
    #[serde(alias = "srcZip")] src_zip: String,
}

#[tauri::command]
async fn open_gallery_from_zip(app: tauri::AppHandle, args: OpenZipArgs) -> Result<String, String> {
    let run_dir = import_gallery(app.clone(), ImportArgs { src_zip: args.src_zip.clone() }).await?;
    open_gallery_from_dir(app, OpenDirArgs { run_dir: run_dir.clone() }).await.map_err(|e| e.to_string())?;
    Ok(run_dir)
}

#[derive(Debug, Deserialize)]
struct OpenFigmaImporterArgs {
    #[serde(alias = "runDir")] run_dir: String,
    port: Option<u16>,
}

#[tauri::command]
async fn open_figma_importer(app: tauri::AppHandle, args: OpenFigmaImporterArgs) -> Result<String, String> {
    let run_path = PathBuf::from(&args.run_dir);
    if !run_path.exists() { return Err("run_dir does not exist".into()); }

    // Materialize the embedded server script into the run directory
    let server_script = run_path.join("serve-run.ts");
    fs::write(&server_script, SERVE_RUN_TS).map_err(|e| format!("failed to write server script: {}", e))?;

    // Resolve bun command similarly to screenshot job
    let mut bun_cmd_candidates: Vec<PathBuf> = vec![
        PathBuf::from("bun"),
        PathBuf::from("/opt/homebrew/bin/bun"),
        PathBuf::from("/usr/local/bin/bun"),
        PathBuf::from("/usr/bin/bun"),
    ];
    if let Ok(custom) = std::env::var("BUN_PATH") { bun_cmd_candidates.insert(0, PathBuf::from(custom)); }
    let bun_cmd = bun_cmd_candidates.into_iter().find(|p| {
        if p.components().count() == 1 { true } else { p.exists() }
    }).unwrap_or_else(|| PathBuf::from("bun"));

    let port = args.port.unwrap_or(7777);
    let base_url = format!("http://localhost:{}", port);

    // Start the Bun server in the background
    let mut cmd = Command::new(bun_cmd);
    if let Ok(mut path_var) = std::env::var("PATH") {
        if !path_var.split(':').any(|p| p == "/opt/homebrew/bin") {
            path_var = format!("{}:{}", "/opt/homebrew/bin", path_var);
        }
        cmd.env("PATH", path_var);
    }
    let _child = cmd
        .args([
            "run",
            server_script.to_string_lossy().as_ref(),
            run_path.to_string_lossy().as_ref(),
            &port.to_string(),
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("failed to spawn bun server: {}", e))?;

    // Best-effort: copy the URL to clipboard so the user can paste into plugin if needed
    #[cfg(target_os = "macos")]
    {
        let mut pb = Command::new("/usr/bin/pbcopy");
        use std::io::Write;
        if let Ok(mut child) = pb.stdin(Stdio::piped()).spawn() {
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(base_url.as_bytes());
            }
        }
    }

    // Open Figma to a new file (user should have "Open links in desktop app" enabled)
    let _ = Command::new("open")
        .args(["-a", "Figma", "https://www.figma.com/file/new"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();

    Ok(base_url)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![run_screenshot_job, export_gallery, import_gallery, open_gallery_from_dir, open_gallery_from_zip, open_figma_importer])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}


