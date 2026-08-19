//! 知识库（资料，DESIGN §6）：kb/ 物理目录树即分类，Inbox 是默认导入落点。
//! md 容器格式：正文承载描述，原件作附件存 `_assets/`、以相对路径引用。

use std::path::Path;

use crate::assoc::{self, AssocBlock};
use crate::frontmatter::{self, Frontmatter};
use crate::links;
use crate::workspace::Workspace;

#[derive(Debug, thiserror::Error)]
pub enum MaterialError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("yaml: {0}")]
    Yaml(#[from] serde_yaml::Error),
    #[error("{0}")]
    NotFound(String),
}

/// kb 相对路径 → 物理目录（去掉 "kb/" 前缀；Inbox 及根为 None/目录名）。
pub fn folder_of(rel_path: &str) -> Option<String> {
    let dir = Path::new(rel_path).parent()?;
    let s = dir.to_string_lossy().replace('\\', "/");
    let trimmed = s.strip_prefix("kb/")?.to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterialSummary {
    pub id: String,
    pub title: String,
    pub path: String,
    pub folder: Option<String>,
    pub updated_at: String,
}

/// 容器名唯一化：同目录同名自动 -2/-3（机制决策 7）。
pub fn unique_stem(ws: &Workspace, dir_rel: &str, stem: &str) -> String {
    let dir = ws.root.join(dir_rel);
    let mut candidate = stem.to_string();
    let mut i = 2;
    loop {
        if !dir.join(format!("{candidate}.md")).exists() {
            return candidate;
        }
        candidate = format!("{stem}-{i}");
        i += 1;
    }
}

/// 新建资料（稀疏 frontmatter：默认 status/tags 省略，机制决策 5）。
pub fn create_material(
    ws: &Workspace,
    title: &str,
    dir_rel: &str,
) -> Result<(Frontmatter, String), MaterialError> {
    let mut fm = Frontmatter::new_post(title, None);
    fm.sparse = true;
    let stem = unique_stem(ws, dir_rel, &slug::slugify(title));
    let rel = format!("{dir_rel}/{stem}.md");
    let abs = ws.root.join(&rel);
    std::fs::create_dir_all(abs.parent().unwrap())?;
    std::fs::write(&abs, fm.to_content(""))?;
    Ok((fm, rel))
}

/// 读资料文件：返回 (fm, 纯正文（不含块）, 块)。
pub fn read_material_file(
    ws: &Workspace,
    rel_path: &str,
) -> Result<(Frontmatter, String, Option<AssocBlock>), MaterialError> {
    let content = std::fs::read_to_string(ws.root.join(rel_path))?;
    let (fm, body_with_block) = frontmatter::parse(&content)?;
    let (clean, block) = assoc::strip_assoc(&body_with_block);
    Ok((fm, clean, block))
}

/// 落盘资料：正文视为纯正文，块以磁盘当前内容为准回拼（机制决策 1）。
/// 返回是否发生实质正文变化（块变化不算，不触发快照）。
pub fn write_material(
    ws: &Workspace,
    rel_path: &str,
    fm: &Frontmatter,
    clean_body: &str,
) -> Result<bool, MaterialError> {
    let prev = std::fs::read_to_string(ws.root.join(rel_path)).unwrap_or_default();
    let (_, prev_body_with_block) = frontmatter::parse(&prev)?;
    let (prev_clean, disk_block) = assoc::strip_assoc(&prev_body_with_block);
    let changed = crate::history::is_material_change(&prev_clean, clean_body);
    let mut fm = fm.clone();
    fm.sparse = true;
    let full = assoc::append_assoc(clean_body, &disk_block.unwrap_or_default());
    let full = fm.to_content(&full);
    std::fs::write(ws.root.join(rel_path), full)?;
    Ok(changed)
}

/// md 导入：拷入 kb/{dest_dir}/，无 id 则补；frontmatter 透传（§6）。
pub fn import_md(
    ws: &Workspace,
    src_abs: &Path,
    dest_dir_rel: &str,
) -> Result<String, MaterialError> {
    let stem_src = src_abs
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "imported".into());
    let stem = unique_stem(ws, dest_dir_rel, &stem_src);
    let rel = format!("{dest_dir_rel}/{stem}.md");
    let dst = ws.root.join(&rel);
    std::fs::create_dir_all(dst.parent().unwrap())?;
    let content = std::fs::read_to_string(src_abs)?;
    let (fm, body) = frontmatter::parse(&content)?;
    let fm = if fm.is_new() {
        let mut m = Frontmatter::new_post(&stem_src, None);
        m.sparse = true;
        // 手写 frontmatter 键透传（含 source 等）
        m.extra = fm.extra;
        m.title = fm.title.is_empty().then(|| stem_src.clone()).unwrap_or(fm.title.clone());
        m
    } else {
        let mut m = fm;
        m.sparse = true;
        m
    };
    std::fs::write(&dst, fm.to_content(&body))?;
    Ok(rel)
}

