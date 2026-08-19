# M3「有知识库」验收 QA 清单

> 自动化基线：`cargo test` **96/96**（M2 69 + M3 新增 27）；vitest **96/96**（M2 52 + M3 新增 44，16 个测试文件）；`tsc --noEmit` 0 错误。

| # | 检查项（DESIGN 章节） | 结果 | 备注 |
|---|---|---|---|
| 1 | kb 物理目录树 + Inbox 默认落点（§6） | ✅ 单测 kbTreeOps/KbTree + materials（create/import 落 Inbox） | |
| 2 | 资料编辑与文稿同一编辑器；默认开历史（Inbox 亦然）（§6） | ✅ EditorPane material 模式 + save_material 快照（materials::write_material/`write_snapshot`） | |
| 3 | md 导入：结构保留、frontmatter 透传、补 id（§6） | ✅ 单测 `import_md_passthrough_and_id` | |
| 4 | 非 md 导入容器化：原件入 `_assets/`、容器落 Inbox、attachments 记录（§6） | ✅ 单测 `containerized_import`（含冲突 -2 与附件去重） | |
| 5 | 尾部关联块双侧同步；没有关联就没有块；块内相对路径正确（§7.1） | ✅ 单测 `assoc_two_sides_add_remove_and_block_boundary` + assoc.rs 五条 | |
| 6 | 块是应用维护区；另一侧改块不丢失（机制决策 1） | ✅ 单测 `strip_and_reappend_roundtrip`、`manual_noise_inside_block_is_overwritten`、`write_material_disk_block_wins`、post 版 save/read 剥块回拼 | |
| 7 | 文稿尾部「发布版本」区自动维护、点击直达（§5.2/§7.1，M2 顺延项） | ✅ 单测 `publish_excludes_block_and_versions_section` + AssocPanel 版本条目跳转测试 | |
| 8 | 发布版本创建/同步不含关联块（决策 9/机制决策 2） | ✅ 同上测试断言版本 body 无 wb:assoc | |
| 9 | `[[标题]]` 唯一匹配跳转；重名悬空并弹候选（§7.2） | ✅ `resolve_wiki`（unique/ambiguous/none）+ withWikiLinks/CandidatesDialog 测试 | |
| 10 | title 变更同步更新全部 `[[旧标题]]` 引用 + 块内显示标题双侧（决策 14） | ✅ 单测 `title_sync_updates_wiki_refs_and_block_titles`（含围栏跳过） | |
| 11 | 反链面板聚合正文链接/关联块两来源并标注（§7.2） | ✅ `backlinks_and_resolve_wiki` + BacklinksPanel 测试 | |
| 12 | 资料⇄文稿互转：id 不变、历史随行、关联保留、块路径重算（§6/§3.3） | ✅ 单测 `conversion_keeps_assoc_with_recomputed_paths` | |
| 13 | 应用内移动/重命名：正文相对链接 + 关联块双侧 + 索引原子同步（§7.3） | ✅ 单测 `rename_updates_referencing_body_links` + relocate/sync_refs_for_move | |
| 14 | 虚拟目录调整不触发任何物理同步（§7.3 对照） | ✅ M1 已保证 | |
| 15 | 健康检查：断链（回收站目标单独提示）、孤儿历史、无主版本、孤儿附件（§7.4） | ✅ 单测 `material_trash_and_health_basics` + HealthPanel 测试 | |
| 16 | 孤儿附件：历史快照引用的旧指纹不算孤儿；清理仅限显式确认清单（§3.3） | ✅ health.rs collect_all_texts 含 `.versions/**` 快照；确认清理测试 | |
| 17 | 资料回收站 30 天清理（含 .versions 连带）（原则 7） | ✅ purge_trash 泛化双 kind（机制决策 4）；列表/恢复/引用同步测试 | |
| 18 | 外部改动：kb 扫描重联、无 id 待导入（§7.4） | ✅ scan_materials + diff/apply 合并判定（子代理完成的 scan.rs 扩展） | |
| 19 | 「裸读文件即可见关联」抽查：资源管理器打开 md 可见块与相对链接 | ⏳ 人工（安装版抽查） | |
| 20 | 中文检索覆盖资料（§9 检索范围 posts+kb） | ✅ FTS 索引随资料 upsert（kind=material）；搜索 UI 随 M5 | |

## 实现备注

- 后端执行历经一次子代理限额中断，其半成品（sparse frontmatter、links 表、kb 扫描）经验收后由主会话续完；前端由子代理完整交付，主会话独立复核三线全绿。
- wiki 预览跳转经 `#wiki:` 锚点 + URL 编码标题实现；textarea 保持原文（零锁定不变）。
- 关联条目移除依赖 `assoc_targets` 命令（块内相对路径 → id 解析）；版本区条目解析 `.versions/{base}/publish/{target}.md` 直达版本编辑器。

## 构建产物（2026-08-19）

- NSIS：`C:\Users\lijun\.mewbox-cargo-target\release\bundle\nsis\MewBox_0.1.0_x64-setup.exe`
- MSI：同目录 msi\
