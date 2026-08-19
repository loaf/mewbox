mod commands;

pub mod assets;
pub mod assoc;
pub mod config;
pub mod frontmatter;
pub mod health;
pub mod history;
pub mod index;
pub mod links;
pub mod materials;
pub mod publish;
pub mod scan;
pub mod state;
pub mod vfolder;
pub mod workspace;

use std::path::{Path, PathBuf};

pub use state::AppState;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

/// 解析本次运行的工作区路径：
/// 1. 环境变量 MEWBOX_WORKSPACE（开发/测试覆盖）
/// 2. debug 构建默认仓库根 dev-workspace/（Task 9 冒烟依赖此行为）
/// 3. release：上次路径（app_config_dir/last-workspace.json），无则选目录对话框，取消则 home/MewBox
fn resolve_workspace_path(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(p) = std::env::var("MEWBOX_WORKSPACE") {
        return PathBuf::from(p);
    }
    #[cfg(debug_assertions)]
    {
        if let Some(root) = find_repo_root() {
            return root.join("dev-workspace");
        }
    }
    let cfg_dir = app.path().app_config_dir().ok();
    let last = cfg_dir.as_ref().map(|d| d.join("last-workspace.json"));
    if let Some(last) = &last {
        if let Ok(s) = std::fs::read_to_string(last) {
            if let Ok(p) = serde_json::from_str::<String>(&s) {
                if Path::new(&p).exists() {
                    return PathBuf::from(p);
                }
            }
        }
    }
    let picked: Option<PathBuf> = app
        .dialog()
        .file()
        .blocking_pick_folder()
        .and_then(|f| f.into_path().ok());
    let path = picked.unwrap_or_else(|| home_dir().join("MewBox"));
    if let (Some(dir), Some(last)) = (&cfg_dir, &last) {
        let _ = std::fs::create_dir_all(dir);
        let _ = std::fs::write(last, serde_json::to_string(&path).unwrap_or_default());
    }
    path
}

/// 从当前目录向上找仓库根（含 package.json + src-tauri 的目录）。仅 debug 构建使用。
#[cfg(debug_assertions)]
fn find_repo_root() -> Option<PathBuf> {
    let mut dir = std::env::current_dir().ok()?;
    loop {
        if dir.join("package.json").exists() && dir.join("src-tauri").exists() {
            return Some(dir);
        }
        if !dir.pop() {
            return None;
        }
    }
}

fn home_dir() -> PathBuf {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // single-instance 必须第一个注册（Tauri 2 要求，迟注册收不到第二实例事件）
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let ws_path = resolve_workspace_path(&app.handle());
            let ws = match workspace::Workspace::init(&ws_path) {
                Ok(ws) => ws,
                Err(workspace::Error::WorkspaceInUse) => {
                    app.dialog()
                        .message(format!("工作区正被另一个实例使用：\n{}", ws_path.display()))
                        .kind(tauri_plugin_dialog::MessageDialogKind::Error)
                        .blocking_show();
                    std::process::exit(1);
                }
                Err(e) => {
                    eprintln!("工作区初始化失败: {e}");
                    std::process::exit(1);
                }
            };
            let state = AppState::new(ws)?;
            if let Err(e) = state.startup_maintenance() {
                eprintln!("启动维护失败（不阻塞启动）: {e}");
            }
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_posts,
            commands::create_post,
            commands::read_post,
            commands::save_post,
            commands::set_post_title,
            commands::set_post_status,
            commands::set_post_folder,
            commands::rename_virtual_folder,
            commands::move_post_to_trash,
            commands::list_trash,
            commands::restore_post,
            commands::list_snapshots,
            commands::read_snapshot,
            commands::restore_snapshot,
            commands::set_snapshot_milestone,
            commands::save_pasted_image,
            commands::search_posts,
            commands::scan_refresh,
            commands::import_external,
            commands::list_publish_versions,
            commands::list_all_versions,
            commands::workspace_root,
            commands::create_publish_version,
            commands::read_publish_version,
            commands::save_publish_version,
            commands::sync_publish_from_post,
            commands::set_publish_published,
            commands::list_version_snapshots,
            commands::read_version_snapshot,
            commands::restore_version_snapshot,
            commands::set_version_milestone,
            commands::list_publish_targets,
            commands::add_publish_target,
            commands::save_pasted_image_at,
            commands::list_materials,
            commands::create_material,
            commands::read_material,
            commands::save_material,
            commands::set_material_title,
            commands::import_md_files,
            commands::import_files_containerized,
            commands::move_material_to_trash,
            commands::list_material_trash,
            commands::restore_material,
            commands::convert_material_to_post,
            commands::convert_post_to_material,
            commands::rename_post_slug,
            commands::rename_material_file,
            commands::move_material,
            commands::rename_kb_dir,
            commands::update_assoc,
            commands::assoc_targets,
            commands::backlinks,
            commands::resolve_wiki,
            commands::health_check,
            commands::clean_orphan_assets
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
