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

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Scope {
    Posts,
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
        Ok(())
    }
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
}
