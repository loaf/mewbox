# 喵盒 MewBox

本地优先的个人写作工作台：Markdown 文稿为核心，发布版本独立演化，知识库服务写作，AI 作为无状态工具层。设计见 [DESIGN.md](./DESIGN.md)，路线图与里程碑计划见 [docs/superpowers/plans/](./docs/superpowers/plans/)。

## 开发

技术栈：Tauri 2（Rust）+ React 19 + TypeScript + Tailwind 4 + @uiw/react-md-editor；索引 SQLite(rusqlite) + FTS5 + jieba-rs。

```bash
pnpm install          # 安装依赖
pnpm tauri dev        # 开发运行（debug 构建默认工作区 = 仓库根 dev-workspace/）
pnpm tauri build      # 产出安装包（NSIS）
```

### 测试

```bash
cargo test --manifest-path src-tauri/Cargo.toml   # Rust 全部单测
bash scripts/sync-to-local.sh                      # 同步源码到 C:\mewbox-work（本地镜像）
cd /c/mewbox-work && npx vitest run                # 前端测试在镜像里跑
cd /c/mewbox-work && npx tsc --noEmit              # 类型检查同样在镜像里
```

### ⚠️ 本仓库在网络盘（RaiDrive）上的适配

1. **Rust target 在本地盘**：`src-tauri/.cargo/config.toml` 与根 `.cargo/config.toml` 将 target-dir 指向 `C:/Users/lijun/.mewbox-cargo-target`——网络盘上并行编译/链接会丢失中间对象文件（LNK1181）。
2. **前端测试走本地镜像**：vitest worker 从网络盘加载模块图会超过其硬编码的 60s 启动超时，因此用 `scripts/sync-to-local.sh`（robocopy）把源码镜像到 `C:\mewbox-work`，测试与类型检查都在镜像执行；镜像里不含 src-tauri 与文档。
3. pnpm 使用 `node-linker=hoisted`（`.npmrc`）：网络盘不支持 pnpm 默认布局所需的符号链接。

### 工作区数据

debug 构建默认工作区为仓库根 `dev-workspace/`（可用环境变量 `MEWBOX_WORKSPACE` 覆盖）；release 构建记住上次工作区（`%APPDATA%/com.mewbox.app/last-workspace.json`），首次运行弹出选择对话框。工作区目录自包含，拷走即迁移；`.index/index.db` 只是可重建缓存。
