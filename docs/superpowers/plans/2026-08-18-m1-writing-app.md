# M1「能写作」实施计划

> **For agentic workers:** REQUIRED: 使用 `executing-plans`（或 `subagent-driven-development`）技能执行本计划。步骤使用复选框（`- [ ]`）跟踪。前置阅读：`DESIGN.md` §3/§4/§7.4/§9/§10/§11 与 `2026-08-18-mewbox-roadmap.md`。

**Goal:** 交付「带完整历史与虚拟目录管理的 Markdown 写作应用」——第一个可安装的桌面应用（DESIGN §12 M1）。

**Architecture:** Tauri 2 单进程：Rust 侧承载全部文件/索引/历史逻辑（每个模块先以纯函数 + tempdir 单测落地，Tauri command 只做薄封装）；React 侧三栏布局 + `@uiw/react-md-editor`，状态用 zustand，组件测试 mock `invoke`。

**Tech Stack:** Tauri 2 / React 18 + TypeScript / Tailwind 4 / zustand / @uiw/react-md-editor / rusqlite(bundled, FTS5) / jieba-rs / chrono / sha2 / Vitest + @testing-library/react。

**工作目录：** `X:\proj\myaikl`（下称仓库根）。工作区数据目录（用户文档）运行时才创建；开发调试用 `dev-workspace/`（git 忽略）。

---

## 文件结构（M1 落点）

```
myaikl/
├── index.html  vite.config.ts  tsconfig.json  package.json   ← 前端脚手架
├── src/                          ← React
│   ├── main.tsx  App.tsx
│   ├── styles/theme.css          ← 设计令牌（取自 prototype/css/style.css :root）
│   ├── stores/app.ts             ← zustand：文稿列表/选中/dirty/视图模式
│   ├── lib/
│   │   ├── api.ts                ← invoke 封装（全部 Tauri 命令的类型化入口）
│   │   ├── outline.ts            ← 大纲抽取（纯函数）
│   │   ├── markPlugin.ts         ← ==高亮== remark 插件（纯函数可测）
│   │   └── treeOps.ts            ← 拖拽落点计算等纯函数
│   └── components/
│       ├── AppShell.tsx          ← 三栏骨架 + 左栏区块
│       ├── PostTree.tsx          ← 虚拟目录树（聚合渲染 + 拖拽）
│       ├── NewPostDialog.tsx
│       ├── EditorPane.tsx        ← 编辑器 + 自动保存 + 贴图
│       ├── OutlinePanel.tsx
│       ├── HistoryPanel.tsx      ← 快照列表 + diff + 恢复 + 里程碑
│       └── TrashPanel.tsx
├── src-tauri/
│   ├── Cargo.toml  tauri.conf.json
│   └── src/
│       ├── lib.rs                ← run()：单实例/工作区初始化/命令注册
│       ├── workspace.rs          ← 工作区目录初始化 + workspace.lock
│       ├── frontmatter.rs        ← 解析/序列化（透传未知键）
│       ├── history.rs            ← 快照命名/保留策略/落盘/恢复/清理
│       ├── vfolder.rs            ← 虚拟目录聚合/规范化/改名批处理
│       ├── index.rs              ← SQLite 元数据 + FTS5 + jieba 预分词检索
│       ├── scan.rs               ← posts/ 扫描 + id 重联 + 外部改动报告
│       ├── assets.rs             ← _assets/ 指纹池 + 相对路径
│       ├── state.rs              ← AppState（Workspace + Index 句柄，命令可测的载体）
│       └── commands.rs           ← #[tauri::command] 薄封装
└── docs/superpowers/plans/       ← 本计划所在
```

职责边界：纯逻辑（frontmatter/history 策略/vfolder/分词）不碰 Tauri 类型；`commands.rs` 不含业务逻辑（每函数 ≤ 15 行）；组件只做渲染与调度，可测纯函数全部下沉 `src/lib`。

---

## Chunk 1：后端基石（Rust，任务 0–9）

### Task 0: 仓库与脚手架

**Files:** Create: `.gitignore`, `README.md`，以及 create-tauri-app 生成物（调整标识为 MewBox）。

- [ ] **Step 1: git init 与忽略规则**

```bash
cd /x/proj/myaikl && git init
```

`.gitignore`：

```
node_modules/
dist/
dev-workspace/
src-tauri/target/
src-tauri/gen/schemas/
*.log
```

- [ ] **Step 2: 脚手架（react-ts 模板搬入根目录）**

```bash
cd /x/proj/myaikl && pnpm create tauri-app@latest scaffold --template react-ts --manager pnpm --yes
# 把 scaffold/ 内容移入根目录（保留已存在的 DESIGN.md、docs/、prototype/ 等）：
mv scaffold/* scaffold/.[!.]* . 2>/dev/null; rmdir scaffold
pnpm install
```

`package.json` 修 `name: "mewbox"`；`src-tauri/tauri.conf.json` 修 `productName: "MewBox"`、`identifier: "com.mewbox.app"`、窗口 `title: "喵盒 MewBox"`、`width: 1280, height: 820`。

- [ ] **Step 3: 前端测试与样式基建**

```bash
pnpm add -D vitest jsdom @testing-library/react @testing-library/user-event @testing-library/jest-dom
pnpm add tailwindcss @tailwindcss/vite zustand @uiw/react-md-editor
```

`vite.config.ts`：plugins 加 `tailwindcss()`；test 段 `environment: 'jsdom'`, `globals: true`, `setupFiles: ['./src/test/setup.ts']`。
`src/test/setup.ts`：`import '@testing-library/jest-dom'`。
`src/styles/theme.css`：`@import "tailwindcss";` + 从 `prototype/css/style.css` 抄 `:root` 设计令牌（`--bg/--cream/--card/--line/--ink/--muted/--cat/--cat-dk/--cat-lt/--cat-bg/--box/--green/--red` 与字体变量），`main.tsx` 引入。
`package.json` scripts：`"check": "tsc --noEmit && vitest run"`、`"test": "vitest"`。
（M1 不引入 eslint：类型安全由 tsc 承担，roadmap 工作约定 #3 已按此口径；后续引入时更新 check 脚本。）

