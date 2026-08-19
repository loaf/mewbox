# M2「能发布」验收 QA 清单

> 自动化基线：`cargo test` **68/68**（M1 41 + M2 新增 27）；vitest **48/48**（M1 39 + M2 新增 9）；`tsc --noEmit` 0 错误。
> 人工项建议安装版或 `pnpm tauri dev` 逐条勾选。

| # | 检查项（DESIGN 章节） | 结果 | 备注 |
|---|---|---|---|
| 1 | 创建 wechat 版：`.versions/{id}/publish/wechat.md` 存在、fm 字段齐全（id/target/base）、`_assets` 引用重算为 `../../../` | ✅ 单测 `create_writes_rewritten_links` / `create_read_save_sync_roundtrip` | |
| 2 | 同目标再建报错提示；新目标名可用（决策 8） | ✅ 单测 `one_target_one_version_enforced` + PublishDialog 报错展示测试 | |
| 3 | 版本编辑不进左栏；横幅归属（含母版标题）；回到母版 | ✅ 组件测试 `版本态：归属横幅 + 回到母版`；侧栏只扫 posts/（M1 机制） | |
| 4 | 版本改动不影响母版、母版改动不影响版本 | ✅ 单测 `post_and_version_independent` | |
| 5 | 同步前版本旧内容进 `{target}.history/`；同步后正文==母版（链接重算） | ✅ 单测 `sync_snapshots_before_overwrite`（含 1.1s 隔离同秒去重语义） | |
| 6 | 从指定历史版本分叉：forked_from 记录、正文取自快照 | ✅ 单测 `create_from_snapshot_records_forked_from` + PublishDialog 分叉测试 | |
| 7 | 发布记录回填 url/日期；状态由 url 派生（回填=已发布，清空=草稿）；chip 显示 | ✅ 单测 `set_published_roundtrip`（派生）+ PublishRecordDialog 保存链路 | |
| 8 | 版本历史列表/diff/恢复/里程碑可用 | ✅ 单测 `save_snapshots_into_own_history_and_restore_milestone` + HistoryPanel 版本态测试 | |
| 9 | 目标注册表：新增入 config.toml（toml 透传保留其它段落）；改名手改文件 | ✅ 单测 config.rs 四条；UI「加入注册表」勾选默认开 | |
| 10 | 贴图进版本：相对路径从 `.versions/{id}/publish/` 出发指向 `_assets/` 真实文件 | ✅ 单测 `save_pasted_image_at_relative` + EditorPane 版本态贴图测试 | |
| 11 | 版本历史也吃保留策略清理（与文稿同一机制） | ✅ 单测 `cleanup_also_sweeps_publish_history`（里程碑键用版本 UUID） | |
| 12 | 无主版本报告（base 缺失）；base 在回收站不算 | ✅ 单测 `orphan_version_reported_and_trashed_base_not_orphan` | |
| 13 | 链接重写：http/锚点/fragment/query 原样；代码围栏内不改 | ✅ 单测 rewrite_tests 六条 | |
| 14 | 尾部关联块「发布版本」区 | ⏳ M3 随关联块体系挂接（roadmap 已注） | |

## 环境与实现备注

- 同秒同内容的快照会因「时间戳+hash8」文件名天然去重——语义无损（内容相同），测试用 1.1s 间隔规避。
- 链接重写做了词法归一化（折叠 `.`/`..`）；`<img src>` 与根相对 `/x` 路径不处理（M2 已知限制）。
- `pnpm tauri build` 产物见下节。

## 构建产物（2026-08-19）

- NSIS：`C:\Users\lijun\.mewbox-cargo-target\release\bundle\nsis\MewBox_0.1.0_x64-setup.exe`
- MSI：`C:\Users\lijun\.mewbox-cargo-target\release\bundle\msi\MewBox_0.1.0_x64_en-US.msi`
