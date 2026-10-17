//! HRouter 股票工作台的桌面壳：开一个窗口，确保本机服务在跑，然后直接打开服务自带的界面。
//! 服务是独立的 Node 进程（和 `npm run service:install` 装的常驻服务是同一个程序），
//! 关掉窗口它也继续跑，撮合、盯价和调度不会被打断；已经在跑时直接连上，不会再起一个。

use std::fs::OpenOptions;
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;
use tauri::webview::NewWindowResponse;
use tauri::{Manager, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

const PORT: u16 = 8780;

fn service_url() -> Url {
    Url::parse(&format!("http://127.0.0.1:{PORT}/")).expect("valid service url")
}

fn service_up() -> bool {
    let addr: SocketAddr = ([127, 0, 0, 1], PORT).into();
    TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
}

fn is_service(url: &Url) -> bool {
    url.host_str() == Some("127.0.0.1") && url.port() == Some(PORT)
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from)
}

/// 桌面应用拿到的 PATH 很短（尤其是 macOS 从访达启动时），所以把常见的 Node 安装位置也找一遍
fn find_node() -> Option<PathBuf> {
    let exe = if cfg!(windows) { "node.exe" } else { "node" };
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    if let Some(h) = home() {
        dirs.push(h.join(".local").join("bin"));
        dirs.push(h.join(".volta").join("bin"));
        dirs.push(h.join(".nvm").join("current").join("bin"));
    }
    if cfg!(windows) {
        dirs.push(PathBuf::from(r"C:\Program Files\nodejs"));
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            dirs.push(PathBuf::from(local).join("Programs").join("nodejs"));
        }
    } else {
        dirs.extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].iter().map(PathBuf::from));
    }
    dirs.into_iter().map(|d| d.join(exe)).find(|p| p.is_file())
}

fn service_entry(app: &tauri::AppHandle) -> Option<PathBuf> {
    if let Ok(res) = app.path().resource_dir() {
        let p = res.join("plugin").join("mcp").join("server.bundle.mjs");
        if p.is_file() {
            return Some(p);
        }
    }
    // 开发时：直接用仓库里打包好的插件
    let dev = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../plugins/hrouter-market-pulse/mcp/server.bundle.mjs");
    dev.is_file().then_some(dev)
}

fn start_service(app: &tauri::AppHandle) -> Result<(), String> {
    if service_up() {
        return Ok(());
    }
    let node = find_node().ok_or("没找到 Node.js（需要 20 以上），请先安装 Node")?;
    let entry = service_entry(app).ok_or("安装包里缺少本机服务")?;
    let log_dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&log_dir).map_err(|e| e.to_string())?;
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_dir.join("service.log"))
        .map_err(|e| e.to_string())?;
    let mut cmd = Command::new(node);
    cmd.arg(&entry)
        .arg("--service")
        .env("HROUTER_REPORT_PORT", PORT.to_string())
        .stdin(Stdio::null())
        .stdout(log.try_clone().map_err(|e| e.to_string())?)
        .stderr(log);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0); // 脱离窗口进程，关掉应用后继续跑
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        cmd.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS);
    }
    cmd.spawn().map_err(|e| format!("启动本机服务失败：{e}"))?;
    for _ in 0..150 {
        if service_up() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err(format!("本机服务没有按时启动，详情见日志 {}", log_dir.join("service.log").display()))
}

/// 本机服务以外的链接（数据源、GitHub、许可证）交给系统浏览器打开
fn open_outside(app: &tauri::AppHandle, url: &Url) {
    if matches!(url.scheme(), "http" | "https" | "mailto") {
        let _ = app.opener().open_url(url.as_str(), None::<&str>);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let nav = handle.clone();
            let popup = handle.clone();
            let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("HRouter 股票工作台")
                .inner_size(1440.0, 920.0)
                .min_inner_size(1100.0, 720.0)
                .center();
            // 只有 macOS 有透明标题栏；Windows 用系统标题栏
            #[cfg(target_os = "macos")]
            let builder = builder.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true);
            let window = builder
                .on_navigation(move |url| {
                    // 窗口里只打开加载页和本机服务，其他地址交给浏览器
                    if is_service(url) || matches!(url.scheme(), "tauri" | "asset") || url.host_str() == Some("tauri.localhost") {
                        return true;
                    }
                    open_outside(&nav, url);
                    false
                })
                .on_new_window(move |url, _features| {
                    open_outside(&popup, &url);
                    NewWindowResponse::Deny
                })
                .build()?;
            std::thread::spawn(move || match start_service(&handle) {
                Ok(()) => {
                    let _ = window.navigate(service_url());
                }
                Err(e) => {
                    eprintln!("{e}");
                    let message = serde_json::to_string(&e).unwrap_or_default();
                    let _ = window.eval(format!("window.showError && window.showError({message})"));
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("启动 HRouter 股票工作台失败");
}
