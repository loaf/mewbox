use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use chrono::{DateTime, Datelike, Duration, TimeZone, Utc};

/// 历史快照的保留策略（DESIGN §4.2）：
/// 近 48h 全留 → 每日 1 份共 30 天 → 此后每周 1 份；里程碑永留。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RetentionConfig {
    pub full_hours: i64,
    pub daily_days: i64,
}

impl Default for RetentionConfig {
    fn default() -> Self {
        Self {
            full_hours: 48,
            daily_days: 30,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct SnapshotMeta {
    pub ts: DateTime<Utc>,
    pub hash8: String,
    pub milestone: Option<String>,
}

/// sha256 前 8 个十六进制字符。
pub fn hash8(content: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(content.as_bytes());
    hex::encode(&digest[..4])
}

/// 快照文件名：{YYYYMMDD-HHMMSS}-{hash8}.md（DESIGN §4.2）。
pub fn snapshot_file_name(ts: DateTime<Utc>, content: &str) -> String {
    let local = ts.with_timezone(&chrono::Local);
    format!("{}-{}.md", local.format("%Y%m%d-%H%M%S"), hash8(content))
}

/// 实质变化判断：仅尾部空白差异不算（编辑器落盘常见噪声）。
pub fn is_material_change(old: &str, new: &str) -> bool {
    old.trim_end() != new.trim_end()
}

/// 计算应保留的快照集合（不在集合内的可清理）。
pub fn plan_retention(
    snaps: &[SnapshotMeta],
    now: &DateTime<Utc>,
    cfg: &RetentionConfig,
) -> HashSet<DateTime<Utc>> {
    let mut keep = HashSet::new();
    let mut daily: HashMap<(i32, u32), SnapshotMeta> = HashMap::new();
    let mut weekly: HashMap<(i32, u32), SnapshotMeta> = HashMap::new();

    for s in snaps {
        if s.milestone.is_some() {
            keep.insert(s.ts); // 里程碑永留
            continue;
        }
        let age = *now - s.ts;
        if age <= Duration::hours(cfg.full_hours) {
            keep.insert(s.ts); // 近窗口全留
        } else if age <= Duration::days(cfg.daily_days) {
            let local = s.ts.with_timezone(&chrono::Local);
            let key = (local.year(), local.ordinal());
            let e = daily.entry(key).or_insert_with(|| s.clone());
            if s.ts > e.ts {
                *e = s.clone();
            }
        } else {
            let iso = s.ts.iso_week();
            let key = (iso.year(), iso.week());
            let e = weekly.entry(key).or_insert_with(|| s.clone());
            if s.ts > e.ts {
                *e = s.clone();
            }
        }
    }
    for s in daily.into_values().chain(weekly.into_values()) {
        keep.insert(s.ts);
    }
    keep
}

// ═══════════════ IO 部分 ═══════════════

#[derive(Debug, thiserror::Error)]
pub enum HistoryError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("index: {0}")]
    Index(#[from] crate::index::Error),
    #[error("数据不一致: {0}")]
    Parse(String),
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotEntry {
    pub file_name: String,
    /// 本地时间（快照文件名解析而来）
    pub ts: chrono::NaiveDateTime,
    pub ts_utc: DateTime<Utc>,
    pub hash8: String,
    pub milestone: Option<String>,
}

fn versions_dir(ws: &crate::workspace::Workspace, file_id: &str) -> PathBuf {
    ws.root.join(".versions").join(file_id)
}

fn history_dir(ws: &crate::workspace::Workspace, file_id: &str) -> PathBuf {
    versions_dir(ws, file_id).join(".history")
}

fn ts_key(ts: &chrono::NaiveDateTime) -> String {
    ts.format("%Y-%m-%dT%H:%M:%S").to_string()
}

/// Windows 上 rename 不能覆盖已存在文件，先删后改名。
fn atomic_write(path: &Path, content: &str) -> std::io::Result<()> {
    let tmp = path.with_extension("md.tmp");
    std::fs::write(&tmp, content)?;
    if path.exists() {
        std::fs::remove_file(path)?;
    }
    std::fs::rename(&tmp, path)
}

/// 保存时调用：内容实质变化才落快照（DESIGN §4.2）。
pub fn maybe_snapshot(
    ws: &crate::workspace::Workspace,
    idx: &crate::index::Index,
    file_id: &str,
    prev_content: &str,
    new_content: &str,
) -> Result<Option<SnapshotEntry>, HistoryError> {
    if !is_material_change(prev_content, new_content) {
        return Ok(None);
    }
    Ok(Some(write_snapshot(ws, idx, file_id, new_content)?))
}

/// 无条件写一份快照到指定目录（默认封装用于文稿/资料 `.history`，
/// 发布版本复用 `_in` 版本指向 `{target}.history/`）。
pub fn write_snapshot(
    ws: &crate::workspace::Workspace,
    idx: &crate::index::Index,
    file_id: &str,
    content: &str,
) -> Result<SnapshotEntry, HistoryError> {
    write_snapshot_in(ws, &history_dir(ws, file_id), idx, file_id, content)
}

pub fn write_snapshot_in(
    ws: &crate::workspace::Workspace,
    dir: &Path,
    idx: &crate::index::Index,
    file_id: &str,
    content: &str,
) -> Result<SnapshotEntry, HistoryError> {
    let now = chrono::Local::now();
    let h = hash8(content);
    let name = format!("{}-{}.md", now.format("%Y%m%d-%H%M%S"), h);
    std::fs::create_dir_all(dir)?;
    let path = dir.join(&name);
    if !path.exists() {
        atomic_write(&path, content)?;
    }
    let ts = now.naive_local();
    idx.record_snapshot(file_id, &ts_key(&ts), &h)?;
    let _ = ws;
    Ok(SnapshotEntry {
        file_name: name,
        ts,
        ts_utc: now.with_timezone(&Utc),
        hash8: h,
        milestone: None,
    })
}

/// 快照列表：以磁盘为权威（index 只是加速缓存，DESIGN 原则 3）。
pub fn list_snapshots(
    ws: &crate::workspace::Workspace,
    idx: &crate::index::Index,
    file_id: &str,
) -> Result<Vec<SnapshotEntry>, HistoryError> {
    list_snapshots_in(ws, &history_dir(ws, file_id), idx, file_id)
}

pub fn list_snapshots_in(
    _ws: &crate::workspace::Workspace,
    dir: &Path,
    idx: &crate::index::Index,
    file_id: &str,
) -> Result<Vec<SnapshotEntry>, HistoryError> {
    let mut out = Vec::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return Ok(out),
    };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let Some(stem) = name.strip_suffix(".md") else {
            continue;
        };
        let parts: Vec<&str> = stem.split('-').collect();
        if parts.len() != 3 {
            continue;
        }
        let Ok(ts) = chrono::NaiveDateTime::parse_from_str(
            &format!("{}T{}", parts[0], parts[1]),
            "%Y%m%dT%H%M%S",
        ) else {
            continue;
        };
        let Some(ts_utc) = chrono::Local
            .from_local_datetime(&ts)
            .single()
            .map(|d| d.with_timezone(&Utc))
        else {
            continue;
        };
        let hash = parts[2].to_string();
        let milestone = idx
            .snapshot_milestone(file_id, &ts_key(&ts), &hash)
            .unwrap_or(None);
        out.push(SnapshotEntry {
            file_name: name,
            ts,
            ts_utc,
            hash8: hash,
            milestone,
        });
    }
    out.sort_by(|a, b| b.ts.cmp(&a.ts)); // 新→旧
    Ok(out)
}

/// 恢复快照：先把当前内容快照（永不破坏性覆盖），再覆盖主文件（索引定位路径版）。
pub fn restore(
    ws: &crate::workspace::Workspace,
    idx: &crate::index::Index,
    file_id: &str,
    snapshot_file: &str,
) -> Result<(), HistoryError> {
    let meta = idx
        .get_file(file_id)?
        .ok_or_else(|| HistoryError::Parse(format!("文件 {file_id} 不在索引中")))?;
    let main_path = ws.root.join(&meta.path);
    restore_in(
        ws,
        idx,
        file_id,
        &history_dir(ws, file_id),
        snapshot_file,
        &main_path,
    )
}

/// 目录版恢复：快照源目录与覆盖目标显式指定（发布版本复用）。
pub fn restore_in(
    ws: &crate::workspace::Workspace,
    idx: &crate::index::Index,
    file_id: &str,
    dir: &Path,
    snapshot_file: &str,
    overwrite_path: &Path,
) -> Result<(), HistoryError> {
    let snap_content = std::fs::read_to_string(dir.join(snapshot_file))?;
    if overwrite_path.exists() {
        if let Ok(current) = std::fs::read_to_string(overwrite_path) {
            write_snapshot_in(ws, dir, idx, file_id, &current)?;
        }
    }
    atomic_write(overwrite_path, &snap_content)?;
    Ok(())
}

/// 读取某份快照的正文（供前端 diff；快照存完整文件，此处剥掉 frontmatter）。
pub fn read_snapshot_body(
    ws: &crate::workspace::Workspace,
    file_id: &str,
    snapshot_file: &str,
) -> std::io::Result<String> {
    read_snapshot_body_in(ws, &history_dir(ws, file_id), snapshot_file)
}

pub fn read_snapshot_body_in(
    _ws: &crate::workspace::Workspace,
    dir: &Path,
    snapshot_file: &str,
) -> std::io::Result<String> {
    let content = std::fs::read_to_string(dir.join(snapshot_file))?;
    Ok(crate::frontmatter::parse(&content)
        .map(|(_, body)| body)
        .unwrap_or(content))
}

/// 里程碑命名（永久保留标记）。
pub fn set_milestone(
    ws: &crate::workspace::Workspace,
    idx: &crate::index::Index,
    file_id: &str,
    snapshot_file: &str,
    name: &str,
) -> Result<(), HistoryError> {
    set_milestone_in(ws, idx, file_id, &history_dir(ws, file_id), snapshot_file, name)
}

pub fn set_milestone_in(
    ws: &crate::workspace::Workspace,
    idx: &crate::index::Index,
    file_id: &str,
    dir: &Path,
    snapshot_file: &str,
    name: &str,
) -> Result<(), HistoryError> {
    let snaps = list_snapshots_in(ws, dir, idx, file_id)?;
    let Some(s) = snaps.iter().find(|s| s.file_name == snapshot_file) else {
        return Err(HistoryError::Parse(format!("快照不存在: {snapshot_file}")));
    };
    idx.set_snapshot_milestone(file_id, &ts_key(&s.ts), &s.hash8, name)?;
    Ok(())
}

/// 按保留策略清理所有文件的历史；返回清理数量。
/// 同时覆盖发布版本历史 `publish/{target}.history/`（DESIGN §5.1「与文稿同一机制」）。
pub fn cleanup(
    ws: &crate::workspace::Workspace,
    idx: &crate::index::Index,
    now: &DateTime<Utc>,
    cfg: &RetentionConfig,
) -> Result<usize, HistoryError> {
    let versions = ws.root.join(".versions");
    let mut removed = 0;
    let entries = match std::fs::read_dir(&versions) {
        Ok(e) => e,
        Err(_) => return Ok(0),
    };
    for entry in entries.flatten() {
        let base_id = entry.file_name().to_string_lossy().into_owned();
        if !entry.path().is_dir() {
            continue;
        }
        // 待清理的 (历史目录, 记录用 file_id)：文稿 .history + 各发布版本 {target}.history
        let mut jobs: Vec<(PathBuf, String)> = vec![(history_dir(ws, &base_id), base_id.clone())];
        let publish_dir = versions.join(&base_id).join("publish");
        if let Ok(rd) = std::fs::read_dir(&publish_dir) {
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().into_owned();
                if !name.ends_with(".history") || !e.path().is_dir() {
                    continue;
                }
                // 里程碑按 (file_id, ts, hash) 记录：file_id 必须用版本自身 UUID
                // （从兄弟版本文件的 frontmatter 取；取不到时退回 base_id，里程碑查询将失配）
                let sibling = publish_dir.join(name.trim_end_matches(".history").to_string() + ".md");
                let version_id = std::fs::read_to_string(&sibling)
                    .ok()
                    .and_then(|c| crate::publish::parse(&c).ok())
                    .map(|(fm, _)| fm.id.to_string())
                    .unwrap_or_else(|| base_id.clone());
                jobs.push((e.path(), version_id));
            }
        }
        for (dir, file_id) in jobs {
            let snaps = list_snapshots_in(ws, &dir, idx, &file_id)?;
            let metas: Vec<SnapshotMeta> = snaps
                .iter()
                .map(|s| SnapshotMeta {
                    ts: s.ts_utc,
                    hash8: s.hash8.clone(),
                    milestone: s.milestone.clone(),
                })
                .collect();
            let keep = plan_retention(&metas, now, cfg);
            for s in &snaps {
                if !keep.contains(&s.ts_utc) {
                    let _ = std::fs::remove_file(dir.join(&s.file_name));
                    let _ = idx.delete_snapshot(&file_id, &ts_key(&s.ts), &s.hash8);
                    removed += 1;
                }
            }
        }
    }
    Ok(removed)
}

