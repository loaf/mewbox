//! 链接工具：文件间相对路径与目的地解析（关联块/正文引用共用）。

use std::path::{Component, Path, PathBuf};

/// 词法归一化：折叠 `.`/`..`（开头越根的 `..` 保留）。
pub fn normalize_rel_path(p: &Path) -> PathBuf {
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

fn to_ws_string(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

/// 两个工作区相对文件之间的相对引用（`/` 分隔）：from → to。
/// 例：from="posts/a.md", to="kb/x/b.md" → "../kb/x/b.md"
pub fn rel_between(from_file: &str, to_file: &str) -> Option<String> {
    let from_dir = Path::new(from_file).parent()?;
    let target = normalize_rel_path(Path::new(to_file));
    let diff = pathdiff::diff_paths(&target, from_dir)?;
    Some(to_ws_string(&diff))
}

/// 解析单条目的地：以 from_file 所在目录为基准 → 工作区相对路径（剥 fragment/query）。
/// 外链/锚点/data/越根 → None。
pub fn resolve_dest(from_file: &str, dest: &str) -> Option<String> {
    let lower = dest.to_lowercase();
    if lower.starts_with("http://")
        || lower.starts_with("https://")
        || dest.starts_with('#')
        || lower.starts_with("mailto:")
        || lower.starts_with("data:")
    {
        return None;
    }
    let (path_part, _tail) = match dest.find(['#', '?']) {
        Some(i) => (&dest[..i], &dest[i..]),
        None => (dest, ""),
    };
    if path_part.is_empty() {
        return None;
    }
    let from_dir = Path::new(from_file).parent()?;
    let abs = normalize_rel_path(&from_dir.join(path_part));
    if abs.starts_with("..") {
        return None;
    }
    Some(to_ws_string(&abs))
}

// ═══════ wiki 链接（DESIGN §7.2） ═══════

/// 跳过代码围栏的逐行迭代
fn each_prose_line(body: &str, mut f: impl FnMut(&str)) {
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
            continue;
        }
        if !in_fence {
            f(line);
        }
    }
}

/// 抽取正文 `[[标题]]` 引用（跳过围栏）。
pub fn extract_wiki_refs(body: &str) -> Vec<String> {
    let mut out = Vec::new();
    each_prose_line(body, |line| {
        let mut rest = line;
        while let Some(i) = rest.find("[[") {
            let after = &rest[i + 2..];
            let Some(j) = after.find("]]") else { break };
            let title = &after[..j];
            if !title.trim().is_empty() {
                out.push(title.to_string());
            }
            rest = &after[j + 2..];
        }
    });
    out
}

/// 标题变更同步：全文 `[[旧]]` → `[[新]]`（跳过围栏，围栏行原样保留）。
pub fn rename_wiki_refs(body: &str, old: &str, new: &str) -> String {
    let from = format!("[[{old}]]");
    let to = format!("[[{new}]]");
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
                out_lines.push(line.to_string());
                continue;
            } else if mark == fence_mark {
                in_fence = false;
            }
            out_lines.push(line.to_string());
            continue;
        }
        if in_fence {
            out_lines.push(line.to_string());
        } else {
            out_lines.push(line.replace(&from, &to));
        }
    }
    out_lines.join("\n")
}

// ═══════ 正文相对链接的重定向（移动/改名/互转引用同步，Task 5） ═══════

/// 收集正文中的 Markdown 链接目的地（`[t](dest)` 与 `![alt](dest)`；跳过代码围栏）。
pub fn body_link_dests(body: &str) -> Vec<String> {
    let mut out = Vec::new();
    each_prose_line(body, |line| {
        let mut rest = line;
        while let Some(close) = rest.find("](") {
            let after = &rest[close + 2..];
            let Some(end) = after.find(')') else { break };
            out.push(after[..end].to_string());
            rest = &after[end + 1..];
        }
    });
    out
}

/// 正文链接目的地重定向（Task 5 原子同步）：以 from_file 为基准解析 dest，
/// 命中 redirects 旧路径的改写为指向新路径的相对引用（fragment/query 保留；跳过围栏）。
/// 返回 (新正文, 是否发生变化)。
pub fn redirect_body_links(
    body: &str,
    from_file: &str,
    redirects: &[(String, String)],
) -> (String, bool) {
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
        if in_fence || redirects.is_empty() {
            out_lines.push(line.to_string());
        } else {
            out_lines.push(redirect_line(line, from_file, redirects, &mut changed));
        }
    }
    (out_lines.join("\n"), changed)
}

fn redirect_line(
    line: &str,
    from_file: &str,
    redirects: &[(String, String)],
    changed: &mut bool,
) -> String {
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(close) = rest.find("](") {
        let (head, after) = rest.split_at(close + 2);
        out.push_str(head);
        let Some(end) = after.find(')') else {
            out.push_str(after);
            return out;
        };
        let (dest, tail) = after.split_at(end);
        let mut replaced = false;
        if let Some(ws_path) = resolve_dest(from_file, dest) {
            if let Some((_, new_path)) = redirects.iter().find(|(old, _)| *old == ws_path) {
                if let Some(rel) = rel_between(from_file, new_path) {
                    // 保留原 dest 的 fragment/query 尾巴
                    let frag = dest.find(['#', '?']).map(|i| &dest[i..]).unwrap_or("");
                    out.push_str(&rel);
                    out.push_str(frag);
                    replaced = true;
                    *changed = true;
                }
            }
        }
        if !replaced {
            out.push_str(dest);
        }
        out.push_str(&tail[..1]); // ')'
        rest = &tail[1..];
    }
    out.push_str(rest);
    out
}

