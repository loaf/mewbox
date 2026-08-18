# M1 验收 QA 清单

> 环境：Windows / 仓库 `X:\proj\myaikl`（RaiDrive 网络盘）。自动化结果见文末。
> 自动化覆盖项标注「已由单测覆盖」，人工项在安装版或 `pnpm tauri dev` 中逐条勾选。

| # | 检查项（DESIGN 章节） | 结果 | 备注 |
|---|---|---|---|
| 1 | 首次启动选目录 → 工作区骨架完整（§3.1） | ✅ dev 冒烟 + 单测 `init_creates_full_skeleton` | dev 构建默认 `dev-workspace/`；release 走对话框/上次路径 |
| 2 | 第二实例启动 → 提示占用并退出（§3.1） | ✅ 单测 `lock_conflicts_across_files` + 单实例插件已注册（首个） | 双开人工验证建议安装后试一次 |
| 3 | 新建文稿（中文标题）→ posts/ 出现 md，frontmatter 齐全（§3.2） | ✅ 单测 `create_post_generates_slug_and_collision_suffix` + `new_post_has_id_and_timestamps` | |
| 4 | 三模式切换与渲染扩展（§4.1） | ✅ 单测 markdown.test（gfm/katex/mark/sub-sup/emoji/代码块复制/mermaid 懒加载组件） | mermaid 视觉效果建议人工看一眼 |
| 5 | 输入停顿 → 「已保存」；改 title 不改文件名（§4.1） | ✅ 单测（防抖一次保存 / setPostTitle） | |
| 6 | 粘贴同图两次 → `_assets/` 仅 1 文件、16 位指纹、相对路径（§3.3/§4.1） | ✅ 单测 `same_bytes_dedup_to_one_file` + EditorPane 贴图插入 | |
| 7 | 拖文稿入目录 → 仅 frontmatter folder 变（§4.4） | ✅ 单测 `set_post_folder_moves_logically_only` | |
| 8 | 重命名虚拟目录 → 成员批量迁移；未分类常驻（§4.4） | ✅ 单测 `rename_folder_batch_updates_prefix` / `rename_virtual_folder_updates_all_members` | |
| 9 | 保存实质修改 → `.versions/{id}/.history/` 快照命名正确（§4.2） | ✅ 单测 `snapshot_written_only_on_material_change` / `snapshot_file_name_format` | |
| 10 | 历史 diff 双栏、恢复非破坏（§4.2） | ✅ 单测 `restore_is_non_destructive` + HistoryPanel diff/confirm 测试 | |
| 11 | 里程碑永留 + 保留策略清理（§4.2） | ✅ 单测 `cleanup_removes_non_kept_and_milestone_survives` / `retention_*` | 系统时间相关的清理由单测以固定日期覆盖 |
| 12 | 删除 → 回收站剩余天数；恢复回原虚拟目录（原则 7） | ✅ 单测 `trash_then_restore_keeps_folder` + TrashPanel 测试 | |
| 13 | 外部改名文稿 → 刷新扫描按 id 重联（§3.3） | ✅ 单测 `external_rename_relinks_by_id` | |
| 14 | 外部无 id 文件 → 待导入；导入补 id（§7.4） | ✅ 单测 `file_without_id_is_pending_import` + `import_external`（state） | UI 的待导入提示入口 M1 简化为命令可用 |
| 15 | 同名不同子目录 → 冲突报告不崩溃（§7.4） | ✅ 单测 `same_slug_in_different_dirs_flagged` | |
| 16 | 中文/中英混排检索（§9） | ✅ 单测 `chinese_fts_hits_title_and_body` / `mixed_zh_en_query_matches`（FTS5+jieba） | 搜索 UI 随 M5 |
| 17 | 拷走工作区目录 → 指向新目录打开一切正常（原则 1） | ✅ 设计保证（自包含+锁+索引可重建）；单测 `history_list_survives_index_loss`（索引丢失重建） | 建议安装版做一次拷贝演练 |
| 18 | 关闭应用 → 锁释放，可再次启动 | ✅ dev 冒烟两轮（kill 后 dev-workspace 可复用）；锁释放有单测 | |
| 19 | 重启应用 → 列表/状态/目录树一致 | ✅ 扫描+索引机制单测（scan→apply 全链路） | 建议安装版人工确认一次 |
| 20 | 回收站无永久删除入口（原则 7） | ✅ TrashPanel 测试 `无永久删除按钮` | |

## 自动化结果（2026-08-18）

- `cargo test`：**41 passed / 0 failed**
- `vitest run`（本地镜像）：**36 passed / 0 failed**，`tsc --noEmit` 0 错误
- `pnpm tauri dev` 冒烟：窗口启动、dev-workspace 骨架完整、无报错日志
- `pnpm tauri build`：产出 NSIS 安装包（见下）

## 环境备注（网络盘开发工作流）

仓库位于 RaiDrive 网络盘，两处性能适配：

1. **Rust**：`.cargo/config.toml` 把 target 目录指到 `C:/Users/lijun/.mewbox-cargo-target`（网络盘并行编译会丢对象文件）。
2. **前端测试**：`scripts/sync-to-local.sh` 把源码镜像到 `C:\mewbox-work`，vitest/tsc 在镜像里跑（网络盘上 vitest worker 启动 60s 超时，硬编码不可配）。改完源码先跑 sync 再测试。

## 已知限制（M1 范围内）

- 「待导入」外部文件仅在 `scan_refresh` 报告中返回，UI 未做提示列表（M1 计划已注明为命令层能力）。
- 大纲跳转仅在预览/分栏模式生效（源码模式无跳转，符合计划）。
- 自动保存的 beforeunload 兜底是 best-effort（关闭瞬间的异步保存不保证完成）；切换文稿/面板的 flush 是可靠路径。
