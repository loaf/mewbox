use std::path::PathBuf;
use std::sync::Mutex;

use crate::assets;
use crate::assoc::{self, AssocBlock, AssocEntry};
use crate::frontmatter::{self, Frontmatter, PostStatus};
use crate::history::{self, RetentionConfig};
use crate::index::{FileMeta, Index, LinkRow, Scope, SearchHit};
use crate::links;
use crate::materials;
use crate::materials::MaterialSummary;
use crate::publish;
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
    #[error("发布版本: {0}")]
    Publish(#[from] crate::publish::PublishError),
    #[error("资料: {0}")]
    Material(#[from] crate::materials::MaterialError),
    #[error("配置: {0}")]
    Config(#[from] crate::config::ConfigError),
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
    /// 工作区相对路径（前端解析贴图等相对引用用）
    pub path: String,
    /// 尾部关联块（结构化；body 不含块）
    pub assoc: Option<crate::assoc::AssocBlock>,
}

/// 资料内容（编辑器加载用）。
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterialContent {
    pub id: String,
    pub title: String,
    pub body: String,
    pub path: String,
    pub folder: Option<String>,
    pub assoc: Option<crate::assoc::AssocBlock>,
}

/// 反向链接条目（§7.2）。
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Backlink {
    pub from_id: String,
    pub from_title: String,
    /// wiki（正文链接）| assoc（尾部关联块）
    pub kind: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiHit {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub path: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiResolve {
    pub matched: Option<WikiHit>,
    pub candidates: Vec<WikiHit>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    pub updated_at: String,
    pub snapshotted: bool,
}

/// 发布版本内容（编辑器加载用，与 PostContent 对应）。
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionContent {
    pub id: String,
    pub base: String,
    pub target: String,
    pub title: String,
    pub body: String,
    pub published_url: Option<String>,
    pub published_at: Option<String>,
    /// 工作区相对路径（前端解析贴图等相对引用用）
    pub path: String,
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

    pub(crate) fn with_idx<R>(&self, f: impl FnOnce(&Index) -> AppResult<R>) -> AppResult<R> {
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
        let (meta, abs) = self.meta_path(id)?;
        let content = std::fs::read_to_string(&abs)?;
        let (fm, body_with_block) = frontmatter::parse(&content)?;
        // 机制决策 1：编辑器拿到的 body 不含尾部关联块；块以结构化数据返回
        let (body, assoc_block) = assoc::strip_assoc(&body_with_block);
        Ok(PostContent {
            id: fm.id.to_string(),
            title: fm.title,
            folder: fm.folder,
            status: fm.status.to_string(),
            tags: fm.tags,
            body,
            path: meta.path,
            assoc: assoc_block,
        })
    }

    /// content = 纯正文（不含 frontmatter 与关联块）；块以磁盘当前内容回拼（机制决策 1）。
    pub fn save_post(&self, id: &str, body: &str) -> AppResult<SaveResult> {
        let (meta, abs) = self.meta_path(id)?;
        let prev = std::fs::read_to_string(&abs)?;
        let (mut fm, prev_body_with_block) = frontmatter::parse(&prev)?;
        let (prev_clean, disk_block) = assoc::strip_assoc(&prev_body_with_block);
        let (incoming_clean, _) = assoc::strip_assoc(body); // 防御：剥离误传的块
        let body_changed = history::is_material_change(&prev_clean, &incoming_clean);
        fm.bump_updated();
        let new_content = fm.to_content(&assoc::append_assoc(&incoming_clean, &disk_block.unwrap_or_default()));
        // 快照判定只看纯正文；快照内容为完整文件
        if body_changed {
            history::write_snapshot(&self.ws, &self.idx.lock().unwrap(), id, &new_content)?;
        }
        std::fs::write(&abs, &new_content)?;
        let m = self.meta_of(&fm, &meta.path, &new_content, &incoming_clean);
        let updated = fm.updated.clone();
        self.with_idx_mut(|idx| Ok(idx.upsert_file(&m, &incoming_clean)?))?;
        Ok(SaveResult {
            updated_at: updated,
            snapshotted: body_changed,
        })
    }

    fn rewrite_frontmatter(&self, id: &str, f: impl FnOnce(&mut Frontmatter)) -> AppResult<PostSummary> {
        let (meta, abs) = self.meta_path(id)?;
        let content = std::fs::read_to_string(&abs)?;
        let (mut fm, body_with_block) = frontmatter::parse(&content)?;
        let (body, disk_block) = assoc::strip_assoc(&body_with_block);
        f(&mut fm);
        fm.bump_updated();
        let new_content = fm.to_content(&assoc::append_assoc(&body, &disk_block.unwrap_or_default()));
        std::fs::write(&abs, &new_content)?;
        let m = self.meta_of(&fm, &meta.path, &new_content, &body);
        let summary = self.summary_of(&m, &fm.tags);
        self.with_idx_mut(|idx| Ok(idx.upsert_file(&m, &body)?))?;
        Ok(summary)
    }

    pub fn set_post_title(&self, id: &str, title: &str) -> AppResult<PostSummary> {
        let old = self.meta_by_id(id)?.title;
        let summary = self.rewrite_frontmatter(id, |fm| fm.title = title.to_string())?;
        if old != title {
            self.sync_title_refs(id, &old, title)?;
        }
        Ok(summary)
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

    pub fn read_snapshot_body(&self, id: &str, snapshot_file: &str) -> AppResult<String> {
        Ok(history::read_snapshot_body(&self.ws, id, snapshot_file)?)
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
        let material_report = scan::scan_materials(&self.ws)?;
        report.materials = material_report.materials;
        report.material_pending_import = material_report.material_pending_import;
        {
            let idx = self.idx.lock().map_err(|_| AppError::NotFound("索引锁中毒".into()))?;
            scan::diff_with_index(&idx, &mut report)?;
            scan::apply_to_index(&idx, &report)?;
        }
        report.orphan_versions = self.scan_publishes()?;
        self.rebuild_link_graph()?;
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

    // ───── 发布版本（DESIGN §5） ─────

    fn version_content(&self, base_id: &str, target: &str) -> AppResult<VersionContent> {
        let (fm, body) = publish::read_version_body(&self.ws, base_id, target)?;
        let path = publish::relative(&self.ws, &publish::version_path(&self.ws, base_id, target));
        Ok(VersionContent {
            id: fm.id.to_string(),
            base: fm.base,
            target: fm.target,
            title: fm.title,
            body,
            published_url: fm.published_url,
            published_at: fm.published_at,
            path,
        })
    }

    pub fn list_publish_versions(&self, base_id: &str) -> AppResult<Vec<publish::VersionSummary>> {
        Ok(publish::list_versions(&self.ws)
            .into_iter()
            .filter(|v| v.base == base_id)
            .collect())
    }

    /// 全量版本清单（侧栏徽标计数用）。
    pub fn list_all_versions(&self) -> AppResult<Vec<publish::VersionSummary>> {
        Ok(publish::list_versions(&self.ws))
    }

    /// 工作区根目录绝对路径（前端把相对资源映射为 asset 协议 URL 用）。
    pub fn workspace_root(&self) -> String {
        self.ws.root.to_string_lossy().replace('\\', "/")
    }

    pub fn create_publish_version(
        &self,
        base_id: &str,
        target: &str,
        from_snapshot: Option<String>,
        current_body: Option<String>,
    ) -> AppResult<VersionContent> {
        let (meta, abs) = self.meta_path(base_id)?;
        let (from_body, forked) = match &from_snapshot {
            Some(f) => (history::read_snapshot_body(&self.ws, base_id, f)?, Some(f.clone())),
            None => {
                // 编辑器当前正文优先（flush 后由前端传入），文件读取兜底
                let body = match &current_body {
                    Some(b) => b.clone(),
                    None => {
                        let content = std::fs::read_to_string(&abs)?;
                        frontmatter::parse(&content).map(|(_, body)| body)?
                    }
                };
                (body, None)
            }
        };
        let post_dir = std::path::Path::new(&meta.path)
            .parent()
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        let title = meta.title;
        self.with_idx(|idx| {
            Ok(publish::create_version(
                &self.ws,
                idx,
                base_id,
                &title,
                target,
                &from_body,
                &post_dir,
                forked,
            )?)
        })?;
        // 创建后刷新母版尾部块的「发布版本」区（M2 顺延项）
        self.refresh_versions_section(base_id)?;
        Ok(self.version_content(base_id, target)?)
    }

    pub fn read_publish_version(&self, base_id: &str, target: &str) -> AppResult<VersionContent> {
        Ok(self.version_content(base_id, target)?)
    }

    pub fn save_publish_version(
        &self,
        base_id: &str,
        target: &str,
        body: &str,
    ) -> AppResult<SaveResult> {
        let (_, prev_body) = publish::read_version_body(&self.ws, base_id, target)?;
        let snapshotted = history::is_material_change(&prev_body, body);
        let s = self.with_idx(|idx| {
            Ok(publish::save_version(&self.ws, idx, base_id, target, body)?)
        })?;
        Ok(SaveResult {
            updated_at: s.updated_at,
            snapshotted,
        })
    }

    pub fn sync_publish_from_post(&self, base_id: &str, target: &str) -> AppResult<VersionContent> {
        let (meta, abs) = self.meta_path(base_id)?;
        let content = std::fs::read_to_string(&abs)?;
        let (_, body) = frontmatter::parse(&content)?;
        let post_dir = std::path::Path::new(&meta.path)
            .parent()
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        self.with_idx(|idx| {
            Ok(publish::sync_from_post(&self.ws, idx, base_id, target, &body, &post_dir)?)
        })?;
        Ok(self.version_content(base_id, target)?)
    }

    pub fn set_publish_published(
        &self,
        base_id: &str,
        target: &str,
        url: Option<String>,
        date: Option<String>,
    ) -> AppResult<publish::VersionSummary> {
        Ok(self.with_idx(|idx| {
            Ok(publish::set_published(&self.ws, idx, base_id, target, url, date)?)
        })?)
    }

    pub fn list_version_snapshots(
        &self,
        base_id: &str,
        target: &str,
    ) -> AppResult<Vec<history::SnapshotEntry>> {
        Ok(self.with_idx(|idx| {
            Ok(publish::list_version_snapshots(&self.ws, idx, base_id, target)?)
        })?)
    }

    pub fn read_version_snapshot(&self, base_id: &str, target: &str, snapshot_file: &str) -> AppResult<String> {
        Ok(publish::read_version_snapshot_body(&self.ws, base_id, target, snapshot_file)?)
    }

    pub fn restore_version_snapshot(&self, base_id: &str, target: &str, snapshot_file: &str) -> AppResult<VersionContent> {
        self.with_idx(|idx| {
            Ok(publish::restore_version_snapshot(&self.ws, idx, base_id, target, snapshot_file)?)
        })?;
        Ok(self.version_content(base_id, target)?)
    }

    pub fn set_version_milestone(&self, base_id: &str, target: &str, snapshot_file: &str, name: &str) -> AppResult<()> {
        self.with_idx(|idx| {
            Ok(publish::set_version_milestone(&self.ws, idx, base_id, target, snapshot_file, name)?)
        })?;
        Ok(())
    }

    pub fn list_publish_targets(&self) -> AppResult<Vec<crate::config::PublishTarget>> {
        Ok(crate::config::list_targets(&self.ws)?)
    }

    pub fn add_publish_target(&self, id: &str, display: &str, note: &str) -> AppResult<()> {
        Ok(crate::config::add_target(&self.ws, id, display, note)?)
    }

    /// 版本态贴图：按版本文件实际路径重算相对引用。
    pub fn save_pasted_image_at(&self, file_rel_path: &str, bytes: &[u8], ext: &str) -> AppResult<String> {
        let (_, filename) = assets::save_asset(&self.ws, bytes, ext)?;
        Ok(assets::relative_asset_path(file_rel_path, &filename))
    }

    /// 发布版本索引维护：登记磁盘版本、清除消失行、报告无主版本（base 在回收站不算）。
    fn scan_publishes(&self) -> AppResult<Vec<String>> {
        let versions = publish::list_versions(&self.ws);
        let mut orphans = Vec::new();
        self.with_idx(|idx| {
            let mut on_disk: std::collections::HashSet<String> = std::collections::HashSet::new();
            for v in &versions {
                on_disk.insert(v.id.clone());
                publish::reindex_version(&self.ws, idx, &v.base, &v.target)?;
                let orphan = match idx.get_file(&v.base)? {
                    None => true,
                    Some(m) => m.missing && m.deleted_at.is_none(),
                };
                if orphan {
                    orphans.push(format!("{}（base {}）", v.target, v.base));
                }
            }
            for row in idx.list_by_kind("publish", true)? {
                if !on_disk.contains(&row.id) {
                    idx.purge_file(&row.id)?;
                }
            }
            Ok(())
        })?;
        Ok(orphans)
    }

    // ───── 知识库与关联体系（M3，DESIGN §6/§7） ─────

    pub(crate) fn live_files(&self) -> AppResult<Vec<FileMeta>> {
        Ok(self.with_idx(|idx| {
            let mut all = idx.list_by_kind("post", false)?;
            all.extend(idx.list_by_kind("material", false)?);
            Ok(all)
        })?)
    }

    fn meta_by_id(&self, id: &str) -> AppResult<FileMeta> {
        Ok(self.with_idx(|idx| {
            Ok(idx
                .get_file(id)?
                .filter(|m| m.deleted_at.is_none())
                .ok_or_else(|| AppError::NotFound(format!("找不到文件 {id}")))?)
        })?)
    }

    /// 含回收站行的查找（恢复操作用）。
    fn meta_by_id_any(&self, id: &str) -> AppResult<FileMeta> {
        Ok(self.with_idx(|idx| {
            Ok(idx
                .get_file(id)?
                .ok_or_else(|| AppError::NotFound(format!("找不到文件 {id}")))?)
        })?)
    }

    /// 读任一文件（post/material）：(fm, 纯正文, 块)。
    fn read_any(&self, rel_path: &str) -> AppResult<(Frontmatter, String, Option<AssocBlock>)> {
        let content = std::fs::read_to_string(self.ws.root.join(rel_path))?;
        let (fm, body_with_block) = frontmatter::parse(&content)?;
        let (clean, block) = assoc::strip_assoc(&body_with_block);
        Ok((fm, clean, block))
    }

    /// 写任一文件：fm + 纯正文 + 磁盘当前块（机制决策 1；调用方传入要写的块则为新块）。
    fn write_any(&self, rel_path: &str, fm: &Frontmatter, clean_body: &str, block: Option<&AssocBlock>) -> AppResult<()> {
        let disk_block = if block.is_some() {
            None
        } else {
            self.read_any(rel_path)?.2
        };
        let b = block.or(disk_block.as_ref()).cloned().unwrap_or_default();
        std::fs::write(self.ws.root.join(rel_path), fm.to_content(&assoc::append_assoc(clean_body, &b)))?;
        Ok(())
    }

    fn upsert_row_of(&self, fm: &Frontmatter, meta: &FileMeta, clean_body: &str) -> AppResult<()> {
        let full = std::fs::read_to_string(self.ws.root.join(&meta.path))?;
        let mut m = self.meta_of(fm, &meta.path, &full, clean_body);
        m.kind = meta.kind.clone();
        if meta.kind == "material" {
            m.folder = materials::folder_of(&meta.path);
        }
        self.with_idx_mut(|idx| Ok(idx.upsert_file(&m, clean_body)?))
    }

    /// 关联/解除关联：双侧原子更新（§7.1）。
    pub fn update_assoc(&self, a_id: &str, b_id: &str, add: bool) -> AppResult<()> {
        let ma = self.meta_by_id(a_id)?;
        let mb = self.meta_by_id(b_id)?;
        if ma.path == mb.path {
            return Err(AppError::NotFound("不能与自身建立关联".into()));
        }
        let (mut fma, body_a, block_a) = self.read_any(&ma.path)?;
        let (mut fmb, body_b, block_b) = self.read_any(&mb.path)?;
        let mut ba = block_a.unwrap_or_default();
        let mut bb = block_b.unwrap_or_default();

        let entry_in_a = AssocEntry {
            title: mb.title.clone(),
            target: links::rel_between(&ma.path, &mb.path)
                .ok_or_else(|| AppError::NotFound("路径计算失败".into()))?,
        };
        let entry_in_b = AssocEntry {
            title: ma.title.clone(),
            target: links::rel_between(&mb.path, &ma.path)
                .ok_or_else(|| AppError::NotFound("路径计算失败".into()))?,
        };

        let target_of = |side_path: &str, e: &AssocEntry| -> Option<String> {
            links::resolve_dest(side_path, &e.target)
        };
        if add {
            let vec_a = if mb.kind == "material" { &mut ba.materials } else { &mut ba.posts };
            if !vec_a.iter().any(|e| target_of(&ma.path, e).as_deref() == Some(mb.path.as_str())) {
                vec_a.push(entry_in_a);
            }
            let vec_b = if ma.kind == "material" { &mut bb.materials } else { &mut bb.posts };
            if !vec_b.iter().any(|e| target_of(&mb.path, e).as_deref() == Some(ma.path.as_str())) {
                vec_b.push(entry_in_b);
            }
        } else {
            ba.posts.retain(|e| target_of(&ma.path, e).as_deref() != Some(mb.path.as_str()));
            ba.materials.retain(|e| target_of(&ma.path, e).as_deref() != Some(mb.path.as_str()));
            bb.posts.retain(|e| target_of(&mb.path, e).as_deref() != Some(ma.path.as_str()));
            bb.materials.retain(|e| target_of(&mb.path, e).as_deref() != Some(ma.path.as_str()));
        }
        fma.bump_updated();
        fmb.bump_updated();
        self.write_any(&ma.path, &fma, &body_a, Some(&ba))?;
        self.write_any(&mb.path, &fmb, &body_b, Some(&bb))?;
        self.upsert_row_of(&fma, &ma, &body_a)?;
        self.upsert_row_of(&fmb, &mb, &body_b)?;
        self.rebuild_link_graph()?;
        Ok(())
    }

    /// 文稿尾部块的「发布版本」区重建（§5.2/§7.1，M2 顺延项）。
    pub fn refresh_versions_section(&self, post_id: &str) -> AppResult<()> {
        let meta = self.meta_by_id(post_id)?;
        let (fm, body, block) = self.read_any(&meta.path)?;
        let mut b = block.unwrap_or_default();
        let versions: Vec<_> = publish::list_versions(&self.ws)
            .into_iter()
            .filter(|v| v.base == post_id)
            .collect();
        b.versions = versions
            .iter()
            .filter_map(|v| {
                links::rel_between(&meta.path, &v.path).map(|t| AssocEntry {
                    title: format!("{} 版", v.target),
                    target: t,
                })
            })
            .collect();
        self.write_any(&meta.path, &fm, &body, Some(&b))?;
        self.upsert_row_of(&fm, &meta, &body)?;
        Ok(())
    }

    /// 他人文件同步：正文相对链接与关联块路径 old → new（§7.3 的引用同步部分）。
    /// 迁移者本人（索引仍是旧路径）跳过，由调用方处理。
    fn sync_refs_for_move(&self, old_rel: &str, new_rel: &str) -> AppResult<()> {
        for other in self.live_files()? {
            if other.path == old_rel {
                continue;
            }
            let Ok((ofm, obody, oblock)) = self.read_any(&other.path) else {
                continue;
            };
            let new_body = materials::rewrite_links_to(&obody, &other.path, old_rel, new_rel);
            let mut ob = oblock.unwrap_or_default();
            let mut block_changed = false;
            for e in ob
                .posts
                .iter_mut()
                .chain(ob.materials.iter_mut())
                .chain(ob.versions.iter_mut())
            {
                if links::resolve_dest(&other.path, &e.target).as_deref() == Some(old_rel) {
                    if let Some(t) = links::rel_between(&other.path, new_rel) {
                        e.target = t;
                        block_changed = true;
                    }
                }
            }
            if new_body.is_some() || block_changed {
                self.write_any(&other.path, &ofm, new_body.as_deref().unwrap_or(&obody), Some(&ob))?;
                self.upsert_row_of(&ofm, &other, new_body.as_deref().unwrap_or(&obody))?;
            }
        }
        self.rebuild_link_graph()?;
        Ok(())
    }

    /// 文件迁移（移动/重命名/互转的原子核心，§7.3）：文件 → 他人正文相对链接 → 关联块双侧 → 索引。
    fn relocate(&self, id: &str, new_rel: &str, new_kind: Option<&str>) -> AppResult<()> {
        let mut meta = self.meta_by_id(id)?;
        let old_rel = meta.path.clone();
        if old_rel == new_rel {
            return Ok(());
        }
        let (mut fm, body, mut block) = self.read_any(&old_rel)?;
        // sparse 语义随目标库切换（机制决策 5）
        if let Some(kind) = new_kind {
            fm.sparse = kind == "material";
            if kind == "material" {
                fm.folder = None;
            }
        }
        materials::move_material_file(&self.ws, &old_rel, new_rel)?;
        meta.path = new_rel.to_string();
        if let Some(k) = new_kind {
            meta.kind = k.to_string();
        }
        if meta.kind == "material" {
            meta.folder = materials::folder_of(new_rel);
        }

        // 他人文件：正文相对链接 + 块内路径重算（引用同步）
        self.sync_refs_for_move(&old_rel, new_rel)?;
        // 自己：块内相对路径按新位置重算
        if let Some(b) = block.as_mut() {
            for e in b.posts.iter_mut().chain(b.materials.iter_mut()) {
                if let Some(resolved) = links::resolve_dest(&old_rel, &e.target) {
                    if let Some(t) = links::rel_between(new_rel, &resolved) {
                        e.target = t;
                    }
                }
            }
        }
        self.write_any(new_rel, &fm, &body, block.as_ref())?;
        self.upsert_row_of(&fm, &meta, &body)?;
        self.rebuild_link_graph()?;
        Ok(())
    }

    pub fn convert_material_to_post(&self, id: &str) -> AppResult<PostSummary> {
        let meta = self.meta_by_id(id)?;
        if meta.kind != "material" {
            return Err(AppError::NotFound("不是资料".into()));
        }
        let (_, new_name) = {
            let stem = std::path::Path::new(&meta.path)
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            let mut candidate = stem.clone();
            let mut i = 2;
            while self.ws.root.join(format!("posts/{candidate}.md")).exists() {
                candidate = format!("{stem}-{i}");
                i += 1;
            }
            ((), candidate)
        };
        self.relocate(id, &format!("posts/{new_name}.md"), Some("post"))?;
        self.refresh_versions_section(id);
        let meta = self.meta_by_id(id)?;
        let (fm, _, _) = self.read_any(&meta.path)?;
        Ok(self.summary_of(&meta, &fm.tags))
    }

    pub fn convert_post_to_material(&self, id: &str) -> AppResult<MaterialSummary> {
        let meta = self.meta_by_id(id)?;
        if meta.kind != "post" {
            return Err(AppError::NotFound("不是文稿".into()));
        }
        let stem = materials::unique_stem(&self.ws, "kb/Inbox", "from-post");
        let new_rel = format!("kb/Inbox/{stem}.md");
        self.relocate(id, &new_rel, Some("material"))?;
        let meta = self.meta_by_id(id)?;
        let (fm, _, _) = self.read_any(&meta.path)?;
        Ok(MaterialSummary {
            id: meta.id.clone(),
            title: meta.title.clone(),
            path: meta.path.clone(),
            folder: meta.folder.clone(),
            updated_at: fm.updated.clone(),
        })
    }

    pub fn rename_post_slug(&self, id: &str, new_slug: &str) -> AppResult<PostSummary> {
        let _ = self.meta_by_id(id)?;
        let slug = new_slug.trim().trim_end_matches(".md");
        if slug.is_empty() {
            return Err(AppError::NotFound("slug 不能为空".into()));
        }
        self.relocate(id, &format!("posts/{slug}.md"), None)?;
        let meta = self.meta_by_id(id)?;
        let (fm, _, _) = self.read_any(&meta.path)?;
        Ok(self.summary_of(&meta, &fm.tags))
    }

    pub fn rename_material_file(&self, id: &str, new_name: &str) -> AppResult<MaterialSummary> {
        let meta = self.meta_by_id(id)?;
        let dir = std::path::Path::new(&meta.path)
            .parent()
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|| "kb/Inbox".into());
        let stem = new_name.trim().trim_end_matches(".md");
        if stem.is_empty() {
            return Err(AppError::NotFound("名称不能为空".into()));
        }
        self.relocate(id, &format!("{dir}/{stem}.md"), None)?;
        let meta = self.meta_by_id(id)?;
        let (fm, _, _) = self.read_any(&meta.path)?;
        Ok(material_summary_of(&meta, &fm))
    }

    pub fn move_material(&self, id: &str, new_dir: &str) -> AppResult<MaterialSummary> {
        let meta = self.meta_by_id(id)?;
        let stem = std::path::Path::new(&meta.path)
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let dir = if new_dir.trim().is_empty() { "kb".to_string() } else { format!("kb/{}", new_dir.trim().trim_matches('/')) };
        self.relocate(id, &format!("{dir}/{stem}.md"), None)?;
        let meta = self.meta_by_id(id)?;
        let (fm, _, _) = self.read_any(&meta.path)?;
        Ok(material_summary_of(&meta, &fm))
    }

    pub fn rename_kb_dir(&self, dir_rel: &str, new_name: &str) -> AppResult<Vec<MaterialSummary>> {
        let prefix = format!("{}/", dir_rel.trim_matches('/'));
        let new_name = new_name.trim().trim_matches('/');
        if new_name.is_empty() {
            return Err(AppError::NotFound("目录名不能为空".into()));
        }
        let parent = std::path::Path::new(&prefix).parent().map(|p| p.to_string_lossy().replace('\\', "/")).unwrap_or_else(|| "kb".into());
        let mut moved = Vec::new();
        for m in self.live_files()? {
            if m.kind == "material" && m.path.starts_with(&prefix) {
                let rest = m.path.strip_prefix(&prefix).unwrap_or("");
                let new_rel = format!("{parent}/{new_name}/{rest}");
                self.relocate(&m.id, &new_rel, None)?;
                let meta = self.meta_by_id(&m.id)?;
                let (fm, _, _) = self.read_any(&meta.path)?;
                moved.push(material_summary_of(&meta, &fm));
            }
        }
        Ok(moved)
    }

    /// 标题变更全库同步（决策 14）：wiki 引用 + 关联块双侧显示标题。
    fn sync_title_refs(&self, id: &str, old_title: &str, new_title: &str) -> AppResult<()> {
        let meta = self.meta_by_id(id)?;
        for other in self.live_files()? {
            if other.id == id {
                continue;
            }
            let (ofm, obody, oblock) = self.read_any(&other.path)?;
            let new_body = links::rename_wiki_refs(&obody, old_title, new_title);
            let mut ob = oblock.unwrap_or_default();
            let mut changed = new_body != obody;
            for e in ob.posts.iter_mut().chain(ob.materials.iter_mut()) {
                if links::resolve_dest(&other.path, &e.target).as_deref() == Some(meta.path.as_str())
                    && e.title == old_title
                {
                    e.title = new_title.to_string();
                    changed = true;
                }
            }
            if changed {
                self.write_any(&other.path, &ofm, &new_body, Some(&ob))?;
                self.upsert_row_of(&ofm, &other, &new_body)?;
            }
        }
        self.rebuild_link_graph()?;
        Ok(())
    }

    /// 链接图全量重建（磁盘为准，机制决策 6）。
    pub fn rebuild_link_graph(&self) -> AppResult<()> {
        let files = self.live_files()?;
        let by_title: std::collections::HashMap<String, String> = files
            .iter()
            .map(|m| (m.title.clone(), m.id.clone()))
            .collect();
        let by_path: std::collections::HashMap<String, String> =
            files.iter().map(|m| (m.path.clone(), m.id.clone())).collect();
        let mut rows: Vec<LinkRow> = Vec::new();
        for m in &files {
            let Ok(content) = std::fs::read_to_string(self.ws.root.join(&m.path)) else { continue };
            let (_, body_with_block) = frontmatter::parse(&content).unwrap_or((Frontmatter::default(), content.clone()));
            let (clean, block) = assoc::strip_assoc(&body_with_block);
            for t in links::extract_wiki_refs(&clean) {
                rows.push(LinkRow {
                    from_id: m.id.clone(),
                    to_id: by_title.get(&t).cloned(),
                    raw_title: t,
                    kind: "wiki".into(),
                });
            }
            if let Some(b) = block {
                for e in b.posts.iter().chain(b.materials.iter()) {
                    let to = links::resolve_dest(&m.path, &e.target)
                        .and_then(|p| by_path.get(&p).cloned());
                    rows.push(LinkRow {
                        from_id: m.id.clone(),
                        to_id: to,
                        raw_title: e.title.clone(),
                        kind: "assoc".into(),
                    });
                }
            }
        }
        self.with_idx(|idx| Ok(idx.replace_links(&rows)?))?;
        Ok(())
    }

    /// 反向链接：两来源标注（§7.2）。
    pub fn backlinks(&self, id: &str) -> AppResult<Vec<Backlink>> {
        let meta = self.meta_by_id(id)?;
        let mut out = Vec::new();
        for other in self.live_files()? {
            if other.id == id {
                continue;
            }
            let Ok(content) = std::fs::read_to_string(self.ws.root.join(&other.path)) else { continue };
            let (_, body_with_block) = frontmatter::parse(&content).unwrap_or((Frontmatter::default(), content.clone()));
            let (clean, block) = assoc::strip_assoc(&body_with_block);
            if links::extract_wiki_refs(&clean).iter().any(|t| t == &meta.title) {
                out.push(Backlink {
                    from_id: other.id.clone(),
                    from_title: other.title.clone(),
                    kind: "wiki".into(),
                });
            }
            if let Some(b) = block {
                let hit = b.posts.iter().chain(b.materials.iter()).any(|e| {
                    links::resolve_dest(&other.path, &e.target).as_deref() == Some(meta.path.as_str())
                });
                if hit {
                    out.push(Backlink {
                        from_id: other.id.clone(),
                        from_title: other.title.clone(),
                        kind: "assoc".into(),
                    });
                }
            }
        }
        Ok(out)
    }

    /// `[[标题]]` 解析（§7.2）：唯一 → matched；重名 → 候选；无 → 空。
    pub fn resolve_wiki(&self, title: &str) -> AppResult<WikiResolve> {
        let files = self.live_files()?;
        let hits: Vec<WikiHit> = files
            .iter()
            .filter(|m| m.title == title)
            .map(|m| WikiHit {
                id: m.id.clone(),
                kind: m.kind.clone(),
                title: m.title.clone(),
                path: m.path.clone(),
            })
            .collect();
        Ok(match hits.len() {
            0 => WikiResolve { matched: None, candidates: vec![] },
            1 => WikiResolve { matched: hits.into_iter().next(), candidates: vec![] },
            _ => WikiResolve { matched: None, candidates: hits },
        })
    }

    // ───── 资料库操作（§6） ─────

    pub fn list_materials(&self) -> AppResult<Vec<MaterialSummary>> {
        Ok(self.with_idx(|idx| {
            let mut all = idx.list_by_kind("material", false)?;
            all.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
            Ok(all
                .into_iter()
                .map(|m| MaterialSummary {
                    id: m.id.clone(),
                    title: m.title.clone(),
                    path: m.path.clone(),
                    folder: m.folder.clone().or_else(|| materials::folder_of(&m.path)),
                    updated_at: m.updated_at.clone(),
                })
                .collect())
        })?)
    }

    pub fn create_material(&self, title: &str, dir_rel: &str) -> AppResult<MaterialContent> {
        let dir = if dir_rel.trim().is_empty() || dir_rel == "kb" {
            "kb/Inbox".to_string()
        } else {
            format!("kb/{}", dir_rel.trim().trim_matches('/'))
        };
        let (fm, rel) = materials::create_material(&self.ws, title, &dir)?;
        let m = FileMeta {
            id: fm.id.to_string(),
            kind: "material".into(),
            path: rel.clone(),
            title: fm.title.clone(),
            folder: materials::folder_of(&rel),
            status: "draft".into(),
            tags: "[]".into(),
            created_at: fm.created.clone(),
            updated_at: fm.updated.clone(),
            deleted_at: None,
            hash: String::new(),
            missing: false,
        };
        self.with_idx_mut(|idx| Ok(idx.upsert_file(&m, "")?))?;
        let folder = materials::folder_of(&rel);
        Ok(MaterialContent {
            id: fm.id.to_string(),
            title: fm.title,
            body: String::new(),
            path: rel,
            folder,
            assoc: None,
        })
    }

    pub fn read_material(&self, id: &str) -> AppResult<MaterialContent> {
        let meta = self.meta_by_id(id)?;
        let (fm, body, block) = self.read_any(&meta.path)?;
        Ok(MaterialContent {
            id: fm.id.to_string(),
            title: fm.title,
            body,
            path: meta.path.clone(),
            folder: meta.folder.clone().or_else(|| materials::folder_of(&meta.path)),
            assoc: block,
        })
    }

    pub fn save_material(&self, id: &str, body: &str) -> AppResult<SaveResult> {
        let meta = self.meta_by_id(id)?;
        let (mut fm, prev_clean, _) = self.read_any(&meta.path)?;
        let (incoming, _) = assoc::strip_assoc(body);
        let changed = history::is_material_change(&prev_clean, &incoming);
        fm.bump_updated();
        fm.sparse = true;
        let new_full = fm.to_content(&assoc::append_assoc(&incoming, &self.read_any(&meta.path)?.2.unwrap_or_default()));
        if changed {
            history::write_snapshot(&self.ws, &self.idx.lock().unwrap(), id, &new_full)?;
        }
        std::fs::write(self.ws.root.join(&meta.path), &new_full)?;
        self.upsert_row_of(&fm, &meta, &incoming)?;
        Ok(SaveResult {
            updated_at: fm.updated.clone(),
            snapshotted: changed,
        })
    }

    pub fn set_material_title(&self, id: &str, title: &str) -> AppResult<MaterialSummary> {
        let meta = self.meta_by_id(id)?;
        let (mut fm, body, block) = self.read_any(&meta.path)?;
        let old = fm.title.clone();
        fm.title = title.to_string();
        fm.bump_updated();
        self.write_any(&meta.path, &fm, &body, block.as_ref())?;
        self.upsert_row_of(&fm, &meta, &body)?;
        self.sync_title_refs(id, &old, title)?;
        let meta = self.meta_by_id(id)?;
        Ok(material_summary_of(&meta, &fm))
    }

    pub fn import_md_files(&self, src_abs: &[String], dest_dir: &str) -> AppResult<Vec<MaterialSummary>> {
        let dir = if dest_dir.trim().is_empty() { "kb/Inbox".to_string() } else { format!("kb/{}", dest_dir.trim().trim_matches('/')) };
        let mut out = Vec::new();
        for src in src_abs {
            let rel = materials::import_md(&self.ws, std::path::Path::new(src), &dir)?;
            let (fm, _, _) = materials::read_material_file(&self.ws, &rel)?;
            let m = FileMeta {
                id: fm.id.to_string(),
                kind: "material".into(),
                path: rel.clone(),
                title: fm.title.clone(),
                folder: materials::folder_of(&rel),
                status: "draft".into(),
                tags: "[]".into(),
                created_at: fm.created.clone(),
                updated_at: fm.updated.clone(),
                deleted_at: None,
                hash: String::new(),
                missing: false,
            };
            self.with_idx_mut(|idx| Ok(idx.upsert_file(&m, "")?))?;
            out.push(material_summary_of(&m, &fm));
        }
        Ok(out)
    }

    pub fn import_files_containerized(&self, src_abs: &[String]) -> AppResult<Vec<MaterialSummary>> {
        let mut out = Vec::new();
        for src in src_abs {
            let rel = materials::import_file_containerized(&self.ws, std::path::Path::new(src))?;
            let (fm, _, _) = materials::read_material_file(&self.ws, &rel)?;
            let m = FileMeta {
                id: fm.id.to_string(),
                kind: "material".into(),
                path: rel.clone(),
                title: fm.title.clone(),
                folder: materials::folder_of(&rel),
                status: "draft".into(),
                tags: "[]".into(),
                created_at: fm.created.clone(),
                updated_at: fm.updated.clone(),
                deleted_at: None,
                hash: String::new(),
                missing: false,
            };
            self.with_idx_mut(|idx| Ok(idx.upsert_file(&m, "")?))?;
            out.push(material_summary_of(&m, &fm));
        }
        Ok(out)
    }

    pub fn move_material_to_trash(&self, id: &str) -> AppResult<()> {
        let mut meta = self.meta_by_id(id)?;
        let name = std::path::Path::new(&meta.path)
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| format!("{id}.md"));
        let stem = name.trim_end_matches(".md");
        let mut candidate = stem.to_string();
        let mut i = 2;
        while self.ws.root.join(format!("kb/.trash/{candidate}.md")).exists() {
            candidate = format!("{stem}-{i}");
            i += 1;
        }
        let new_rel = format!("kb/.trash/{candidate}.md");
        materials::move_material_file(&self.ws, &meta.path, &new_rel)?;
        // 引用同步：块/正文里的链接改指回收站路径（健康检查归类为「目标在回收站」）
        self.sync_refs_for_move(&meta.path.clone(), &new_rel)?;
        meta.path = new_rel.clone();
        meta.deleted_at = Some(chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string());
        meta.folder = None;
        let (fm, body, _) = self.read_any(&new_rel)?;
        let m = FileMeta {
            id: meta.id.clone(),
            kind: "material".into(),
            path: new_rel,
            title: fm.title.clone(),
            folder: None,
            status: "draft".into(),
            tags: "[]".into(),
            created_at: fm.created.clone(),
            updated_at: fm.updated.clone(),
            deleted_at: meta.deleted_at.clone(),
            hash: String::new(),
            missing: false,
        };
        self.with_idx_mut(|idx| Ok(idx.upsert_file(&m, &body)?))?;
        Ok(())
    }

    pub fn list_material_trash(&self) -> AppResult<Vec<TrashItem>> {
        Ok(self.with_idx(|idx| {
            let now = chrono::Local::now();
            Ok(idx
                .list_by_kind("material", true)?
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
        })?)
    }

    pub fn restore_material(&self, id: &str) -> AppResult<MaterialSummary> {
        let mut meta = self.meta_by_id_any(id)?;
        if meta.deleted_at.is_none() {
            return Err(AppError::NotFound("资料不在回收站".into()));
        }
        let name = std::path::Path::new(&meta.path)
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| format!("{id}.md"));
        let stem = name.trim_end_matches(".md").to_string();
        let stem = materials::unique_stem(&self.ws, "kb/Inbox", &stem);
        let new_rel = format!("kb/Inbox/{stem}.md");
        materials::move_material_file(&self.ws, &meta.path, &new_rel)?;
        self.sync_refs_for_move(&meta.path.clone(), &new_rel)?;
        meta.path = new_rel.clone();
        meta.deleted_at = None;
        let (fm, body, _) = self.read_any(&new_rel)?;
        let m = FileMeta {
            id: meta.id.clone(),
            kind: "material".into(),
            path: new_rel,
            title: fm.title.clone(),
            folder: materials::folder_of(&meta.path),
            status: "draft".into(),
            tags: "[]".into(),
            created_at: fm.created.clone(),
            updated_at: fm.updated.clone(),
            deleted_at: None,
            hash: String::new(),
            missing: false,
        };
        self.with_idx_mut(|idx| Ok(idx.upsert_file(&m, &body)?))?;
        Ok(material_summary_of(&m, &fm))
    }

    /// 健康检查（§7.4）。
    pub fn health_check(&self) -> AppResult<crate::health::HealthReport> {
        Ok(crate::health::check(&self.ws, self)?)
    }

    pub fn clean_orphan_assets(&self, fingerprints: &[String]) -> AppResult<usize> {
        Ok(crate::health::clean_orphan_assets(&self.ws, fingerprints)?)
    }
}

fn material_summary_of(m: &FileMeta, fm: &Frontmatter) -> MaterialSummary {
    MaterialSummary {
        id: m.id.clone(),
        title: m.title.clone(),
        path: m.path.clone(),
        folder: m.folder.clone().or_else(|| materials::folder_of(&m.path)),
        updated_at: fm.updated.clone(),
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

    // ───── 知识库与关联（M3） ─────

    #[test]
    fn assoc_two_sides_add_remove_and_block_boundary() {
        let (_d, st) = state();
        let p = st.create_post("深度工作", None).unwrap();
        st.save_post(&p.id, "母版正文，参考 [[深度工作]] 自引").unwrap();
        let m = st.create_material("设计笔记", "研究").unwrap();

        // 建立关联：双侧出现对方
        st.update_assoc(&p.id, &m.id, true).unwrap();
        let pc = st.read_post(&p.id).unwrap();
        assert!(pc.body.starts_with("母版正文"), "body 不含块: {}", pc.body);
        let block = pc.assoc.as_ref().unwrap();
        assert_eq!(block.materials.len(), 1);
        assert_eq!(block.materials[0].title, "设计笔记");
        let m_file = m.path.rsplit('/').next().unwrap();
        assert!(
            block.materials[0].target.starts_with("../kb/") && block.materials[0].target.ends_with(m_file),
            "相对路径正确: {}",
            block.materials[0].target
        );
        let mc = st.read_material(&m.id).unwrap();
        let mblock = mc.assoc.as_ref().unwrap();
        assert_eq!(mblock.posts.len(), 1);
        assert_eq!(mblock.posts[0].title, "深度工作");

        // 编辑器保存（body 不含块）不丢另一侧后续写入的块（机制决策 1）
        st.save_post(&p.id, "母版正文改").unwrap();
        st.update_assoc(&p.id, &m.id, true).unwrap(); // 幂等
        let pc2 = st.read_post(&p.id).unwrap();
        assert_eq!(pc2.body, "母版正文改");
        assert_eq!(pc2.assoc.as_ref().unwrap().materials.len(), 1);

        // 解除：双侧移除 → 没有关联就没有块
        st.update_assoc(&p.id, &m.id, false).unwrap();
        let pc3 = st.read_post(&p.id).unwrap();
        assert!(pc3.assoc.is_none());
        assert!(st.read_material(&m.id).unwrap().assoc.is_none());
    }

    #[test]
    fn publish_excludes_block_and_versions_section() {
        let (_d, st) = state();
        let p = st.create_post("深度工作", None).unwrap();
        let m = st.create_material("笔记", "").unwrap();
        st.update_assoc(&p.id, &m.id, true).unwrap();
        st.create_publish_version(&p.id, "wechat", None, Some("正文".into())).unwrap();
        // 版本不含块（决策 9）
        let v = st.read_publish_version(&p.id, "wechat").unwrap();
        assert!(!v.body.contains("wb:assoc"), "{}", v.body);
        // 母版块出现「发布版本」区（M2 顺延项）
        let pc = st.read_post(&p.id).unwrap();
        let versions = pc.assoc.as_ref().unwrap().versions.clone();
        assert_eq!(versions.len(), 1);
        assert!(versions[0].title.contains("wechat"));
    }

    #[test]
    fn conversion_keeps_assoc_with_recomputed_paths() {
        let (_d, st) = state();
        let p = st.create_post("深度工作", None).unwrap();
        st.save_post(&p.id, "正文 [资料](../kb/研究/x.md)").unwrap();
        let m = st.create_material("设计笔记", "研究").unwrap();
        st.update_assoc(&p.id, &m.id, true).unwrap();

        // 文稿 → 资料：关联保留、双侧路径按新位置重算
        let summary = st.convert_post_to_material(&p.id).unwrap();
        assert!(summary.path.starts_with("kb/Inbox/"), "{}", summary.path);
        let mc = st.read_material(&m.id).unwrap();
        let assoc = mc.assoc.as_ref().unwrap();
        let entry = &assoc.posts[0];
        assert!(entry.target.ends_with("Inbox/from-post.md"), "{}", entry.target);

        // 资料 → 文稿：回到 posts/，路径再次重算
        let back = st.convert_material_to_post(&p.id).unwrap();
        assert!(back.path.starts_with("posts/"), "{}", back.path);
        let mc2 = st.read_material(&m.id).unwrap();
        assert!(mc2.assoc.as_ref().unwrap().posts[0].target.starts_with("../../posts/"), "{:?}", mc2.assoc);
    }

    #[test]
    fn rename_updates_referencing_body_links() {
        let (_d, st) = state();
        let a = st.create_post("甲", None).unwrap();
        st.save_post(&a.id, "引用 [资料](../kb/研究/x.md)").unwrap();
        let m = st.create_material("笔记", "研究").unwrap();
        // 手工让甲的正文指向 m 的实际路径
        let mc = st.read_material(&m.id).unwrap();
        let target = crate::links::rel_between(&a.path, &mc.path).unwrap();
        st.save_post(&a.id, &format!("引用 [资料]({target})")).unwrap();
        // 重命名资料文件 → 甲正文里的链接更新
        st.rename_material_file(&m.id, "改名后").unwrap();
        let ac = st.read_post(&a.id).unwrap();
        let new_target = crate::links::rel_between(&a.path, &st.read_material(&m.id).unwrap().path).unwrap();
        assert!(ac.body.contains(&new_target), "{} 应含 {}", ac.body, new_target);
    }

    #[test]
    fn title_sync_updates_wiki_refs_and_block_titles() {
        let (_d, st) = state();
        let a = st.create_post("甲", None).unwrap();
        let p = st.create_post("深度工作", None).unwrap();
        st.save_post(&a.id, "参考 [[深度工作]]").unwrap();
        let m = st.create_material("笔记", "").unwrap();
        st.update_assoc(&p.id, &m.id, true).unwrap();
        // 改母版标题 → wiki 引用与块内显示标题同步（双侧）
        st.set_post_title(&p.id, "深度工作实践记").unwrap();
        let ac = st.read_post(&a.id).unwrap();
        assert!(ac.body.contains("[[深度工作实践记]]"), "{}", ac.body);
        let mc = st.read_material(&m.id).unwrap();
        assert_eq!(mc.assoc.as_ref().unwrap().posts[0].title, "深度工作实践记");
    }

    #[test]
    fn backlinks_and_resolve_wiki() {
        let (_d, st) = state();
        let a = st.create_post("甲", None).unwrap();
        let _p = st.create_post("深度工作", None).unwrap();
        let _p2 = st.create_post("深度工作", None).unwrap(); // 重名
        st.save_post(&a.id, "参考 [[深度工作]]").unwrap();
        let m = st.create_material("笔记", "").unwrap();
        st.update_assoc(&a.id, &m.id, true).unwrap();

        // 反链：资料被关联块引用
        let bl = st.backlinks(&m.id).unwrap();
        assert!(bl.iter().any(|b| b.kind == "assoc" && b.from_id == a.id));
        // resolve_wiki：重名 → 候选
        let r = st.resolve_wiki("深度工作").unwrap();
        assert!(r.matched.is_none());
        assert_eq!(r.candidates.len(), 2);
        // 唯一标题 → 命中
        let r2 = st.resolve_wiki("甲").unwrap();
        assert_eq!(r2.matched.as_ref().unwrap().id, a.id);
    }

    #[test]
    fn material_trash_and_health_basics() {
        let (_d, st) = state();
        let a = st.create_post("甲", None).unwrap();
        let m = st.create_material("笔记", "").unwrap();
        st.update_assoc(&a.id, &m.id, true).unwrap();
        // 健康检查：关联目标在 → 无断链
        let h = st.health_check().unwrap();
        assert!(h.broken_links.is_empty(), "{:?}", h.broken_links);
        // 资料进回收站 → 链接目标归入 trash_targets（不算断链）
        st.move_material_to_trash(&m.id).unwrap();
        let h2 = st.health_check().unwrap();
        assert!(h2.broken_links.is_empty());
        assert!(!h2.trash_targets.is_empty(), "回收站目标单独提示");
        // 孤儿附件：未引用的 _assets 文件列出；被历史快照引用的不算
        crate::assets::save_asset(&st.ws, b"unreferenced", "png").unwrap();
        let h3 = st.health_check().unwrap();
        assert_eq!(h3.orphan_assets.len(), 1);
        assert_eq!(st.clean_orphan_assets(&h3.orphan_assets).unwrap(), 1);
        assert_eq!(st.health_check().unwrap().orphan_assets.len(), 0);
        // 资料回收站列表与恢复
        let trash = st.list_material_trash().unwrap();
        assert_eq!(trash.len(), 1);
        st.restore_material(&m.id).unwrap();
        assert!(st.list_material_trash().unwrap().is_empty());
    }

    // ───── 发布版本 ─────

    #[test]
    fn create_read_save_sync_roundtrip() {
        let (_d, st) = state();
        let p = st.create_post("深度工作", None).unwrap();
        st.save_post(&p.id, "母版 v1\n\n![](../_assets/a.png)\n").unwrap();

        let v = st.create_publish_version(&p.id, "wechat", None, None).unwrap();
        assert_eq!(v.base, p.id);
        assert_eq!(v.target, "wechat");
        assert!(v.body.contains("../../../_assets/a.png"), "{}", v.body);

        let saved = st.save_publish_version(&p.id, "wechat", "公众号适配版").unwrap();
        assert!(saved.snapshotted);
        let v2 = st.read_publish_version(&p.id, "wechat").unwrap();
        assert_eq!(v2.body, "公众号适配版");
        assert_eq!(v2.id, v.id, "版本 id 不变");

        let synced = st.sync_publish_from_post(&p.id, "wechat").unwrap();
        assert!(synced.body.contains("母版 v1"), "{}", synced.body);
        assert!(synced.body.contains("../../../_assets/a.png"));
        // 版本历史有内容（保存快照 + 同步前抢救；同秒同内容会去重，隔 1 秒成两份）
        std::thread::sleep(std::time::Duration::from_millis(1100));
        let synced2 = st.sync_publish_from_post(&p.id, "wechat").unwrap();
        let _ = synced2;
        assert!(st.list_version_snapshots(&p.id, "wechat").unwrap().len() >= 2);
    }

    #[test]
    fn create_from_snapshot_records_forked_from() {
        let (_d, st) = state();
        let p = st.create_post("A", None).unwrap();
        st.save_post(&p.id, "v1").unwrap();
        st.save_post(&p.id, "v2").unwrap();
        let snaps = st.list_snapshots(&p.id).unwrap();
        // 快照指纹是完整文件内容的 hash；最旧那份即 v1（先保存）
        let snap_file = snaps.last().unwrap().file_name.clone();
        let v = st.create_publish_version(&p.id, "blog", Some(snap_file.clone()), None).unwrap();
        // forked_from 已写入版本文件 frontmatter
        let content = std::fs::read_to_string(
            st.ws.root.join(format!(".versions/{}/publish/blog.md", p.id)),
        )
        .unwrap();
        assert!(content.contains(&format!("forked_from: {snap_file}")), "{content}");
        assert_eq!(v.base, p.id);
    }

    #[test]
    fn create_with_current_body_uses_editor_content() {
        let (_d, st) = state();
        let p = st.create_post("深度工作", None).unwrap();
        st.save_post(&p.id, "磁盘上的旧内容").unwrap();
        // 编辑器当前正文与磁盘不一致时以编辑器为准（保存可见性竞态的根治）；
        // 链接重写照常工作
        let v = st
            .create_publish_version(
                &p.id,
                "wechat",
                None,
                Some("编辑器最新内容\n\n![](../_assets/a.png)\n".into()),
            )
            .unwrap();
        assert!(v.body.contains("编辑器最新内容"), "{}", v.body);
        assert!(v.body.contains("../../../_assets/a.png"), "{}", v.body);
        assert!(!v.body.contains("磁盘上的旧内容"));
    }

    #[test]
    fn orphan_version_reported_and_trashed_base_not_orphan() {
        let (_d, st) = state();
        let p = st.create_post("A", None).unwrap();
        st.create_publish_version(&p.id, "wechat", None, None).unwrap();
        // 正常状态：无孤儿
        assert!(st.scan_refresh().unwrap().orphan_versions.is_empty());
        // base 进回收站：不算孤儿（DESIGN-REVIEW 遗漏 4）
        st.move_post_to_trash(&p.id).unwrap();
        assert!(st.scan_refresh().unwrap().orphan_versions.is_empty());
        // 索引里彻底没有 base（模拟母版被清除）：报告孤儿
        {
            let idx = st.idx.lock().unwrap();
            idx.purge_file(&p.id).unwrap();
        }
        let report = st.scan_refresh().unwrap();
        assert_eq!(report.orphan_versions.len(), 1);
        assert!(report.orphan_versions[0].contains("wechat"));
    }

    #[test]
    fn save_pasted_image_at_relative() {
        let (_d, st) = state();
        let p = st.create_post("A", None).unwrap();
        st.create_publish_version(&p.id, "wechat", None, None).unwrap();
        let version_rel = format!(".versions/{}/publish/wechat.md", p.id);
        let rel = st
            .save_pasted_image_at(&version_rel, b"img-bytes", "png")
            .unwrap();
        assert!(rel.starts_with("../../../_assets/"), "{rel}");
        assert!(rel.ends_with(".png"), "{rel}");
    }
}
