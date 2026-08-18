import { useEffect, useMemo, useState } from "react";
import { useApp } from "../stores/app";
import { PostTree } from "./PostTree";
import { NewPostDialog } from "./NewPostDialog";
import { EditorPane } from "./EditorPane";
import { OutlinePanel } from "./OutlinePanel";
import { HistoryPanel } from "./HistoryPanel";
import { TrashPanel } from "./TrashPanel";

/** 左栏：文稿区（虚拟目录树）/ 回收站入口 / 占位区（知识库、全局搜索随 M3/M5） */
function LeftColumn({ onCreate }: { onCreate: () => void }) {
  const posts = useApp((s) => s.posts);
  const setTrashOpen = useApp((s) => s.setTrashOpen);
  const trashCount = useApp((s) => s.trash.length);

  return (
    <aside className="flex w-[236px] flex-none flex-col overflow-auto border-r border-[var(--line)] bg-[var(--card)]">
      <div className="px-3 pt-3 pb-2">
        <span className="inline-flex items-center gap-2 rounded-[10px] bg-[var(--cat)] px-3 py-1.5 text-sm font-bold text-white">
          🐾 喵盒
        </span>
      </div>

      <PostTree onNewPost={onCreate} />

      <section className="border-t border-[var(--line)] px-2 py-3 opacity-50" aria-label="知识库">
        <span className="px-1 text-xs font-bold tracking-wide text-[var(--muted)]">📚 知识库（M3）</span>
      </section>
      <section className="border-t border-[var(--line)] px-2 py-3 opacity-50" aria-label="全局搜索">
        <span className="px-1 text-xs font-bold tracking-wide text-[var(--muted)]">🔍 全局搜索（M5）</span>
      </section>

      <button
        onClick={() => setTrashOpen(true)}
        className="mt-auto border-t border-dashed border-[var(--line)] px-4 py-2 text-left text-xs text-[var(--muted)] hover:text-[var(--ink)]"
        data-testid="trash-entry"
      >
        🗑 回收站{trashCount > 0 ? `（${trashCount}）` : ""}
      </button>
      <div className="hidden">{posts.length}</div>
    </aside>
  );
}

/** 主区空状态（prototype/09-empty 基调） */
function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-1 items-center justify-center" data-testid="empty-state">
      <div className="max-w-md text-center">
        <div className="mb-4 text-5xl">🐱📦</div>
        <h2 className="mb-2 text-xl font-bold">喵盒等你落笔</h2>
        <p className="mb-6 text-sm text-[var(--muted)]">
          本地优先的写作工作台——文稿是裸 Markdown，拷走目录即迁移。
        </p>
        <button
          onClick={onCreate}
          className="rounded-lg bg-[var(--cat)] px-5 py-2 text-sm font-semibold text-white"
        >
          新建文稿
        </button>
      </div>
    </div>
  );
}

export function AppShell() {
  const loading = useApp((s) => s.loading);
  const load = useApp((s) => s.load);
  const create = useApp((s) => s.create);
  const selected = useApp((s) => s.selected);
  const rightTab = useApp((s) => s.rightTab);
  const setRightTab = useApp((s) => s.setRightTab);

  const [creating, setCreating] = useState(false);
  const posts = useApp((s) => s.posts);
  const folders = useMemo(
    () => [...new Set(posts.map((p) => p.folder).filter(Boolean) as string[])],
    [posts],
  );

  useEffect(() => {
    load().catch(console.error);
  }, [load]);

  const onCreate = () => setCreating(true);
  const onCreateConfirm = async (title: string, folder?: string) => {
    setCreating(false);
    await create(title, folder);
  };

  if (loading) {
    return <div className="flex h-full items-center justify-center text-sm text-[var(--muted)]">正在打开工作区…</div>;
  }

  return (
    <div className="flex h-full">
      <LeftColumn onCreate={onCreate} />
      <main className="flex min-w-0 flex-1 flex-col bg-[var(--bg)]">
        {selected ? <EditorPane /> : <EmptyState onCreate={onCreate} />}
      </main>
      <aside className="flex w-[288px] flex-none flex-col border-l border-[var(--line)] bg-[var(--card)]">
        <div className="flex gap-1 border-b border-[var(--line)] p-2">
          {(["outline", "history"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setRightTab(tab)}
              className={`rounded-md px-3 py-1 text-xs ${
                rightTab === tab ? "bg-[var(--cat-bg)] font-semibold" : "text-[var(--muted)]"
              }`}
              data-testid={`tab-${tab}`}
            >
              {tab === "outline" ? "大纲" : "历史"}
            </button>
          ))}
        </div>
        <div className="flex min-h-0 flex-1 flex-col" data-testid={`panel-${rightTab}`}>
          {rightTab === "outline" ? <OutlinePanel /> : <HistoryPanel />}
        </div>
      </aside>

      <TrashPanel />

      <NewPostDialog
        open={creating}
        folders={folders}
        onCancel={() => setCreating(false)}
        onCreate={onCreateConfirm}
      />
    </div>
  );
}
