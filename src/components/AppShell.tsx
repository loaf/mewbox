import { useEffect, useState } from "react";
import { useApp } from "../stores/app";
import type { TreeNode } from "../lib/api";

/** 左栏：文稿区 / 回收站入口 / 占位区（知识库、全局搜索随 M3/M5） */
function LeftColumn({ onCreate }: { onCreate: () => void }) {
  const tree = useApp((s) => s.tree);
  const posts = useApp((s) => s.posts);
  const selectedId = useApp((s) => s.selectedId);
  const select = useApp((s) => s.select);
  const setTrashOpen = useApp((s) => s.setTrashOpen);
  const trashCount = useApp((s) => s.trash.length);

  const renderNode = (node: TreeNode, depth: number) => (
    <div key={node.name} className="mb-1">
      <div
        className="px-2 py-1 text-xs font-semibold text-[var(--muted)]"
        style={{ paddingLeft: 8 + depth * 12 }}
      >
        {node.name}
      </div>
      {Object.values(node.children).map((child) => renderNode(child, depth + 1))}
      {node.posts.map((p) => (
        <button
          key={p.id}
          onClick={() => select(p.id)}
          className={`block w-full truncate rounded-lg py-1.5 text-left text-[13px] ${
            selectedId === p.id
              ? "bg-[var(--cat-bg)] font-semibold text-[var(--ink)]"
              : "hover:bg-[var(--cream)]"
          }`}
          style={{ paddingLeft: 20 + depth * 12, paddingRight: 8 }}
          data-testid="post-item"
        >
          {p.title}
        </button>
      ))}
    </div>
  );

  return (
    <aside className="flex w-[236px] flex-none flex-col overflow-auto border-r border-[var(--line)] bg-[var(--card)]">
      <div className="px-3 pt-3 pb-2">
        <span className="inline-flex items-center gap-2 rounded-[10px] bg-[var(--cat)] px-3 py-1.5 text-sm font-bold text-white">
          🐾 喵盒
        </span>
      </div>

      <section className="border-t border-[var(--line)] px-2 py-3" aria-label="文稿">
        <div className="mb-2 flex items-center justify-between px-1">
          <span className="text-xs font-bold tracking-wide text-[var(--muted)]">📄 文稿</span>
          <button
            onClick={onCreate}
            className="rounded-md border border-[var(--line)] bg-white px-2 py-0.5 text-[11px]"
            data-testid="new-post"
          >
            + 新建
          </button>
        </div>
        {tree.map((node) => renderNode(node, 0))}
        {posts.length === 0 && (
          <div className="px-2 py-4 text-center text-xs text-[var(--muted)]">
            还没有文稿，点「+ 新建」开始写作
          </div>
        )}
      </section>

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

  const [newTitle, setNewTitle] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    load().catch(console.error);
  }, [load]);

  const onCreate = () => setCreating(true);
  const onCreateConfirm = async () => {
    if (!newTitle.trim()) return;
    setCreating(false);
    await create(newTitle.trim());
    setNewTitle("");
  };

  if (loading) {
    return <div className="flex h-full items-center justify-center text-sm text-[var(--muted)]">正在打开工作区…</div>;
  }

  return (
    <div className="flex h-full">
      <LeftColumn onCreate={onCreate} />
      <main className="flex min-w-0 flex-1 flex-col bg-[var(--bg)]">
        {selected ? (
          <div className="flex flex-1 items-center justify-center text-sm text-[var(--muted)]" data-testid="editor-placeholder">
            编辑器（Task 12 落地）
          </div>
        ) : (
          <EmptyState onCreate={onCreate} />
        )}
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
        <div className="flex-1 p-3 text-xs text-[var(--muted)]" data-testid={`panel-${rightTab}`}>
          {rightTab === "outline" ? "大纲面板（Task 13 落地）" : "历史面板（Task 14 落地）"}
        </div>
      </aside>

      {creating && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
          data-testid="new-post-dialog"
        >
          <div className="w-[360px] rounded-xl border border-[var(--line)] bg-[var(--card)] p-5 shadow-xl">
            <h3 className="mb-3 text-sm font-bold">新建文稿</h3>
            <input
              autoFocus
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && onCreateConfirm()}
              placeholder="标题"
              className="mb-4 w-full rounded-lg border border-[var(--line)] px-3 py-2 text-sm outline-none focus:border-[var(--cat)]"
              data-testid="new-post-title"
            />
            <div className="flex justify-end gap-2">
              <button onClick={() => setCreating(false)} className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-xs">
                取消
              </button>
              <button
                onClick={onCreateConfirm}
                className="rounded-lg bg-[var(--cat)] px-3 py-1.5 text-xs font-semibold text-white"
                data-testid="new-post-confirm"
              >
                创建
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
