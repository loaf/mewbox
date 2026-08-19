//! 发布版本（DESIGN §5）：文稿在某渠道的适配变体，
//! 物理存于 `.versions/{base}/publish/{target}.md`，与母版独立演化。

use std::path::{Path, PathBuf};

use serde_yaml::Mapping;

use crate::workspace::Workspace;

#[derive(Debug, thiserror::Error)]
pub enum PublishError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("该文稿已有「{0}」版本的发布版本；重发请新建目标名（如 {0}-0902）")]
    TargetExists(String),
    #[error("{0}")]
    NotFound(String),
}

/// 发布版本 frontmatter（DESIGN §3.2）：id 为版本自身 UUID；base 指向文稿 id；
/// forked_from 记录分叉来源的历史快照文件名（可空 = 创建时点）。
#[derive(Debug, Clone, PartialEq)]
pub struct PublishFrontmatter {
    pub id: uuid::Uuid,
    pub target: String,
    pub base: String,
    pub forked_from: Option<String>,
    pub published_url: Option<String>,
    pub published_at: Option<String>,
    pub title: String,
    pub created: String,
    pub updated: String,
    pub extra: Mapping,
}

impl Default for PublishFrontmatter {
    fn default() -> Self {
        Self {
            id: uuid::Uuid::nil(),
            target: String::new(),
            base: String::new(),
            forked_from: None,
            published_url: None,
            published_at: None,
            title: String::new(),
            created: String::new(),
            updated: String::new(),
            extra: Mapping::new(),
        }
    }
}

impl PublishFrontmatter {
    pub fn new(base: &str, target: &str, title: &str) -> Self {
        let now = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string();
        Self {
            id: uuid::Uuid::new_v4(),
            target: target.to_string(),
            base: base.to_string(),
            created: now.clone(),
            updated: now,
            title: title.to_string(),
            ..Default::default()
        }
    }

    pub fn bump_updated(&mut self) {
        self.updated = chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string();
    }

    /// 序列化：固定字段顺序 + extra 透传（同 frontmatter.rs 模式）。
    pub fn to_content(&self, body: &str) -> String {
        let mut out = String::from("---\n");
        out.push_str(&format!("id: {}\n", self.id));
        out.push_str(&format!("target: {}\n", yaml_scalar(&self.target)));
        out.push_str(&format!("base: {}\n", self.base));
        if let Some(f) = &self.forked_from {
            out.push_str(&format!("forked_from: {}\n", yaml_scalar(f)));
        }
        if let Some(u) = &self.published_url {
            out.push_str(&format!("published_url: {}\n", yaml_scalar(u)));
        }
        if let Some(d) = &self.published_at {
            out.push_str(&format!("published_at: {}\n", yaml_scalar(d)));
        }
        out.push_str(&format!("title: {}\n", yaml_scalar(&self.title)));
        if !self.created.is_empty() {
            out.push_str(&format!("created: {}\n", yaml_scalar(&self.created)));
        }
        if !self.updated.is_empty() {
            out.push_str(&format!("updated: {}\n", yaml_scalar(&self.updated)));
        }
        for (k, v) in &self.extra {
            if matches!(k, serde_yaml::Value::String(_)) {
                let mut single = Mapping::new();
                single.insert(k.clone(), v.clone());
                if let Ok(line) = serde_yaml::to_string(&serde_yaml::Value::Mapping(single)) {
                    out.push_str(line.trim_end());
                    out.push('\n');
                }
            }
        }
        out.push_str("---\n");
        out.push_str(body);
        out
    }
}

fn yaml_scalar(s: &str) -> String {
    if s.is_empty()
        || s.contains(':')
        || s.contains('#')
        || s.contains('\n')
        || s.trim() != s
        || s.starts_with('[')
        || s.starts_with('{')
    {
        serde_yaml::to_string(s).unwrap_or_default().trim().to_string()
    } else {
        s.to_string()
    }
}

