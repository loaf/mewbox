//! Markdown 导出/迁移（DESIGN §12 M5）：
//! - `export_md`：posts（平铺）/ kb（目录树）导出为裸 Markdown 目录——frontmatter
//!   字节级原样透传，仅重写指向附件池 `_assets/` 的相对链接，被引用附件随行拷贝；
//! - `export_post_zip`：单文稿打包（正文 + 历史 + 发布版本 + 引用附件）。
//!
//! 零锁定原则：导出物用任何编辑器可直接打开；链接按导出布局（或 zip 内布局）重算。

use std::io::Write;
use std::path::Path;

use crate::links;
use crate::workspace::Workspace;

#[derive(Debug, thiserror::Error)]
pub enum ExportError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("zip: {0}")]
    Zip(#[from] zip::result::ZipError),
    #[error("{0}")]
    NotFound(String),
}

#[derive(Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportMdReport {
    /// 导出的 md 文件数
    pub files: usize,
    /// 随行拷贝的附件数
    pub assets: usize,
}

fn to_ws_string(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

/// frontmatter 字节级切分（与 frontmatter::split 同规则）：
/// (含两侧 `---` 围栏的原样头部, 正文)；无 frontmatter → ("", 全文)。
fn split_frontmatter_raw(content: &str) -> (&str, &str) {
    let mut lines = content.split_inclusive('\n');
    let first = match lines.next() {
        Some(l) if l.trim_end_matches(['\r', '\n']) == "---" => l,
        _ => return ("", content),
    };
    let yaml_start = first.len();
    let mut offset = yaml_start;
    for line in lines {
        let len = line.len();
        if line.trim_end_matches(['\r', '\n']) == "---" {
            return (&content[..offset + len], &content[offset + len..]);
        }
        offset += len;
    }
    // 没有闭合分隔线：整个文件按正文处理（frontmatter 语义同 parse）
    ("", content)
}

struct ExportedText {
    /// frontmatter 原文 + 重写后的正文
    content: String,
    /// 被引用的附件池文件（工作区相对 `_assets/...`）
    assets: Vec<String>,
}

/// 重写正文中指向附件池的相对链接：
/// dest 以 `from_rel`（该内容原本所属的工作区文件）解析 → 命中 `_assets/` 的
/// 改写为 `rel_between(target_rel, asset)`（target_rel = 导出物里的新位置），
/// fragment/query 保留；代码围栏内不动（与 links::redirect_body_links 同规则）。
fn rewrite_asset_links(content: &str, from_rel: &str, target_rel: &str) -> ExportedText {
    let (raw_fm, body) = split_frontmatter_raw(content);
    let mut assets = Vec::new();
    for dest in links::body_link_dests(body) {
        if let Some(p) = links::resolve_dest(from_rel, &dest) {
            if p.starts_with("_assets/") && !assets.contains(&p) {
                assets.push(p);
            }
        }
    }
    let mut out = String::with_capacity(body.len());
    if assets.is_empty() {
        out.push_str(body);
    } else {
        let mut in_fence = false;
        let mut fence_mark = "";
        for (i, line) in body.split('\n').enumerate() {
            if i > 0 {
                out.push('\n');
            }
            let t = line.trim_start();
            if t.starts_with("```") || t.starts_with("~~~") {
                let mark = &t[..3];
                if !in_fence {
                    in_fence = true;
                    fence_mark = mark;
                } else if mark == fence_mark {
                    in_fence = false;
                }
                out.push_str(line);
                continue;
            }
            if in_fence {
                out.push_str(line);
            } else {
                rewrite_line(line, from_rel, target_rel, &assets, &mut out);
            }
        }
    }
    ExportedText {
        content: format!("{raw_fm}{out}"),
        assets,
    }
}

fn rewrite_line(line: &str, from_rel: &str, target_rel: &str, assets: &[String], out: &mut String) {
    let mut rest = line;
    while let Some(close) = rest.find("](") {
        let (head, after) = rest.split_at(close + 2);
        out.push_str(head);
        let Some(end) = after.find(')') else {
            out.push_str(after);
            return;
        };
        let (dest, tail) = after.split_at(end);
        let replaced = links::resolve_dest(from_rel, dest)
            .filter(|p| assets.contains(p))
            .and_then(|p| links::rel_between(target_rel, &p))
            .map(|rel| {
                let frag = dest.find(['#', '?']).map(|i| &dest[i..]).unwrap_or("");
                format!("{rel}{frag}")
            });
        match replaced {
            Some(new_dest) => out.push_str(&new_dest),
            None => out.push_str(dest),
        }
        out.push(')');
        rest = &tail[1..];
    }
    out.push_str(rest);
}

// ═══════════════ 目录导出（§12：Markdown 导出） ═══════════════

/// 导出 posts/（平铺）或 kb/（目录树）到 dest_dir：
/// 保留 scope 内相对结构（剥掉 `posts/`、`kb/` 前缀）、排除忽略目录
/// （.trash/.git/node_modules）、frontmatter 原样、附件随行至 dest_dir/_assets/。
pub fn export_md(
    ws: &Workspace,
    scope: &str,
    dest_dir: &Path,
) -> Result<ExportMdReport, ExportError> {
    let scope_dir = match scope {
        "posts" => "posts",
        "kb" => "kb",
        _ => return Err(ExportError::NotFound(format!("未知导出范围：{scope}"))),
    };
    std::fs::create_dir_all(dest_dir)?;
    let mut report = ExportMdReport::default();
    let mut assets: Vec<String> = Vec::new();

    for entry in walkdir::WalkDir::new(ws.root.join(scope_dir))
        .into_iter()
        .filter_entry(|e| {
            e.depth() == 0 || !crate::scan::is_ignored_dir(&e.file_name().to_string_lossy())
        })
    {
        let Ok(e) = entry else { continue };
        if !e.file_type().is_file() {
            continue;
        }
        if e.path().extension().and_then(|x| x.to_str()) != Some("md") {
            continue;
        }
        let src_rel = to_ws_string(e.path().strip_prefix(&ws.root).unwrap_or(e.path()));
        let Some(dest_rel) = src_rel.strip_prefix(&format!("{scope_dir}/")) else {
            continue;
        };
        let content = std::fs::read_to_string(e.path())?;
        let ex = rewrite_asset_links(&content, &src_rel, dest_rel);
        let dest_file = dest_dir.join(dest_rel);
        if let Some(parent) = dest_file.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&dest_file, ex.content)?;
        report.files += 1;
        for a in ex.assets {
            if !assets.contains(&a) {
                assets.push(a);
            }
        }
    }

    for a in &assets {
        let src = ws.root.join(a);
        if src.exists() {
            let dst = dest_dir.join(a);
            std::fs::create_dir_all(dst.parent().unwrap())?;
            std::fs::copy(&src, &dst)?;
            report.assets += 1;
        }
    }
    Ok(report)
}

