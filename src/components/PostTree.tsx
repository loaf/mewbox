import { useMemo, useState } from "react";
import { api, PostSummary, TreeNode } from "../lib/api";
import { useApp } from "../stores/app";
import { buildTree, filterAndSort, onFolderDrop, onPostDrop, UNCATEGORIZED } from "../lib/treeOps";

const STATUS_LABEL: Record<string, string> = {
  draft: "草稿",
  writing: "写作中",
  done: "完稿",
  archived: "归档",
};

/** 状态 chip（draft/writing/done 取 prototype chip-*，archived 灰底） */
export function StatusChip({ status }: { status: string }) {
  const cls =
    status === "draft"
      ? "bg-[#f3e3c8] text-[#9a7a3c]"
      : status === "writing"
        ? "bg-[var(--cat-bg)] text-[var(--cat)]"
        : status === "done"
          ? "bg-[#e0ecdd] text-[var(--green)]"
          : "bg-[var(--cream)] text-[var(--muted)]"; // archived
  return (
    <span className={`ml-auto rounded-full px-2 py-px text-[10px] font-semibold ${cls}`} data-testid={`chip-${status}`}>
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

interface DragPayload {
  kind: "post" | "folder";
  id?: string;
  folderPath?: string;
}

/** 结构化的 DataTransfer 替身（jsdom 无 DataTransfer，鸭子类型即可） */
interface DtLike {
  setData: (type: string, value: string) => void;
  getData: (type: string) => string;
}

function makeDataTransfer(payload: DragPayload): DtLike {
  const store: Record<string, string> = {};
  const dt: DtLike = {
    setData: (type, value) => {
      store[type] = value;
    },
    getData: (type) => store[type] ?? "",
  };
  dt.setData("application/x-mewbox", JSON.stringify(payload));
  return dt;
}

function readPayload(e: { dataTransfer: DtLike }): DragPayload | null {
  try {
    const raw = e.dataTransfer.getData("application/x-mewbox");
    return raw ? (JSON.parse(raw) as DragPayload) : null;
  } catch {
    return null;
  }
}

export function PostTree({ onNewPost }: { onNewPost: () => void }) {
  const posts = useApp((s) => s.posts);
  const selectedId = useApp((s) => s.selectedId);
  const select = useApp((s) => s.select);
  const load = useApp((s) => s.load);

  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [sortKey, setSortKey] = useState<"updated" | "title">("updated");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<{ x: number; y: number; kind: "post" | "folder"; target: PostSummary | string } | null>(null);
  const [renameFolder, setRenameFolder] = useState<{ from: string } | null>(null);
  const [renameTitle, setRenameTitle] = useState<{ post: PostSummary } | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);

  const visible = useMemo(() => filterAndSort(posts, statusFilter, sortKey), [posts, statusFilter, sortKey]);
  const tree = useMemo(() => buildTree(visible), [visible]);

  const postById = (id: string) => posts.find((p) => p.id === id);

  const handleDropOnFolder = async (e: React.DragEvent, targetFolderPath: string | null) => {
    e.preventDefault();
    setDragOver(null);
    const payload = readPayload(e);
    if (!payload) return;
    if (payload.kind === "post" && payload.id) {
      const p = postById(payload.id);
      const op = onPostDrop(payload.id, p?.folder ?? null, targetFolderPath);
      if (op) {
        await api.setPostFolder(op.id, op.folder);
        await load();
      }
    } else if (payload.kind === "folder" && payload.folderPath) {
      const op = onFolderDrop(payload.folderPath, targetFolderPath);
      if (op) {
        await api.renameVirtualFolder(op.from, op.to);
        await load();
      }
    }
  };

  const renderFolder = (node: TreeNode, depth: number, pathPrefix: string) => {
    const path = pathPrefix ? `${pathPrefix}/${node.name}` : node.name;
    const isUncategorized = node.name === UNCATEGORIZED;
    return (
      <div key={path} data-testid={`folder-${path.replace(/\//g, "-")}`}>
        <div
          className={`flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1 text-[13px] font-semibold ${
            dragOver === path ? "border border-dashed border-[var(--cat)] bg-[var(--cat-bg)]" : ""
          }`}
          style={{ paddingLeft: 8 + depth * 12 }}
          onClick={() => setCollapsed((c) => ({ ...c, [path]: !c[path] }))}
          draggable={!isUncategorized}
          onDragStart={(e) => {
            e.dataTransfer.setData("application/x-mewbox", JSON.stringify({ kind: "folder", folderPath: path } as DragPayload));
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(path);
          }}
          onDragLeave={() => setDragOver(null)}
          onDrop={(e) => (isUncategorized ? handleDropOnFolder(e, null) : handleDropOnFolder(e, path))}
          onContextMenu={(e) => {
            if (isUncategorized) return;
            e.preventDefault();
            setMenu({ x: e.clientX, y: e.clientY, kind: "folder", target: path });
          }}
        >
          <span className="text-[10px] text-[var(--muted)]">{collapsed[path] ? "▸" : "▾"}</span>
          <span>{node.name}</span>
          <span className="text-[10px] text-[var(--muted)]">
            {node.posts.length + Object.values(node.children).length > 0
              ? ` (${node.posts.length + countDescendants(node)})`
              : ""}
          </span>
        </div>
        {!collapsed[path] && (
          <div>
            {Object.values(node.children).map((c) => renderFolder(c, depth + 1, path))}
            {node.posts.map((ref) => {
              const p = postById(ref.id);
              if (!p) return null;
              return (
                <div
                  key={ref.id}
                  data-testid="post-item"
                  className={`flex cursor-pointer items-center gap-2 rounded-lg py-1 pr-2 text-[13px] ${
                    selectedId === ref.id ? "bg-[var(--cat-bg)] font-semibold" : "hover:bg-[var(--cream)]"
                  }`}
                  style={{ paddingLeft: 20 + depth * 12 }}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData("application/x-mewbox", JSON.stringify({ kind: "post", id: ref.id } as DragPayload));
                  }}
                  onClick={() => select(ref.id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu({ x: e.clientX, y: e.clientY, kind: "post", target: p });
                  }}
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-[var(--cat-lt)]" />
                  <span className="truncate">{p.title}</span>
                  <StatusChip status={p.status} />
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  return (
    <section className="border-t border-[var(--line)] px-2 py-3" aria-label="文稿">
      <div className="mb-2 flex items-center justify-between px-1">
        <span className="text-xs font-bold tracking-wide text-[var(--muted)]">📄 文稿</span>
        <button
          onClick={onNewPost}
          className="rounded-md border border-[var(--line)] bg-white px-2 py-0.5 text-[11px]"
          data-testid="new-post"
        >
          + 新建
        </button>
      </div>

      <div className="mb-2 flex gap-1 px-1">
        <select
          data-testid="status-filter"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="w-1/2 rounded-md border border-[var(--line)] bg-white px-1 py-0.5 text-[11px]"
        >
          <option value="all">全部状态</option>
          <option value="draft">草稿</option>
          <option value="writing">写作中</option>
          <option value="done">完稿</option>
          <option value="archived">归档</option>
        </select>
        <select
          data-testid="sort-key"
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value as "updated" | "title")}
          className="w-1/2 rounded-md border border-[var(--line)] bg-white px-1 py-0.5 text-[11px]"
        >
          <option value="updated">按更新时间</option>
          <option value="title">按标题</option>
        </select>
      </div>

      {tree.map((node) => renderFolder(node, 0, ""))}
      {posts.length === 0 && (
        <div className="px-2 py-4 text-center text-xs text-[var(--muted)]">
          还没有文稿，点「+ 新建」开始写作
        </div>
      )}

      {menu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <div
            className="fixed z-50 min-w-[140px] rounded-lg border border-[var(--line)] bg-white py-1 text-xs shadow-lg"
            style={{ left: menu.x, top: menu.y }}
            data-testid="context-menu"
          >
            {menu.kind === "folder" ? (
              <button
                className="block w-full px-3 py-1.5 text-left hover:bg-[var(--cream)]"
                onClick={() => {
                  setRenameFolder({ from: menu.target as string });
                  setMenu(null);
                }}
                data-testid="menu-rename-folder"
              >
                重命名目录
              </button>
            ) : (
              <>
                <button
                  className="block w-full px-3 py-1.5 text-left hover:bg-[var(--cream)]"
                  onClick={() => {
                    setRenameTitle({ post: menu.target as PostSummary });
                    setMenu(null);
                  }}
                  data-testid="menu-rename-title"
                >
                  改标题
                </button>
                {(["draft", "writing", "done", "archived"] as const).map((s) => (
                  <button
                    key={s}
                    className="block w-full px-3 py-1.5 text-left hover:bg-[var(--cream)]"
                    onClick={async () => {
                      const post = menu.target as PostSummary;
                      setMenu(null);
                      await api.setPostStatus(post.id, s);
                      await load();
                    }}
                  >
                    标记为{STATUS_LABEL[s]}
                  </button>
                ))}
                <button
                  className="block w-full px-3 py-1.5 text-left text-[var(--red)] hover:bg-[var(--cream)]"
                  data-testid="menu-trash"
                  onClick={async () => {
                    const post = menu.target as PostSummary;
                    setMenu(null);
                    if (window.confirm(`移入回收站？「${post.title}」可在 30 天内恢复。`)) {
                      await api.movePostToTrash(post.id);
                      await load();
                      if (useApp.getState().selectedId === post.id) await useApp.getState().select(null);
                    }
                  }}
                >
                  移入回收站
                </button>
              </>
            )}
          </div>
        </>
      )}

      {renameFolder && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="w-[340px] rounded-xl border border-[var(--line)] bg-[var(--card)] p-5 shadow-xl" data-testid="rename-folder-dialog">
            <h3 className="mb-3 text-sm font-bold">重命名目录</h3>
            <p className="mb-2 text-xs text-[var(--muted)]">{renameFolder.from} →</p>
            <input
              autoFocus
              defaultValue={renameFolder.from}
              data-testid="rename-folder-input"
              onKeyDown={async (e) => {
                if (e.key === "Enter") {
                  const to = (e.target as HTMLInputElement).value.trim();
                  if (to && to !== renameFolder.from) {
                    await api.renameVirtualFolder(renameFolder.from, to);
                    await load();
                  }
                  setRenameFolder(null);
                }
              }}
              className="mb-4 w-full rounded-lg border border-[var(--line)] px-3 py-2 text-sm outline-none focus:border-[var(--cat)]"
            />
            <div className="flex justify-end gap-2">
              <button onClick={() => setRenameFolder(null)} className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-xs">
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {renameTitle && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="w-[340px] rounded-xl border border-[var(--line)] bg-[var(--card)] p-5 shadow-xl" data-testid="rename-title-dialog">
            <h3 className="mb-3 text-sm font-bold">改标题（不改文件名）</h3>
            <input
              autoFocus
              defaultValue={renameTitle.post.title}
              data-testid="rename-title-input"
              onKeyDown={async (e) => {
                if (e.key === "Enter") {
                  const title = (e.target as HTMLInputElement).value.trim();
                  if (title) {
                    await api.setPostTitle(renameTitle.post.id, title);
                    await load();
                  }
                  setRenameTitle(null);
                }
              }}
              className="mb-4 w-full rounded-lg border border-[var(--line)] px-3 py-2 text-sm outline-none focus:border-[var(--cat)]"
            />
            <div className="flex justify-end gap-2">
              <button onClick={() => setRenameTitle(null)} className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-xs">
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function countDescendants(node: TreeNode): number {
  return Object.values(node.children).reduce((n, c) => n + countDescendants(c), node.posts.length);
}

export { makeDataTransfer };
