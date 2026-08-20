import { useEffect, useMemo, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { api } from "../lib/api";
import { useApp } from "../stores/app";
import { PostTree } from "./PostTree";
import { NewPostDialog } from "./NewPostDialog";
import { EditorPane } from "./EditorPane";
import { OutlinePanel } from "./OutlinePanel";
import { HistoryPanel } from "./HistoryPanel";
import { BacklinksPanel } from "./BacklinksPanel";
import { TrashPanel } from "./TrashPanel";
import { KbTree } from "./KbTree";
import { HealthPanel } from "./HealthPanel";
import { MaterialSearchPanel } from "./MaterialSearchPanel";
import { AIWorkbench } from "./AIWorkbench";
import { SettingsPanel } from "./SettingsPanel";
import { GlobalSearch } from "./GlobalSearch";

/** Markdown 目录导出（M5，DESIGN §12）：posts 平铺 / kb 树，frontmatter 透传、附件随行 */
function ExportButtons() {
  const [note, setNote] = useState<string | null>(null);

  const run = async (scope: "posts" | "kb") => {
    const dir = await openFileDialog({
      directory: true,
      title: scope === "posts" ? "选择文稿导出目录" : "选择知识库导出目录",
    });
    if (typeof dir !== "string" || !dir) return;
    try {
      const r = await api.exportMd(scope, dir);
      setNote(`已导出 ${r.files} 个文件、${r.assets} 个附件`);
    } catch (err) {
      setNote(`导出失败：${err}`);
    }
  };

  return (
    <div className="border-t border-dashed border-[var(--line)] px-4 py-2">
      <button
        onClick={() => void run("posts")}
        className="w-full py-1.5 text-left text-[13px] text-[var(--muted)] hover:text-[var(--ink)]"
        data-testid="export-posts"
      >
        📤 导出文稿 Markdown…
      </button>
      <button
        onClick={() => void run("kb")}
        className="w-full py-1.5 text-left text-[13px] text-[var(--muted)] hover:text-[var(--ink)]"
        data-testid="export-kb"
      >
        📤 导出知识库 Markdown…
      </button>
      {note && (
        <p className="pt-1 text-xs text-[var(--green)]" data-testid="export-note">
          {note}
        </p>
      )}
    </div>
  );
}

/** 左栏：文稿区 / 知识库区（M3）/ 全局搜索入口（M5）/ 导出 / 回收站与健康检查入口 */
function LeftColumn({ onCreate }: { onCreate: () => void }) {
  const posts = useApp((s) => s.posts);
  const setTrashOpen = useApp((s) => s.setTrashOpen);
  const setSettingsOpen = useApp((s) => s.setSettingsOpen);
  const setSearchOpen = useApp((s) => s.setSearchOpen);
  const trashCount = useApp((s) => s.trash.length);
  const [healthOpen, setHealthOpen] = useState(false);

  return (
    <aside className="flex w-[248px] flex-none flex-col overflow-auto border-r border-[var(--line)] bg-[var(--card)]">
      <div className="px-3 pt-3 pb-2">
        <span className="inline-flex items-center gap-2 rounded-[10px] bg-[var(--cat)] px-3 py-2 text-sm font-bold text-white">
          🐾 喵盒
        </span>
      </div>

      <PostTree onNewPost={onCreate} />

      <KbTree />

      <section className="border-t border-[var(--line)] px-3 py-3" aria-label="全局搜索">
        <button
          onClick={() => setSearchOpen(true)}
          className="flex w-full items-center justify-between rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-[13px] font-semibold text-[var(--ink)] hover:border-[var(--cat)]"
          data-testid="search-entry"
        >
          <span>🔍 全局搜索</span>
          <span className="text-[11px] font-normal text-[var(--muted)]">Ctrl+Shift+F</span>
        </button>
      </section>

      <div className="mt-auto border-t border-dashed border-[var(--line)]">
        <button
          onClick={() => setSettingsOpen(true)}
          className="w-full px-4 py-2.5 text-left text-[13px] text-[var(--muted)] hover:text-[var(--ink)]"
          data-testid="settings-entry"
        >
          ⚙ 设置
        </button>
        <button
          onClick={() => setHealthOpen(true)}
          className="w-full px-4 py-2.5 text-left text-[13px] text-[var(--muted)] hover:text-[var(--ink)]"
          data-testid="health-entry"
        >
          🩺 健康检查
        </button>
        <ExportButtons />
        <button
          onClick={() => setTrashOpen(true)}
          className="w-full border-t border-dashed border-[var(--line)] px-4 py-2.5 text-left text-[13px] text-[var(--muted)] hover:text-[var(--ink)]"
          data-testid="trash-entry"
        >
          🗑 回收站{trashCount > 0 ? `（${trashCount}）` : ""}
        </button>
      </div>
      <div className="hidden">{posts.length}</div>

      <HealthPanel open={healthOpen} onClose={() => setHealthOpen(false)} />
    </aside>
  );
}

/** 主区空状态（prototype/09-empty 基调） */
function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-1 items-center justify-center" data-testid="empty-state">
      <div className="max-w-md text-center">
        <div className="mb-4 text-6xl">🐱📦</div>
        <h2 className="mb-2 text-2xl font-bold">喵盒等你落笔</h2>
        <p className="mb-6 text-sm text-[var(--muted)]">
          本地优先的写作工作台——文稿是裸 Markdown，拷走目录即迁移。
        </p>
        <button
          onClick={onCreate}
          className="rounded-lg bg-[var(--cat)] px-6 py-2.5 text-sm font-semibold text-white"
        >
          新建文稿
        </button>
      </div>
    </div>
  );
}

