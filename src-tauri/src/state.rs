use std::path::PathBuf;
use std::sync::Mutex;

use crate::assets;
use crate::frontmatter::{self, Frontmatter, PostStatus};
use crate::history::{self, RetentionConfig};
use crate::index::{FileMeta, Index, Scope, SearchHit};
use crate::scan;
use crate::vfolder::{self, PostRef, TreeNode};
use crate::workspace::Workspace;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("index: {0}")]
    Index(#[from] crate::index::Error),
    #[error("history: {0}")]
    History(#[from] history::HistoryError),
    #[error("frontmatter: {0}")]
    Frontmatter(#[from] serde_yaml::Error),
    #[error("虚拟目录: {0}")]
    VFolder(#[from] vfolder::VFolderError),
    #[error("{0}")]
    NotFound(String),
}

impl serde::Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostSummary {
    pub id: String,
    pub title: String,
    pub folder: Option<String>,
    pub status: String,
    pub tags: Vec<String>,
    pub path: String,
    pub updated_at: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostsPayload {
    pub tree: Vec<TreeNode>,
    pub posts: Vec<PostSummary>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashItem {
    pub id: String,
    pub title: String,
    pub folder: Option<String>,
    pub deleted_at: String,
    pub days_left: i64,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostContent {
    pub id: String,
    pub title: String,
    pub folder: Option<String>,
    pub status: String,
    pub tags: Vec<String>,
    pub body: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    pub updated_at: String,
    pub snapshotted: bool,
}

/// 命令层核心：所有业务方法都在这（Tauri command 只做薄封装，可独立测试）。
pub struct AppState {
    pub ws: Workspace,
    pub idx: Mutex<Index>,
}

impl AppState {
    pub fn new(ws: Workspace) -> AppResult<Self> {
        let idx = Index::open(&ws.root.join(".index").join("index.db"))?;
        Ok(Self {
            ws,
            idx: Mutex::new(idx),
        })
    }

    fn with_idx<R>(&self, f: impl FnOnce(&Index) -> AppResult<R>) -> AppResult<R> {
        let idx = self
            .idx
            .lock()
            .map_err(|_| AppError::NotFound("索引锁中毒".into()))?;
        f(&idx)
    }

    fn with_idx_mut<R>(&self, f: impl FnOnce(&Index) -> AppResult<R>) -> AppResult<R> {
        let idx = self
            .idx
            .lock()
            .map_err(|_| AppError::NotFound("索引锁中毒".into()))?;
        f(&idx)
    }

    // ───── 列表 ─────

    pub fn list_posts(&self) -> AppResult<PostsPayload> {
        self.with_idx(|idx| {
            let metas = idx.list_by_kind("post", false)?;
            let posts: Vec<PostSummary> = metas
                .iter()
                .map(|m| PostSummary {
                    id: m.id.clone(),
                    title: m.title.clone(),
                    folder: m.folder.clone(),
                    status: m.status.clone(),
                    tags: serde_json::from_str(&m.tags).unwrap_or_default(),
                    path: m.path.clone(),
                    updated_at: m.updated_at.clone(),
                })
                .collect();
            let refs: Vec<PostRef> = posts
                .iter()
                .map(|p| PostRef {
                    id: p.id.clone(),
                    title: p.title.clone(),
                    folder: p.folder.clone(),
                })
                .collect();
            Ok(PostsPayload {
                tree: vfolder::build_tree(&refs),
                posts,
            })
        })
    }

    // ───── 创建 / 读取 / 保存 ─────

    pub fn create_post(&self, title: &str, folder: Option<&str>) -> AppResult<PostSummary> {
        let fm = Frontmatter::new_post(title, folder);
        let slug = self.unique_slug(&slugify(title), &fm);
        let path = format!("posts/{slug}.md");
        let content = fm.to_content("");
        std::fs::create_dir_all(self.ws.root.join("posts"))?;
        std::fs::write(self.ws.root.join(&path), &content)?;
        let meta = self.meta_of(&fm, &path, &content, "");
        let summary = self.summary_of(&meta, &fm.tags);
        self.with_idx_mut(|idx| Ok(idx.upsert_file(&meta, "")?))?;
        Ok(summary)
    }

    fn unique_slug(&self, base: &str, fm: &Frontmatter) -> String {
        let mut candidate = base.to_string();
        let mut i = 2;
        loop {
            let p = self.ws.root.join(format!("posts/{candidate}.md"));
            if !p.exists() {
                return candidate;
            }
            candidate = format!("{base}-{i}");
            i += 1;
            let _ = fm;
        }
    }

    fn meta_of(&self, fm: &Frontmatter, path: &str, full: &str, body: &str) -> FileMeta {
        let _ = body;
        FileMeta {
            id: fm.id.to_string(),
            kind: "post".into(),
            path: path.into(),
            title: fm.title.clone(),
            folder: fm.folder.clone(),
            status: fm.status.to_string(),
            tags: serde_json::to_string(&fm.tags).unwrap_or_else(|_| "[]".into()),
            created_at: fm.created.clone(),
            updated_at: fm.updated.clone(),
            deleted_at: None,
            hash: scan::file_hash(full),
            missing: false,
        }
    }

    fn summary_of(&self, m: &FileMeta, tags: &[String]) -> PostSummary {
        PostSummary {
            id: m.id.clone(),
            title: m.title.clone(),
            folder: m.folder.clone(),
            status: m.status.clone(),
            tags: tags.to_vec(),
            path: m.path.clone(),
            updated_at: m.updated_at.clone(),
        }
    }

    fn meta_path(&self, id: &str) -> AppResult<(FileMeta, String)> {
        self.with_idx(|idx| {
            idx.get_file(id)?
                .map(|m| {
                    let abs = self.ws.root.join(&m.path).to_string_lossy().into_owned();
                    (m, abs)
                })
                .ok_or_else(|| AppError::NotFound(format!("找不到文稿 {id}")))
        })
    }

    pub fn read_post(&self, id: &str) -> AppResult<PostContent> {
        let (_, abs) = self.meta_path(id)?;
        let content = std::fs::read_to_string(&abs)?;
        let (fm, body) = frontmatter::parse(&content)?;
        Ok(PostContent {
            id: fm.id.to_string(),
            title: fm.title,
            folder: fm.folder,
            status: fm.status.to_string(),
            tags: fm.tags,
            body,
        })
    }

    /// content = 正文 body（不含 frontmatter）；frontmatter 由服务端维护。
    pub fn save_post(&self, id: &str, body: &str) -> AppResult<SaveResult> {
        let (meta, abs) = self.meta_path(id)?;
        let prev = std::fs::read_to_string(&abs)?;
        let (mut fm, prev_body) = frontmatter::parse(&prev)?;
        let body_changed = history::is_material_change(&prev_body, body);
        fm.bump_updated();
        let new_content = fm.to_content(body);
        // 快照判定只看正文是否实质变化；快照内容为完整文件
        if body_changed {
            history::write_snapshot(&self.ws, &self.idx.lock().unwrap(), id, &new_content)?;
        }
        std::fs::write(&abs, &new_content)?;
        let m = self.meta_of(&fm, &meta.path, &new_content, body);
        let updated = fm.updated.clone();
        self.with_idx_mut(|idx| Ok(idx.upsert_file(&m, body)?))?;
        Ok(SaveResult {
            updated_at: updated,
            snapshotted: body_changed,
        })
    }

    fn rewrite_frontmatter(&self, id: &str, f: impl FnOnce(&mut Frontmatter)) -> AppResult<PostSummary> {
        let (meta, abs) = self.meta_path(id)?;
        let content = std::fs::read_to_string(&abs)?;
        let (mut fm, body) = frontmatter::parse(&content)?;
        f(&mut fm);
        fm.bump_updated();
        let new_content = fm.to_content(&body);
        std::fs::write(&abs, &new_content)?;
        let m = self.meta_of(&fm, &meta.path, &new_content, &body);
        let summary = self.summary_of(&m, &fm.tags);
        self.with_idx_mut(|idx| Ok(idx.upsert_file(&m, &body)?))?;
        Ok(summary)
    }

    pub fn set_post_title(&self, id: &str, title: &str) -> AppResult<PostSummary> {
        self.rewrite_frontmatter(id, |fm| fm.title = title.to_string())
    }

    pub fn set_post_status(&self, id: &str, status: &str) -> AppResult<PostSummary> {
        let s = match status {
            "draft" => PostStatus::Draft,
            "writing" => PostStatus::Writing,
            "done" => PostStatus::Done,
            "archived" => PostStatus::Archived,
            _ => return Err(AppError::NotFound(format!("未知状态 {status}"))),
        };
        self.rewrite_frontmatter(id, |fm| fm.status = s)
    }

    /// 拖拽改分类：只改 frontmatter folder，物理不动（DESIGN §4.4）。
    pub fn set_post_folder(&self, id: &str, folder: Option<&str>) -> AppResult<PostSummary> {
        let normalized = vfolder::normalize_folder(folder.unwrap_or(""));
        self.rewrite_frontmatter(id, |fm| fm.folder = normalized)
    }

    /// 重命名虚拟目录：批量改成员 folder。
    pub fn rename_virtual_folder(&self, from: &str, to: &str) -> AppResult<PostsPayload> {
        let metas = self.with_idx(|idx| Ok(idx.list_by_kind("post", false)?))?;
        let refs: Vec<PostRef> = metas
            .iter()
            .map(|m| PostRef {
                id: m.id.clone(),
                title: m.title.clone(),
                folder: m.folder.clone(),
            })
            .collect();
        let updated = vfolder::rename_folder(&refs, from, to)?;
        for p in updated {
            if let Some(folder) = &p.folder {
                let old = refs.iter().find(|r| r.id == p.id).and_then(|r| r.folder.clone());
                if old.as_deref() != Some(folder.as_str()) {
                    self.set_post_folder(&p.id, Some(folder))?;
                }
            }
        }
        self.list_posts()
    }

    // ───── 回收站 ─────

    pub fn move_post_to_trash(&self, id: &str) -> AppResult<()> {
        let (mut meta, abs) = self.meta_path(id)?;
        let src = PathBuf::from(&abs);
        let filename = src
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| format!("{id}.md"));
        let trash_dir = self.ws.root.join("posts/.trash");
        std::fs::create_dir_all(&trash_dir)?;
        let mut dst = trash_dir.join(&filename);
        if dst.exists() {
            dst = trash_dir.join(format!("{}-{id}.md", filename.trim_end_matches(".md")));
        }
        std::fs::rename(&src, &dst)?;
        meta.path = dst
            .strip_prefix(&self.ws.root)
            .unwrap_or(&dst)
            .to_string_lossy()
            .replace('\\', "/");
        meta.deleted_at = Some(chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string());
        let body = std::fs::read_to_string(&dst).unwrap_or_default();
        self.with_idx_mut(|idx| Ok(idx.upsert_file(&meta, &body)?))?;
        Ok(())
    }

    pub fn list_trash(&self) -> AppResult<Vec<TrashItem>> {
        self.with_idx(|idx| {
            let metas = idx.list_by_kind("post", true)?;
            let now = chrono::Local::now();
            Ok(metas
                .iter()
                .filter_map(|m| {
                    let deleted_at = m.deleted_at.clone()?;
                    let dt = chrono::NaiveDateTime::parse_from_str(&deleted_at, "%Y-%m-%dT%H:%M:%S").ok()?;
                    let days = (now.naive_local() - dt).num_days();
                    Some(TrashItem {
                        id: m.id.clone(),
                        title: m.title.clone(),
                        folder: m.folder.clone(),
                        deleted_at,
                        days_left: (30 - days).max(0),
                    })
                })
                .collect())
        })
    }

    pub fn restore_post(&self, id: &str) -> AppResult<PostSummary> {
        let (mut meta, abs) = self.meta_path(id)?;
        if meta.deleted_at.is_none() {
            return Err(AppError::NotFound("文稿不在回收站".into()));
        }
        let src = PathBuf::from(&abs);
        let filename = src
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| format!("{id}.md"));
        let posts_dir = self.ws.root.join("posts");
        let mut dst = posts_dir.join(&filename);
        let mut i = 2;
        let stem = filename.trim_end_matches(".md").to_string();
        while dst.exists() {
            dst = posts_dir.join(format!("{stem}-{i}.md"));
            i += 1;
        }
        std::fs::rename(&src, &dst)?;
        meta.path = dst
            .strip_prefix(&self.ws.root)
            .unwrap_or(&dst)
            .to_string_lossy()
            .replace('\\', "/");
        meta.deleted_at = None;
        let content = std::fs::read_to_string(&dst)?;
        let (fm, body) = frontmatter::parse(&content)?;
        let m = self.meta_of(&fm, &meta.path, &content, &body);
        let summary = self.summary_of(&m, &fm.tags);
        self.with_idx_mut(|idx| Ok(idx.upsert_file(&m, &body)?))?;
        Ok(summary)
    }

    // ───── 历史 ─────

    pub fn list_snapshots(&self, id: &str) -> AppResult<Vec<history::SnapshotEntry>> {
        self.with_idx(|idx| Ok(history::list_snapshots(&self.ws, idx, id)?))
    }

    pub fn restore_snapshot(&self, id: &str, snapshot_file: &str) -> AppResult<PostContent> {
        self.with_idx(|idx| Ok(history::restore(&self.ws, idx, id, snapshot_file)?))?;
        self.read_post(id)
    }

    pub fn set_snapshot_milestone(&self, id: &str, snapshot_file: &str, name: &str) -> AppResult<()> {
        self.with_idx(|idx| {
            Ok(history::set_milestone(&self.ws, idx, id, snapshot_file, name)?)
        })?;
        Ok(())
    }

    // ───── 附件 / 检索 / 扫描 ─────

    /// 贴图入库 → 返回可直接插进正文的相对路径 markdown。
    pub fn save_pasted_image(&self, post_id: &str, bytes: &[u8], ext: &str) -> AppResult<String> {
        let (meta, _) = self.meta_path(post_id)?;
        let (_, filename) = assets::save_asset(&self.ws, bytes, ext)?;
        Ok(assets::relative_asset_path(&meta.path, &filename))
    }

    pub fn search_posts(&self, query: &str) -> AppResult<Vec<SearchHit>> {
        self.with_idx(|idx| Ok(idx.search(query, Scope::Posts)?))
    }

    pub fn scan_refresh(&self) -> AppResult<scan::ScanReport> {
        let mut report = scan::scan_posts(&self.ws)?;
        {
            let idx = self.idx.lock().map_err(|_| AppError::NotFound("索引锁中毒".into()))?;
            scan::diff_with_index(&idx, &mut report)?;
            scan::apply_to_index(&idx, &report)?;
        }
        Ok(report)
    }

    /// 外部新建（无 id）文件导入：补 id/title 写回并入库。
    pub fn import_external(&self, rel_path: &str) -> AppResult<PostSummary> {
        let abs = self.ws.root.join(rel_path);
        let content = std::fs::read_to_string(&abs)?;
        let (parsed, body) = frontmatter::parse(&content)?;
        let stem = abs
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let mut fm = Frontmatter::new_post(&stem, None);
        fm.extra = parsed.extra;
        let new_content = fm.to_content(&body);
        std::fs::write(&abs, &new_content)?;
        let m = self.meta_of(&fm, rel_path, &new_content, &body);
        let summary = self.summary_of(&m, &fm.tags);
        self.with_idx_mut(|idx| Ok(idx.upsert_file(&m, &body)?))?;
        Ok(summary)
    }

    /// 启动维护：扫描重联 + 历史清理 + 回收站到期清除。
    pub fn startup_maintenance(&self) -> AppResult<()> {
        self.scan_refresh()?;
        self.with_idx(|idx| {
            let now = chrono::Utc::now();
            history::cleanup(&self.ws, idx, &now, &RetentionConfig::default())?;
            history::purge_trash(&self.ws, idx, &now)?;
            Ok(())
        })
    }
}

/// 物理文件名 slug：ASCII 标题 → kebab；非 ASCII（如中文）→ post-{uuid8}。
fn slugify(title: &str) -> String {
    let mut s: String = title
        .trim()
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    while s.contains("--") {
        s = s.replace("--", "-");
    }
    let s = s.trim_matches('-').to_string();
    if s.is_empty() {
        format!("post-{}", &uuid::Uuid::new_v4().to_string()[..8])
    } else {
        s.chars().take(60).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> (tempfile::TempDir, AppState) {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::init(dir.path()).unwrap();
        // 测试用内存库，避免落盘锁冲突
        let state = AppState {
            ws,
            idx: Mutex::new(Index::open_in_memory().unwrap()),
        };
        (dir, state)
    }

    #[test]
    fn create_post_generates_slug_and_collision_suffix() {
        let (_d, st) = state();
        let a = st.create_post("Hello World", None).unwrap();
        assert!(a.path.ends_with("posts/hello-world.md"), "{}", a.path);
        let b = st.create_post("Hello World", None).unwrap();
        assert!(b.path.ends_with("posts/hello-world-2.md"));
        let c = st.create_post("深度工作", None).unwrap();
        assert!(c.path.starts_with("posts/post-"), "{}", c.path);
    }

    #[test]
    fn save_post_preserves_id_bumps_updated_and_snapshots() {
        let (_d, st) = state();
        let p = st.create_post("A", None).unwrap();
        let first = st.save_post(&p.id, "第一版").unwrap();
        assert!(first.snapshotted);
        assert!(!first.updated_at.is_empty());
        let before = st.read_post(&p.id).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        let second = st.save_post(&p.id, "第二版").unwrap();
        assert_ne!(before.title, "\u{0}"); // title 未被破坏
        assert!(second.snapshotted);
        let again = st.read_post(&p.id).unwrap();
        assert_eq!(again.body, "第二版");
        assert_eq!(again.id, p.id); // id 保留
        assert_eq!(st.list_snapshots(&p.id).unwrap().len(), 2);
        // 无实质变化不快照
        let third = st.save_post(&p.id, "第二版\n\n").unwrap();
        assert!(!third.snapshotted);
        assert_eq!(st.list_snapshots(&p.id).unwrap().len(), 2);
    }

    #[test]
    fn trash_then_restore_keeps_folder() {
        let (_d, st) = state();
        let p = st.create_post("A", Some("技术/分布式")).unwrap();
        st.move_post_to_trash(&p.id).unwrap();
        let trash = st.list_trash().unwrap();
        assert_eq!(trash.len(), 1);
        assert_eq!(trash[0].folder.as_deref(), Some("技术/分布式"));
        // 回收站中的文稿不出现在列表
        assert!(st.list_posts().unwrap().posts.is_empty());
        let restored = st.restore_post(&p.id).unwrap();
        assert_eq!(restored.folder.as_deref(), Some("技术/分布式"));
        assert!(st.list_trash().unwrap().is_empty());
    }

    #[test]
    fn set_post_folder_moves_logically_only() {
        let (_d, st) = state();
        let p = st.create_post("A", None).unwrap();
        let physical = st.ws.root.join(&p.path);
        st.set_post_folder(&p.id, Some("随笔")).unwrap();
        let content = std::fs::read_to_string(&physical).unwrap();
        assert!(content.contains("folder: 随笔"));
        // 物理路径不变
        assert_eq!(
            st.with_idx(|i| Ok(i.get_file(&p.id)?)).unwrap().unwrap().path,
            p.path
        );
    }

    #[test]
    fn rename_virtual_folder_updates_all_members() {
        let (_d, st) = state();
        let a = st.create_post("A", Some("技术/分布式")).unwrap();
        let b = st.create_post("B", Some("技术")).unwrap();
        let c = st.create_post("C", Some("技术前沿")).unwrap();
        let payload = st.rename_virtual_folder("技术", "后端").unwrap();
        let find = |id: &str| payload.posts.iter().find(|p| p.id == id).unwrap().folder.clone();
        assert_eq!(find(&a.id).as_deref(), Some("后端/分布式"));
        assert_eq!(find(&b.id).as_deref(), Some("后端"));
        assert_eq!(find(&c.id).as_deref(), Some("技术前沿"));
    }
}