- [ ] **Step 4: Rust dev 依赖**

`src-tauri/Cargo.toml` `[dependencies]` 追加：

```toml
serde = { version = "1", features = ["derive"] }
serde_json = "1"
serde_yaml = "0.9"
uuid = { version = "1", features = ["v4"] }
chrono = { version = "0.4", features = ["serde"] }
sha2 = "0.10"
hex = "0.4"
rusqlite = { version = "0.37", features = ["bundled"] }
jieba-rs = "0.7"
walkdir = "2"
pathdiff = "0.2"
fs2 = "0.4"
thiserror = "2"
tauri-plugin-dialog = "2"
tauri-plugin-single-instance = "2"
once_cell = "1"

[dev-dependencies]
tempfile = "3"
```

（jieba-rs 必须保留默认特性 `default-dict`（内嵌词典）——`default-features = false` 会得到空词典实例，中文分词全部失效。）

- [ ] **Step 5: 冒烟验证**

```bash
pnpm check && cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: vitest “No test files found” 不报错退出（0 exit），cargo 0 tests passed。

- [ ] **Step 6: Commit** `chore: scaffold tauri2+react workspace, git init`

### Task 1: 工作区初始化 workspace.rs

**Files:** Create: `src-tauri/src/workspace.rs`；Test: `src-tauri/src/workspace.rs` 内 `#[cfg(test)]`（Rust 单测与实现同文件，模块保持 <300 行）。

- [ ] **Step 1: 失败测试**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn init_creates_full_skeleton() {
        let dir = tempdir().unwrap();
        let ws = Workspace::init(dir.path()).unwrap();
        for p in ["workspace.json", "config.toml", "workspace.lock", "posts", "posts/.trash",
                  "kb", "kb/Inbox", "kb/.trash", "_assets", ".versions", ".index"] {
            assert!(dir.path().join(p).exists(), "missing {p}");
        }
        let card: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.path().join("workspace.json")).unwrap()).unwrap();
        assert_eq!(card["schema_version"], 1);
        assert!(card["created_at"].as_str().is_some());
        assert!(ws.root.ends_with(dir.path()));
    }

    #[test]
    fn init_is_idempotent() {
        let dir = tempdir().unwrap();
        Workspace::init(dir.path()).unwrap();
        Workspace::init(dir.path()).unwrap(); // 不报错、不重置
    }

    #[test]
    fn lock_conflicts_across_files() {
        let dir = tempdir().unwrap();
        let a = Workspace::init(dir.path()).unwrap();
        assert!(a.release_lock());            // 释放后
        let _b = Workspace::init(dir.path()).unwrap(); // 可重新占用
    }
}
```

- [ ] **Step 2: `cargo test workspace` 确认编译失败（模块不存在）**

- [ ] **Step 3: 实现**（要点）

```rust
pub struct Workspace { pub root: PathBuf, lock_file: Option<fs2::File> }