/// 解析发布版本文件：复用文稿 frontmatter 的切分逻辑（--- 分隔、CRLF 容忍、body 原样）。
pub fn parse(content: &str) -> Result<(PublishFrontmatter, String), serde_yaml::Error> {
    let Some(yaml) = split_yaml(content) else {
        return Ok((PublishFrontmatter::default(), content.to_string()));
    };
    let value: serde_yaml::Value = serde_yaml::from_str(&yaml)?;
    let body = split_body(content);
    let serde_yaml::Value::Mapping(mapping) = value else {
        return Ok((PublishFrontmatter::default(), body));
    };
    let mut fm = PublishFrontmatter::default();
    let mut extra = Mapping::new();
    for (k, v) in mapping {
        let key = match &k {
            serde_yaml::Value::String(s) => s.clone(),
            _ => continue,
        };
        match key.as_str() {
            "id" => match v.as_str().and_then(|s| uuid::Uuid::parse_str(s).ok()) {
                Some(id) => fm.id = id,
                None => {
                    extra.insert(k, v);
                }
            },
            "target" => match v.as_str() {
                Some(t) => fm.target = t.to_string(),
                None => {
                    extra.insert(k, v);
                }
            },
            "base" => match v.as_str() {
                Some(t) => fm.base = t.to_string(),
                None => {
                    extra.insert(k, v);
                }
            },
            "forked_from" => match &v {
                serde_yaml::Value::Null => {}
                serde_yaml::Value::String(s) => fm.forked_from = Some(s.clone()),
                _ => {
                    extra.insert(k, v);
                }
            },
            "published_url" => match &v {
                serde_yaml::Value::Null => {}
                serde_yaml::Value::String(s) => fm.published_url = Some(s.clone()),
                _ => {
                    extra.insert(k, v);
                }
            },
            "published_at" => match &v {
                serde_yaml::Value::Null => {}
                serde_yaml::Value::String(s) => fm.published_at = Some(s.clone()),
                _ => {
                    extra.insert(k, v);
                }
            },
            "title" => match v.as_str() {
                Some(t) => fm.title = t.to_string(),
                None => {
                    extra.insert(k, v);
                }
            },
            "created" => match v.as_str() {
                Some(t) => fm.created = t.to_string(),
                None => {
                    extra.insert(k, v);
                }
            },
            "updated" => match v.as_str() {
                Some(t) => fm.updated = t.to_string(),
                None => {
                    extra.insert(k, v);
                }
            },
            _ => {
                extra.insert(k, v);
            }
        }
    }
    fm.extra = extra;
    Ok((fm, body))
}

fn split_yaml(content: &str) -> Option<String> {
    let mut lines = content.split_inclusive('\n');
    let first = match lines.next() {
        Some(l) if l.trim_end_matches(['\r', '\n']) == "---" => l,
        _ => return None,
    };
    let yaml_start = first.len();
    let mut offset = yaml_start;
    for line in lines {
        let len = line.len();
        if line.trim_end_matches(['\r', '\n']) == "---" {
            return Some(content[yaml_start..offset].to_string());
        }
        offset += len;
    }
    None
}

fn split_body(content: &str) -> String {
    let mut lines = content.split_inclusive('\n');
    let first = match lines.next() {
        Some(l) if l.trim_end_matches(['\r', '\n']) == "---" => l,
        _ => return content.to_string(),
    };
    let yaml_start = first.len();
    let mut offset = yaml_start;
    for line in lines {
        let len = line.len();
        if line.trim_end_matches(['\r', '\n']) == "---" {
            return content[offset + len..].to_string();
        }
        offset += len;
    }
    content.to_string()
}

/// 版本文件路径：`.versions/{base}/publish/{target}.md`（base = 文稿 id）。
pub fn version_path(ws: &Workspace, base_id: &str, target: &str) -> PathBuf {
    ws.root
        .join(".versions")
        .join(base_id)
        .join("publish")
        .join(format!("{target}.md"))
}

/// 版本自身历史目录：`.versions/{base}/publish/{target}.history/`。
pub fn version_history_dir(ws: &Workspace, base_id: &str, target: &str) -> PathBuf {
    ws.root
        .join(".versions")
        .join(base_id)
        .join("publish")
        .join(format!("{target}.history"))
}

pub fn relative(ws: &Workspace, p: &Path) -> String {
    p.strip_prefix(&ws.root)
        .unwrap_or(p)
        .to_string_lossy()
        .replace('\\', "/")
}

