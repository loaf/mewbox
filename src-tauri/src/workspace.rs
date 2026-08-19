use std::fs;
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use fs2::FileExt;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("工作区正被另一个实例使用")]
    WorkspaceInUse,
}

/// 工作区：自包含的目录结构 + 单实例排他锁（DESIGN §3.1）。
#[derive(Debug)]
pub struct Workspace {
    pub root: PathBuf,
    lock_file: Option<fs::File>,
}

impl Workspace {
    /// 初始化（或打开已存在的）工作区；幂等。
    pub fn init(root: &Path) -> Result<Self, Error> {
        fs::create_dir_all(root)?;
        for d in [
            "posts/.trash",
            "kb/Inbox",
            "kb/.trash",
            "_assets",
            ".versions",
            ".index",
        ] {
            fs::create_dir_all(root.join(d))?;
        }
        let card = root.join("workspace.json");
        if !card.exists() {
            fs::write(
                &card,
                serde_json::json!({
                    "schema_version": 1,
                    "app": "MewBox",
                    "created_at": chrono::Utc::now().to_rfc3339()
                })
                .to_string(),
            )?;
        }
        let config = root.join("config.toml");
        if !config.exists() {
            fs::write(&config, "# MewBox config\n")?;
        }
        let lock = Self::acquire_lock(root)?;
        Ok(Self {
            root: root.to_path_buf(),
            lock_file: Some(lock),
        })
    }

    fn acquire_lock(root: &Path) -> Result<fs::File, Error> {
        let mut f = fs::OpenOptions::new()
            .create(true)
            .write(true)
            .open(root.join("workspace.lock"))?;
        // 非阻塞排他锁：第二实例（含本进程另一句柄）try_lock 失败 → WorkspaceInUse
        f.try_lock_exclusive().map_err(|_| Error::WorkspaceInUse)?;
        // pid 必须经同一句柄写入：Windows 下另一句柄写锁定区域会得到锁冲突
        f.set_len(0)?;
        f.seek(SeekFrom::Start(0))?;
        f.write_all(format!("pid={}\n", std::process::id()).as_bytes())?;
        Ok(f)
    }

    pub fn release_lock(&mut self) -> bool {
        if let Some(f) = self.lock_file.take() {
            let _ = f.unlock();
            true
        } else {
            false
        }
    }
}

/// 共享句柄克隆：排他锁仍由原始实例持有（M4：AI 异步任务需要 'static 工作区访问）。
impl Clone for Workspace {
    fn clone(&self) -> Self {
        Self { root: self.root.clone(), lock_file: None }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn init_creates_full_skeleton() {
        let dir = tempdir().unwrap();
        let ws = Workspace::init(dir.path()).unwrap();
        for p in [
            "workspace.json",
            "config.toml",
            "workspace.lock",
            "posts",
            "posts/.trash",
            "kb",
            "kb/Inbox",
            "kb/.trash",
            "_assets",
            ".versions",
            ".index",
        ] {
            assert!(dir.path().join(p).exists(), "missing {p}");
        }
        let card: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.path().join("workspace.json")).unwrap())
                .unwrap();
        assert_eq!(card["schema_version"], 1);
        assert!(card["created_at"].as_str().is_some());
        assert!(ws.root.ends_with(dir.path()));
    }

    #[test]
    fn init_is_idempotent() {
        let dir = tempdir().unwrap();
        Workspace::init(dir.path()).unwrap();
        // 第一个 Workspace 已 drop（锁随之释放），二次 init 不报错、不重置
        Workspace::init(dir.path()).unwrap();
        let card: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.path().join("workspace.json")).unwrap())
                .unwrap();
        assert!(card["created_at"].as_str().is_some());
    }

    #[test]
    fn lock_conflicts_across_files() {
        let dir = tempdir().unwrap();
        let mut a = Workspace::init(dir.path()).unwrap();
        let err = Workspace::init(dir.path()).unwrap_err();
        assert!(matches!(err, Error::WorkspaceInUse));
        a.release_lock();
        let _b = Workspace::init(dir.path()).unwrap();
    }
}
