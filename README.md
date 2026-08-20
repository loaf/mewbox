# 喵盒 MewBox 🐾📦

> 本地优先的个人写作工作台：Markdown 文稿为核心，每篇文稿可派生多个**发布版本**（公众号/博客/微博…）独立演化；配套**知识库**服务写作，资料与文稿、文稿与文稿双向**关联**（关联在文件内容尾部可见）；**AI 作为无状态工具层**——总结/翻译/改写/润色/查错，全程人工把关。

**设计文档**：[DESIGN.md](./DESIGN.md) ｜ **里程碑计划与 QA 清单**：[docs/superpowers/plans/](./docs/superpowers/plans/) ｜ **界面原型**：[prototype/](./prototype/)

## ✨ 功能总览

| 能力 | 说明 |
|---|---|
| 📄 文稿 | 源码/分栏/预览三模式（GFM/KaTeX/mermaid/高亮/==标记==/上下标/emoji）；防抖自动保存；虚拟目录树（拖拽改分类、状态/标签过滤）；回收站 30 天可恢复 |
| 🕘 历史 | 自动快照（48h 全留→每日→每周）、里程碑永留、双栏 diff、非破坏恢复；发布版本独立历史 |
| 📣 发布版本 | 一目标一版本、从文稿或指定历史分叉、相对引用自动重写、从文稿同步（先快照）、发布记录回填；不进侧栏、横幅标识归属 |
| 📚 知识库 | kb 物理目录树（Inbox 默认落点）、资料与文稿同一编辑器（默认历史）、md 导入透传、非 md 文件自动容器化（原件指纹入 `_assets/`） |
| 🔗 关联 | 尾部关联块双侧同步（裸读 md 即见关联）、`[[wiki 链接]]` 跳转与重名候选、反链面板、资料⇄文稿互转、移动/改名全量引用同步、健康检查 |
| 🤖 AI | OpenAI 兼容/Anthropic/Ollama 三家 SSE 流式；API Key 存系统钥匙串；操作→模型路由 + fallback；调用留痕与用量统计；AI 工作台（混合多选上下文）+ 选区工具条 + 全文润色/查错（逐条采纳）+ 快捷搜索资料 |
| 🔍 检索迁移 | FTS5 + jieba 中英混排全局搜索；Markdown 导出（附件随行）；单文稿 zip 打包（正文+附件+历史+发布版本）；工作区目录拷走即迁移 |

## 🛠 开发

技术栈：Tauri 2（Rust）+ React 19 + TypeScript + Tailwind 4 + @uiw/react-md-editor；SQLite（rusqlite + FTS5）+ jieba-rs；LLM 走 Rust（reqwest + SSE）。

```bash
pnpm install          # 安装依赖
pnpm tauri dev        # 开发运行（debug 构建默认工作区 = 仓库根 dev-workspace/）
pnpm tauri build      # 产出安装包（NSIS / MSI）
```

### 测试

```bash
cargo test --manifest-path src-tauri/Cargo.toml   # Rust 全部单测（164）
bash scripts/sync-to-local.sh                      # 同步源码到 C:\mewbox-work（本地镜像，见下）
cd /c/mewbox-work && npx vitest run                # 前端测试（170）在镜像里跑
cd /c/mewbox-work && npx tsc --noEmit              # 类型检查同样在镜像里
```

### ⚠️ 网络盘（RaiDrive）适配说明

仓库位于网络盘时的三项必要适配（普通本地盘可忽略）：

1. **Rust target 在本地盘**：`.cargo/config.toml` 将 target-dir 指向 `C:/Users/lijun/.mewbox-cargo-target`——网络盘上并行编译/链接会丢失中间对象文件（LNK1181）。
2. **前端测试走本地镜像**：vitest worker 从网络盘加载模块图会超过其硬编码的 60s 启动超时，用 `scripts/sync-to-local.sh`（robocopy）把源码镜像到 `C:\mewbox-work`，测试/类型检查在镜像执行。
3. **pnpm** 使用 `node-linker=hoisted`（`.npmrc`）：网络盘不支持默认符号链接布局。

### 工作区数据

debug 构建默认工作区为仓库根 `dev-workspace/`（可用环境变量 `MEWBOX_WORKSPACE` 覆盖）；release 记住上次工作区（`%APPDATA%/com.mewbox.app/last-workspace.json`），首次运行弹出选择对话框。工作区目录**自包含，拷走即迁移**；`.index/index.db` 只是可重建缓存。

## 🧭 架构速览

```
src/                  React 前端（stores zustand / lib 纯函数 / components）
src-tauri/src/        Rust 后端（薄命令层 + 领域模块）
  ├─ workspace.rs     工作区初始化与单实例锁
  ├─ frontmatter.rs   YAML frontmatter（未知键透传、稀疏序列化）
  ├─ history.rs       快照/保留策略/恢复/回收站清理
  ├─ index.rs         SQLite 元数据 + FTS5 + jieba 预分词 + 链接图 + ai_calls
  ├─ publish.rs       发布版本（frontmatter/链接重写/IO/同步）
  ├─ materials.rs     知识库（容器化导入/稀疏/引用重写）
  ├─ assoc.rs         尾部关联块（双侧同步、应用维护区）
  ├─ links.rs         文件间相对路径/wiki 引用
  ├─ health.rs        健康检查（断链/孤儿历史/无主版本/孤儿附件）
  ├─ ai.rs            编排（上下文/流式事件/结果去向/预算留痕）
  ├─ llm.rs           OpenAI/Anthropic/Ollama SSE 流式 + mock 测试
  └─ prompts.rs       中文 prompt 模板 + 容错 JSON 解析
```

## 📦 里程碑

M1 能写作 → M2 能发布 → M3 有知识库 → M4 有 AI → M5 好检索好迁移（+ UI 打磨）。各里程碑的验收 QA 清单见 `docs/superpowers/plans/`。