// ═══════════════ 相对链接重写（DESIGN §5.1 创建/同步时） ═══════════════

/// 词法归一化：折叠 `.` 与 `..`（开头越根的 `..` 保守保留）。
fn normalize_lexical(p: &Path) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for comp in p.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                if out.file_name().is_some() {
                    out.pop();
                } else {
                    out.push("..");
                }
            }
            c => out.push(c.as_os_str()),
        }
    }
    out
}

/// 单个目的地重算：`(dest, from_dir, to_dir) → 新 dest`；不可重算（外链/锚点）返回 None。
fn recalc_dest(dest: &str, from_dir: &str, to_dir: &str) -> Option<String> {
    let lower = dest.to_lowercase();
    if lower.starts_with("http://")
        || lower.starts_with("https://")
        || dest.starts_with('#')
        || lower.starts_with("mailto:")
        || lower.starts_with("data:")
    {
        return None;
    }
    // 剥 fragment/query，重算后拼回
    let (path_part, tail) = match dest.find(['#', '?']) {
        Some(i) => (&dest[..i], &dest[i..]),
        None => (dest, ""),
    };
    if path_part.is_empty() {
        return None;
    }
    let from = normalize_lexical(&Path::new(from_dir).join(path_part));
    let to = Path::new(to_dir);
    let diff = pathdiff::diff_paths(&from, to)?;
    Some(format!("{}{}", diff.to_string_lossy().replace('\\', "/"), tail))
}

/// 逐行重写 markdown 链接/图片目的地：跳过代码围栏内；`[text](dest)` 中
/// dest 按 from_dir → to_dir 重算（`/` 分隔）。`<img src>` 与根相对 `/x` 不处理（M2 限制）。
pub fn rewrite_relative_links(body: &str, from_dir: &str, to_dir: &str) -> String {
    let mut out_lines: Vec<String> = Vec::new();
    let mut in_fence = false;
    let mut fence_mark = "";
    for line in body.split('\n') {
        let trimmed = line.trim_start();
        if let Some(fence) = trimmed.starts_with("```").then_some("```").or_else(|| {
            if trimmed.starts_with("~~~") {
                Some("~~~")
            } else {
                None
            }
        }) {
            if !in_fence {
                in_fence = true;
                fence_mark = fence;
            } else if fence == fence_mark {
                in_fence = false;
            }
            out_lines.push(line.to_string());
            continue;
        }
        if in_fence {
            out_lines.push(line.to_string());
            continue;
        }
        out_lines.push(rewrite_line(line, from_dir, to_dir));
    }
    out_lines.join("\n")
}

fn rewrite_line(line: &str, from_dir: &str, to_dir: &str) -> String {
    // 扫描 `](` … `)` 的目的地段
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(close) = rest.find("](") {
        let (head, after) = rest.split_at(close + 2); // 含 "]("
        out.push_str(head);
        let Some(end) = after.find(')') else {
            out.push_str(after);
            return out;
        };
        let (dest, tail) = after.split_at(end);
        match recalc_dest(dest, from_dir, to_dir) {
            Some(new_dest) => {
                out.push_str(&new_dest);
            }
            None => out.push_str(dest),
        }
        out.push_str(&tail[..1]); // ')'
        rest = &tail[1..];
    }
    out.push_str(rest);
    out
}

// ═══════════════ IO（DESIGN §5.1） ═══════════════

use crate::history::{self, HistoryError};
use crate::index::{FileMeta, Index};

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionSummary {
    pub id: String,
    pub base: String,
    pub target: String,
    pub title: String,
    pub published_url: Option<String>,
    pub published_at: Option<String>,
    pub updated_at: String,
    pub path: String,
}

pub fn publish_dir_rel(base_id: &str) -> String {
    format!(".versions/{base_id}/publish")
}