/// 非 md 导入容器化（§6）：原件入 `_assets/`，容器落 `kb/Inbox/`。
pub fn import_file_containerized(
    ws: &Workspace,
    src_abs: &Path,
) -> Result<String, MaterialError> {
    let filename = src_abs
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file.bin".into());
    let stem_src = src_abs
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "imported".into());
    let ext = src_abs
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("bin")
        .to_lowercase();
    let bytes = std::fs::read(src_abs)?;
    let (_, asset_name) = crate::assets::save_asset(ws, &bytes, &ext)?;
    let stem = unique_stem(ws, "kb/Inbox", &stem_src);

    let mut fm = Frontmatter::new_post(&stem_src, None);
    fm.sparse = true;
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let extras = [
        ("source", serde_yaml::Value::String(filename.clone())),
        ("collected_at", serde_yaml::Value::String(today)),
        (
            "attachments",
            serde_yaml::Value::Sequence(vec![serde_yaml::Value::String(asset_name.clone())]),
        ),
    ];
    for (k, v) in extras {
        fm.extra.insert(serde_yaml::Value::String(k.into()), v);
    }
    let rel = format!("kb/Inbox/{stem}.md");
    let body = format!(
        "（待补描述：{stem_src}）\n\n[原件：{filename}]({})\n",
        crate::assets::relative_asset_path(&rel, &asset_name)
    );
    std::fs::write(ws.root.join(&rel), fm.to_content(&body))?;
    Ok(rel)
}

/// 资料移入/移出回收站（物理移动 + 保留原相对目录信息由索引承载）。
pub fn move_material_file(ws: &Workspace, from_rel: &str, to_rel: &str) -> Result<(), MaterialError> {
    let from = ws.root.join(from_rel);
    let to = ws.root.join(to_rel);
    std::fs::create_dir_all(to.parent().unwrap())?;
    if to.exists() {
        return Err(MaterialError::NotFound(format!("目标已存在：{to_rel}")));
    }
    std::fs::rename(from, to)?;
    Ok(())
}

/// 目标路径是否存在（健康检查/断链判定用）。
pub fn ws_path_exists(ws: &Workspace, rel: &str) -> bool {
    ws.root.join(rel).exists()
}

/// links 辅助：重写正文中指向 old_target 的相对链接 → new_target（跳围栏）。
/// 返回 None 表示无变化。
pub fn rewrite_links_to(body: &str, from_file: &str, old_target: &str, new_target: &str) -> Option<String> {
    let new_dest = links::rel_between(from_file, new_target)?;
    let mut changed = false;
    let mut out_lines = Vec::new();
    let mut in_fence = false;
    let mut fence_mark = "";
    for line in body.split('\n') {
        let t = line.trim_start();
        if t.starts_with("```") || t.starts_with("~~~") {
            let mark = &t[..3];
            if !in_fence {
                in_fence = true;
                fence_mark = mark;
            } else if mark == fence_mark {
                in_fence = false;
            }
            out_lines.push(line.to_string());
            continue;
        }
        if in_fence {
            out_lines.push(line.to_string());
            continue;
        }
        if !line.contains("](") {
            out_lines.push(line.to_string());
            continue;
        }
        let mut out = String::with_capacity(line.len());
        let mut rest = line;
        let mut line_changed = false;
        while let Some(close) = rest.find("](") {
            let (head, after) = rest.split_at(close + 2);
            out.push_str(head);
            let Some(end) = after.find(')') else {
                out.push_str(after);
                break;
            };
            let (dest, tail) = after.split_at(end);
            let hit = links::resolve_dest(from_file, dest.trim()).as_deref() == Some(old_target);
            if hit {
                out.push_str(&new_dest);
                line_changed = true;
            } else {
                out.push_str(dest);
            }
            out.push_str(&tail[..1]);
            rest = &tail[1..];
        }
        out.push_str(rest);
        changed |= line_changed;
        out_lines.push(out);
    }
    if !changed {
        return None;
    }
    Some(out_lines.join("\n"))
}

