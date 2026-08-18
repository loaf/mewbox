use crate::history::SnapshotEntry;
use crate::index::SearchHit;
use crate::scan::ScanReport;
use crate::state::{
    AppError, AppResult, PostContent, PostSummary, PostsPayload, SaveResult, TrashItem,
};
use crate::AppState;

#[tauri::command]
pub fn list_posts(state: tauri::State<'_, AppState>) -> AppResult<PostsPayload> {
    state.list_posts()
}

#[tauri::command]
pub fn create_post(
    state: tauri::State<'_, AppState>,
    title: String,
    folder: Option<String>,
) -> AppResult<PostSummary> {
    state.create_post(&title, folder.as_deref())
}

#[tauri::command]
pub fn read_post(state: tauri::State<'_, AppState>, id: String) -> AppResult<PostContent> {
    state.read_post(&id)
}

#[tauri::command]
pub fn save_post(
    state: tauri::State<'_, AppState>,
    id: String,
    content: String,
) -> AppResult<SaveResult> {
    state.save_post(&id, &content)
}

#[tauri::command]
pub fn set_post_title(
    state: tauri::State<'_, AppState>,
    id: String,
    title: String,
) -> AppResult<PostSummary> {
    state.set_post_title(&id, &title)
}

#[tauri::command]
pub fn set_post_status(
    state: tauri::State<'_, AppState>,
    id: String,
    status: String,
) -> AppResult<PostSummary> {
    state.set_post_status(&id, &status)
}

#[tauri::command]
pub fn set_post_folder(
    state: tauri::State<'_, AppState>,
    id: String,
    folder: Option<String>,
) -> AppResult<PostSummary> {
    state.set_post_folder(&id, folder.as_deref())
}

#[tauri::command]
pub fn rename_virtual_folder(
    state: tauri::State<'_, AppState>,
    from: String,
    to: String,
) -> AppResult<PostsPayload> {
    state.rename_virtual_folder(&from, &to)
}

#[tauri::command]
pub fn move_post_to_trash(state: tauri::State<'_, AppState>, id: String) -> AppResult<()> {
    state.move_post_to_trash(&id)
}

#[tauri::command]
pub fn list_trash(state: tauri::State<'_, AppState>) -> AppResult<Vec<TrashItem>> {
    state.list_trash()
}

#[tauri::command]
pub fn restore_post(
    state: tauri::State<'_, AppState>,
    id: String,
) -> AppResult<PostSummary> {
    state.restore_post(&id)
}

#[tauri::command]
pub fn list_snapshots(
    state: tauri::State<'_, AppState>,
    id: String,
) -> AppResult<Vec<SnapshotEntry>> {
    state.list_snapshots(&id)
}

#[tauri::command]
pub fn restore_snapshot(
    state: tauri::State<'_, AppState>,
    id: String,
    snapshot_file: String,
) -> AppResult<PostContent> {
    state.restore_snapshot(&id, &snapshot_file)
}

#[tauri::command]
pub fn set_snapshot_milestone(
    state: tauri::State<'_, AppState>,
    id: String,
    snapshot_file: String,
    name: String,
) -> AppResult<()> {
    state.set_snapshot_milestone(&id, &snapshot_file, &name)
}

#[tauri::command]
pub fn save_pasted_image(
    state: tauri::State<'_, AppState>,
    post_id: String,
    bytes: Vec<u8>,
    ext: String,
) -> AppResult<String> {
    state.save_pasted_image(&post_id, &bytes, &ext)
}

#[tauri::command]
pub fn search_posts(
    state: tauri::State<'_, AppState>,
    query: String,
) -> AppResult<Vec<SearchHit>> {
    state.search_posts(&query)
}

#[tauri::command]
pub fn scan_refresh(state: tauri::State<'_, AppState>) -> AppResult<ScanReport> {
    state.scan_refresh()
}

#[tauri::command]
pub fn import_external(
    state: tauri::State<'_, AppState>,
    path: String,
) -> AppResult<PostSummary> {
    state.import_external(&path)
}

// AppError 已实现 Serialize（字符串形式），命令可直接返回 Result
#[allow(dead_code)]
fn _assert_error_serializable(e: AppError) -> String {
    serde_json::to_string(&e).unwrap()
}