fn upsert_row(idx: &Index, fm: &PublishFrontmatter, path: &str, full: &str, body: &str) -> Result<(), crate::index::Error> {
    idx.upsert_file(
        &FileMeta {
            id: fm.id.to_string(),
            kind: "publish".into(),
            path: path.into(),
            title: fm.title.clone(),
            folder: None,
            // 状态由 published_url 是否回填派生（M2 决策）
            status: if fm.published_url.is_some() { "published" } else { "draft" }.into(),
            tags: "[]".into(),
            created_at: fm.created.clone(),
            updated_at: fm.updated.clone(),
            deleted_at: None,
            hash: crate::scan::file_hash(full),
            missing: false,
        },
        body,
    )
}

fn read_version_file(ws: &Workspace, base_id: &str, target: &str) -> Result<(PublishFrontmatter, String, String), PublishError> {
    let path = version_path(ws, base_id, target);
    if !path.exists() {
        return Err(PublishError::NotFound(format!("没有「{target}」发布版本")));
    }
    let content = std::fs::read_to_string(&path)?;
    let (fm, body) = parse(&content).map_err(|e| PublishError::NotFound(e.to_string()))?;
    Ok((fm, body, content))
}

/// 创建发布版本：一目标一版本（重发用新目标名，DESIGN 决策 8）；
/// 正文相对引用按版本实际位置重写。
pub fn create_version(
    ws: &Workspace,
    idx: &Index,
    base_id: &str,
    post_title: &str,
    target: &str,
    from_body: &str,
    from_dir: &str,
    forked_from: Option<String>,
) -> Result<VersionSummary, PublishError> {
    let path = version_path(ws, base_id, target);
    if path.exists() {
        return Err(PublishError::TargetExists(target.to_string()));
    }
    let mut fm = PublishFrontmatter::new(base_id, target, post_title);
    fm.forked_from = forked_from;
    // 机制决策 2：发布版本不携带母版的尾部关联块（决策 9）
    let (clean_from, _) = crate::assoc::strip_assoc(from_body);
    let body = rewrite_relative_links(&clean_from, from_dir, &publish_dir_rel(base_id));
    let full = fm.to_content(&body);
    std::fs::create_dir_all(path.parent().unwrap())?;
    std::fs::write(&path, &full)?;
    let rel_path = relative(ws, &path);
    upsert_row(idx, &fm, &rel_path, &full, &body).map_err(PublishError::from)?;
    Ok(summary_of(&fm, &rel_path))
}

fn summary_of(fm: &PublishFrontmatter, path: &str) -> VersionSummary {
    VersionSummary {
        id: fm.id.to_string(),
        base: fm.base.clone(),
        target: fm.target.clone(),
        title: fm.title.clone(),
        published_url: fm.published_url.clone(),
        published_at: fm.published_at.clone(),
        updated_at: fm.updated.clone(),
        path: path.to_string(),
    }
}

/// 全工作区版本清单（磁盘为准）。
pub fn list_versions(ws: &Workspace) -> Vec<VersionSummary> {
    let mut out = Vec::new();
    let versions = ws.root.join(".versions");
    let Ok(bases) = std::fs::read_dir(&versions) else {
        return out;
    };
    for base in bases.flatten() {
        let publish = base.path().join("publish");
        let Ok(files) = std::fs::read_dir(&publish) else {
            continue;
        };
        for f in files.flatten() {
            let name = f.file_name().to_string_lossy().into_owned();
            if !name.ends_with(".md") || name.len() <= 3 {
                continue;
            }
            if let Ok(content) = std::fs::read_to_string(f.path()) {
                if let Ok((fm, _)) = parse(&content) {
                    out.push(summary_of(&fm, &relative(ws, &f.path())));
                }
            }
        }
    }
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    out
}

pub fn read_version_body(ws: &Workspace, base_id: &str, target: &str) -> Result<(PublishFrontmatter, String), PublishError> {
    let (fm, body, _) = read_version_file(ws, base_id, target)?;
    Ok((fm, body))
}

/// 保存版本：正文实质变化才快照进版本自身 {target}.history/。
pub fn save_version(
    ws: &Workspace,
    idx: &Index,
    base_id: &str,
    target: &str,
    body: &str,
) -> Result<VersionSummary, PublishError> {
    let (mut fm, prev_body, _) = read_version_file(ws, base_id, target)?;
    let path = version_path(ws, base_id, target);
    let rel_path = relative(ws, &path);
    fm.bump_updated();
    let full = fm.to_content(body);
    if history::is_material_change(&prev_body, body) {
        history::write_snapshot_in(
            ws,
            &version_history_dir(ws, base_id, target),
            idx,
            &fm.id.to_string(),
            &full,
        )
        .map_err(PublishError::from)?;
    }
    std::fs::write(&path, &full)?;
    upsert_row(idx, &fm, &rel_path, &full, body).map_err(PublishError::from)?;
    Ok(summary_of(&fm, &rel_path))
}

