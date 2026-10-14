import { useMemo, useState } from "react";
import { save as saveDialogFile } from "@tauri-apps/plugin-dialog";
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
    <span className={`ml-auto flex-none rounded px-2.5 py-1 text-[11px] font-semibold ${cls}`} data-testid={`chip-${status}`}>
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
  const selectedId2 = useApp((s) => s.selectedId2);
  const pane2Open = useApp((s) => s.pane2Open);
  const view = useApp((s) => s.view);
  const versionCounts = useApp((s) => s.versionCounts);
  const select = useApp((s) => s.select);
  const load = useApp((s) => s.load);

  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [tagFilter, setTagFilter] = useState<string>("all");
  const [sortKey, setSortKey] = useState<"updated" | "title">("updated");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<{ x: number; y: number; kind: "post" | "folder"; target: PostSummary | string } | null>(null);
  const [renameFolder, setRenameFolder] = useState<{ from: string } | null>(null);
  const [renameTitle, setRenameTitle] = useState<{ post: PostSummary } | null>(null);
  const [renameSlug, setRenameSlug] = useState<{ post: PostSummary } | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [zipNote, setZipNote] = useState<string | null>(null);

  /** 全体文稿的标签清单（§4.3 标签过滤下拉） */
  const tags = useMemo(
    () => [...new Set(posts.flatMap((p) => p.tags))].sort((a, b) => a.localeCompare(b, "zh")),
    [posts],
  );
  const visible = useMemo(
    () => filterAndSort(posts, statusFilter, sortKey, tagFilter),
    [posts, statusFilter, sortKey, tagFilter],
  );
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
          className={`flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1.5 text-[13px] font-semibold ${
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
              // 版本态：左栏高亮母版（版本本身不进列表，DESIGN 决策 8）
              const isBase = view.kind === "version" && view.baseId === ref.id;
              const vCount = versionCounts[ref.id] ?? 0;
              // 双栏：主栏强高亮，次栏打开的篇目弱标记（浅底 + 空心点）
              const inPane2 = pane2Open && selectedId2 === ref.id && !(selectedId === ref.id || isBase);
              return (
                <div
                  key={ref.id}
                  data-testid="post-item"
                  className={`flex cursor-pointer items-center gap-2 rounded-lg py-1.5 pr-2 text-[13px] ${
                    selectedId === ref.id || isBase
                      ? "bg-[var(--cat-bg)] font-semibold"
                      : inPane2
                        ? "bg-[var(--cream)]"
                        : "hover:bg-[var(--cream)]"
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
                  <span className={`h-1.5 w-1.5 flex-none rounded-full ${isBase ? "bg-[var(--box)]" : "bg-[var(--cat-lt)]"}`} />
                  <span className="min-w-0 flex-1 truncate">{p.title}</span>
                  {vCount > 0 && (
                    <span
                      className="flex-none rounded bg-[var(--cream)] px-2 py-1 text-[11px] font-semibold text-[var(--box-dk)]"
                      title={`${vCount} 个发布版本`}
                      data-testid="version-badge"
                    >
                      📣{vCount}
                    </span>
                  )}
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
    <section className="px-3 py-4" aria-label="文稿">
      <div className="mb-2.5 flex items-center justify-between px-1">
        <span className="text-[11.5px] font-bold tracking-[0.04em] text-[var(--muted)]">📄 文稿</span>
        <button
          onClick={onNewPost}
          className="px-1.5 py-1 text-[12px] font-semibold text-[var(--cat)] hover:text-[var(--cat-dk)]"
          data-testid="new-post"
        >
          + 新建
        </button>
      </div>

      <div className="mb-3 flex gap-1.5 px-1">
        <select
          data-testid="status-filter"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="w-1/3 rounded-md border border-[var(--line)] bg-white px-2 py-1.5 text-[12px]"
        >
          <option value="all">全部状态</option>
          <option value="draft">草稿</option>
          <option value="writing">写作中</option>
          <option value="done">完稿</option>
          <option value="archived">归档</option>
        </select>
        <select
          data-testid="tag-filter"
          value={tagFilter}
          onChange={(e) => setTagFilter(e.target.value)}
          className="w-1/3 rounded-md border border-[var(--line)] bg-white px-2 py-1.5 text-[12px]"
        >
          <option value="all">全部标签</option>
          {tags.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <select
          data-testid="sort-key"
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value as "updated" | "title")}
          className="w-1/3 rounded-md border border-[var(--line)] bg-white px-2 py-1.5 text-[12px]"
        >
          <option value="updated">按更新时间</option>
          <option value="title">按标题</option>
        </select>
      </div>

      {zipNote && (
        <p className="mb-2 px-2 text-xs text-[var(--green)]" data-testid="zip-note">
          {zipNote}
        </p>
      )}

      {tree.map((node) => renderFolder(node, 0, ""))}
      {visible.length === 0 && posts.length > 0 && (
        <div className="px-2 py-4 text-center text-xs text-[var(--muted)]">
          没有符合过滤条件的文稿
        </div>
      )}
      {posts.length === 0 && (
        <div className="px-2 py-4 text-center text-xs text-[var(--muted)]">
          还没有文稿，点「+ 新建」开始写作
        </div>
      )}

      {menu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <div
            className="fixed z-50 min-w-[160px] rounded-lg border border-[var(--line)] bg-white py-1.5 text-[13px] shadow-lg"
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
                    const post = menu.target as PostSummary;
                    setMenu(null);
                    void useApp.getState().openPane2(post.id);
                  }}
                  data-testid="menu-open-pane2"
                >
                  在分栏中打开
                </button>
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
                <button
                  className="block w-full px-3 py-1.5 text-left hover:bg-[var(--cream)]"
                  onClick={() => {
                    setRenameSlug({ post: menu.target as PostSummary });
                    setMenu(null);
                  }}
                  data-testid="menu-rename-slug"
                >
                  重命名文件…
                </button>
                <button
                  className="block w-full px-3 py-1.5 text-left hover:bg-[var(--cream)]"
                  data-testid="menu-export-zip"
                  onClick={async () => {
                    const post = menu.target as PostSummary;
                    setMenu(null);
                    // 打包导出（M5，DESIGN §12）：正文+附件+历史+发布版本
                    const dest = await saveDialogFile({
                      title: "打包导出文稿",
                      defaultPath: `${post.title}.zip`,
                    });
                    if (!dest) return;
                    try {
                      await api.exportPostZip(post.id, dest);
                      setZipNote(`已打包导出：${dest}`);
                    } catch (err) {
                      setZipNote(`打包导出失败：${err}`);
                    }
                  }}
                >
                  打包导出…
                </button>
                <button
                  className="block w-full px-3 py-1.5 text-left hover:bg-[var(--cream)]"
                  onClick={async () => {
                    const post = menu.target as PostSummary;
                    setMenu(null);
                    await api.convertPostToMaterial(post.id);
                    await load();
                    if (useApp.getState().selectedId === post.id) await useApp.getState().select(null);
                  }}
                  data-testid="menu-convert-material"
                >
                  转为资料
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
          <div className="w-[360px] rounded-xl border border-[var(--line)] bg-[var(--card)] p-6 shadow-xl" data-testid="rename-folder-dialog">
            <h3 className="mb-3 text-base font-bold">重命名目录</h3>
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
              <button onClick={() => setRenameFolder(null)} className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-[13px]">
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {renameTitle && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="w-[360px] rounded-xl border border-[var(--line)] bg-[var(--card)] p-6 shadow-xl" data-testid="rename-title-dialog">
            <h3 className="mb-3 text-base font-bold">改标题（不改文件名）</h3>
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
              <button onClick={() => setRenameTitle(null)} className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-[13px]">
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {renameSlug && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="w-[360px] rounded-xl border border-[var(--line)] bg-[var(--card)] p-6 shadow-xl" data-testid="rename-slug-dialog">
            <h3 className="mb-3 text-base font-bold">重命名文件（slug）</h3>
            <p className="mb-2 text-xs text-[var(--muted)]">
              改的是<strong>物理文件名</strong>（磁盘上的 posts/xxx.md），<strong>列表显示的标题不变</strong>
              ——改标题请用「改标题」。正文与关联块里的引用会自动同步到新路径。
            </p>
            <p className="mb-2 text-[10px] text-[var(--muted)]">
              当前：posts/{renameSlug.post.path.split("/").pop()}
            </p>
            <input
              autoFocus
              defaultValue={renameSlug.post.path.split("/").pop()?.replace(/\.md$/, "") ?? ""}
              data-testid="rename-slug-input"
              onKeyDown={async (e) => {
                if (e.key === "Enter") {
                  const slug = (e.target as HTMLInputElement).value.trim();
                  if (slug) {
                    await api.renamePostSlug(renameSlug.post.id, slug);
                    await load();
                  }
                  setRenameSlug(null);
                }
              }}
              className="mb-4 w-full rounded-lg border border-[var(--line)] px-3 py-2 text-sm outline-none focus:border-[var(--cat)]"
            />
            <div className="flex justify-end gap-2">
              <button onClick={() => setRenameSlug(null)} className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-[13px]">
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