impl Workspace {
    pub fn init(root: &Path) -> Result<Self> {
        std::fs::create_dir_all(root)?;
        for d in ["posts/.trash", "kb/Inbox", "kb/.trash", "_assets", ".versions", ".index"] {
            std::fs::create_dir_all(root.join(d))?;
        }
        let card = root.join("workspace.json");
        if !card.exists() {
            std::fs::write(&card, serde_json::json!({
                "schema_version": 1, "app": "MewBox",
                "created_at": chrono::Utc::now().to_rfc3339()
            }).to_string())?;
        }
        let config = root.join("config.toml");
        if !config.exists() { std::fs::write(&config, "# MewBox config\n")?; }
        let lock = Self::acquire_lock(root)?;
        Ok(Self { root: root.to_path_buf(), lock_file: Some(lock) })
    }
    fn acquire_lock(root: &Path) -> Result<fs2::File> {
        use fs2::FileExt;
        let mut f = std::fs::OpenOptions::new().create(true).write(true)
            .open(root.join("workspace.lock"))?;
        // 非阻塞排他锁：第二实例 try_lock 失败 → WorkspaceInUse
        f.try_lock_exclusive().map_err(|_| Error::WorkspaceInUse)?;
        // pid 必须经同一句柄写入：Windows 下另一句柄写锁定区域会得到锁冲突
        use std::io::{Seek, SeekFrom, Write};
        f.set_len(0)?;
        f.seek(SeekFrom::Start(0))?;
        f.write_all(format!("pid={}\n", std::process::id()).as_bytes())?;
        Ok(f)
    }
    pub fn release_lock(&mut self) -> bool {
        if let Some(f) = self.lock_file.take() { let _ = fs2::FileExt::unlock(&f); true } else { false }
    }
}
```

错误枚举含 `WorkspaceInUse`（第二实例提示占用并退出，DESIGN-REVIEW 遗漏 5）。

- [ ] **Step 4: `cargo test workspace` → 3 passed**

- [ ] **Step 5: Commit** `feat(workspace): init skeleton + single-workspace lock`

### Task 2: frontmatter.rs

**Files:** Create: `src-tauri/src/frontmatter.rs`

- [ ] **Step 1: 失败测试**（覆盖：无 frontmatter、往返透传未知键、CRLF、body 字节保真、updated 时间戳）

```rust
#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "---\nid: 3f2c0000-0000-0000-0000-000000000001\ntitle: 深度工作\ntags: [essay]\nstatus: draft\ncreated: 2026-08-18T10:00:00\nupdated: 2026-08-18T12:30:00\n---\n\n正文A\r\n第二行\n";

    #[test]
    fn parses_and_roundtrips_with_extra_keys() {
        let src = SAMPLE.replace("tags: [essay]", "tags: [essay]\nrating: 5");
        let (fm, body) = parse(&src).unwrap();
        assert_eq!(fm.id.to_string(), "3f2c0000-0000-0000-0000-000000000001");
        assert_eq!(fm.title, "深度工作");
        assert_eq!(fm.folder, None);
        let out = fm.to_content(&body);
        let (fm2, body2) = parse(&out).unwrap();
        assert_eq!(fm2.id, fm.id);
        assert_eq!(body2, body);                    // body 原样（含 \r\n）
        assert!(out.contains("rating: 5"));          // 未知键透传
    }

    #[test]
    fn content_without_frontmatter_is_all_body() {
        let (fm, body) = parse("就是正文").unwrap();
        assert!(fm.is_new());
        assert_eq!(body, "就是正文");
    }

    #[test]
    fn serialize_is_canonical_order() {
        let (fm, body) = parse(SAMPLE).unwrap();
        let out = fm.to_content(&body);
        let id_pos = out.find("id:").unwrap();
        let title_pos = out.find("title:").unwrap();
        let updated_pos = out.find("updated:").unwrap();
        assert!(id_pos < title_pos && title_pos < updated_pos);
    }
}
```

- [ ] **Step 2: `cargo test frontmatter` 失败**

- [ ] **Step 3: 实现要点**

- `parse(&str) -> Result<(Frontmatter, String)>`：文件以 `---\n`（或 `---\r\n`）开头则到下一个 `\n---` 行为止为 YAML；否则 `Frontmatter::new_empty()` + 全文为 body。
- `Frontmatter { id: Uuid, title: String, folder: Option<String>, status: PostStatus, tags: Vec<String>, created: String, updated: String, extra: serde_yaml::Mapping }`——已知字段抽走，剩余键进 `extra`。
- `to_content(&body) -> String`：固定顺序 `id, title, folder, status, tags, created, updated, …extra` 手写行（不用 serde_yaml 序列化整个结构，保证顺序与 `tags: [a, b]` 行内数组格式）；`folder: None` 时省略该行。
- `bump_updated(&mut self)`：`now` 置 `updated`，不动 `created`。
- `PostStatus { Draft, Writing, Done, Archived }`，serde 别名小写字符串。

- [ ] **Step 4: `cargo test frontmatter` → 3 passed**

- [ ] **Step 5: Commit** `feat(frontmatter): parse/serialize with passthrough, canonical order, CRLF-safe`

### Task 3: history.rs 快照命名与保留策略（纯函数）

**Files:** Create: `src-tauri/src/history.rs`

- [ ] **Step 1: 失败测试**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{TimeZone, Utc};

    fn snap(days_ago: i64, hour: u32, min: u32, milestone: Option<&str>) -> SnapshotMeta {
        SnapshotMeta {
            ts: Utc.with_ymd_and_hms(2026, 8, 18, hour, min, 0).unwrap() - chrono::Duration::days(days_ago),
            hash8: "abcd1234".into(),
            milestone: milestone.map(String::from),
        }
    }

    #[test]
    fn snapshot_file_name_format() {
        let ts = Utc.with_ymd_and_hms(2026, 8, 18, 9, 5, 3).unwrap();
        assert_eq!(snapshot_file_name(ts, "内容X"), "20260818-090503-8d1f0a1c.md"); // hash8 以实际 sha256 前 8 位为准，先断言前后缀
    }

    #[test]
    fn retention_keeps_recent_daily_then_weekly_and_milestones() {
        let now = Utc.with_ymd_and_hms(2026, 8, 18, 12, 0, 0).unwrap();
        let snaps = vec![
            snap(0, 9, 0, None), snap(0, 10, 0, None),              // 48h 内：全留
            snap(3, 9, 0, None), snap(3, 15, 0, None),              // 同日：留最新
            snap(10, 9, 0, None),
            snap(40, 9, 0, None), snap(41, 9, 0, None), snap(47, 9, 0, None), // >30d：按周各留 1（40/47 同周则并 1）
            snap(60, 9, 0, Some("交稿版")),                          // 里程碑永留
        ];
        let keep = plan_retention(&snaps, &now, &RetentionConfig::default());
        assert!(keep.contains(&snaps[0].ts) && keep.contains(&snaps[1].ts));
        assert!(!keep.contains(&snaps[3].ts));   // 同日旧的删
        assert!(keep.contains(&snaps[6].ts));    // 里程碑
        // >30d 组：断言保留数 ≤ 2（按 ISO 周聚合）
    }

    #[test]
    fn material_change_ignores_whitespace_only_tail() {
        assert!(!is_material_change("a\n\n", "a"));
        assert!(is_material_change("a", "ab"));
    }
}
```

- [ ] **Step 2: `cargo test history` 失败**

- [ ] **Step 3: 实现要点**

- `hash8(content) -> String`：sha256 前 8 个十六进制字符；`snapshot_file_name(ts, content)` = `{ts:%Y%m%d-%H%M%S}-{hash8}.md`。
- `plan_retention(snaps, now, cfg) -> HashSet<DateTime>`：里程碑全保留；`now - ts <= 48h` 全留；48h–30d 按**日**（本地时区）取最新；>30d 按 **ISO 周**取最新；其余可删。`RetentionConfig { full_hours: 48, daily_days: 30 }`。
- `is_material_change(old, new)`：`trim_end` 后不等才算实质变化。
- 注意：`snapshot_file_name` 测试中 hash 值以实现算出的真实值回填（先写断言前后缀 + 长度，跑通后固化）。

- [ ] **Step 4: `cargo test history` → 3 passed**

- [ ] **Step 5: Commit** `feat(history): snapshot naming + retention policy (48h/daily/weekly/milestone)`