/// 版本历史列表/恢复/里程碑。
pub fn list_version_snapshots(
    ws: &Workspace,
    idx: &Index,
    base_id: &str,
    target: &str,
) -> Result<Vec<history::SnapshotEntry>, PublishError> {
    let (fm, _) = read_version_body(ws, base_id, target)?;
    Ok(history::list_snapshots_in(
        ws,
        &version_history_dir(ws, base_id, target),
        idx,
        &fm.id.to_string(),
    )?)
}

pub fn restore_version_snapshot(
    ws: &Workspace,
    idx: &Index,
    base_id: &str,
    target: &str,
    snapshot_file: &str,
) -> Result<(), PublishError> {
    let (fm, _) = read_version_body(ws, base_id, target)?;
    history::restore_in(
        ws,
        idx,
        &fm.id.to_string(),
        &version_history_dir(ws, base_id, target),
        snapshot_file,
        &version_path(ws, base_id, target),
    )
    .map_err(PublishError::from)
}

pub fn set_version_milestone(
    ws: &Workspace,
    idx: &Index,
    base_id: &str,
    target: &str,
    snapshot_file: &str,
    name: &str,
) -> Result<(), PublishError> {
    let (fm, _) = read_version_body(ws, base_id, target)?;
    history::set_milestone_in(
        ws,
        idx,
        &fm.id.to_string(),
        &version_history_dir(ws, base_id, target),
        snapshot_file,
        name,
    )
    .map_err(PublishError::from)
}

pub fn read_version_snapshot_body(
    ws: &Workspace,
    base_id: &str,
    target: &str,
    snapshot_file: &str,
) -> Result<String, PublishError> {
    Ok(history::read_snapshot_body_in(
        ws,
        &version_history_dir(ws, base_id, target),
        snapshot_file,
    )?)
}

/// 索引重建单条版本行（scan_publishes 用）。
pub fn reindex_version(ws: &Workspace, idx: &Index, base_id: &str, target: &str) -> Result<(), PublishError> {
    let (fm, body, content) = read_version_file(ws, base_id, target)?;
    let rel_path = relative(ws, &version_path(ws, base_id, target));
    upsert_row(idx, &fm, &rel_path, &content, &body).map_err(PublishError::from)
}

/// 从文稿重新同步：先无条件快照当前版本（DESIGN-REVIEW 二轮 10），
/// 再以母版正文（重写链接）覆盖；版本 id/target/base 与发布记录保留。
pub fn sync_from_post(
    ws: &Workspace,
    idx: &Index,
    base_id: &str,
    target: &str,
    post_body: &str,
    post_dir: &str,
) -> Result<VersionSummary, PublishError> {
    let (mut fm, _, prev_full) = read_version_file(ws, base_id, target)?;
    let path = version_path(ws, base_id, target);
    let rel_path = relative(ws, &path);
    history::write_snapshot_in(
        ws,
        &version_history_dir(ws, base_id, target),
        idx,
        &fm.id.to_string(),
        &prev_full,
    )
    .map_err(PublishError::from)?;
    let (clean_post, _) = crate::assoc::strip_assoc(post_body);
    let body = rewrite_relative_links(&clean_post, post_dir, &publish_dir_rel(base_id));
    fm.bump_updated();
    let full = fm.to_content(&body);
    std::fs::write(&path, &full)?;
    upsert_row(idx, &fm, &rel_path, &full, &body).map_err(PublishError::from)?;
    Ok(summary_of(&fm, &rel_path))
}