mod slug {
    /// 物理文件名：ASCII → kebab；非 ASCII → material-{uuid8}。
    pub fn slugify(title: &str) -> String {
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
            format!("material-{}", &uuid::Uuid::new_v4().to_string()[..8])
        } else {
            s.chars().take(60).collect()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn ws() -> (tempfile::TempDir, Workspace) {
        let dir = tempdir().unwrap();
        let w = Workspace::init(dir.path()).unwrap();
        (dir, w)
    }

    #[test]
    fn folder_of_derives_from_path() {
        assert_eq!(folder_of("kb/Inbox/a.md").as_deref(), Some("Inbox"));
        assert_eq!(folder_of("kb/研究/深度工作/b.md").as_deref(), Some("研究/深度工作"));
        assert_eq!(folder_of("kb/a.md"), None);
    }

    #[test]
    fn create_material_sparse_and_unique() {
        let (_d, w) = ws();
        let (fm, rel) = create_material(&w, "设计素材", "kb/Inbox").unwrap();
        assert!(rel.starts_with("kb/Inbox/"));
        let content = std::fs::read_to_string(w.root.join(&rel)).unwrap();
        assert!(!content.contains("status:"), "稀疏省略: {content}");
        assert!(!content.contains("tags:"));
        let (fm2, body, block) = read_material_file(&w, &rel).unwrap();
        assert_eq!(fm2.id, fm.id);
        assert_eq!(body, "");
        assert!(block.is_none());
        // 同名（ASCII slug）→ -2；中文标题走 material-{uuid8} 天然不撞
        let (_, rel3) = create_material(&w, "design notes", "kb/Inbox").unwrap();
        let (_, rel4) = create_material(&w, "design notes", "kb/Inbox").unwrap();
        assert!(rel4.contains("-2"), "{rel4}");
        assert_ne!(rel3, rel4);
    }

    #[test]
    fn write_material_disk_block_wins() {
        let (_d, w) = ws();
        let (_, rel) = create_material(&w, "素材", "kb/Inbox").unwrap();
        // 另一侧（磁盘）写入了一个块
        let mut block = AssocBlock::default();
        block.posts.push(crate::assoc::AssocEntry {
            title: "文稿A".into(),
            target: "../../posts/a.md".into(),
        });
        let (_, body, _) = read_material_file(&w, &rel).unwrap();
        std::fs::write(
            w.root.join(&rel),
            format!("---\ntitle: 素材\n---\n{}", crate::assoc::append_assoc(&body, &block)),
        )
        .unwrap();
        // 编辑器保存纯正文（不含块）：磁盘块应保留（机制决策 1）
        let (fm, _, _) = read_material_file(&w, &rel).unwrap();
        let changed = write_material(&w, &rel, &fm, "新描述正文").unwrap();
        assert!(changed);
        let (_, body2, block2) = read_material_file(&w, &rel).unwrap();
        assert_eq!(body2, "新描述正文");
        assert_eq!(block2, Some(block));
        // 再保存同正文：无变化
        let (fm3, _, b3) = read_material_file(&w, &rel).unwrap();
        let _ = b3;
        assert!(!write_material(&w, &rel, &fm3, "新描述正文").unwrap());
    }

    #[test]
    fn import_md_passthrough_and_id() {
        let (_d, w) = ws();
        let src = w.root.join("tmp-import.md");
        std::fs::write(&src, "---\nsource: https://example.com/a\ntitle: 外部文章\n---\n外部正文\n").unwrap();
        let rel = import_md(&w, &src, "kb/研究").unwrap();
        let content = std::fs::read_to_string(w.root.join(&rel)).unwrap();
        assert!(content.contains("source: https://example.com/a"), "{content}");
        assert!(content.contains("title: 外部文章"));
        assert!(content.contains("id: "), "补 id");
        assert!(content.contains("外部正文"));
        assert!(rel.starts_with("kb/研究/"));
    }

    #[test]
    fn containerized_import() {
        let (_d, w) = ws();
        let src = w.root.join("论文.pdf");
        std::fs::write(&src, b"fake-pdf-bytes").unwrap();
        let rel = import_file_containerized(&w, &src).unwrap();
        assert!(rel.starts_with("kb/Inbox/"), "{rel}");
        let (_, body, _) = read_material_file(&w, &rel).unwrap();
        assert!(body.contains("[原件：论文.pdf]("));
        assert!(body.contains("../_assets/"), "{body}");
        let content = std::fs::read_to_string(w.root.join(&rel)).unwrap();
        assert!(content.contains("collected_at: "));
        assert!(content.contains("attachments:"));
        // 原件确实入库且指纹命名
        let assets: Vec<_> = std::fs::read_dir(w.root.join("_assets"))
            .unwrap()
            .flatten()
            .collect();
        assert_eq!(assets.len(), 1);
        let name = assets[0].file_name().to_string_lossy().into_owned();
        assert!(name.ends_with(".pdf"));
        assert_eq!(name.split('.').next().unwrap().len(), 16);
        // 同名 → 容器 -2，附件去重不重复入库
        let rel2 = import_file_containerized(&w, &src).unwrap();
        assert!(rel2.contains("-2"), "{rel2}");
        assert_eq!(std::fs::read_dir(w.root.join("_assets")).unwrap().count(), 1);
    }

    #[test]
    fn rewrite_links_to_targets_only_old() {
        let body = "见 [甲](../kb/研究/a.md) 和 [乙](../kb/b.md) 以及 ![](../_assets/x.png)\n```\n[丙](../kb/研究/a.md)\n```\n";
        let out = rewrite_links_to(body, "posts/p.md", "kb/研究/a.md", "kb/新/a.md").unwrap();
        assert!(out.contains("[甲](../kb/新/a.md)"), "{out}");
        assert!(out.contains("[乙](../kb/b.md)"), "其它链接不动");
        assert!(out.contains("../_assets/x.png"));
        assert!(out.contains("[丙](../kb/研究/a.md)"), "围栏内不动");
        // 无变化 → None
        assert!(rewrite_links_to(body, "posts/p.md", "kb/none.md", "kb/x.md").is_none());
    }
}
