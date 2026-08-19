use std::collections::HashMap;
use std::path::Path;

use crate::frontmatter;
use crate::index::{FileMeta, Index};
use crate::workspace::Workspace;

#[derive(Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanReport {
    /// 磁盘上扫到的有效文稿（元数据 + 正文）
    pub posts: Vec<(FileMeta, String)>,
    /// id 相同但路径变化（外部改名 → 重联，DESIGN §3.3）
    pub path_changes: Vec<PathChange>,
    /// 无 frontmatter id 的外部新建文件（提示导入或补 id，DESIGN §7.4）
    pub pending_import: Vec<PendingFile>,
    /// 同名文件（不同子目录同 slug）冲突提示
    pub slug_conflicts: Vec<String>,
    /// 索引里有、磁盘上没有的 id（missing 标记，记录不删）
    pub missing: Vec<String>,
    /// 无主发布版本（base 文稿缺失；base 在回收站的不算，DESIGN-REVIEW 遗漏 4）
    pub orphan_versions: Vec<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathChange {
    pub id: String,
    pub old_path: String,
    pub new_path: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingFile {
    pub path: String,
}

/// 内容指纹（变化检测用，全量 sha256）。
pub fn file_hash(content: &str) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(content.as_bytes()))
}

fn rel(root: &Path, p: &Path) -> String {
    p.strip_prefix(root)
        .unwrap_or(p)
        .to_string_lossy()
        .replace('\\', "/")
}

/// 扫描 posts/（递归，排除 .trash/），解析 frontmatter。
pub fn scan_posts(ws: &Workspace) -> Result<ScanReport, std::io::Error> {
    let posts_dir = ws.root.join("posts");
    let mut report = ScanReport::default();
    let mut by_basename: HashMap<String, Vec<String>> = HashMap::new();

    for entry in walkdir::WalkDir::new(&posts_dir)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            !(e.depth() > 0 && name == ".trash")
        })
    {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let rel_path = rel(&ws.root, path);
        let content = std::fs::read_to_string(path)?;
        let (fm, body) = match frontmatter::parse(&content) {
            Ok(v) => v,
            Err(_) => {
                // YAML 解析失败的文件按待导入处理（人工决定去留）
                report.pending_import.push(PendingFile { path: rel_path });
                continue;
            }
        };
        by_basename
            .entry(path.file_name().unwrap_or_default().to_string_lossy().into_owned())
            .or_default()
            .push(rel_path.clone());

        if fm.is_new() {
            report.pending_import.push(PendingFile { path: rel_path });
            continue;
        }
        report.posts.push((
            FileMeta {
                id: fm.id.to_string(),
                kind: "post".into(),
                path: rel_path,
                title: fm.title,
                folder: fm.folder,
                status: fm.status.to_string(),
                tags: serde_json::to_string(&fm.tags).unwrap_or_else(|_| "[]".into()),
                created_at: fm.created,
                updated_at: fm.updated,
                deleted_at: None,
                hash: file_hash(&content),
                missing: false,
            },
            body,
        ));
    }

    for (name, paths) in by_basename {
        if paths.len() > 1 {
            report.slug_conflicts.push(name);
        }
    }
    Ok(report)
}

/// 与索引对比：外部改名（路径变化）与磁盘缺失。
pub fn diff_with_index(idx: &Index, report: &mut ScanReport) -> Result<(), crate::index::Error> {
    let indexed = idx.list_by_kind("post", true)?;
    let scanned: HashMap<&str, &str> = report
        .posts
        .iter()
        .map(|(m, _)| (m.id.as_str(), m.path.as_str()))
        .collect();
    let index_map: HashMap<String, String> = indexed
        .iter()
        .map(|m| (m.id.clone(), m.path.clone()))
        .collect();

    for (id, new_path) in &scanned {
        if let Some(old_path) = index_map.get(*id) {
            if old_path != new_path {
                report.path_changes.push(PathChange {
                    id: (*id).to_string(),
                    old_path: old_path.clone(),
                    new_path: (*new_path).to_string(),
                });
            }
        }
    }
    for m in &indexed {
        if m.deleted_at.is_none() && !scanned.contains_key(m.id.as_str()) && !m.missing {
            report.missing.push(m.id.clone());
        }
    }
    Ok(())
}