/// 发布记录回填：只动 url/日期；status 由 url 派生。
pub fn set_published(
    ws: &Workspace,
    idx: &Index,
    base_id: &str,
    target: &str,
    url: Option<String>,
    date: Option<String>,
) -> Result<VersionSummary, PublishError> {
    let (mut fm, body, _) = read_version_file(ws, base_id, target)?;
    fm.published_url = url;
    fm.published_at = date;
    fm.bump_updated();
    let path = version_path(ws, base_id, target);
    let rel_path = relative(ws, &path);
    let full = fm.to_content(&body);
    std::fs::write(&path, &full)?;
    upsert_row(idx, &fm, &rel_path, &full, &body).map_err(PublishError::from)?;
    Ok(summary_of(&fm, &rel_path))
}

impl From<HistoryError> for PublishError {
    fn from(e: HistoryError) -> Self {
        PublishError::NotFound(e.to_string())
    }
}

impl From<crate::index::Error> for PublishError {
    fn from(e: crate::index::Error) -> Self {
        PublishError::NotFound(e.to_string())
    }
}

#[cfg(test)]
mod rewrite_tests {
    use super::*;

    const PUBLISH_DIR: &str = ".versions/3f2c0000-0000-0000-0000-000000000001/publish";

    #[test]
    fn asset_link_rewritten_from_flat_post() {
        let body = "开头\n\n![](../_assets/9f3c2a1b.png)\n";
        let out = rewrite_relative_links(body, "posts", PUBLISH_DIR);
        assert!(out.contains("![](../../../_assets/9f3c2a1b.png)"), "{out}");
    }

    #[test]
    fn asset_link_rewritten_from_nested_post() {
        let out = rewrite_relative_links("![](../../_assets/a.png)", "posts/2026", PUBLISH_DIR);
        assert!(out.contains("../../../_assets/a.png"), "{out}");
    }

    #[test]
    fn http_and_anchor_untouched() {
        let body = "[外链](https://example.com/a) 与 [页内](#sec) 与 ![图](../_assets/a.png)";
        let out = rewrite_relative_links(body, "posts", PUBLISH_DIR);
        assert!(out.contains("(https://example.com/a)"));
        assert!(out.contains("(#sec)"));
        assert!(out.contains("../../../_assets/a.png"));
    }

    #[test]
    fn kb_link_rewritten() {
        let out = rewrite_relative_links("[资料](../kb/research/x.md)", "posts", PUBLISH_DIR);
        assert!(out.contains("../../../kb/research/x.md"), "{out}");
    }

    #[test]
    fn fragment_and_query_preserved() {
        let out = rewrite_relative_links("[x](../kb/a.md#sec) [y](../kb/a.md?q=1)", "posts", PUBLISH_DIR);
        assert!(out.contains("../../../kb/a.md#sec"), "{out}");
        assert!(out.contains("../../../kb/a.md?q=1"), "{out}");
    }

    #[test]
    fn code_fence_untouched() {
        let body = "```\n[x](y.md)\n```\n`[z](w.md)` 之外的 [a](../_assets/b.png)";
        let out = rewrite_relative_links(body, "posts", PUBLISH_DIR);
        assert!(out.contains("[x](y.md)"), "围栏内不改: {out}");
        assert!(out.contains("../../../_assets/b.png"));
    }
}

#[cfg(test)]
mod io_tests {
    use super::*;
    use crate::workspace::Workspace as Ws;

    fn setup() -> (tempfile::TempDir, Ws, Index) {
        let dir = tempfile::tempdir().unwrap();
        let ws = Ws::init(dir.path()).unwrap();
        let idx = Index::open_in_memory().unwrap();
        (dir, ws, idx)
    }

    const BASE: &str = "3f2c0000-0000-0000-0000-000000000001";

    #[test]
    fn create_writes_rewritten_links() {
        let (_d, ws, idx) = setup();
        let body = "导语\n\n![](../_assets/9f3c2a1b.png)\n";
        let s = create_version(&ws, &idx, BASE, "深度工作", "wechat", body, "posts", None).unwrap();
        assert_eq!(s.base, BASE);
        assert_eq!(s.target, "wechat");
        let (fm, vbody) = read_version_body(&ws, BASE, "wechat").unwrap();
        assert_eq!(fm.base, BASE);
        assert!(!fm.id.is_nil());
        assert!(vbody.contains("../../../_assets/9f3c2a1b.png"), "{vbody}");
        // 索引登记为 publish
        let row = idx.get_file(&fm.id.to_string()).unwrap().unwrap();
        assert_eq!(row.kind, "publish");
        assert_eq!(row.status, "draft");
    }

