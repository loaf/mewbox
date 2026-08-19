# M3「有知识库」实施计划

> **For agentic workers:** 使用 `executing-plans` 技能执行。前置阅读：DESIGN §6（知识库）、§7（关联体系全章）、§3.3（跨库移动）、§12 M3；M1/M2 已建立的模式（AppState 方法 + 薄命令、tempdir 单测、本地镜像跑 vitest）。已获用户授权：评审通过后直接执行，里程碑结束验收。

**Goal:** 资料服务写作、关联在文件中可见——kb 物理目录树 + 资料编辑/历史/导入；尾部关联块双侧同步 + wiki 链接/反链；资料⇄文稿互转；应用内移动/重命名引用同步；健康检查；挂接 M2 顺延的关联块「发布版本」区。

**关键设计约束（DESIGN §6/§7/决策 7/14）：**
- kb 物理目录即分类；Inbox 是默认导入落点（也开历史）。
- 尾部关联块是**唯一正式关联**：应用维护区（HTML 注释标记），双侧同步，没有关联就没有块；块内 `[标题](相对路径)` 随移动同步重算；发布版本不用块（归属靠 base），但**文稿尾部**的块里有「发布版本」区（M2 顺延，自动维护的相对链接）。
- 正文 `[[标题]]` 是轻量补充：唯一匹配跳转；重名保持悬空并给候选；**title 变更由应用同步更新全部引用**；反链面板聚合两个来源。
- 互转与移动：id 不变、历史随行、关联保留；移动/重命名原子同步「文件 → 正文 wiki 引用（title 变更）+ 关联块双侧路径 → 索引」。
- 健康检查四类：断链（回收站目标不计、单独提示）、孤儿历史、无主发布版本、孤儿附件（列出、手动确认清理）。

## 关键机制决策（评审修订）

1. **关联块的读写边界（防丢失更新）**：`read_post/read_material` 返回的 `body` **不含**块，同时返回结构化 `assoc`（前端只读渲染）；`save_post/save_material` 收到的 body 视为纯正文，落盘时**重新读取磁盘上的块原样追加**（磁盘块为准，避免编辑器打开期间另一侧写入的关联被覆盖）；块的增删只经关联命令（update_assoc_two_sides 双侧原子写）。块不参与 `is_material_change` 快照判定。
2. **发布版本防泄漏**：`publish::create_version`（文件路径与 current_body 路径）与 `sync_from_post` 写版本前一律 `strip_assoc`（决策 9）。
3. **标题变更同步**：`set_post_title` / 资料改标题 → 全库 `rename_wiki_refs`（跳过围栏）+ 关联块双侧显示标题更新；`refresh_versions_section` 在 create_publish_version 后触发（scan 时对账）。
4. **资料回收站**：`move_material_to_trash/restore`（kb/.trash，索引 deleted_at）；`purge_trash` 泛化为 kind∈{post,material}；kb 树回收站入口（Task 8）。
5. **frontmatter 稀疏序列化**：Frontmatter 增加 `sparse` 标记——资料序列化时 status=draft 且 tags 空则两字段省略（互转 posts→kb 去语义、kb→posts 补全）。
6. **链接图**：`rebuild_link_graph` 在启动扫描与每次关联/移动/改名变更后重建（缓存性质）。
7. **导入命名冲突**：Inbox 同名自动 `-2` 后缀。
8. **前端刷新**：关联命令返回后调用方 `reload`（store 已有模式）；`@tauri-apps/plugin-dialog` 加入前端依赖。
9. **孤儿附件判定范围**：正文引用收集自 posts + kb + 发布版本 + `.versions/**/.history/` 快照（历史快照合法引用旧指纹，§3.3）；清理仅按显式确认的指纹执行。

### Task 0: 模块骨架
- [ ] 新建 `assoc.rs`、`materials.rs`、`links.rs`、`health.rs` 挂入 lib.rs。

### Task 1: links.rs 相对路径通用化
- [ ] `rel_between(from_file, to_file) -> String`（工作区相对、`/` 分隔，词法归一化；从 publish.rs 的 normalize_lexical 提为共享）；`resolve_rel(from_file, dest) -> Option<工作区相对路径>`（剥 fragment/query）。测试：posts↔kb、↔versions、越根 None。

### Task 2: assoc.rs 尾部关联块
- [ ] 纯逻辑：`parse_assoc(content) -> Option<AssocBlock>`（begin/end 注释之间；三区：关联文稿/关联资料/发布版本）；`strip_assoc(content) -> (body_without_block, Option<AssocBlock>)`；`render_assoc(block) -> String`。**没有关联就没有块**；手动改动会被覆盖（块整体重渲染）。
- [ ] `update_assoc_two_sides(ws, idx, a_id, b_id, op: Add/Remove)`：读两文件 → 各自块增删对方（标题 + 相对路径经 links.rs 按实际位置计算）→ 写回 → 索引（链接图存内存结构 `LinkGraph {edges: Vec<(a,b,source)>}`，暂存 idx 新表 `links`，可重建）。发布版本区由 `refresh_versions_section(ws, post_id)` 维护（列该文稿全部版本，路径指向 `.versions/{id}/publish/{target}.md`）。
- [ ] 测试：双侧增删、路径随文件位置正确、无关联无块、块内手动内容被规范重渲染、发布版本区自动列出/移除。