### Task 4: vfolder.rs 虚拟目录（纯函数）

**Files:** Create: `src-tauri/src/vfolder.rs`

- [ ] **Step 1: 失败测试**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn post(id: &str, folder: Option<&str>) -> PostRef {
        PostRef { id: id.into(), title: format!("t{id}"), folder: folder.map(String::from) }
    }

    #[test]
    fn builds_tree_with_uncategorized_bucket() {
        let tree = build_tree(&[
            post("1", Some("技术/分布式")), post("2", Some("技术")), post("3", None),
        ]);
        // 断言：根 = [技术(含子 分布式, 直属 2), 未分类(3)]；未分类永远排最后
    }

    #[test]
    fn normalizes_folder_values() {
        assert_eq!(normalize_folder(" /技术//分布式/ "), Some("技术/分布式".into()));
        assert_eq!(normalize_folder(""), None);
        assert_eq!(normalize_folder("/"), None);
    }

    #[test]
    fn rename_folder_batch_updates_prefix() {
        let items = vec![post("1", Some("技术/分布式")), post("2", Some("技术")), post("3", Some("技术前沿"))];
        let updated = rename_folder(&items, "技术", "技术/后端");
        // 断言：1 → 技术/后端/分布式；2 → 技术/后端；3 不变（前缀整段匹配，非字符串前缀）
    }

    #[test]
    fn rename_into_descendant_rejected() {
        let items = vec![post("1", Some("技术"))];
        assert!(rename_folder(&items, "技术", "技术/子").is_err());
    }
}
```

- [ ] **Step 2: `cargo test vfolder` 失败**

- [ ] **Step 3: 实现要点**

- `normalize_folder`：trim → 去首尾 `/` → 折叠连续 `//` → 空串为 `None`（DESIGN-REVIEW 二轮 9 采纳的值规范）。
- `build_tree`：按 `/` 分段建树；`folder=None` 聚合进固定尾部的「未分类」节点；同级按名称排序。
- `rename_folder(from, to)`：`from` 是 `to` 的祖先时报错；成员 folder **整段等于** `from` 或 **以 `from/` 开头** 才替换（防止 `技术前沿` 误伤）。
- `TreeNode { name, children: BTreeMap<String, TreeNode>, posts: Vec<PostRef> }`。

- [ ] **Step 4: `cargo test vfolder` → 4 passed**

- [ ] **Step 5: Commit** `feat(vfolder): folder aggregation, normalization, batch rename with prefix guard`

### Task 5: index.rs 索引 + FTS5 + jieba

**Files:** Create: `src-tauri/src/index.rs`

- [ ] **Step 1: 失败测试**（中英混排是关键用例，DESIGN §9）

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn db_with_two_posts() -> Index {
        let mut idx = Index::open_in_memory().unwrap();
        idx.upsert_file(&FileMeta {
            id: "id-1".into(), kind: "post", path: "posts/a.md".into(),
            title: "深度工作实践记".into(), folder: Some("技术".into()),
            status: "draft".into(), tags: "[]".into(),
            created_at: "2026-08-18T10:00:00".into(), updated_at: "2026-08-18T10:00:00".into(),
            deleted_at: None, hash: "h1".into(),
        }, "注意力残留 attention residue 影响深度工作").unwrap();
        idx.upsert_file(&/* id-2, title "Weekly Review", body "weekly review 反思" */).unwrap();
        idx
    }

    #[test]
    fn chinese_fts_hits_title_and_body() {
        let idx = db_with_two_posts();
        assert_eq!(idx.search("注意力", Scope::Posts).unwrap()[0].id, "id-1");
        assert_eq!(idx.search("深度工作", Scope::Posts).unwrap().len() >= 1); // 命中标题
    }

    #[test]
    fn mixed_zh_en_query_matches() {
        let idx = db_with_two_posts();
        assert_eq!(idx.search("attention residue", Scope::Posts).unwrap().len(), 1);
    }

    #[test]
    fn update_reindexes_and_delete_removes() {
        let mut idx = db_with_two_posts();
        // 改 id-1 正文后旧词不再命中；soft-delete（deleted_at 置位）后不出现在结果
    }

    #[test]
    fn fts5_available_in_bundled_sqlite() {
        assert!(Index::open_in_memory().is_ok()); // 建表含 fts5 virtual table，失败即 bundled 未启用 FTS5
    }
}
```

- [ ] **Step 2: `cargo test index` 失败。特别地 Step「fts5_available」若失败**：改用 rusqlite feature `bundled-full`（计划内许可的调整），其余不变。

- [ ] **Step 3: 实现要点**

- Schema（`schema_version=1`）：

```sql
CREATE TABLE files(
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL, folder TEXT, status TEXT NOT NULL DEFAULT 'draft',
  tags TEXT NOT NULL DEFAULT '[]', created_at TEXT, updated_at TEXT,
  deleted_at TEXT, hash TEXT, missing INTEGER NOT NULL DEFAULT 0);
CREATE TABLE snapshots(
  id INTEGER PRIMARY KEY AUTOINCREMENT, file_id TEXT NOT NULL,
  ts TEXT NOT NULL, hash TEXT NOT NULL, milestone TEXT);