    #[test]
    fn one_target_one_version_enforced() {
        let (_d, ws, idx) = setup();
        create_version(&ws, &idx, BASE, "T", "wechat", "b", "posts", None).unwrap();
        assert!(matches!(
            create_version(&ws, &idx, BASE, "T", "wechat", "b2", "posts", None),
            Err(PublishError::TargetExists(_))
        ));
        // 新目标名可用
        create_version(&ws, &idx, BASE, "T", "wechat-0902", "b", "posts", None).unwrap();
    }

    #[test]
    fn save_snapshots_into_own_history_and_restore_milestone() {
        let (_d, ws, idx) = setup();
        create_version(&ws, &idx, BASE, "T", "wechat", "v1", "posts", None).unwrap();
        save_version(&ws, &idx, BASE, "wechat", "v2").unwrap();
        save_version(&ws, &idx, BASE, "wechat", "v3").unwrap();
        let snaps = list_version_snapshots(&ws, &idx, BASE, "wechat").unwrap();
        assert!(snaps.len() >= 2, "实质变化各留一份: {}", snaps.len());
        // 里程碑（对任意一份；hash8 是完整文件内容的指纹，测试不预知具体值）
        let any_snap = &snaps[0];
        set_version_milestone(&ws, &idx, BASE, "wechat", &any_snap.file_name, "定稿").unwrap();
        let snaps2 = list_version_snapshots(&ws, &idx, BASE, "wechat").unwrap();
        assert!(snaps2.iter().any(|s| s.milestone.as_deref() == Some("定稿")));
        // 恢复：当前内容被抢救为新快照，主文件正文 == 目标快照正文
        // （同秒同内容会因「时间戳+hash」文件名去重，隔 1 秒确保抢救快照成新文件）
        std::thread::sleep(std::time::Duration::from_millis(1100));
        restore_version_snapshot(&ws, &idx, BASE, "wechat", &any_snap.file_name).unwrap();
        let (_, body_now) = read_version_body(&ws, BASE, "wechat").unwrap();
        let expected = read_version_snapshot_body(&ws, BASE, "wechat", &any_snap.file_name).unwrap();
        assert_eq!(body_now, expected);
        assert!(list_version_snapshots(&ws, &idx, BASE, "wechat").unwrap().len() > snaps.len());
    }

    #[test]
    fn sync_snapshots_before_overwrite() {
        let (_d, ws, idx) = setup();
        create_version(&ws, &idx, BASE, "T", "wechat", "旧版本内容", "posts", None).unwrap();
        save_version(&ws, &idx, BASE, "wechat", "版本被改过").unwrap();
        // 同秒同内容的抢救快照会与上一份去重，隔 1 秒确保 sync 前快照成新文件
        std::thread::sleep(std::time::Duration::from_millis(1100));
        // 母版正文带附件引用
        let post_body = "母版新内容\n\n![](../_assets/a.png)\n";
        sync_from_post(&ws, &idx, BASE, "wechat", post_body, "posts").unwrap();
        let (_, body) = read_version_body(&ws, BASE, "wechat").unwrap();
        assert!(body.contains("母版新内容"));
        assert!(body.contains("../../../_assets/a.png"), "{body}");
        // 旧版本内容进历史
        let snaps = list_version_snapshots(&ws, &idx, BASE, "wechat").unwrap();
        assert!(snaps.len() >= 2);
    }

    #[test]
    fn post_and_version_independent() {
        let (_d, ws, idx) = setup();
        create_version(&ws, &idx, BASE, "T", "wechat", "v1", "posts", None).unwrap();
        // 改母版（写一个假文稿文件）
        std::fs::write(ws.root.join("posts/a.md"), "母版改了").unwrap();
        let (_, vbody) = read_version_body(&ws, BASE, "wechat").unwrap();
        assert_eq!(vbody, "v1", "母版改动不影响版本");
        // 改版本
        save_version(&ws, &idx, BASE, "wechat", "版本改了").unwrap();
        assert_eq!(
            std::fs::read_to_string(ws.root.join("posts/a.md")).unwrap(),
            "母版改了",
            "版本改动不影响母版"
        );
    }