/// 链接图重建（机制决策 6，磁盘为准）：正文 wiki 引用（唯一标题命中才有 to_id）
/// + 关联块条目（路径反查 id）。写入 idx 的 links 表（缓存性质，可随时重建）。
pub fn rebuild_link_graph(
    ws: &crate::workspace::Workspace,
    idx: &crate::index::Index,
) -> Result<(), crate::index::Error> {
    use std::collections::HashMap;
    let mut rows = idx.list_by_kind("post", false)?;
    rows.extend(idx.list_by_kind("material", false)?);
    let path_to_id: HashMap<String, String> =
        rows.iter().map(|m| (m.path.clone(), m.id.clone())).collect();
    let mut title_ids: HashMap<&str, Vec<&str>> = HashMap::new();
    for m in &rows {
        title_ids.entry(m.title.as_str()).or_default().push(m.id.as_str());
    }
    let mut links: Vec<crate::index::LinkRow> = Vec::new();
    for m in &rows {
        let Ok(content) = std::fs::read_to_string(ws.root.join(&m.path)) else { continue };
        let Ok((_, body)) = crate::frontmatter::parse(&content) else { continue };
        let (clean, block) = crate::assoc::strip_assoc(&body);
        let mut seen = std::collections::HashSet::new();
        for title in extract_wiki_refs(&clean) {
            if !seen.insert(title.clone()) {
                continue; // 同标题多次引用只记一条
            }
            let to_id = match title_ids.get(title.as_str()) {
                Some(ids) if ids.len() == 1 => Some(ids[0].to_string()),
                _ => None, // 重名/无匹配：悬空（前端给候选）
            };
            links.push(crate::index::LinkRow {
                from_id: m.id.clone(),
                to_id,
                raw_title: title,
                kind: "wiki".into(),
            });
        }
        if let Some(b) = block {
            for e in b.posts.iter().chain(&b.materials).chain(&b.versions) {
                let to_id = resolve_dest(&m.path, &e.target).and_then(|p| path_to_id.get(&p).cloned());
                links.push(crate::index::LinkRow {
                    from_id: m.id.clone(),
                    to_id,
                    raw_title: e.title.clone(),
                    kind: "assoc".into(),
                });
            }
        }
    }
    idx.replace_links(&links)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rel_between_across_libs() {
        assert_eq!(
            rel_between("posts/a.md", "kb/x/b.md").as_deref(),
            Some("../kb/x/b.md")
        );
        assert_eq!(
            rel_between(".versions/p1/publish/wechat.md", "kb/x/b.md").as_deref(),
            Some("../../../kb/x/b.md")
        );
        assert_eq!(rel_between("kb/x/b.md", "posts/a.md").as_deref(), Some("../../posts/a.md"));
    }

    #[test]
    fn resolve_dest_variants() {
        assert_eq!(
            resolve_dest("posts/a.md", "../_assets/x.png").as_deref(),
            Some("_assets/x.png".into())
        );
        assert_eq!(
            resolve_dest(".versions/p1/publish/w.md", "../../../kb/a.md").as_deref(),
            Some("kb/a.md".into())
        );
        // fragment 剥离、外链/锚点 None
        assert_eq!(
            resolve_dest("posts/a.md", "../kb/a.md#sec").as_deref(),
            Some("kb/a.md".into())
        );
        assert_eq!(resolve_dest("posts/a.md", "https://x.com"), None);
        assert_eq!(resolve_dest("posts/a.md", "#anchor"), None);
        // 越出工作区根
        assert_eq!(resolve_dest("posts/a.md", "../../../../outside.md"), None);
    }

    #[test]
    fn wiki_refs_extract_and_rename_skip_fences() {
        let body = "参考 [[深度工作]] 与 [[随笔]]\n\n```\n[[围栏内不算]]\n```\n再提 [[深度工作]]";
        let refs = extract_wiki_refs(body);
        assert_eq!(refs, vec!["深度工作".to_string(), "随笔".into(), "深度工作".into()]);
        let renamed = rename_wiki_refs(body, "深度工作", "深度工作实践记");
        assert!(renamed.contains("[[深度工作实践记]]"));
        assert!(!renamed.contains("[[深度工作]]"));
        assert!(renamed.contains("[[围栏内不算]]"), "围栏内不替换: {renamed}");
    }

    #[test]
    fn redirect_body_links_updates_only_matching() {
        let body = "见 [文稿](../../posts/a.md) 与 ![图](_assets/x.png)\n\n```\n[x](../../posts/a.md)\n```\n";
        let moves = vec![("posts/a.md".to_string(), "kb/研究/资料.md".to_string())];
        let (out, changed) = redirect_body_links(body, "kb/n/m.md", &moves);
        assert!(changed);
        let expected = rel_between("kb/n/m.md", "kb/研究/资料.md").unwrap();
        assert!(out.contains(&format!("[文稿]({expected})")), "{out}");
        // 其它链接与围栏内不动
        assert!(out.contains("![图](_assets/x.png)"));
        assert!(out.contains("[x](../../posts/a.md)"));

        // 不相关的移动集合：无变化
        let (out2, changed2) = redirect_body_links(body, "kb/n/m.md", &[]);
        assert!(!changed2);
        assert_eq!(out2, body);

        // fragment 保留
        let (out3, changed3) = redirect_body_links(
            "[x](../../posts/a.md#sec)",
            "kb/n/m.md",
            &moves,
        );
        assert!(changed3);
        assert!(out3.contains(&format!("{expected}#sec")), "{out3}");
    }

    #[test]
    fn body_link_dests_collects_and_skips_fences() {
        let body = "[a](x.md) ![i](../_assets/p.png)\n```nope\n[f](fenced.md)\n```";
        let dests = body_link_dests(body);
        assert_eq!(dests, vec!["x.md".to_string(), "../_assets/p.png".to_string()]);
    }
}