CREATE VIRTUAL TABLE files_fts USING fts5(title_tokens, body_tokens, content='', contentless_delete=1);
CREATE TABLE fts_map(file_id TEXT PRIMARY KEY, fts_rowid INTEGER NOT NULL);
```

- `tokenize(text)`：`once_cell::sync::Lazy<Jieba>` + `jieba.cut(text, true)` → 空格连接（写入时预分词，DESIGN §9）；英文小写化由 unicode61 分词器天然处理。
- FTS 行更新 = `DELETE` + `INSERT`（contentless 表不支持 `UPDATE`；`contentless_delete=1` 需 SQLite ≥3.43，rusqlite bundled 满足）。`bundled` 特性本身已启用 FTS5，Step 2 的 `bundled-full` fallback 预计不触发，保留作保险。
- `search(query, scope)`：查询词同样经 `tokenize` → `"tok1 tok2"` 短语引号包裹 + `OR` 连接的组合；join `files`（`kind='post'` 且 `deleted_at IS NULL`）按 rank 排序返回 `{id, path, title, snippet?}`。
- `open_in_memory()` 供测试；`open(path)` 打开 `.index/index.db`。
- 索引**可重建**：`rebuild_from(&[FileMeta])` 全量重写（M5 导入与健康检查复用）。

- [ ] **Step 4: `cargo test index` → 4 passed**

- [ ] **Step 5: Commit** `feat(index): sqlite meta + fts5 with jieba pre-tokenization (zh/en mixed)`

### Task 6: scan.rs 扫描与外部改动重联

**Files:** Create: `src-tauri/src/scan.rs`

- [ ] **Step 1: 失败测试**（tempdir 造夹具：正常文稿、外部改名、无 id 新文件、同名不同子目录、`.trash` 排除）

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_reports_posts_and_excludes_trash() { /* posts/a.md 有效；posts/.trash/b.md 不出现 */ }

    #[test]
    fn external_rename_relinks_by_id() {
        // 预置索引：id-1 → posts/old.md；磁盘上文件已被外部改名为 posts/new.md（frontmatter id 不变）
        // 断言：report.path_changes = [("id-1","posts/old.md"→"posts/new.md")]，应用后索引指向新路径
    }

    #[test]
    fn file_without_id_is_pending_import() { /* 报告 pending_import 列表，不自动写入 */ }

    #[test]
    fn same_slug_in_different_dirs_flagged() { /* posts/2026/foo.md + posts/2027/foo.md → conflicts 非空 */ }

    #[test]
    fn indexed_file_missing_on_disk_reported() { /* missing=true 报告，记录不删 */ }
}
```

- [ ] **Step 2: `cargo test scan` 失败**

- [ ] **Step 3: 实现要点**

- `scan_posts(ws) -> ScanReport { posts: Vec<(FileMeta, body)>, path_changes, pending_import, slug_conflicts, missing }`：`walkdir` 递归 `posts/`，跳过 `.trash`；解析 frontmatter。
- 与索引 diff：按 id 匹配——id 在、路径变 → `path_changes`；id 在、文件不在 → `missing`；磁盘有、索引无 id → `pending_import`；basename 相同（不同目录）→ `slug_conflicts`。
- `apply_to_index(report, &mut idx)`：upsert + relink（DESIGN §3.3 外部改动检测）。

- [ ] **Step 4: `cargo test scan` → 5 passed**

- [ ] **Step 5: Commit** `feat(scan): posts scan with id-based relink, pending-import and conflict report`

### Task 7: history.rs 落盘 / 恢复 / 清理（IO 部分）

**Files:** Modify: `src-tauri/src/history.rs`

- [ ] **Step 1: 失败测试**

```rust
#[test]
fn snapshot_written_only_on_material_change() {
    // 初次保存写 1 份；内容不变再保存不新增；实质修改再写 1 份；快照文件名符合命名规则
}
#[test]
fn restore_is_non_destructive() {
    // 恢复到旧快照：当前内容先成为新快照；主文件内容 == 目标快照；历史列表 +1
}
#[test]
fn milestone_survives_cleanup() {
    // 设里程碑 → cleanup() → 该快照文件仍在磁盘
}
#[test]
fn cleanup_removes_non_kept_snapshots() { /* 按 plan_retention 删文件与记录 */ }
#[test]
fn trash_purge_after_30_days_removes_versions_dir() {
    // deleted_at 31 天前 → 清理后 posts/.trash/x.md 与 .versions/{id}/ 均不存在（DESIGN-REVIEW 二轮 13）
}
#[test]
fn history_list_survives_index_loss() {
    // 删除 index.db 重建后 list_snapshots 仍完整（磁盘快照为权威，DESIGN 原则 3）
}
```

- [ ] **Step 2: `cargo test history::io_tests` 失败**

- [ ] **Step 3: 实现要点**

- `maybe_snapshot(ws, idx, id, prev_body, new_body)`：实质变化才写 `.versions/{id}/.history/{name}` + `snapshots` 表记录。
- `restore(ws, idx, id, snapshot_id) -> new_body`：当前内容先快照，再覆盖主文件（临时文件 + rename 原子写）。
- `set_milestone / list_snapshots / cleanup(now) / purge_trash(ws, idx, now)`（30 天；连带删 `.versions/{id}/` 整目录）。
- 磁盘快照为**权威**，`snapshots` 表只是缓存（列不出表时回扫目录——`list_snapshots` 实现为：以目录扫描为准，表作加速）。测试含「删掉 index.db 后历史列表仍完整」一条。

- [ ] **Step 4: `cargo test history` → 全部 passed（Task 3 的 3 条 + 本任务 6 条）**

- [ ] **Step 5: Commit** `feat(history): snapshot io, non-destructive restore, milestones, retention cleanup, trash purge`

### Task 8: assets.rs 附件池

**Files:** Create: `src-tauri/src/assets.rs`

- [ ] **Step 1: 失败测试**

```rust
#[test]
fn same_bytes_dedup_to_one_file() {
    // 两次 save_asset(同 bytes) → 同一文件名（16 hex + 扩展名）、目录里只有 1 个文件
}
#[test]
fn different_bytes_two_files() {}
#[test]
fn relative_path_from_post() {
    // posts/a.md → "../_assets/xx.png"；posts/2026/a.md → "../../_assets/xx.png"（pathdiff）
}
#[test]
fn fingerprint_length_16_hex() { /* 文件名 = ^[0-9a-f]{16}\.ext$ */ }
```

- [ ] **Step 2: `cargo test assets` 失败**