    #[test]
    fn set_published_roundtrip() {
        let (_d, ws, idx) = setup();
        create_version(&ws, &idx, BASE, "T", "blog", "b", "posts", None).unwrap();
        set_published(&ws, &idx, BASE, "blog", Some("https://blog/x".into()), Some("2026-08-20".into())).unwrap();
        let (fm, _) = read_version_body(&ws, BASE, "blog").unwrap();
        assert_eq!(fm.published_url.as_deref(), Some("https://blog/x"));
        assert_eq!(fm.published_at.as_deref(), Some("2026-08-20"));
        let row = idx.get_file(&fm.id.to_string()).unwrap().unwrap();
        assert_eq!(row.status, "published"); // 派生
        // 清空 url → 回到 draft
        set_published(&ws, &idx, BASE, "blog", None, None).unwrap();
        let row = idx.get_file(&fm.id.to_string()).unwrap().unwrap();
        assert_eq!(row.status, "draft");
    }

    #[test]
    fn list_versions_scans_disk() {
        let (_d, ws, idx) = setup();
        create_version(&ws, &idx, BASE, "T", "wechat", "a", "posts", None).unwrap();
        create_version(&ws, &idx, BASE, "T", "blog", "b", "posts", None).unwrap();
        let all = list_versions(&ws);
        assert_eq!(all.len(), 2);
        assert!(all.iter().all(|v| v.base == BASE));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "---\nid: 8ab10000-0000-0000-0000-000000000001\ntarget: wechat\nbase: 3f2c0000-0000-0000-0000-000000000001\nforked_from: 20260818-090503-8d1f0a1c.md\npublished_url: https://mp.weixin.qq.com/s/abc\npublished_at: 2026-08-20\ntitle: 深度工作（公众号版）\ncreated: 2026-08-18T10:00:00\nupdated: 2026-08-19T09:00:00\n---\n\n正文开头\n";

    #[test]
    fn parse_and_roundtrip() {
        let (fm, body) = parse(SAMPLE).unwrap();
        assert_eq!(fm.target, "wechat");
        assert_eq!(fm.base, "3f2c0000-0000-0000-0000-000000000001");
        assert_eq!(fm.forked_from.as_deref(), Some("20260818-090503-8d1f0a1c.md"));
        assert_eq!(fm.published_url.as_deref(), Some("https://mp.weixin.qq.com/s/abc"));
        assert_eq!(fm.published_at.as_deref(), Some("2026-08-20"));
        assert_eq!(body, "\n正文开头\n");
        let out = fm.to_content(&body);
        let (fm2, body2) = parse(&out).unwrap();
        assert_eq!(fm2, fm);
        assert_eq!(body2, body);
    }

    #[test]
    fn minimal_frontmatter() {
        let src = "---\nid: 8ab10000-0000-0000-0000-000000000002\ntarget: blog\nbase: b0000000-0000-0000-0000-000000000003\n---\nbody";
        let (fm, body) = parse(src).unwrap();
        assert_eq!(fm.target, "blog");
        assert!(fm.forked_from.is_none());
        assert!(fm.published_url.is_none());
        assert_eq!(fm.title, "");
        assert_eq!(body, "body");
        let (fm2, _) = parse(&fm.to_content(&body)).unwrap();
        assert_eq!(fm2, fm);
    }

    #[test]
    fn canonical_order() {
        let (fm, body) = parse(SAMPLE).unwrap();
        let out = fm.to_content(&body);
        let positions = ["id:", "target:", "base:", "forked_from:", "published_url:", "title:"]
            .map(|k| out.find(k).unwrap());
        assert!(positions.windows(2).all(|w| w[0] < w[1]));
    }

    #[test]
    fn extra_keys_roundtrip() {
        let src = SAMPLE.replace("title: 深度工作（公众号版）", "title: 深度工作（公众号版）\nnote: 手改备注");
        let (fm, body) = parse(&src).unwrap();
        assert!(fm.to_content(&body).contains("note: 手改备注"));
    }
}
