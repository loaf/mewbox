use std::path::Path;

use once_cell::sync::Lazy;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

static JIEBA: Lazy<jieba_rs::Jieba> = Lazy::new(jieba_rs::Jieba::new);

/// 写入时预分词（DESIGN §9）：jieba 切词后空格连接，交给 FTS5 默认分词器。
pub fn tokenize(text: &str) -> String {
    JIEBA.cut(text, true).join(" ")
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMeta {
    pub id: String,
    pub kind: String, // "post"（kb/publish 随后续里程碑）
    pub path: String, // 工作区相对路径，/ 分隔
    pub title: String,
    pub folder: Option<String>,
    pub status: String,
    pub tags: String, // JSON 数组字符串
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
    pub hash: String,
    pub missing: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub id: String,
    pub path: String,
    pub title: String,
}

/// 链接图边（缓存性质，从磁盘全量重建）：kind ∈ wiki|assoc。
#[derive(Debug, Clone, Serialize)]
pub struct LinkRow {
    pub from_id: String,
    pub to_id: Option<String>,
    pub raw_title: String,
    pub kind: String,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Scope {
    Posts,
    Materials,
}

pub struct Index {
    conn: Connection,
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS files(
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  folder TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  tags TEXT NOT NULL DEFAULT '[]',
  created_at TEXT,
  updated_at TEXT,
  deleted_at TEXT,
  hash TEXT,
  missing INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS snapshots(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  hash TEXT NOT NULL,
  milestone TEXT
);
CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
  title_tokens, body_tokens, content='', contentless_delete=1
);
CREATE TABLE IF NOT EXISTS fts_map(file_id TEXT PRIMARY KEY, fts_rowid INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS links(
  from_id TEXT NOT NULL,
  to_id TEXT,
  raw_title TEXT NOT NULL,
  kind TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_links_to ON links(to_id);
CREATE TABLE IF NOT EXISTS ai_calls(
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  op TEXT NOT NULL,
  target_ids TEXT NOT NULL DEFAULT '[]',
  model TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT '',
  prompt_digest TEXT NOT NULL DEFAULT '',
  note TEXT,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  outcome TEXT NOT NULL DEFAULT 'preview'
);
CREATE INDEX IF NOT EXISTS idx_ai_calls_ts ON ai_calls(ts);
"#;

impl Index {
    pub fn open_in_memory() -> Result<Self, Error> {
        let conn = Connection::open_in_memory()?;
        Self::init(conn)
    }

    pub fn open(path: &Path) -> Result<Self, Error> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
        let _ = conn.pragma_update(None, "journal_mode", "WAL");
        Self::init(conn)
    }

    fn init(conn: Connection) -> Result<Self, Error> {
        conn.execute_batch(SCHEMA)?;
        conn.execute(
            "INSERT OR IGNORE INTO meta(key, value) VALUES('schema_version', '1')",
            [],
        )?;
        Ok(Self { conn })
    }

    /// 写入/更新文件元数据与全文索引（FTS 行更新 = DELETE + INSERT）。
    pub fn upsert_file(&self, m: &FileMeta, body: &str) -> Result<(), Error> {
        self.conn.execute(
            "INSERT INTO files(id, kind, path, title, folder, status, tags, created_at, updated_at, deleted_at, hash, missing)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
             ON CONFLICT(id) DO UPDATE SET
               kind=?2, path=?3, title=?4, folder=?5, status=?6, tags=?7,
               created_at=?8, updated_at=?9, deleted_at=?10, hash=?11, missing=?12",
            params![m.id, m.kind, m.path, m.title, m.folder, m.status, m.tags,
                    m.created_at, m.updated_at, m.deleted_at, m.hash, m.missing as i64],
        )?;
        self.reindex_fts(&m.id, &m.title, body)
    }

    fn reindex_fts(&self, file_id: &str, title: &str, body: &str) -> Result<(), Error> {
        let old_rowid: Option<i64> = self
            .conn
            .query_row("SELECT fts_rowid FROM fts_map WHERE file_id=?1", [file_id], |r| {
                r.get(0)
            })
            .map(Some)
            .or_else(|e| if e == rusqlite::Error::QueryReturnedNoRows { Ok(None) } else { Err(e) })?;
        if let Some(rowid) = old_rowid {
            self.conn.execute("DELETE FROM files_fts WHERE rowid=?1", [rowid])?;
        }
        self.conn.execute(
            "INSERT INTO files_fts(title_tokens, body_tokens) VALUES(?1, ?2)",
            params![tokenize(title), tokenize(body)],
        )?;
        let rowid = self.conn.last_insert_rowid();
        self.conn.execute(
            "INSERT INTO fts_map(file_id, fts_rowid) VALUES(?1, ?2)
             ON CONFLICT(file_id) DO UPDATE SET fts_rowid=?2",
            params![file_id, rowid],
        )?;
        Ok(())
    }

    /// 检索：查询词同样经 jieba 分词，OR 连接的引号短语；回收站排除。
    pub fn search(&self, query: &str, scope: Scope) -> Result<Vec<SearchHit>, Error> {
        let tokens: Vec<String> = JIEBA
            .cut(query, true)
            .into_iter()
            .filter(|t| !t.trim().is_empty())
            .map(|t| t.to_string())
            .collect();
        if tokens.is_empty() {
            return Ok(vec![]);
        }
        let match_expr = tokens
            .iter()
            .map(|t| format!("\"{}\"", t.replace('"', " ")))
            .collect::<Vec<_>>()
            .join(" OR ");
        let kind = match scope {
            Scope::Posts => "post",
            Scope::Materials => "material",
        };
        let mut stmt = self.conn.prepare(
            "WITH hits AS (SELECT rowid, rank FROM files_fts WHERE files_fts MATCH ?1)
             SELECT f.id, f.path, f.title FROM hits h
             JOIN fts_map m ON m.fts_rowid = h.rowid
             JOIN files f ON f.id = m.file_id
             WHERE f.kind = ?2 AND f.deleted_at IS NULL AND f.missing = 0
             ORDER BY h.rank",
        )?;
        let rows = stmt.query_map(params![match_expr, kind], |r| {
            Ok(SearchHit {
                id: r.get(0)?,
                path: r.get(1)?,
                title: r.get(2)?,
            })
        })?;
        let mut hits = Vec::new();
        for h in rows {
            hits.push(h?);
        }
        Ok(hits)
    }

    pub fn get_file(&self, id: &str) -> Result<Option<FileMeta>, Error> {
        let res = self.conn.query_row("SELECT * FROM files WHERE id=?1", [id], row_to_meta);
        match res {
            Ok(m) => Ok(Some(m)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    pub fn list_by_kind(&self, kind: &str, include_deleted: bool) -> Result<Vec<FileMeta>, Error> {
        let sql = if include_deleted {
            "SELECT * FROM files WHERE kind=?1 ORDER BY updated_at DESC"
        } else {
            "SELECT * FROM files WHERE kind=?1 AND deleted_at IS NULL ORDER BY updated_at DESC"
        };
        let mut stmt = self.conn.prepare(sql)?;
        let rows = stmt.query_map([kind], row_to_meta)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// 全量重建（索引只是可重建缓存，DESIGN 原则 3）。
    pub fn rebuild_from(&self, files: &[(FileMeta, String)]) -> Result<(), Error> {
        self.conn.execute("DELETE FROM files", [])?;
        self.conn.execute("DELETE FROM fts_map", [])?;
        self.conn.execute("DELETE FROM files_fts", [])?;
        for (m, body) in files {
            self.upsert_file(m, body)?;
        }
        Ok(())
    }

    pub fn record_snapshot(&self, file_id: &str, ts: &str, hash: &str) -> Result<(), Error> {
        self.conn.execute(
            "INSERT OR IGNORE INTO snapshots(file_id, ts, hash) VALUES(?1, ?2, ?3)",
            params![file_id, ts, hash],
        )?;
        Ok(())
    }

    pub fn snapshot_milestone(
        &self,
        file_id: &str,
        ts: &str,
        hash: &str,
    ) -> Result<Option<String>, Error> {
        let res = self.conn.query_row(
            "SELECT milestone FROM snapshots WHERE file_id=?1 AND ts=?2 AND hash=?3 AND milestone IS NOT NULL",
            params![file_id, ts, hash],
            |r| r.get(0),
        );
        match res {
            Ok(name) => Ok(Some(name)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    pub fn set_snapshot_milestone(
        &self,
        file_id: &str,
        ts: &str,
        hash: &str,
        name: &str,
    ) -> Result<(), Error> {
        // 以 (file_id, ts, hash) 为准维护：先删同键旧记录再插入
        self.conn.execute(
            "DELETE FROM snapshots WHERE file_id=?1 AND ts=?2 AND hash=?3",
            params![file_id, ts, hash],
        )?;
        self.conn.execute(
            "INSERT INTO snapshots(file_id, ts, hash, milestone) VALUES(?1,?2,?3,?4)",
            params![file_id, ts, hash, name],
        )?;
        Ok(())
    }

    pub fn delete_snapshot(&self, file_id: &str, ts: &str, hash: &str) -> Result<(), Error> {
        self.conn.execute(
            "DELETE FROM snapshots WHERE file_id=?1 AND ts=?2 AND hash=?3",
            params![file_id, ts, hash],
        )?;
        Ok(())
    }

    pub fn set_missing(&self, id: &str, missing: bool) -> Result<(), Error> {
        self.conn.execute(
            "UPDATE files SET missing=?2 WHERE id=?1",
            params![id, missing as i64],
        )?;
        Ok(())
    }

    /// 彻底移除文件记录（含 FTS）。回收站 30 天清理时调用。
    pub fn purge_file(&self, id: &str) -> Result<(), Error> {
        self.conn.execute("DELETE FROM files WHERE id=?1", [id])?;
        if let Ok(rowid) = self
            .conn
            .query_row("SELECT fts_rowid FROM fts_map WHERE file_id=?1", [id], |r| {
                r.get::<_, i64>(0)
            })
        {
            self.conn.execute("DELETE FROM files_fts WHERE rowid=?1", [rowid])?;
        }
        self.conn.execute("DELETE FROM fts_map WHERE file_id=?1", [id])?;
        self.conn.execute("DELETE FROM snapshots WHERE file_id=?1", [id])?;
        self.conn.execute("DELETE FROM links WHERE from_id=?1 OR to_id=?1", [id])?;
        Ok(())
    }

    /// 链接图全量替换（磁盘为准，机制决策 6）。
    pub fn replace_links(&self, rows: &[LinkRow]) -> Result<(), Error> {
        self.conn.execute("DELETE FROM links", [])?;
        {
            let mut stmt = self
                .conn
                .prepare("INSERT INTO links(from_id, to_id, raw_title, kind) VALUES(?1,?2,?3,?4)")?;
            for r in rows {
                stmt.execute(params![r.from_id, r.to_id, r.raw_title, r.kind])?;
            }
        }
        Ok(())
    }

    /// 某文件的反向链接（链接图缓存查询）。
    pub fn links_to(&self, id: &str) -> Result<Vec<LinkRow>, Error> {
        let mut stmt = self
            .conn
            .prepare("SELECT from_id, to_id, raw_title, kind FROM links WHERE to_id=?1")?;
        let rows = stmt.query_map([id], |r| {
            Ok(LinkRow {
                from_id: r.get(0)?,
                to_id: r.get(1)?,
                raw_title: r.get(2)?,
                kind: r.get(3)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    // ───── AI 留痕与用量（DESIGN §8.5，M4 T4）─────

    /// 每次 AI 调用入账（留痕仅审计，不作上下文）。outcome 初值 preview。
    pub fn record_ai_call(&self, c: &AiCall) -> Result<(), Error> {
        self.conn.execute(
            "INSERT OR REPLACE INTO ai_calls(id, ts, op, target_ids, model, provider, prompt_digest, note, tokens_in, tokens_out, duration_ms, outcome)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
            params![
                c.id, c.ts, c.op, c.target_ids, c.model, c.provider, c.prompt_digest,
                c.note, c.tokens_in as i64, c.tokens_out as i64, c.duration_ms as i64, c.outcome
            ],
        )?;
        Ok(())
    }

    /// 结果去向更新（preview → adopted|discarded|saved|cancelled|error）。
    /// 仅当当前仍是 preview 才生效（终态不可逆，防止取消竞态覆盖去向）。
    pub fn update_ai_outcome(&self, id: &str, outcome: &str, note: Option<&str>) -> Result<(), Error> {
        self.conn.execute(
            "UPDATE ai_calls SET outcome=?2, note=COALESCE(?3, note) WHERE id=?1 AND outcome='preview'",
            params![id, outcome, note],
        )?;
        Ok(())
    }

    /// 一键清空留痕（§8.5）。
    pub fn clear_ai_calls(&self) -> Result<(), Error> {
        self.conn.execute("DELETE FROM ai_calls", [])?;
        Ok(())
    }

    /// 某日前缀（"2026-08-19"）内的已花费美分（按 provider 单价，Ollama 恒 0）。
    pub fn ai_cents_since(
        &self,
        ts_prefix: &str,
        prices: &std::collections::HashMap<String, (u64, u64)>,
    ) -> Result<u64, Error> {
        let mut stmt = self.conn.prepare(
            "SELECT provider, tokens_in, tokens_out FROM ai_calls WHERE ts LIKE ?1 || '%'",
        )?;
        let rows = stmt.query_map([ts_prefix], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?))
        })?;
        let mut cents = 0u64;
        for row in rows {
            let (provider, tin, tout) = row?;
            let (pin, pout) = prices.get(&provider).copied().unwrap_or((0, 0));
            cents += cents_of(tin.max(0) as u64, tout.max(0) as u64, pin, pout);
        }
        Ok(cents)
    }

    /// 用量聚合（period：日/月），按 周期/操作/模型/provider 分组，美分按单价折算。
    pub fn usage_stats(
        &self,
        month_scope: bool,
        prices: &std::collections::HashMap<String, (u64, u64)>,
    ) -> Result<Vec<UsageRow>, Error> {
        let n = if month_scope { 7 } else { 10 };
        let mut stmt = self.conn.prepare(
            "SELECT substr(ts,1,?1), op, model, provider, SUM(tokens_in), SUM(tokens_out), COUNT(*)
             FROM ai_calls GROUP BY substr(ts,1,?1), op, model, provider ORDER BY substr(ts,1,?1) DESC, COUNT(*) DESC",
        )?;
        let rows = stmt.query_map([n], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, i64>(5)?,
                r.get::<_, i64>(6)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (period_key, op, model, provider, tin, tout, calls) = row?;
            let (pin, pout) = prices.get(&provider).copied().unwrap_or((0, 0));
            out.push(UsageRow {
                period_key,
                op,
                model,
                provider,
                tokens_in: tin.max(0) as u64,
                tokens_out: tout.max(0) as u64,
                cents: cents_of(tin.max(0) as u64, tout.max(0) as u64, pin, pout),
                calls: calls.max(0) as u64,
            });
        }
        Ok(out)
    }
}

/// 美分 = tokens_in/1000*in_price + tokens_out/1000*out_price（整数、向下取整，修订决策 6）。
pub fn cents_of(tokens_in: u64, tokens_out: u64, price_in: u64, price_out: u64) -> u64 {
    tokens_in * price_in / 1000 + tokens_out * price_out / 1000
}

/// 一次 AI 调用的留痕行。
#[derive(Debug, Clone)]
pub struct AiCall {
    pub id: String,
    /// 本地时间 "YYYY-MM-DDTHH:MM:SS"（可注入，跨日聚合测试用）
    pub ts: String,
    pub op: String,
    /// JSON 数组字符串
    pub target_ids: String,
    pub model: String,
    pub provider: String,
    pub prompt_digest: String,
    pub note: Option<String>,
    pub tokens_in: u64,
    pub tokens_out: u64,
    pub duration_ms: u64,
    /// preview|adopted|discarded|saved|cancelled|error
    pub outcome: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageRow {
    pub period_key: String,
    pub op: String,
    pub model: String,
    pub provider: String,
    pub tokens_in: u64,
    pub tokens_out: u64,
    pub cents: u64,
    pub calls: u64,
}

fn row_to_meta(r: &rusqlite::Row<'_>) -> rusqlite::Result<FileMeta> {
    Ok(FileMeta {
        id: r.get("id")?,
        kind: r.get("kind")?,
        path: r.get("path")?,
        title: r.get("title")?,
        folder: r.get("folder")?,
        status: r.get("status")?,
        tags: r.get("tags")?,
        created_at: r.get("created_at")?,
        updated_at: r.get("updated_at")?,
        deleted_at: r.get("deleted_at")?,
        hash: r.get("hash")?,
        missing: r.get::<_, i64>("missing")? != 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(id: &str, title: &str, path: &str) -> FileMeta {
        FileMeta {
            id: id.into(),
            kind: "post".into(),
            path: path.into(),
            title: title.into(),
            folder: Some("技术".into()),
            status: "draft".into(),
            tags: "[]".into(),
            created_at: "2026-08-18T10:00:00".into(),
            updated_at: "2026-08-18T10:00:00".into(),
            deleted_at: None,
            hash: format!("h-{id}"),
            missing: false,
        }
    }

    fn db_with_two_posts() -> Index {
        let idx = Index::open_in_memory().unwrap();
        idx.upsert_file(
            &meta("id-1", "深度工作实践记", "posts/a.md"),
            "注意力残留 attention residue 影响深度工作",
        )
        .unwrap();
        idx.upsert_file(
            &meta("id-2", "Weekly Review", "posts/b.md"),
            "weekly review 反思",
        )
        .unwrap();
        idx
    }

    #[test]
    fn fts5_available_in_bundled_sqlite() {
        // 建表含 fts5 virtual table（SCHEMA），打开成功即 FTS5 可用
        let idx = Index::open_in_memory().unwrap();
        let n: i64 = idx
            .conn
            .query_row("SELECT count(*) FROM files_fts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn chinese_fts_hits_title_and_body() {
        let idx = db_with_two_posts();
        assert_eq!(idx.search("注意力", Scope::Posts).unwrap()[0].id, "id-1");
        let hits = idx.search("深度工作", Scope::Posts).unwrap();
        assert!(hits.iter().any(|h| h.id == "id-1"), "标题命中: {hits:?}");
    }

    #[test]
    fn mixed_zh_en_query_matches() {
        let idx = db_with_two_posts();
        let hits = idx.search("attention residue", Scope::Posts).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "id-1");
    }

    #[test]
    fn update_reindexes_and_soft_delete_excludes() {
        let idx = db_with_two_posts();
        // 更新正文：旧词不再命中
        idx.upsert_file(
            &meta("id-1", "深度工作实践记", "posts/a.md"),
            "weekly 周报",
        )
        .unwrap();
        assert!(idx.search("注意力", Scope::Posts).unwrap().is_empty());
        assert_eq!(idx.search("周报", Scope::Posts).unwrap().len(), 1);

        // 软删除后不出现在结果
        let mut m = meta("id-2", "Weekly Review", "posts/b.md");
        m.deleted_at = Some("2026-08-18T10:00:00".into());
        idx.upsert_file(&m, "weekly review 反思").unwrap();
        assert!(idx.search("反思", Scope::Posts).unwrap().is_empty());
    }

    #[test]
    fn rebuild_and_purge_roundtrip() {
        let idx = db_with_two_posts();
        idx.rebuild_from(&[(meta("id-1", "深度工作", "posts/a.md"), "正文".to_string())])
            .unwrap();
        assert_eq!(idx.list_by_kind("post", false).unwrap().len(), 1);
        idx.purge_file("id-1").unwrap();
        assert!(idx.list_by_kind("post", false).unwrap().is_empty());
        assert!(idx.search("正文", Scope::Posts).unwrap().is_empty());
    }

    // ───── AI 留痕（M4 T4）─────

    fn call(id: &str, ts: &str, provider: &str, tin: i64, tout: i64) -> AiCall {
        AiCall {
            id: id.into(),
            ts: ts.into(),
            op: "summarize".into(),
            target_ids: r#"["id-1"]"#.into(),
            model: "gpt-x".into(),
            provider: provider.into(),
            prompt_digest: "digest".into(),
            note: None,
            tokens_in: tin as u64,
            tokens_out: tout as u64,
            duration_ms: 1200,
            outcome: "preview".into(),
        }
    }

    fn prices() -> std::collections::HashMap<String, (u64, u64)> {
        [("cloud".to_string(), (10u64, 20u64))].into_iter().collect()
    }

    #[test]
    fn ai_calls_record_outcomes_and_terminal_guard() {
        let idx = Index::open_in_memory().unwrap();
        idx.record_ai_call(&call("c1", "2026-08-19T10:00:00", "cloud", 1000, 500)).unwrap();
        // preview → adopted
        idx.update_ai_outcome("c1", "adopted", Some("采纳 3/5 条")).unwrap();
        // 终态不可逆：adopted 后 cancel 无效
        idx.update_ai_outcome("c1", "cancelled", None).unwrap();
        let outcome: String = idx
            .conn
            .query_row("SELECT outcome FROM ai_calls WHERE id='c1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(outcome, "adopted");
        let note: String = idx
            .conn
            .query_row("SELECT note FROM ai_calls WHERE id='c1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(note, "采纳 3/5 条");
        // 不存在的 id 静默无操作
        idx.update_ai_outcome("ghost", "adopted", None).unwrap();
        // 清空
        idx.clear_ai_calls().unwrap();
        let n: i64 = idx.conn.query_row("SELECT COUNT(*) FROM ai_calls", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn ai_cents_day_and_month_rollover() {
        let idx = Index::open_in_memory().unwrap();
        // 昨天两笔 + 今天一笔（跨日/跨月聚合）
        idx.record_ai_call(&call("a", "2026-07-31T23:00:00", "cloud", 2000, 1000)).unwrap();
        idx.record_ai_call(&call("b", "2026-08-19T09:00:00", "cloud", 1000, 500)).unwrap();
        idx.record_ai_call(&call("c", "2026-08-19T23:59:59", "local", 999999, 999999)).unwrap();
        let day = idx.ai_cents_since("2026-08-19", &prices()).unwrap();
        // 1000*10/1000 + 500*20/1000 = 10 + 10 = 20；local 无价 → 0
        assert_eq!(day, 20);
        let month = idx.ai_cents_since("2026-08", &prices()).unwrap();
        assert_eq!(month, 20);
        let july = idx.ai_cents_since("2026-07", &prices()).unwrap();
        // 2000*10/1000 + 1000*20/1000 = 20 + 20 = 40
        assert_eq!(july, 40);
    }

    #[test]
    fn usage_stats_aggregates_by_period_op_model() {
        let idx = Index::open_in_memory().unwrap();
        idx.record_ai_call(&call("a", "2026-08-18T10:00:00", "cloud", 1000, 500)).unwrap();
        idx.record_ai_call(&call("b", "2026-08-18T11:00:00", "cloud", 1000, 500)).unwrap();
        idx.record_ai_call(&call("c", "2026-08-19T12:00:00", "local", 100, 100)).unwrap();
        let day = idx.usage_stats(false, &prices()).unwrap();
        // 两天两组：19 日（local，0 美分）+ 18 日（cloud 2 次合并）
        assert_eq!(day.len(), 2, "{day:?}");
        let d18 = day.iter().find(|r| r.period_key == "2026-08-18").unwrap();
        assert_eq!(d18.calls, 2);
        assert_eq!(d18.tokens_in, 2000);
        assert_eq!(d18.cents, 40); // 2000*10/1000 + 1000*20/1000 = 20 + 20
        let month = idx.usage_stats(true, &prices()).unwrap();
        // 按 provider 分组计价：cloud（有价）与 local（无价 0）两组
        assert_eq!(month.len(), 2, "{month:?}");
        let m_cloud = month.iter().find(|r| r.provider == "cloud").unwrap();
        assert_eq!(m_cloud.period_key, "2026-08");
        assert_eq!(m_cloud.calls, 2);
        assert_eq!(m_cloud.cents, 40);
    }

    #[test]
    fn search_materials_scope_only_hits_materials() {
        let idx = Index::open_in_memory().unwrap();
        let mut m = meta("id-m", "研究笔记", "kb/Inbox/note.md");
        m.kind = "material".into();
        idx.upsert_file(&m, "独一无二的研究词条").unwrap();
        idx.upsert_file(&meta("id-p", "深度工作实践", "posts/a.md"), "文稿正文").unwrap();
        let hits = idx.search("独一无二", Scope::Materials).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "id-m");
        // OR 分词下 posts 范围不含资料词条
        assert!(idx.search("独一无二", Scope::Posts).unwrap().is_empty());
    }
}