- [ ] **Step 3: 实现要点**

- `save_asset(ws, bytes, ext) -> (fp, filename)`：sha256 前 16 位十六进制；存在即复用（去重），不存在则写入（只读不可变语义：后续无覆盖路径）。
- `relative_asset_path(post_path, asset_name) -> String`：`pathdiff::diff_paths` 计算，`/` 分隔（跨平台一致）。
- M1 仅接「编辑器贴图」入口；资料原件导入随 M3。

- [ ] **Step 4: `cargo test assets` → 4 passed**

- [ ] **Step 5: Commit** `feat(assets): content-addressed immutable pool with dedup + relative path calc`

### Task 9: state.rs + commands.rs 命令层

**Files:** Create: `src-tauri/src/state.rs`, `src-tauri/src/commands.rs`；Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: 失败测试**（命令逻辑放 `AppState` 方法，直接测，不经 Tauri 运行时）

```rust
#[test]
fn create_post_generates_slug_and_collision_suffix() {
    // title "Hello World" → posts/hello-world.md；再建同名 → posts/hello-world-2.md
    // title 全中文 → post-{uuid8}.md
}
#[test]
fn save_post_preserves_id_bumps_updated_and_snapshots() {}
#[test]
fn trash_then_restore_keeps_folder() {}
#[test]
fn set_post_folder_moves_logically_only() {
    // 改 folder 后：物理路径不变（仍是 posts/x.md），frontmatter folder 变了
}
#[test]
fn rename_virtual_folder_via_state_updates_all_members() {}
```

- [ ] **Step 2: `cargo test commands` 失败**

- [ ] **Step 3: 实现要点**

- `AppState { ws: Workspace, idx: Mutex<Index> }`；命令 = `AppState` 方法 + `#[tauri::command]` 薄封装（≤15 行/函数）：
  - `list_posts() -> Vec<PostSummary>`（含树数据：folder 原始值，聚合交前端或返回 `build_tree` 结果——**返回聚合树**，前端零逻辑）；
  - `create_post(title, folder) / read_post(id) / save_post(id, content) / set_post_title(id, title) / set_post_status / set_post_folder / rename_virtual_folder(from, to)`；
  - **`save_post` 的 `content` = 正文 body（不含 frontmatter）**：frontmatter 由服务端持有并维护（bump `updated`、保留 `id/created`）；title/status/folder 的修改走对应 `set_*` 命令（各自重写 frontmatter 落盘），编辑器不拼 YAML；
  - `move_post_to_trash(id) / list_trash / restore_post(id)`（移动 = 物理移入 `posts/.trash/`，索引 `deleted_at` 置位）；
  - `list_snapshots(id) / restore_snapshot(id, snapshot_id) / set_snapshot_milestone(id, snapshot_id, name)`；
  - `save_pasted_image(post_id, bytes, ext) -> markdown 相对路径`；
  - `search_posts(query) -> Vec<SearchHit>`（M5 才做 UI，命令先就位）；
  - `scan_refresh() -> ScanReport`（含 `pending_import` 的「导入」动作 `import_external(path)`：补 id 写回 frontmatter）。
- `lib.rs run()`：**第一个**注册的插件是 `single_instance`（Tauri 2 要求首个注册，迟注册收不到第二实例事件；第二实例弹窗退出）；启动流程 = 确定工作区路径——`#[cfg(debug_assertions)]` 下默认取仓库根 `dev-workspace/`（可用环境变量 `MEWBOX_WORKSPACE` 覆盖，Task 9 Step 4 冒烟依赖此行为）；release 读上次路径（`%APPDATA%/com.mewbox.app/app.json`），无则 `dialog` 插件选目录并记录 → `Workspace::init`（失败即 `WorkspaceInUse` 弹窗退出）→ 打开索引 → `scan_posts` + `apply_to_index` → `cleanup + purge_trash`。
- jieba 懒加载放 `Index::tokenize` 首次调用（后台线程预热：`std::thread::spawn(|| Lazy::force(&JIEBA))`，避免首帧卡顿）。

- [ ] **Step 4: `cargo test` 全绿；`pnpm tauri dev` 冒烟：窗口打开、dev-workspace 生成完整骨架**

- [ ] **Step 5: Commit** `feat(commands): tauri command layer + startup flow (single instance, workspace bootstrap)`

---

## Chunk 2：前端与集成（任务 10–16）

### Task 10: 应用骨架 AppShell + 状态store

**Files:** Create: `src/components/AppShell.tsx`, `src/stores/app.ts`, `src/lib/api.ts`；Test: `src/components/AppShell.test.tsx`

- [ ] **Step 1: 失败测试**（mock `src/lib/api.ts` 的 invoke 层）

```tsx
vi.mock('../lib/api', () => ({
  api: {
    listPosts: vi.fn().mockResolvedValue({ tree: mockTree, posts: mockPosts }),
    listTrash: vi.fn().mockResolvedValue([]),
  },
}));
// 用例1: 渲染左栏三区（文稿 / 知识库-置灰占位 / 全局搜索-置灰占位）与右栏页签（大纲/历史）
// 用例2: 无选中时主区显示空状态（参考 prototype/09-empty：欢迎语 + 新建按钮）
// 用例3: 点击新建 → 调 createPost 并选中
```

- [ ] **Step 2: `pnpm vitest run AppShell` 失败**

- [ ] **Step 3: 实现要点**

- `api.ts`：`invoke` 的类型化封装（类型与 Rust 命令签名一一对应，蛇形转驼峰由 serde rename 统一）。
- store：`{ tree, posts, selectedId, dirty, viewMode, rightTab }`；action：`load()`（listPosts + listTrash）、`select(id)`（flush 保存 → readPost）、`create()`。
- 布局照 `prototype/index.html` 的三栏骨架：左 236px / 右 288px 可折叠，Tailwind + theme.css 变量。M1 窗口用系统原生标题栏（自定义标题栏进 backlog，原型已有视觉稿）。