/// 回收站到期清理（30 天）：删文件 + 连带删 .versions/{id}/ 整目录 + 索引行
/// （DESIGN-REVIEW 二轮 13）。返回清理数量。
pub fn purge_trash(
    ws: &crate::workspace::Workspace,
    idx: &crate::index::Index,
    now: &DateTime<Utc>,
) -> Result<usize, HistoryError> {
    let metas = idx.list_by_kind("post", true)?;
    let mut purged = 0;
    for m in metas {
        let Some(deleted_at) = &m.deleted_at else {
            continue;
        };
        let Ok(dt) = chrono::NaiveDateTime::parse_from_str(deleted_at, "%Y-%m-%dT%H:%M:%S") else {
            continue;
        };
        let Some(local) = chrono::Local.from_local_datetime(&dt).single() else {
            continue;
        };
        if *now - local.with_timezone(&Utc) <= Duration::days(30) {
            continue;
        }
        let _ = std::fs::remove_file(ws.root.join(&m.path));
        let _ = std::fs::remove_dir_all(versions_dir(ws, &m.id));
        idx.purge_file(&m.id)?;
        purged += 1;
    }
    Ok(purged)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    use crate::index::FileMeta;
    use crate::workspace::Workspace;

    fn snap(days_ago: i64, hour: u32, min: u32, milestone: Option<&str>) -> SnapshotMeta {
        SnapshotMeta {
            ts: Utc
                .with_ymd_and_hms(2026, 8, 18, hour, min, 0)
                .unwrap()
                - Duration::days(days_ago),
            hash8: "abcd1234".into(),
            milestone: milestone.map(String::from),
        }
    }

    #[test]
    fn snapshot_file_name_format() {
        let ts = Utc.with_ymd_and_hms(2026, 8, 18, 1, 5, 3).unwrap();
        let name = snapshot_file_name(ts, "内容X");
        assert!(name.ends_with(&format!("-{}.md", hash8("内容X"))), "{name}");
        let parts: Vec<&str> = name.trim_end_matches(".md").split('-').collect();
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[2].len(), 8);
        assert_eq!(parts[0].len(), 8);
        assert_eq!(parts[1].len(), 6);
    }

    #[test]
    fn retention_keeps_recent_daily_then_weekly_and_milestones() {
        let now = Utc.with_ymd_and_hms(2026, 8, 18, 12, 0, 0).unwrap();
        let recent_1 = snap(0, 9, 0, None);
        let recent_2 = snap(0, 10, 0, None);
        let day_old = snap(3, 9, 0, None);
        let day_new = snap(3, 15, 0, None);
        let mid = snap(10, 9, 0, None);
        let w1 = snap(40, 9, 0, None);
        let w2 = snap(41, 9, 0, None);
        let w3 = snap(47, 9, 0, None);
        let milestone = snap(60, 9, 0, Some("交稿版"));
        let snaps = vec![
            recent_1.clone(),
            recent_2.clone(),
            day_old.clone(),
            day_new.clone(),
            mid.clone(),
            w1.clone(),
            w2.clone(),
            w3.clone(),
            milestone.clone(),
        ];
        let keep = plan_retention(&snaps, &now, &RetentionConfig::default());

        assert!(keep.contains(&recent_1.ts) && keep.contains(&recent_2.ts));
        assert!(!keep.contains(&day_old.ts));
        assert!(keep.contains(&day_new.ts));
        assert!(keep.contains(&mid.ts));
        assert!(keep.contains(&milestone.ts));
        let weekly_kept = [&w1, &w2, &w3].iter().filter(|s| keep.contains(&s.ts)).count();
        assert!(weekly_kept >= 1 && weekly_kept <= 3);
    }

    #[test]
    fn same_day_multiple_snaps_keep_latest_only() {
        let now = Utc.with_ymd_and_hms(2026, 8, 18, 12, 0, 0).unwrap();
        // 用 1/2 点（本地同日，不跨 UTC+8 时区换算出的本地日期）
        let a = snap(5, 1, 0, None);
        let b = snap(5, 2, 0, None);
        let keep = plan_retention(&[a.clone(), b.clone()], &now, &RetentionConfig::default());
        assert!(!keep.contains(&a.ts));
        assert!(keep.contains(&b.ts));
    }

    #[test]
    fn material_change_ignores_whitespace_only_tail() {
        assert!(!is_material_change("a\n\n", "a"));
        assert!(is_material_change("a", "ab"));
    }

    // ───── IO 测试 ─────

    fn setup() -> (tempfile::TempDir, Workspace, crate::index::Index) {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::init(dir.path()).unwrap();
        let idx = crate::index::Index::open_in_memory().unwrap();
        (dir, ws, idx)
    }

    fn indexed_post(ws: &Workspace, idx: &crate::index::Index, id: &str, path: &str, content: &str) {
        let p = ws.root.join(path);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, content).unwrap();
        idx.upsert_file(
            &FileMeta {
                id: id.into(),
                kind: "post".into(),
                path: path.into(),
                title: "T".into(),
                folder: None,
                status: "draft".into(),
                tags: "[]".into(),
                created_at: String::new(),
                updated_at: String::new(),
                deleted_at: None,
                hash: String::new(),
                missing: false,
            },
            content,
        )
        .unwrap();
    }

    #[test]
    fn snapshot_written_only_on_material_change() {
        let (_dir, ws, idx) = setup();
        indexed_post(&ws, &idx, "id-1", "posts/a.md", "v1");
        assert!(maybe_snapshot(&ws, &idx, "id-1", "v1", "v1").unwrap().is_none());
        assert!(maybe_snapshot(&ws, &idx, "id-1", "v1", "v1\n\n").unwrap().is_none());
        let s = maybe_snapshot(&ws, &idx, "id-1", "v1", "v2").unwrap();
        assert!(s.is_some());
        assert_eq!(list_snapshots(&ws, &idx, "id-1").unwrap().len(), 1);
        assert!(maybe_snapshot(&ws, &idx, "id-1", "v2", "v3").unwrap().is_some());
        assert_eq!(list_snapshots(&ws, &idx, "id-1").unwrap().len(), 2);
    }

    #[test]
    fn restore_is_non_destructive() {
        let (_dir, ws, idx) = setup();
        indexed_post(&ws, &idx, "id-1", "posts/a.md", "v1");
        maybe_snapshot(&ws, &idx, "id-1", "", "v1").unwrap(); // v1 快照
        std::fs::write(ws.root.join("posts/a.md"), "v2").unwrap();
        maybe_snapshot(&ws, &idx, "id-1", "v1", "v2").unwrap(); // v2 快照
        std::fs::write(ws.root.join("posts/a.md"), "v3").unwrap(); // 未快照的当前态

        let v1_snap = list_snapshots(&ws, &idx, "id-1")
            .unwrap()
            .into_iter()
            .find(|s| s.hash8 == hash8("v1"))
            .unwrap();
        restore(&ws, &idx, "id-1", &v1_snap.file_name).unwrap();

        assert_eq!(std::fs::read_to_string(ws.root.join("posts/a.md")).unwrap(), "v1");
        // 恢复前 v3 被抢救为新快照：历史 3 份（v1、v2、v3）
        assert_eq!(list_snapshots(&ws, &idx, "id-1").unwrap().len(), 3);
    }

    #[test]
    fn cleanup_removes_non_kept_and_milestone_survives() {
        let (_dir, ws, idx) = setup();
        indexed_post(&ws, &idx, "id-1", "posts/a.md", "x");
        let dir = history_dir(&ws, "id-1");
        std::fs::create_dir_all(&dir).unwrap();
        // 造旧快照：同一天两份（旧的应被清理）+ 一份更早的里程碑
        std::fs::write(dir.join("20260610-080000-aaaa1111.md"), "old-day").unwrap();
        std::fs::write(dir.join("20260610-200000-bbbb2222.md"), "new-day").unwrap();
        std::fs::write(dir.join("20260501-080000-cccc3333.md"), "milestone-body").unwrap();
        set_milestone(&ws, &idx, "id-1", "20260501-080000-cccc3333.md", "初稿").unwrap();

        let now = Utc::now();
        let removed = cleanup(&ws, &idx, &now, &RetentionConfig::default()).unwrap();
        assert!(removed >= 1);
        let left = list_snapshots(&ws, &idx, "id-1").unwrap();
        // 断言以文件名中的 hash 段为准（list_snapshots 从文件名解析）
        assert!(left.iter().any(|s| s.milestone.as_deref() == Some("初稿")));
        assert!(!left.iter().any(|s| s.hash8 == "aaaa1111")); // 同周旧份被清
        assert!(left.iter().any(|s| s.hash8 == "bbbb2222")); // 同周最新保留
    }

    #[test]
    fn trash_purge_after_30_days_removes_versions_dir() {
        let (_dir, ws, idx) = setup();
        let dt = (chrono::Local::now() - Duration::days(31))
            .format("%Y-%m-%dT%H:%M:%S")
            .to_string();
        indexed_post(&ws, &idx, "id-1", "posts/.trash/a.md", "deleted");
        let mut m = idx.get_file("id-1").unwrap().unwrap();
        m.deleted_at = Some(dt);
        idx.upsert_file(&m, "deleted").unwrap();
        // 历史目录存在
        std::fs::create_dir_all(history_dir(&ws, "id-1")).unwrap();
        std::fs::write(history_dir(&ws, "id-1").join("20260801-080000-dddd4444.md"), "s").unwrap();

        let now = Utc::now();
        assert_eq!(purge_trash(&ws, &idx, &now).unwrap(), 1);
        assert!(!ws.root.join("posts/.trash/a.md").exists());
        assert!(!versions_dir(&ws, "id-1").exists());
        assert!(idx.get_file("id-1").unwrap().is_none());
    }

    #[test]
    fn history_list_survives_index_loss() {
        let (_dir, ws, idx) = setup();
        indexed_post(&ws, &idx, "id-1", "posts/a.md", "x");
        maybe_snapshot(&ws, &idx, "id-1", "", "x").unwrap();
        maybe_snapshot(&ws, &idx, "id-1", "x", "y").unwrap();
        let before = list_snapshots(&ws, &idx, "id-1").unwrap().len();
        assert_eq!(before, 2);
        // index.db 丢失重建后，列表仍完整（磁盘为准）
        let fresh = crate::index::Index::open_in_memory().unwrap();
        assert_eq!(list_snapshots(&ws, &fresh, "id-1").unwrap().len(), before);
    }

    #[test]
    fn snapshot_in_custom_dir() {
        let (_dir, ws, idx) = setup();
        let dir = ws.root.join(".versions").join("id-1").join("publish").join("wechat.history");
        write_snapshot_in(&ws, &dir, &idx, "vid-1", "版本内容 v1").unwrap();
        write_snapshot_in(&ws, &dir, &idx, "vid-1", "版本内容 v2").unwrap();
        let snaps = list_snapshots_in(&ws, &dir, &idx, "vid-1").unwrap();
        assert_eq!(snaps.len(), 2);
        // 同秒快照不依赖排序：按正文内容断言
        let bodies: Vec<String> = snaps
            .iter()
            .map(|s| read_snapshot_body_in(&ws, &dir, &s.file_name).unwrap())
            .collect();
        assert!(bodies.contains(&"版本内容 v1".to_string()));
        assert!(bodies.contains(&"版本内容 v2".to_string()));
    }

    #[test]
    fn cleanup_also_sweeps_publish_history() {
        let (_dir, ws, idx) = setup();
        indexed_post(&ws, &idx, "id-1", "posts/a.md", "x");
        // 版本文件（frontmatter 提供版本 UUID，里程碑键用它）
        let vfm = crate::publish::PublishFrontmatter::new("id-1", "wechat", "公众号版");
        let publish_dir = ws.root.join(".versions").join("id-1").join("publish");
        std::fs::create_dir_all(&publish_dir).unwrap();
        std::fs::write(publish_dir.join("wechat.md"), vfm.to_content("正文")).unwrap();
        let vdir = publish_dir.join("wechat.history");
        std::fs::create_dir_all(&vdir).unwrap();
        // 旧快照两份（同周：留最新）+ 一份里程碑
        std::fs::write(vdir.join("20260610-080000-aaaa1111.md"), "old").unwrap();
        std::fs::write(vdir.join("20260610-200000-bbbb2222.md"), "new").unwrap();
        std::fs::write(vdir.join("20260501-080000-cccc3333.md"), "milestone").unwrap();
        set_milestone_in(&ws, &idx, &vfm.id.to_string(), &vdir, "20260501-080000-cccc3333.md", "定稿").unwrap();

        let now = Utc::now();
        cleanup(&ws, &idx, &now, &RetentionConfig::default()).unwrap();
        let left = list_snapshots_in(&ws, &vdir, &idx, &vfm.id.to_string()).unwrap();
        assert!(!left.iter().any(|s| s.hash8 == "aaaa1111"), "同周旧份应被清理");
        assert!(left.iter().any(|s| s.hash8 == "bbbb2222"));
        assert!(left.iter().any(|s| s.milestone.as_deref() == Some("定稿")), "里程碑永留");
    }
}