// ═══════════════ 单文稿打包（§12：正文+附件+历史+发布版本） ═══════════════

/// 打包单个文稿为 zip：
/// - `post.md`：母版文件原样（frontmatter + 正文 + 尾部块），附件链接重写为包内 `_assets/`
/// - `post.md.history/*.md`：`.versions/{id}/.history/` 快照（快照是母版的完整拷贝，
///   链接基准 = 母版路径）
/// - `publish/*.md`：`.versions/{id}/publish/` 发布版本（链接基准 = 版本自身路径）
/// - `_assets/*`：以上内容引用到的附件池文件
pub fn export_post_zip(
    ws: &Workspace,
    post_path: &str,
    post_id: &str,
    dest: &Path,
) -> Result<(), ExportError> {
    let post_abs = ws.root.join(post_path);
    let post_content = std::fs::read_to_string(&post_abs)
        .map_err(|_| ExportError::NotFound(format!("找不到文稿文件 {post_path}")))?;

    // (内容, 内容的链接基准路径, zip 内路径)
    let mut entries: Vec<(String, String, String)> =
        vec![(post_content, post_path.to_string(), "post.md".into())];

    let hist_dir = ws.root.join(".versions").join(post_id).join(".history");
    if hist_dir.exists() {
        for entry in walkdir::WalkDir::new(&hist_dir).max_depth(1).into_iter().flatten() {
            if !entry.file_type().is_file()
                || entry.path().extension().and_then(|x| x.to_str()) != Some("md")
            {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if let Ok(content) = std::fs::read_to_string(entry.path()) {
                entries.push((content, post_path.to_string(), format!("post.md.history/{name}")));
            }
        }
    }

    let publish_dir = ws.root.join(".versions").join(post_id).join("publish");
    if let Ok(rd) = std::fs::read_dir(&publish_dir) {
        for f in rd.flatten() {
            if !f.file_type().map(|t| t.is_file()).unwrap_or(false) {
                continue;
            }
            let name = f.file_name().to_string_lossy().into_owned();
            if !name.ends_with(".md") {
                continue;
            }
            let from_rel = format!(".versions/{post_id}/publish/{name}");
            if let Ok(content) = std::fs::read_to_string(f.path()) {
                entries.push((content, from_rel, format!("publish/{name}")));
            }
        }
    }

    let mut assets: Vec<String> = Vec::new();
    let mut buf = Vec::new();
    {
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for (content, from_rel, zip_rel) in &entries {
            let ex = rewrite_asset_links(content, from_rel, zip_rel);
            for a in ex.assets {
                if !assets.contains(&a) {
                    assets.push(a);
                }
            }
            zip.start_file(zip_rel.as_str(), opts)?;
            zip.write_all(ex.content.as_bytes())?;
        }
        for a in &assets {
            let bytes = std::fs::read(ws.root.join(a))?;
            zip.start_file(a.as_str(), opts)?;
            zip.write_all(&bytes)?;
        }
        zip.finish()?;
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(dest, &buf)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assets;
    use crate::frontmatter::Frontmatter;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    const ID_1: &str = "3f2c0000-0000-0000-0000-000000000001";

    fn ws_with() -> (tempfile::TempDir, Workspace) {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::init(dir.path()).unwrap();
        (dir, ws)
    }

    fn state_with() -> (tempfile::TempDir, crate::AppState) {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::init(dir.path()).unwrap();
        let state = crate::AppState {
            keys: Arc::new(crate::llm::InMemoryKeyStore::default()),
            idx: Arc::new(Mutex::new(crate::index::Index::open_in_memory().unwrap())),
            ai_tasks: Arc::new(Mutex::new(HashMap::new())),
            ws,
        };
        (dir, state)
    }

    fn write_md(ws: &Workspace, rel_path: &str, body: &str) {
        let path = ws.root.join(rel_path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let fm = Frontmatter {
            id: uuid::Uuid::parse_str(ID_1).unwrap(),
            title: "深度工作".into(),
            ..Default::default()
        };
        std::fs::write(path, fm.to_content(body)).unwrap();
    }

    // ───── split / 重写 ─────

    #[test]
    fn split_keeps_frontmatter_bytes_verbatim() {
        let content = "---\nid: x\ntitle: 深度工作\ncustom: { a: 1 }\n---\n\n正文";
        let (fm, body) = split_frontmatter_raw(content);
        assert_eq!(fm, "---\nid: x\ntitle: 深度工作\ncustom: { a: 1 }\n---\n");
        assert_eq!(body, "\n正文");
        // 无 frontmatter
        let (fm2, body2) = split_frontmatter_raw("就是正文");
        assert_eq!(fm2, "");
        assert_eq!(body2, "就是正文");
    }

    #[test]
    fn rewrite_normalizes_asset_link_and_keeps_fence() {
        let content = "---\ntitle: t\n---\n![图](../_assets/a.png)\n\n```md\n![围栏](../_assets/a.png)\n```\n";
        let ex = rewrite_asset_links(content, "posts/x.md", "x.md");
        assert_eq!(ex.assets, vec!["_assets/a.png".to_string()]);
        // posts/x.md → 导出根 x.md：../_assets/a.png 归一为 _assets/a.png
        assert!(ex.content.contains("![图](_assets/a.png)"), "{}", ex.content);
        // 围栏内不动、frontmatter 原样
        assert!(ex.content.contains("![围栏](../_assets/a.png)"));
        assert!(ex.content.starts_with("---\ntitle: t\n---\n"));
    }

    // ───── export_md ─────

    #[test]
    fn export_md_posts_flat_with_assets_and_trash_excluded() {
        let (dir, ws) = ws_with();
        let (_, img) = assets::save_asset(&ws, b"img-bytes", "png").unwrap();
        write_md(&ws, "posts/a.md", &format!("正文\n\n![图](../_assets/{img})\n"));
        write_md(&ws, "posts/.trash/b.md", "回收站不导出");
        let out = dir.path().join("out");

        let report = export_md(&ws, "posts", &out).unwrap();
        assert_eq!(report.files, 1);
        assert_eq!(report.assets, 1);
        let exported = std::fs::read_to_string(out.join("a.md")).unwrap();
        // 剥掉 posts/ 前缀 → 链接重写为 _assets/xxx（相对导出根）
        assert!(exported.contains(&format!("![图](_assets/{img})")), "{exported}");
        assert!(exported.contains("title: 深度工作"), "frontmatter 透传");
        assert!(out.join("_assets").join(&img).exists(), "附件随行");
        assert!(!out.join(".trash").exists());
        let asset_bytes = std::fs::read(out.join("_assets").join(&img)).unwrap();
        assert_eq!(asset_bytes, b"img-bytes");
    }

    #[test]
    fn export_md_kb_tree_preserves_structure_and_ignores_git() {
        let (dir, ws) = ws_with();
        let (_, img) = assets::save_asset(&ws, b"img2", "png").unwrap();
        write_md(&ws, "kb/研究/笔记.md", &format!("引用 ![](../../_assets/{img})"));
        write_md(&ws, "kb/根.md", &format!("根 ![](../_assets/{img})"));
        write_md(&ws, "kb/.git/config.md", "git 内容");
        write_md(&ws, "kb/node_modules/pkg/readme.md", "依赖");
        write_md(&ws, "kb/.trash/旧.md", "回收站");
        let out = dir.path().join("kb-out");

        let report = export_md(&ws, "kb", &out).unwrap();
        assert_eq!(report.files, 2);
        assert_eq!(report.assets, 1, "同一附件去重随行");
        let nested = std::fs::read_to_string(out.join("研究").join("笔记.md")).unwrap();
        assert!(nested.contains(&format!("![](../_assets/{img})")), "{nested}");
        let root = std::fs::read_to_string(out.join("根.md")).unwrap();
        assert!(root.contains(&format!("![](_assets/{img})")), "{root}");
        assert!(!out.join(".git").exists());
        assert!(!out.join("node_modules").exists());
    }

    #[test]
    fn export_md_unknown_scope_rejected() {
        let (dir, ws) = ws_with();
        let err = export_md(&ws, "everything", &dir.path().join("x")).unwrap_err();
        assert!(err.to_string().contains("未知导出范围"));
    }

    // ───── export_post_zip ─────

    #[test]
    fn zip_bundles_post_history_versions_and_assets() {
        let (dir, st) = state_with();
        let p = st.create_post("深度工作", None).unwrap();
        let (_, img) = assets::save_asset(&st.ws, b"zip-img", "png").unwrap();
        // 保存产生母版历史快照；发布版本正文取自磁盘（链接重写为版本路径基准）
        st.save_post(&p.id, &format!("母版 ![](../_assets/{img})")).unwrap();
        st.create_publish_version(&p.id, "wechat", None, None).unwrap();
        assert!(
            st.ws.root.join(format!(".versions/{}/.history", p.id)).exists(),
            "前置：母版历史已产生"
        );

        let out = dir.path().join("bundle.zip");
        st.export_post_zip(&p.id, &out.to_string_lossy()).unwrap();

        let f = std::fs::File::open(&out).unwrap();
        let mut zip = zip::ZipArchive::new(f).unwrap();
        let names: Vec<String> = zip.file_names().map(|n| n.to_string()).collect();
        assert!(names.contains(&"post.md".to_string()), "{names:?}");
        assert!(names.contains(&format!("_assets/{img}")), "{names:?}");
        assert!(names.contains(&"publish/wechat.md".to_string()), "{names:?}");
        assert!(
            names.iter().any(|n| n.starts_with("post.md.history/") && n.ends_with(".md")),
            "{names:?}"
        );

        use std::io::Read;
        let post = {
            let mut s = String::new();
            zip.by_name("post.md").unwrap().read_to_string(&mut s).unwrap();
            s
        };
        assert!(post.contains(&format!("![](_assets/{img})")), "包内相对链接: {post}");
        assert!(!post.contains(&format!("![](../_assets/{img})")), "{post}");
        assert!(post.contains("title: 深度工作"), "frontmatter 原样: {post}");

        let ver = {
            let mut s = String::new();
            zip.by_name("publish/wechat.md").unwrap().read_to_string(&mut s).unwrap();
            s
        };
        // 版本正文链接基准 .versions/{id}/publish/w.md → 包内 publish/w.md：../../../ → ../
        assert!(ver.contains(&format!("![](../_assets/{img})")), "{ver}");
        assert!(!ver.contains(&format!("![](../../../_assets/{img})")), "{ver}");
    }

    #[test]
    fn zip_without_assets_or_history_still_valid() {
        let (dir, st) = state_with();
        let p = st.create_post("纯文字", None).unwrap();
        st.save_post(&p.id, "只有文字，没有附件").unwrap();
        let out = dir.path().join("plain.zip");
        st.export_post_zip(&p.id, &out.to_string_lossy()).unwrap();
        let f = std::fs::File::open(&out).unwrap();
        let mut zip = zip::ZipArchive::new(f).unwrap();
        let mut body = String::new();
        use std::io::Read;
        zip.by_name("post.md").unwrap().read_to_string(&mut body).unwrap();
        assert!(body.contains("只有文字"));
    }
}