- [ ] **Step 4: `pnpm vitest run AppShell` → 3 passed**

- [ ] **Step 5: Commit** `feat(shell): three-column app shell, stores, typed api layer`

### Task 11: 虚拟目录树 PostTree

**Files:** Create: `src/components/PostTree.tsx`, `NewPostDialog.tsx`, `src/lib/treeOps.ts`；Test: `src/components/PostTree.test.tsx`, `src/lib/treeOps.test.ts`

- [ ] **Step 1: 失败测试**

```ts
// treeOps.test.ts（纯函数）
test('drop post onto folder → set_post_folder 参数正确')
test('drop folder onto folder → rename_virtual_folder 参数正确，且目标是自身后代时 no-op')
// PostTree.test.tsx（组件，mock api）
test('渲染聚合树：目录 > 子目录 > 文稿，未分类固定最后')
test('拖拽文稿到目录触发 setPostFolder（fireEvent.dragStart/drop + DataTransfer mock）')
test('状态 chips 渲染（draft/writing/done 取 prototype chip-*；archived 无现成样式，新增灰底 chip 用 --muted）')
test('状态过滤 + 更新时间/标题排序下拉生效（DESIGN §4.3；标签过滤随 M5 全局搜索）')
test('右键目录 → 重命名对话框 → renameVirtualFolder')
```

- [ ] **Step 2: `pnpm vitest run treeOps PostTree` 失败**

- [ ] **Step 3: 实现要点**

- HTML5 DnD 原生实现（不引树库，M1 树规模小）；拖拽逻辑全部走 `treeOps` 纯函数，组件只转发。
- 新建文稿：`NewPostDialog`（标题必填、目录可选下拉 = 现有 folder + 新建）；`createPost(title, folder)`。
- 文稿操作菜单：改名（title，不改文件名）、改状态、移入回收站（确认弹窗，文案「可在回收站恢复，30 天后自动清除」）。

- [ ] **Step 4: `pnpm vitest run treeOps PostTree` → 7 passed（treeOps 2 + 组件 5）**

- [ ] **Step 5: Commit** `feat(tree): virtual folder tree with drag-drop recategorize and uncategorized bucket`

### Task 12: 编辑器 EditorPane（三模式 + 渲染扩展 + 自动保存 + 贴图）

**Files:** Create: `src/components/EditorPane.tsx`, `src/lib/markdown.tsx`（插件与预览配置）；Test: `src/components/EditorPane.test.tsx`, `src/lib/markdown.test.tsx`

- [ ] **Step 1: 失败测试**

```tsx
// markdown.test.tsx
test('==高亮== 渲染为 <mark>')            // 自写 remark 插件 markPlugin
test('~下标~ 与 ^上标^ 渲染')             // remark 插件 sub/sup（自写或 remark-sub-super，装不上则自写）
test('表格/任务列表/删除线/脚注 走 remark-gfm')
test('$..$ 与 $$..$$ 走 KaTeX')
// EditorPane.test.tsx
test('三模式切换：源码 textarea / 分栏双区 / 预览 html')
test('自动保存：假时钟下连续输入 1s 只触发一次 savePost，内容=最新值')
test('切换文稿/卸载前强制保存（flush）')
test('粘贴图片 → savePastedImage 返回相对路径插入正文光标处')
test('保存指示器：dirty → “保存中…” → “已保存 · HH:MM”')
```

- [ ] **Step 2: `pnpm vitest run markdown EditorPane` 失败**

- [ ] **Step 3: 实现要点**

- `@uiw/react-md-editor`（`preview="edit|live|preview"` 映射 源码/分栏/预览，segment 控件照 prototype `subbar` 样式）；预览走 `react-markdown` + 插件：`remark-gfm`、`remark-math`+`rehype-katex`（**须 `import 'katex/dist/katex.min.css'`，否则公式无排版**）、`remark-emoji`、自写 `markPlugin`（==text== → `<mark>`）、`rehype-highlight`（代码块包一层带语言标签 + 复制按钮的容器组件）、mermaid **懒加载**（代码块 renderer 遇 `language-mermaid` 才 `import('mermaid')`）。
- 自动保存：800ms 防抖（保存期间的新输入累计到下一次）；`beforeunload` / 切换文稿 / 最小化前 flush；保存成功才清 dirty。
- 贴图：`onPaste` 捕获 `clipboardData.items` 的 image → `ArrayBuffer` → `savePastedImage` → 插入 `![]({relPath})`。
- 标题行：显示/编辑 frontmatter `title`（与文件名解耦，编辑经 `setPostTitle` 落盘）；状态选择器四态（经 `setPostStatus`）。
- 插件包不存在时按 `markPlugin` 同模式自写（sub/sup 已知有现成生态，先试装）。

- [ ] **Step 4: `pnpm vitest run markdown EditorPane` → 9 passed（markdown 4 + 组件 5）**

- [ ] **Step 5: Commit** `feat(editor): 3-mode editor with extensions, debounced autosave, image paste`

### Task 13: 大纲面板 OutlinePanel

**Files:** Create: `src/components/OutlinePanel.tsx`, `src/lib/outline.ts`；Test: `src/lib/outline.test.ts`, `src/components/OutlinePanel.test.tsx`

- [ ] **Step 1: 失败测试**

```ts
// outline.test.ts
test('抽取 #/##/### 标题，跳过代码围栏内的 # 行')
test('带锚点 slug（用于预览模式 scrollIntoView）')
// OutlinePanel.test.tsx
test('渲染层级缩进列表；点击项调用 onJump(heading)')
```

- [ ] **Step 2: 失败 → **Step 3: 实现**（解析用轻量行扫描正则，不引 markdown AST；预览模式 scrollIntoView 按锚点 id，源码模式仅高亮提示）