### Task 3: wiki 链接（links.rs）
- [ ] `extract_wiki_refs(body) -> Vec<String>`（跳过代码围栏与关联块）；`rename_wiki_refs(body, old_title, new_title) -> String`；解析：`resolve_wiki(idx, title)` 唯一→Some；重名/无→None（前端给候选）；悬空链接进链接图标 `pending`。索引表 `links(from_id, to_id|NULL, raw_title, kind: wiki|assoc)` 由 `rebuild_link_graph(idx, files)` 全量重建（磁盘为准）。
- [ ] 测试：抽取跳围栏、重命名全替换、重名不解析、图重建。

### Task 4: materials.rs 资料库
- [ ] frontmatter 复用 frontmatter.rs + `sparse` 稀疏序列化（资料省略默认 status/tags；互转 posts→kb 设 sparse，kb→posts 清除并补全字段）。`list_materials`（扫 kb/ 排除 .trash，物理树，kind=material 入索引）；`read/save/create_material`（body 按机制决策 1 剥块/回拼；历史走 `.versions/{id}/.history/`，Inbox 亦然）；`import_md`（结构保留、id 补齐、透传）；`import_file_containerized`（原件入 `_assets/`，容器落 `kb/Inbox/{stem}[-N].md`，frontmatter source/collected_at/attachments，正文原件相对引用）。资料回收站（决策 4）。标题修改走 set_material_title（决策 3 同步）。
- [ ] 测试：容器化（原件入库+容器正文引用+落 Inbox+冲突后缀）、md 导入透传、资料保存产生历史、read/save 剥块回拼往返（另一侧改块不丢）、sparse 序列化、回收站 30 天清理覆盖 material。

### Task 5: 互转 + 移动/重命名 + 标题同步
- [ ] `convert_material_to_post` / `convert_post_to_material`（sparse 语义切换、id/历史/关联保留，块内相对路径按新位置全部重算，索引 kind 变更）。
- [ ] `rename_post_slug` / `rename_material_file` / `move_material` / `rename_kb_dir`：原子同步——文件移动 → 引用它的正文相对链接 `[t](path)` 重算 → 关联块双侧重算 → 索引。
- [ ] `set_post_title` / `set_material_title` 挂接决策 3：全库 `rename_wiki_refs`（含围栏跳过）+ 关联块双侧显示标题更新。
- [ ] 测试：互转后关联在且路径正确；slug/目录改名后他人正文相对链接更新；标题变更更新 `[[旧标题]]` 与块内显示标题（双侧）；发布版本创建/同步**不含块**。

### Task 6: health.rs 健康检查
- [ ] `check(ws, idx) -> HealthReport { broken_links, trash_targets, orphan_histories, orphan_versions, orphan_assets }`；`list_orphan_assets` 引用收集范围按机制决策 9（posts+kb+发布版本+历史快照）；`clean_orphan_assets(fingerprints)` 仅删显式确认项。
- [ ] 测试：四类检出 + 回收站目标归入 trash_targets；历史快照引用的旧指纹不算孤儿；未确认不删、确认后删且仅删清单内。

### Task 7: 命令层 + 扫描
- [ ] state 方法与命令：kb 树/CRUD/导入/互转/移动改名/关联增删/反链查询 `backlinks(id)`（两来源标注）/wiki 解析 `resolve_wiki(title)`（含重名候选列表）/健康检查/清理孤儿附件；scan 扩展 kb（kind=material、pending_import 复用）。
- [ ] 测试：state 级往返；`cargo test` 全绿。

## Chunk 2：前端（任务 8–13）

### Task 8: 左栏知识库树 + store
- [ ] `KbTree.tsx`：物理目录树（新建/重命名目录、新建资料、右键：导入/互转/移动/回收站）+ kb 回收站入口；store：materials/kbTree/material 视图态（view kind 扩展）。
- [ ] 测试：树渲染、右键菜单项、回收站入口计数。

### Task 9: 资料编辑 + 导入
- [ ] EditorPane 支持 material 模式（横幅「📚 资料 · {目录}」，无发布/状态，标题可编辑=set_material_title）；导入对话框走 `@tauri-apps/plugin-dialog`（加入依赖）。
- [ ] 测试：material 模式横幅/保存分派；导入对话框按扩展名分派 import_md/容器化。

### Task 10: 关联块渲染与关联管理 UI
- [ ] 编辑器底部只读渲染 `assoc`（三区、点击跳转）+「关联文稿…/关联资料…」多选器；资料侧「关联到文稿…」；条目 × 解除；关联命令返回后 reload。发布版本区点击直达版本编辑器。
- [ ] 测试：块渲染、增/删关联调用命令并刷新、版本区条目点击进入版本态。

### Task 11: wiki 链接跳转 + 反链面板
- [ ] 预览 `[[标题]]` 可点击 renderer；resolve→唯一跳转/重名候选弹窗；右栏「反链」页签（两来源标注）。
- [ ] 测试：点击唯一命中跳转；重名弹候选；反链列表来源标注。

### Task 12: 互转/移动/重命名 UI
- [ ] 各右键菜单项 + 确认弹窗（说明引用自动同步）。测试：菜单项调命令。

### Task 13: 健康检查面板 + 集成验收
- [ ] 「健康检查」面板四类清单（回收站目标单独提示）；孤儿附件勾选清理。测试：清单渲染、清理确认链路。
- [ ] `cargo test` + 镜像 vitest/tsc 全绿；dev 冒烟 + build 出包；QA 清单（≥18 项映射 §6/§7）→ roadmap → 验收摘要。

## 明确不做（M3 外）
- 浏览器剪藏、网络搜索收集（backlog）；块级引用 `[[文稿#小节]]`（backlog）；AI 生成描述（M4）；多选批量关联（后续）。