/// 应用扫描结果到索引：upsert 扫到的、标记缺失的。
pub fn apply_to_index(idx: &Index, report: &ScanReport) -> Result<(), crate::index::Error> {
    for (m, body) in &report.posts {
        idx.upsert_file(m, body)?;
    }
    for id in &report.missing {
        idx.set_missing(id, true)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frontmatter::Frontmatter;

    fn ws_with() -> (tempfile::TempDir, Workspace) {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::init(dir.path()).unwrap();
        (dir, ws)
    }

    fn write_md(ws: &Workspace, rel_path: &str, fm: Option<&Frontmatter>, body: &str) {
        let path = ws.root.join(rel_path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let content = match fm {
            Some(fm) => fm.to_content(body),
            None => body.to_string(),
        };
        std::fs::write(path, content).unwrap();
    }

    fn fm(id: &str, title: &str) -> Frontmatter {
        Frontmatter {
            id: uuid::Uuid::parse_str(id).unwrap(),
            title: title.into(),
            ..Default::default()
        }
    }

    const ID_1: &str = "3f2c0000-0000-0000-0000-000000000001";

    #[test]
    fn scan_reports_posts_and_excludes_trash() {
        let (_dir, ws) = ws_with();
        write_md(&ws, "posts/a.md", Some(&fm(ID_1, "A")), "正文");
        write_md(
            &ws,
            "posts/.trash/b.md",
            Some(&fm("3f2c0000-0000-0000-0000-000000000002", "B")),
            "回收站",
        );
        let report = scan_posts(&ws).unwrap();
        assert_eq!(report.posts.len(), 1);
        assert_eq!(report.posts[0].0.id, ID_1);
        assert!(report.pending_import.is_empty());
    }

    #[test]
    fn external_rename_relinks_by_id() {
        let (_dir, ws) = ws_with();
        let idx = Index::open_in_memory().unwrap();
        // 索引里 id-1 → posts/old.md
        idx.upsert_file(
            &FileMeta {
                id: ID_1.into(),
                kind: "post".into(),
                path: "posts/old.md".into(),
                title: "A".into(),
                folder: None,
                status: "draft".into(),
                tags: "[]".into(),
                created_at: String::new(),
                updated_at: String::new(),
                deleted_at: None,
                hash: String::new(),
                missing: false,
            },
            "",
        )
        .unwrap();
        // 磁盘上被外部改名为 posts/new.md（frontmatter id 不变）
        write_md(&ws, "posts/new.md", Some(&fm(ID_1, "A")), "正文");

        let mut report = scan_posts(&ws).unwrap();
        diff_with_index(&idx, &mut report).unwrap();
        apply_to_index(&idx, &report).unwrap();

        assert_eq!(report.path_changes.len(), 1);
        assert_eq!(report.path_changes[0].old_path, "posts/old.md");
        assert_eq!(report.path_changes[0].new_path, "posts/new.md");
        assert_eq!(idx.get_file(ID_1).unwrap().unwrap().path, "posts/new.md");
    }

    #[test]
    fn file_without_id_is_pending_import() {
        let (_dir, ws) = ws_with();
        write_md(&ws, "posts/external.md", None, "外部新建");
        let report = scan_posts(&ws).unwrap();
        assert!(report.posts.is_empty());
        assert_eq!(report.pending_import.len(), 1);
        assert_eq!(report.pending_import[0].path, "posts/external.md");
    }

    #[test]
    fn same_slug_in_different_dirs_flagged() {
        let (_dir, ws) = ws_with();
        write_md(
            &ws,
            "posts/2026/foo.md",
            Some(&fm(ID_1, "F1")),
            "1",
        );
        write_md(
            &ws,
            "posts/2027/foo.md",
            Some(&fm("3f2c0000-0000-0000-0000-000000000003", "F2")),
            "2",
        );
        let report = scan_posts(&ws).unwrap();
        assert_eq!(report.slug_conflicts, vec!["foo.md".to_string()]);
    }

    #[test]
    fn indexed_file_missing_on_disk_reported() {
        let (_dir, ws) = ws_with();
        let idx = Index::open_in_memory().unwrap();
        idx.upsert_file(
            &FileMeta {
                id: ID_1.into(),
                kind: "post".into(),
                path: "posts/gone.md".into(),
                title: "G".into(),
                folder: None,
                status: "draft".into(),
                tags: "[]".into(),
                created_at: String::new(),
                updated_at: String::new(),
                deleted_at: None,
                hash: String::new(),
                missing: false,
            },
            "",
        )
        .unwrap();
        let mut report = scan_posts(&ws).unwrap();
        diff_with_index(&idx, &mut report).unwrap();
        apply_to_index(&idx, &report).unwrap();
        assert_eq!(report.missing, vec![ID_1.to_string()]);
        assert!(idx.get_file(ID_1).unwrap().unwrap().missing);
    }
}