- [ ] **Step 4: 3 passed → **Step 5: Commit** `feat(outline): heading extraction + jump`

### Task 14: 历史面板 HistoryPanel（列表 / diff / 恢复 / 里程碑）

**Files:** Create: `src/components/HistoryPanel.tsx`；Test: `src/components/HistoryPanel.test.tsx`

- [ ] **Step 1: 失败测试**

```tsx
test('渲染快照列表：时间/哈希/里程碑 chip；里程碑可命名与改名')
test('选中快照 → 双栏 diff：jsdiff line-diff，增行绿删行红（绿/红取 theme.css --green/--red）')
test('恢复需确认弹窗 → restoreSnapshot → 刷新列表（恢复产生新快照，列表 +1）')
test('与当前比较 = 最新快照；无快照时空状态')
```

- [ ] **Step 2: 失败 → **Step 3: 实现**（diff 用 `diff` npm 包 lineDiff；面板挂在右栏「历史」页签；同时暴露「打开所在目录」不做——v1 无此命令，跳过）

- [ ] **Step 4: 4 passed → **Step 5: Commit** `feat(history-ui): snapshot list, two-pane diff, restore, milestones`

### Task 15: 回收站 TrashPanel

**Files:** Create: `src/components/TrashPanel.tsx`；Test: `src/components/TrashPanel.test.tsx`

- [ ] **Step 1: 失败测试**

```tsx
test('列出已删文稿：标题/原虚拟目录/剩余天数（30 - days(deleted_at)）')
test('恢复 → restorePost → 从列表消失且回到原 folder')
test('无永久删除按钮（原则 7：不提供不可逆入口）')
test('空回收站空状态')
```

- [ ] **Step 2: 失败 → **Step 3: 实现**（左栏「回收站」入口 → 抽屉面板；启动时 purge 由后端完成）

- [ ] **Step 4: 4 passed → **Step 5: Commit** `feat(trash): trash panel with restore and days-left`

### Task 16: 集成、构建与验收门

**Files:** Modify: `src-tauri/src/lib.rs`（启动流程最终化）、`README.md`（运行/构建说明）；Create: `docs/superpowers/plans/m1-qa-checklist.md`

- [ ] **Step 1: 全量自动化**

```bash
pnpm check && cargo test --manifest-path src-tauri/Cargo.toml --all
```

Expected: vitest 全部通过（约 30 用例）；cargo 全部通过（约 37 用例）。任何失败先修复再继续。

- [ ] **Step 2: 安装包构建**

```bash
pnpm tauri build
```

Expected: `src-tauri/target/release/bundle/nsis/*.exe` 产出；`pnpm tauri build --no-bundle` 可跑通调试。

- [ ] **Step 3: 人工 QA 清单**（逐项打勾写入 `m1-qa-checklist.md`，映射 DESIGN 章节）

1. 首次启动选目录 → 工作区骨架完整（§3.1）
2. 第二实例启动 → 提示占用并退出（§3.1）
3. 新建文稿（中文标题）→ posts/ 出现 md，frontmatter id/title/created 齐全（§3.2）
4. 三模式切换与渲染扩展逐项：表格/代码高亮+复制/KaTeX/mermaid 懒加载/任务列表/删除线/脚注/==高亮==/emoji/上下标（§4.1）
5. 输入停顿 ~1s → 「已保存」；改 title 不改文件名（§4.1）
6. 粘贴图片两次（同图）→ `_assets/` 仅 1 个文件，16 位指纹名，正文相对路径（§3.3/§4.1）
7. 拖文稿入目录 → 仅 frontmatter folder 变，物理路径不变（§4.4）
8. 重命名虚拟目录 → 成员批量迁移；未分类常驻（§4.4）
9. 改动保存 → `.versions/{id}/.history/` 出现 `{时间戳}-{hash8}.md`（§4.2）
10. 历史 diff 双栏、恢复非破坏（恢复后历史 +1）（§4.2）
11. 里程碑命名后手动触发清理（dev：临时改系统时间不可行——用 cargo test 覆盖，QA 记录「已由单测覆盖」）（§4.2）
12. 删除文稿 → 回收站可见剩余天数；恢复 → 回原虚拟目录（§4.4/原则 7）
13. 外部改名文稿文件（资源管理器）→ 应用内刷新扫描自动重联，历史完好（§3.3）
14. 外部放入无 frontmatter 的 md → 出现「待导入」提示，导入后补 id（§7.4）
15. 同名不同子目录两文件 → 冲突提示不崩溃（§7.4）
16. 中文搜索（标题/正文、中英混排）命中正确（§9，经 Rust 测试 + dev 下用临时调试入口验证命令）
17. 拷走 dev-workspace 到新目录 → 指向新目录打开，一切正常（原则 1 冒烟）
18. 关闭应用 → workspace.lock 释放，可再次启动
19. 重启应用 → 列表/状态/目录树与关闭前一致
20. 回收站无任何「永久删除」入口（原则 7）

- [ ] **Step 4: 里程碑收尾**

- QA 结果与遗留问题记入 checklist；更新 roadmap 状态表；合入 `main`。
- Commit: `chore(m1): milestone complete, qa checklist`

- [ ] **Step 5: 确认门**——向用户提交验收摘要（功能、测试统计、QA 结果、已知问题），**等待确认后才撰写 M2 计划**。

---

## 明确不做（M1 范围外，防止蔓延）

- 知识库（kb/ 只建目录不建 UI）、发布版本、关联块/wiki 链接、AI、全局搜索 UI、导入导出、自定义标题栏、多工作区切换——分别属 M2–M5/backlog。
- `config.toml` 仅创建空文件，无编辑 UI（M4 读它做模型路由）。
- macOS/Linux 打包（当前环境 win32，仅出 Windows 安装包；代码保持跨平台路径处理）。
