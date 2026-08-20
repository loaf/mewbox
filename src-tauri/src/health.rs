//! 健康检查（DESIGN §7.4）：断链（回收站目标不计、单独提示）、孤儿历史、
//! 无主发布版本、孤儿附件（列出、手动确认清理；历史快照引用的旧指纹不算孤儿）。

use crate::state::AppState;
use crate::workspace::Workspace;

#[derive(Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthReport {
    /// 断链（来源文件 + 目的地）
    pub broken_links: Vec<BrokenLink>,
    /// 目标在回收站的链接（单独提示，不算断链）
    pub trash_targets: Vec<BrokenLink>,
    pub orphan_histories: Vec<String>,
    pub orphan_versions: Vec<String>,
    pub orphan_assets: Vec<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokenLink {
    pub from: String,
    pub dest: String,
}

/// 收集所有「内容源」：posts + kb（活文件与回收站）+ 发布版本 + 历史快照的全文。
/// 回收站文件照算引用（避免误报孤儿附件）；忽略 .git/node_modules（M5 忽略规则）。
fn collect_all_texts(ws: &Workspace) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for root in ["posts", "kb", ".versions"] {
        for entry in walkdir::WalkDir::new(ws.root.join(root))
            .into_iter()
            .filter_entry(|e| {
                e.depth() == 0
                    || !matches!(
                        e.file_name().to_string_lossy().as_ref(),
                        ".git" | "node_modules"
                    )
            })
        {
            let Ok(e) = entry else { continue };
            if !e.file_type().is_file() {
                continue;
            }
            let ext = e.path().extension().and_then(|x| x.to_str());
            if ext != Some("md") {
                continue;
            }
            let rel = e
                .path()
                .strip_prefix(&ws.root)
                .unwrap_or(e.path())
                .to_string_lossy()
                .replace('\\', "/");
            if let Ok(text) = std::fs::read_to_string(e.path()) {
                out.push((rel, text));
            }
        }
    }
    out
}

/// 正文（含尾部块）里的全部相对链接目的地。
fn all_dests(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut in_fence = false;
    for line in text.lines() {
        let t = line.trim_start();
        if t.starts_with("```") || t.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        let mut rest = line;
        while let Some(close) = rest.find("](") {
            let after = &rest[close + 2..];
            let Some(end) = after.find(')') else { break };
            let dest = after[..end].trim().to_string();
            let lower = dest.to_lowercase();
            if !dest.is_empty()
                && !lower.starts_with("http://")
                && !lower.starts_with("https://")
                && !dest.starts_with('#')
                && !lower.starts_with("mailto:")
                && !lower.starts_with("data:")
            {
                // 剥 fragment/query
                let path_part = match dest.find(['#', '?']) {
                    Some(i) => dest[..i].to_string(),
                    None => dest.clone(),
                };
                if !path_part.is_empty() {
                    out.push(path_part);
                }
            }
            rest = &after[end + 1..];
        }
    }
    out
}

pub fn check(ws: &Workspace, state: &AppState) -> crate::state::AppResult<HealthReport> {
    let mut report = HealthReport::default();

    // 活文件（正文+块断链检查基准）
    let live = state.live_files()?;
    let live_paths: std::collections::HashSet<String> =
        live.iter().map(|m| m.path.clone()).collect();
    let trashed: Vec<(String, String)> = {
        let mut t = Vec::new();
        for kind in ["post", "material"] {
            if let Ok(rows) = state.with_idx(|idx| Ok(idx.list_by_kind(kind, true)?)) {
                for m in rows {
                    if m.deleted_at.is_some() {
                        t.push((m.id.clone(), m.path.clone()));
                    }
                }
            }
        }
        t
    };
    let trash_paths: std::collections::HashSet<&str> =
        trashed.iter().map(|(_, p)| p.as_str()).collect();

    // 断链 / 回收站目标：先按索引归类回收站目标（提示），再以磁盘存在性为准——
    // 索引路径可能滞后于外部移动（Explorer 搬目录），不能当存在性判据（验收反馈修复）
    for m in &live {
        let Ok(text) = std::fs::read_to_string(ws.root.join(&m.path)) else { continue };
        for dest in all_dests(&text) {
            let resolved = crate::links::resolve_dest(&m.path, &dest);
            let Some(target) = resolved else { continue };
            if trash_paths.contains(target.as_str()) {
                report.trash_targets.push(BrokenLink {
                    from: m.path.clone(),
                    dest: target,
                });
                continue;
            }
            if live_paths.contains(&target) || ws.root.join(&target).exists() {
                continue;
            }
            report.broken_links.push(BrokenLink {
                from: m.path.clone(),
                dest: target,
            });
        }
    }

    // 孤儿历史：.versions/{id} 有 .history 快照但索引无此 id
    let all_rows = state.with_idx(|idx| {
        let mut all = idx.list_by_kind("post", true)?;
        all.extend(idx.list_by_kind("material", true)?);
        all.extend(idx.list_by_kind("publish", true)?);
        Ok(all)
    })?;
    let known_ids: std::collections::HashSet<String> =
        all_rows.iter().map(|m| m.id.clone()).collect();
    let versions_root = ws.root.join(".versions");
    if let Ok(rd) = std::fs::read_dir(&versions_root) {
        for e in rd.flatten() {
            let id = e.file_name().to_string_lossy().into_owned();
            let hist = e.path().join(".history");
            if let Ok(hrd) = std::fs::read_dir(&hist) {
                if hrd.flatten().count() > 0 && !known_ids.contains(&id) {
                    report.orphan_histories.push(id);
                }
            }
        }
    }

    // 无主发布版本：base 无索引行（在回收站的除外）
    for v in crate::publish::list_versions(ws) {
        let base_meta = state.with_idx(|idx| Ok(idx.get_file(&v.base)?))?;
        let orphan = match base_meta {
            None => true,
            Some(m) => m.missing && m.deleted_at.is_none(),
        };
        if orphan {
            report.orphan_versions.push(format!("{}（base {}）", v.target, v.base));
        }
    }

    // 孤儿附件：未被 任何内容源（含历史快照） 引用的 _assets 文件
    let texts = collect_all_texts(ws);
    if let Ok(rd) = std::fs::read_dir(ws.root.join("_assets")) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let referenced = texts.iter().any(|(_, t)| t.contains(&name));
            if !referenced {
                report.orphan_assets.push(name.trim_end_matches(|c| c == '.').split('.').next().unwrap_or(&name).to_string());
            }
        }
    }
    Ok(report)
}

/// 清理孤儿附件：仅删显式确认的指纹（且必须是 _assets 下真实存在的文件）。
pub fn clean_orphan_assets(ws: &Workspace, fingerprints: &[String]) -> std::io::Result<usize> {
    let mut removed = 0;
    for fp in fingerprints {
        let dir = ws.root.join("_assets");
        if let Ok(rd) = std::fs::read_dir(&dir) {
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().into_owned();
                if name.split('.').next() == Some(fp.as_str()) {
                    let _ = std::fs::remove_file(e.path());
                    removed += 1;
                }
            }
        }
    }
    Ok(removed)
}
