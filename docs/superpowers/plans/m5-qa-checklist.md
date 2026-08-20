# M5 验收清单 + M4/M5 统一验收摘要

> 自动化基线（最终）：`cargo test` **164/164**；vitest **170/170**（25 个文件）；`tsc --noEmit` 0 错误。

## M5「好检索好迁移」

| # | 检查项 | 结果 |
|---|---|---|
| 1 | UI 大修：字号/间距/图标对齐原型（用户裁定首要） | ✅ 全组件过一遍（基础 14px+、按钮 px-3 py-1.5、图标 17px、留白放宽）；人工验收为准 |
| 2 | 全局搜索：Ctrl+Shift+F 覆盖层、分组结果（文稿/资料/版本可选）、点击跳转、命中高亮 | ✅ search_all 命令 + GlobalSearch 组件 + 测试 |
| 3 | 标签过滤（§4.3 尾欠） | ✅ PostTree 过滤器补标签下拉 |
| 4 | Markdown 导出：目录结构 + frontmatter 透传 + 附件随行 + 链接重写 | ✅ export.rs export_md + tempdir 往返测试 |
| 5 | 单文稿 zip 打包：正文+引用附件+历史+发布版本，包内引用重写 | ✅ zip crate + ZipArchive 校验测试 |
| 6 | 忽略规则：扫描/kb 树排除 .git、node_modules | ✅ scan/list_kb_dirs/health 过滤 + 测试 |

## M4「有 AI」（含两轮验收反馈修复）

密钥 mock-store 根因修复（keyring windows-native）；路由说明 + 一键默认；预算移除（只留 token/时间，用户裁定）；编辑区白底 + 插入符；测试连接自动保存草稿密钥；悬空 wiki 提示；健康检查磁盘为准；知识库新建目录。其余 20 项见 `m4-qa-checklist.md`。

## 统一验收建议路径（人工）

1. 安装最新包 → 全局观感（字号/间距）→ 写作（白底、光标）
2. Ctrl+Shift+F 全局搜索 → 分组跳转；文稿列表按标签过滤
3. 设置 → 配 DeepSeek → 测试连接（应通）→ AI 工作台总结一篇 → 存为资料
4. 选中文本 → 浮条润色 → 替换选区；全文「查错」逐条采纳
5. 文稿右键「打包导出…」→ 解压 zip 检查（正文/_assets/历史/发布版本、链接指向包内）
6. 左栏「导出 Markdown…」→ 导出 kb 树到本地目录 → 裸编辑器打开抽查
7. 健康检查 → 四类清单 + 孤儿附件确认清理
8. 拷走整个工作区目录 → 指向新位置打开（拷走即迁移终验）

## 构建产物（2026-08-20 最终包）

`C:\Users\lijun\.mewbox-cargo-target\release\bundle\nsis\MewBox_0.1.0_x64-setup.exe`
