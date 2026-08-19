use crate::config::PublishTarget;
use crate::history::SnapshotEntry;
use crate::index::SearchHit;
use crate::publish::VersionSummary;
use crate::scan::ScanReport;
use crate::state::{
    AppError, AppResult, PostContent, PostSummary, PostsPayload, SaveResult, TrashItem,
    VersionContent,
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
pub fn read_snapshot(
    state: tauri::State<'_, AppState>,
    id: String,
    snapshot_file: String,
) -> AppResult<String> {
    state.read_snapshot_body(&id, &snapshot_file)
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

// ───── 发布版本（DESIGN §5） ─────

#[tauri::command]
pub fn list_publish_versions(
    state: tauri::State<'_, AppState>,
    base_id: String,
) -> AppResult<Vec<VersionSummary>> {
    state.list_publish_versions(&base_id)
}

#[tauri::command]
pub fn list_all_versions(state: tauri::State<'_, AppState>) -> AppResult<Vec<VersionSummary>> {
    state.list_all_versions()
}

#[tauri::command]
pub fn workspace_root(state: tauri::State<'_, AppState>) -> String {
    state.workspace_root()
}

#[tauri::command]
pub fn create_publish_version(
    state: tauri::State<'_, AppState>,
    base_id: String,
    target: String,
    from_snapshot: Option<String>,
) -> AppResult<VersionContent> {
    state.create_publish_version(&base_id, &target, from_snapshot)
}

#[tauri::command]
pub fn read_publish_version(
    state: tauri::State<'_, AppState>,
    base_id: String,
    target: String,
) -> AppResult<VersionContent> {
    state.read_publish_version(&base_id, &target)
}

#[tauri::command]
pub fn save_publish_version(
    state: tauri::State<'_, AppState>,
    base_id: String,
    target: String,
    content: String,
) -> AppResult<SaveResult> {
    state.save_publish_version(&base_id, &target, &content)
}

#[tauri::command]
pub fn sync_publish_from_post(
    state: tauri::State<'_, AppState>,
    base_id: String,
    target: String,
) -> AppResult<VersionContent> {
    state.sync_publish_from_post(&base_id, &target)
}

#[tauri::command]
pub fn set_publish_published(
    state: tauri::State<'_, AppState>,
    base_id: String,
    target: String,
    url: Option<String>,
    date: Option<String>,
) -> AppResult<VersionSummary> {
    state.set_publish_published(&base_id, &target, url, date)
}

#[tauri::command]
pub fn list_version_snapshots(
    state: tauri::State<'_, AppState>,
    base_id: String,
    target: String,
) -> AppResult<Vec<SnapshotEntry>> {
    state.list_version_snapshots(&base_id, &target)
}

#[tauri::command]
pub fn read_version_snapshot(
    state: tauri::State<'_, AppState>,
    base_id: String,
    target: String,
    snapshot_file: String,
) -> AppResult<String> {
    state.read_version_snapshot(&base_id, &target, &snapshot_file)
}

#[tauri::command]
pub fn restore_version_snapshot(
    state: tauri::State<'_, AppState>,
    base_id: String,
    target: String,
    snapshot_file: String,
) -> AppResult<VersionContent> {
    state.restore_version_snapshot(&base_id, &target, &snapshot_file)
}

#[tauri::command]
pub fn set_version_milestone(
    state: tauri::State<'_, AppState>,
    base_id: String,
    target: String,
    snapshot_file: String,
    name: String,
) -> AppResult<()> {
    state.set_version_milestone(&base_id, &target, &snapshot_file, &name)
}

#[tauri::command]
pub fn list_publish_targets(state: tauri::State<'_, AppState>) -> AppResult<Vec<PublishTarget>> {
    state.list_publish_targets()
}

#[tauri::command]
pub fn add_publish_target(
    state: tauri::State<'_, AppState>,
    id: String,
    display: String,
    note: String,
) -> AppResult<()> {
    state.add_publish_target(&id, &display, &note)
}

#[tauri::command]
pub fn save_pasted_image_at(
    state: tauri::State<'_, AppState>,
    file_rel_path: String,
    bytes: Vec<u8>,
    ext: String,
) -> AppResult<String> {
    state.save_pasted_image_at(&file_rel_path, &bytes, &ext)
}

// AppError 已实现 Serialize（字符串形式），命令可直接返回 Result
#[allow(dead_code)]
fn _assert_error_serializable(e: AppError) -> String {
    serde_json::to_string(&e).unwrap()
}