const RIGHT_TABS = [
  ["outline", "大纲"],
  ["backlinks", "反链"],
  ["history", "历史"],
  ["material-search", "资料检索"],
  ["ai", "AI"],
] as const;

export function AppShell() {
  const loading = useApp((s) => s.loading);
  const load = useApp((s) => s.load);
  const create = useApp((s) => s.create);
  const selected = useApp((s) => s.selected);
  const view = useApp((s) => s.view);
  const version = useApp((s) => s.version);
  const material = useApp((s) => s.material);
  const rightTab = useApp((s) => s.rightTab);
  const setRightTab = useApp((s) => s.setRightTab);
  const settingsOpen = useApp((s) => s.settingsOpen);
  const setSettingsOpen = useApp((s) => s.setSettingsOpen);

  const [creating, setCreating] = useState(false);
  const posts = useApp((s) => s.posts);
  const folders = useMemo(
    () => [...new Set(posts.map((p) => p.folder).filter(Boolean) as string[])],
    [posts],
  );

  useEffect(() => {
    load().catch(console.error);
  }, [load]);

  // Ctrl/Cmd+K → 资料检索页签并聚焦输入框（T13）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setRightTab("material-search");
        window.dispatchEvent(new Event("mewbox:focus-material-search"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setRightTab]);

  const onCreate = () => setCreating(true);
  const onCreateConfirm = async (title: string, folder?: string) => {
    setCreating(false);
    await create(title, folder);
  };

  if (loading) {
    return <div className="flex h-full items-center justify-center text-sm text-[var(--muted)]">正在打开工作区…</div>;
  }

  const hasEditorTarget =
    selected !== null ||
    (view.kind === "version" && version !== null) ||
    (view.kind === "material" && material !== null);

  return (
    <div className="flex h-full">
      <LeftColumn onCreate={onCreate} />
      <main className="flex min-w-0 flex-1 flex-col bg-[var(--bg)]">
        {/* 版本/资料模式下 selected 为空，但编辑器照常渲染（横幅标识归属） */}
        {hasEditorTarget ? <EditorPane /> : <EmptyState onCreate={onCreate} />}
      </main>
      <aside className="flex w-[304px] flex-none flex-col border-l border-[var(--line)] bg-[var(--card)]">
        <div className="flex gap-1.5 border-b border-[var(--line)] p-2.5">
          {RIGHT_TABS.map(([tab, label]) => (
            <button
              key={tab}
              onClick={() => setRightTab(tab)}
              className={`rounded-md px-3 py-1.5 text-[13px] ${
                rightTab === tab ? "bg-[var(--cat-bg)] font-semibold" : "text-[var(--muted)]"
              }`}
              data-testid={`tab-${tab}`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex min-h-0 flex-1 flex-col" data-testid={`panel-${rightTab}`}>
          {rightTab === "outline" ? (
            <OutlinePanel />
          ) : rightTab === "backlinks" ? (
            <BacklinksPanel />
          ) : rightTab === "history" ? (
            <HistoryPanel />
          ) : rightTab === "material-search" ? (
            <MaterialSearchPanel />
          ) : (
            <AIWorkbench />
          )}
        </div>
      </aside>

      <TrashPanel />

      <GlobalSearch />

      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      <NewPostDialog
        open={creating}
        folders={folders}
        onCancel={() => setCreating(false)}
        onCreate={onCreateConfirm}
      />
    </div>
  );
}
