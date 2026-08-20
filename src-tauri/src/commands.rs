use crate::config::PublishTarget;
use crate::history::SnapshotEntry;
use crate::index::SearchHit;
use crate::materials::MaterialSummary;
use crate::publish::VersionSummary;
use crate::scan::ScanReport;
use crate::state::{
    AppError, AppResult, Backlink, MaterialContent, PostContent, PostSummary, PostsPayload,
    SaveResult, TrashItem, VersionContent, WikiResolve,
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

/// 全局搜索（M5，DESIGN §9）：文稿+资料；include_versions 并入发布版本。
#[tauri::command]
pub fn search_all(
    state: tauri::State<'_, AppState>,
    query: String,
    include_versions: bool,
) -> AppResult<Vec<SearchHit>> {
    state.search_all(&query, include_versions)
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
    current_body: Option<String>,
) -> AppResult<VersionContent> {
    state.create_publish_version(&base_id, &target, from_snapshot, current_body)
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

// ───── 知识库与关联体系（M3） ─────

#[tauri::command]
pub fn list_materials(state: tauri::State<'_, AppState>) -> AppResult<Vec<MaterialSummary>> {
    state.list_materials()
}

#[tauri::command]
pub fn create_material(
    state: tauri::State<'_, AppState>,
    title: String,
    dir: String,
) -> AppResult<MaterialContent> {
    state.create_material(&title, &dir)
}

#[tauri::command]
pub fn read_material(state: tauri::State<'_, AppState>, id: String) -> AppResult<MaterialContent> {
    state.read_material(&id)
}

#[tauri::command]
pub fn save_material(
    state: tauri::State<'_, AppState>,
    id: String,
    content: String,
) -> AppResult<SaveResult> {
    state.save_material(&id, &content)
}

#[tauri::command]
pub fn set_material_title(
    state: tauri::State<'_, AppState>,
    id: String,
    title: String,
) -> AppResult<MaterialSummary> {
    state.set_material_title(&id, &title)
}

#[tauri::command]
pub fn import_md_files(
    state: tauri::State<'_, AppState>,
    paths: Vec<String>,
    dest_dir: String,
) -> AppResult<Vec<MaterialSummary>> {
    state.import_md_files(&paths, &dest_dir)
}

#[tauri::command]
pub fn import_files_containerized(
    state: tauri::State<'_, AppState>,
    paths: Vec<String>,
) -> AppResult<Vec<MaterialSummary>> {
    state.import_files_containerized(&paths)
}

#[tauri::command]
pub fn move_material_to_trash(state: tauri::State<'_, AppState>, id: String) -> AppResult<()> {
    state.move_material_to_trash(&id)
}

#[tauri::command]
pub fn list_material_trash(state: tauri::State<'_, AppState>) -> AppResult<Vec<TrashItem>> {
    state.list_material_trash()
}

#[tauri::command]
pub fn restore_material(state: tauri::State<'_, AppState>, id: String) -> AppResult<MaterialSummary> {
    state.restore_material(&id)
}

#[tauri::command]
pub fn convert_material_to_post(
    state: tauri::State<'_, AppState>,
    id: String,
) -> AppResult<PostSummary> {
    state.convert_material_to_post(&id)
}

#[tauri::command]
pub fn convert_post_to_material(
    state: tauri::State<'_, AppState>,
    id: String,
) -> AppResult<MaterialSummary> {
    state.convert_post_to_material(&id)
}

#[tauri::command]
pub fn rename_post_slug(
    state: tauri::State<'_, AppState>,
    id: String,
    new_slug: String,
) -> AppResult<PostSummary> {
    state.rename_post_slug(&id, &new_slug)
}

#[tauri::command]
pub fn rename_material_file(
    state: tauri::State<'_, AppState>,
    id: String,
    new_name: String,
) -> AppResult<MaterialSummary> {
    state.rename_material_file(&id, &new_name)
}

#[tauri::command]
pub fn move_material(
    state: tauri::State<'_, AppState>,
    id: String,
    new_dir: String,
) -> AppResult<MaterialSummary> {
    state.move_material(&id, &new_dir)
}

#[tauri::command]
pub fn rename_kb_dir(
    state: tauri::State<'_, AppState>,
    dir: String,
    new_name: String,
) -> AppResult<Vec<MaterialSummary>> {
    state.rename_kb_dir(&dir, &new_name)
}

#[tauri::command]
pub fn update_assoc(
    state: tauri::State<'_, AppState>,
    a_id: String,
    b_id: String,
    add: bool,
) -> AppResult<()> {
    state.update_assoc(&a_id, &b_id, add)
}

#[tauri::command]
pub fn assoc_targets(
    state: tauri::State<'_, AppState>,
    id: String,
) -> AppResult<Vec<crate::state::AssocTargetEntry>> {
    state.assoc_targets(&id)
}

#[tauri::command]
pub fn backlinks(state: tauri::State<'_, AppState>, id: String) -> AppResult<Vec<Backlink>> {
    state.backlinks(&id)
}

#[tauri::command]
pub fn resolve_wiki(state: tauri::State<'_, AppState>, title: String) -> AppResult<WikiResolve> {
    state.resolve_wiki(&title)
}

#[tauri::command]
pub fn health_check(state: tauri::State<'_, AppState>) -> AppResult<crate::health::HealthReport> {
    state.health_check()
}

#[tauri::command]
pub fn list_kb_dirs(state: tauri::State<'_, AppState>) -> AppResult<Vec<String>> {
    state.list_kb_dirs()
}

#[tauri::command]
pub fn create_kb_dir(
    state: tauri::State<'_, AppState>,
    parent: String,
    name: String,
) -> AppResult<String> {
    state.create_kb_dir(&parent, &name)
}

#[tauri::command]
pub fn clean_orphan_assets(
    state: tauri::State<'_, AppState>,
    fingerprints: Vec<String>,
) -> AppResult<usize> {
    state.clean_orphan_assets(&fingerprints)
}

// ───── 导出/迁移（M5，DESIGN §12） ─────

#[tauri::command]
pub fn export_md(
    state: tauri::State<'_, AppState>,
    scope: String,
    dest_dir: String,
) -> AppResult<crate::export::ExportMdReport> {
    state.export_md(&scope, &dest_dir)
}

#[tauri::command]
pub fn export_post_zip(
    state: tauri::State<'_, AppState>,
    post_id: String,
    dest_path: String,
) -> AppResult<()> {
    state.export_post_zip(&post_id, &dest_path)
}

// AppError 已实现 Serialize（字符串形式），命令可直接返回 Result
#[allow(dead_code)]
fn _assert_error_serializable(e: AppError) -> String {
    serde_json::to_string(&e).unwrap()
}

// ───── AI（DESIGN §8，M4 T8；流事件 ai-stream:{call_id}）─────

#[tauri::command]
pub fn ai_run_op(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    call_id: String,
    op: String,
    contexts: Vec<crate::ai::ContextEntry>,
    custom: Option<String>,
    question: Option<String>,
    history: Option<Vec<(String, String)>>,
    target_lang: Option<String>,
    tone: Option<String>,
    selection: Option<String>,
    include_attachment_text: Option<bool>,
) -> AppResult<()> {
    state.ai_run_op(
        std::sync::Arc::new(app),
        &call_id,
        &op,
        &contexts,
        crate::ai::RunParams {
            custom,
            question,
            history: history.unwrap_or_default(),
            target_lang,
            tone,
            selection,
            include_attachment_text: include_attachment_text.unwrap_or(false),
        },
    )
}

#[tauri::command]
pub fn ai_cancel(state: tauri::State<'_, AppState>, app: tauri::AppHandle, call_id: String) -> AppResult<()> {
    state.ai_cancel(&app, &call_id)
}

#[tauri::command]
pub fn ai_adopt_result(
    state: tauri::State<'_, AppState>,
    call_id: String,
    note: Option<String>,
) -> AppResult<()> {
    state.ai_adopt_result(&call_id, note.as_deref())
}

#[tauri::command]
pub fn ai_discard_result(state: tauri::State<'_, AppState>, call_id: String) -> AppResult<()> {
    state.ai_discard_result(&call_id)
}

#[tauri::command]
pub fn ai_save_as_material(
    state: tauri::State<'_, AppState>,
    call_id: String,
    title: String,
    body: String,
    source_ids: Vec<String>,
    assoc_ids: Vec<String>,
) -> AppResult<MaterialSummary> {
    state.ai_save_as_material(&call_id, &title, &body, &source_ids, &assoc_ids)
}

#[tauri::command]
pub fn ai_describe_attachment(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    call_id: String,
    material_id: String,
    attachment: String,
) -> AppResult<()> {
    state.ai_describe_attachment(std::sync::Arc::new(app), &call_id, &material_id, &attachment)
}

#[tauri::command]
pub fn ai_apply_suggestions(
    state: tauri::State<'_, AppState>,
    body: String,
    items: Vec<crate::prompts::Suggestion>,
) -> AppResult<crate::ai::ApplyOutcome> {
    state.ai_apply_suggestions(&body, &items)
}

#[tauri::command]
pub async fn ai_test_connection(
    state: tauri::State<'_, AppState>,
    provider_id: String,
) -> AppResult<crate::ai::ConnectionTest> {
    state.ai_test_connection(&provider_id).await
}

#[tauri::command]
pub fn ai_list_providers(state: tauri::State<'_, AppState>) -> AppResult<crate::config::AiConfig> {
    state.ai_list_providers()
}

#[tauri::command]
pub fn ai_save_provider(
    state: tauri::State<'_, AppState>,
    provider: crate::config::AiProvider,
) -> AppResult<()> {
    state.ai_save_provider(&provider)
}

#[tauri::command]
pub fn ai_delete_provider(state: tauri::State<'_, AppState>, id: String) -> AppResult<()> {
    state.ai_delete_provider(&id)
}

#[tauri::command]
pub fn ai_save_ai_config(
    state: tauri::State<'_, AppState>,
    routes: std::collections::BTreeMap<String, String>,
    fallbacks: std::collections::BTreeMap<String, String>,
    budget: crate::config::AiBudget,
) -> AppResult<()> {
    state.ai_save_ai_config(&routes, &fallbacks, budget)
}

#[tauri::command]
pub fn ai_set_key(
    state: tauri::State<'_, AppState>,
    provider_id: String,
    key: String,
) -> AppResult<()> {
    state.ai_set_key(&provider_id, &key)
}

#[tauri::command]
pub fn ai_has_key(state: tauri::State<'_, AppState>, provider_id: String) -> AppResult<bool> {
    state.ai_has_key(&provider_id)
}

#[tauri::command]
pub fn ai_delete_key(state: tauri::State<'_, AppState>, provider_id: String) -> AppResult<()> {
    state.ai_delete_key(&provider_id)
}

#[tauri::command]
pub fn ai_usage(
    state: tauri::State<'_, AppState>,
    month_scope: Option<bool>,
) -> AppResult<Vec<crate::index::UsageRow>> {
    state.ai_usage(month_scope.unwrap_or(false))
}

#[tauri::command]
pub fn ai_clear_calls(state: tauri::State<'_, AppState>) -> AppResult<()> {
    state.ai_clear_calls()
}

#[tauri::command]
pub fn ai_search_materials(
    state: tauri::State<'_, AppState>,
    query: String,
) -> AppResult<Vec<SearchHit>> {
    state.ai_search_materials(&query)
}
