import { useCallback, useEffect, useMemo, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { api, MaterialSummary } from "../lib/api";
import { useApp } from "../stores/app";
import { buildKbTree, kbDirPaths, KB_ROOT, KbTreeNode } from "../lib/kbTreeOps";

/** 左栏知识库区：kb 物理目录树（Inbox 第一）+ 资料右键操作 + 导入 + 资料回收站入口（DESIGN §6） */
export function KbTree() {
  const materials = useApp((s) => s.materials);
  const materialTrashCount = useApp((s) => s.materialTrash.length);
  const view = useApp((s) => s.view);
  const selectMaterial = useApp((s) => s.selectMaterial);
  const select = useApp((s) => s.select);
  const setTrashOpen = useApp((s) => s.setTrashOpen);
  const load = useApp((s) => s.load);

  const [kbDirs, setKbDirs] = useState<string[]>([]);
  const refreshDirs = useCallback(async () => {
    setKbDirs(await api.listKbDirs().catch(() => []));
  }, []);
  useEffect(() => {
    void refreshDirs();
  }, [refreshDirs, materials.length]);

  const tree = useMemo(() => buildKbTree(materials, kbDirs), [materials, kbDirs]);
  const dirPaths = useMemo(() => kbDirPaths(materials, kbDirs), [materials, kbDirs]);

  /** 新建目录（验收反馈：此前只能新建资料） */
  const onCreateDir = async (parent: string) => {
    const name = window.prompt(parent ? `在「${parent}」下新建目录，目录名：` : "新建目录（kb 根下），目录名：");
    if (!name?.trim()) return;
    try {
      await api.createKbDir(parent, name.trim());
      await refreshDirs();
    } catch (e) {
      window.alert(String(e));
    }
  };

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<
    { x: number; y: number; kind: "material" | "dir"; target: MaterialSummary | string } | null
  >(null);
  const [newDialog, setNewDialog] = useState<{ dir: string } | null>(null);
  const [renameDialog, setRenameDialog] = useState<{ m: MaterialSummary } | null>(null);
  const [moveDialog, setMoveDialog] = useState<{ m: MaterialSummary } | null>(null);
  const [renameDir, setRenameDir] = useState<{ from: string } | null>(null);

  const activeMaterialId = view.kind === "material" ? view.id : null;

  /** 导入：.md 透传到当前目录（资料视图 = 所在目录，否则 Inbox），其他文件容器化进 Inbox */
  const onImport = async () => {
    const picked = await openFileDialog({ multiple: true, title: "导入文件（.md 保留结构，其他容器化）" });
    if (!picked) return;
    const paths = Array.isArray(picked) ? picked : [picked];
    const md = paths.filter((p) => /\.md$/i.test(p));
    const others = paths.filter((p) => !/\.md$/i.test(p));
    const st = useApp.getState();
    const currentDir = st.view.kind === "material" ? (st.material?.folder ?? "Inbox") : "Inbox";
    if (md.length > 0) await api.importMdFiles(md, currentDir);
    if (others.length > 0) await api.importFilesContainerized(others);
    await load();
  };

  const onConvertToPost = async (m: MaterialSummary) => {
    const p = await api.convertMaterialToPost(m.id);
    await load();
    await select(p.id);
  };

  const onTrash = async (m: MaterialSummary) => {
    if (!window.confirm(`移入回收站？「${m.title}」可在 30 天内恢复。`)) return;
    await api.moveMaterialToTrash(m.id);
    await load();
    const st = useApp.getState();
    if (st.view.kind === "material" && st.view.id === m.id) {
      await st.selectMaterial(null);
    }
  };

  const renderDir = (node: KbTreeNode, depth: number, pathPrefix: string) => {
    const path = pathPrefix ? `${pathPrefix}/${node.name}` : node.name;
    const isVirtual = node.name === KB_ROOT; // kb 根散文件的虚拟节点：不可改名
    return (
      <div key={path} data-testid={`kb-folder-${path.replace(/\//g, "-")}`}>
        <div
          className="flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1 text-[13px] font-semibold"
          style={{ paddingLeft: 8 + depth * 12 }}
          onClick={() => setCollapsed((c) => ({ ...c, [path]: !c[path] }))}
          onContextMenu={(e) => {
            if (isVirtual) return;
            e.preventDefault();
            setMenu({ x: e.clientX, y: e.clientY, kind: "dir", target: path });
          }}
        >
          <span className="text-[10px] text-[var(--muted)]">{collapsed[path] ? "▸" : "▾"}</span>
          <span>{node.name}</span>
          <span className="text-[10px] text-[var(--muted)]">
            {node.materials.length > 0 ? ` (${node.materials.length})` : ""}
          </span>
        </div>
        {!collapsed[path] && (
          <div>
            {Object.values(node.children).map((c) => renderDir(c, depth + 1, path))}
            {node.materials.map((m) => (
              <div
                key={m.id}
                data-testid="material-item"
                className={`flex cursor-pointer items-center gap-2 rounded-lg py-1 pr-2 text-[13px] ${
                  activeMaterialId === m.id
                    ? "bg-[var(--cat-bg)] font-semibold"
                    : "hover:bg-[var(--cream)]"
                }`}
                style={{ paddingLeft: 20 + depth * 12 }}
                onClick={() => void selectMaterial(m.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ x: e.clientX, y: e.clientY, kind: "material", target: m });
                }}
              >
                <span className="text-[10px]">📎</span>
                <span className="truncate">{m.title}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <section className="border-t border-[var(--line)] px-2 py-3" aria-label="知识库">
      <div className="mb-2 flex items-center justify-between px-1">
        <span className="text-xs font-bold tracking-wide text-[var(--muted)]">📚 知识库</span>
        <div className="flex gap-1">
          <button
            onClick={() => setNewDialog({ dir: "Inbox" })}
            className="rounded-md border border-[var(--line)] bg-white px-2 py-0.5 text-[11px]"
            data-testid="kb-new-material"
          >
            + 新建
          </button>
          <button
            onClick={() => void onCreateDir("")}
            className="rounded-md border border-[var(--line)] bg-white px-2 py-0.5 text-[11px]"
            data-testid="kb-new-dir-btn"
            title="新建目录（kb 根下）"
          >
            📁+
          </button>
          <button
            onClick={() => void onImport()}
            className="rounded-md border border-[var(--line)] bg-white px-2 py-0.5 text-[11px]"
            data-testid="kb-import"
          >
            导入
          </button>
        </div>
      </div>

      {tree.map((node) => renderDir(node, 0, ""))}
      {materials.length === 0 && (
        <div className="px-2 py-3 text-center text-xs text-[var(--muted)]">
          知识库还是空的——点「导入」收集资料
        </div>
      )}

      <button
        onClick={() => setTrashOpen(true)}
        className="mt-2 w-full rounded-md px-2 py-1 text-left text-[11px] text-[var(--muted)] hover:text-[var(--ink)]"
        data-testid="kb-trash-entry"
      >
        🗑 资料回收站{materialTrashCount > 0 ? `（${materialTrashCount}）` : ""}
      </button>

      {/* 右键菜单 */}
      {menu && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu(null);
            }}
          />
          <div
            className="fixed z-50 min-w-[140px] rounded-lg border border-[var(--line)] bg-white py-1 text-xs shadow-lg"
            style={{ left: menu.x, top: menu.y }}
            data-testid="kb-context-menu"
          >
            {menu.kind === "material" ? (
              <>
                <button
                  className="block w-full px-3 py-1.5 text-left hover:bg-[var(--cream)]"
                  data-testid="kb-menu-open"
                  onClick={() => {
                    void selectMaterial((menu.target as MaterialSummary).id);
                    setMenu(null);
                  }}
                >
                  打开
                </button>
                <button
                  className="block w-full px-3 py-1.5 text-left hover:bg-[var(--cream)]"
                  data-testid="kb-menu-rename"
                  onClick={() => {
                    setRenameDialog({ m: menu.target as MaterialSummary });
                    setMenu(null);
                  }}
                >
                  重命名…
                </button>
                <button
                  className="block w-full px-3 py-1.5 text-left hover:bg-[var(--cream)]"
                  data-testid="kb-menu-move"
                  onClick={() => {
                    setMoveDialog({ m: menu.target as MaterialSummary });
                    setMenu(null);
                  }}
                >
                  移动到…
                </button>
                <button
                  className="block w-full px-3 py-1.5 text-left hover:bg-[var(--cream)]"
                  data-testid="kb-menu-convert-post"
                  onClick={() => {
                    void onConvertToPost(menu.target as MaterialSummary);
                    setMenu(null);
                  }}
                >
                  升格为文稿
                </button>
                <button
                  className="block w-full px-3 py-1.5 text-left text-[var(--red)] hover:bg-[var(--cream)]"
                  data-testid="kb-menu-trash"
                  onClick={() => {
                    void onTrash(menu.target as MaterialSummary);
                    setMenu(null);
                  }}
                >
                  移入回收站
                </button>
              </>
            ) : (
              <>
                <button
                  className="block w-full px-3 py-1.5 text-left hover:bg-[var(--cream)]"
                  data-testid="kb-menu-rename-dir"
                  onClick={() => {
                    setRenameDir({ from: menu.target as string });
                    setMenu(null);
                  }}
                >
                  重命名目录
                </button>
                <button
                  className="block w-full px-3 py-1.5 text-left hover:bg-[var(--cream)]"
                  data-testid="kb-menu-new-material"
                  onClick={() => {
                    setNewDialog({ dir: menu.target as string });
                    setMenu(null);
                  }}
                >
                  新建资料
                </button>
                <button
                  className="block w-full px-3 py-1.5 text-left hover:bg-[var(--cream)]"
                  data-testid="kb-menu-new-subdir"
                  onClick={() => {
                    const parent = (menu.target as string).replace(/^kb\/?/, "");
                    setMenu(null);
                    void onCreateDir(parent);
                  }}
                >
                  新建子目录
                </button>
              </>
            )}
          </div>
        </>
      )}

      {/* 新建资料 */}
      {newDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="w-[340px] rounded-xl border border-[var(--line)] bg-[var(--card)] p-5 shadow-xl" data-testid="kb-new-dialog">
            <h3 className="mb-3 text-sm font-bold">新建资料</h3>
            <input
              autoFocus
              data-testid="kb-new-title"
              placeholder="资料标题"
              onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
              className="mb-3 w-full rounded-lg border border-[var(--line)] px-3 py-2 text-sm outline-none focus:border-[var(--cat)]"
            />
            <input
              data-testid="kb-new-dir"
              defaultValue={newDialog.dir}
              list="kb-dirs"
              placeholder="目录（如 研究；空 = Inbox）"
              className="mb-4 w-full rounded-lg border border-[var(--line)] px-3 py-2 text-sm outline-none focus:border-[var(--cat)]"
            />
            <datalist id="kb-dirs">
              {dirPaths.map((d) => (
                <option key={d} value={d} />
              ))}
            </datalist>
            <div className="flex justify-end gap-2">
              <button onClick={() => setNewDialog(null)} className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-xs">
                取消
              </button>
              <button
                onClick={async () => {
                  const title = (document.querySelector('[data-testid="kb-new-title"]') as HTMLInputElement).value.trim();
                  const dir = (document.querySelector('[data-testid="kb-new-dir"]') as HTMLInputElement).value.trim();
                  if (!title) return;
                  setNewDialog(null);
                  await useApp.getState().createMaterial(title, dir || "Inbox");
                }}
                className="rounded-lg bg-[var(--cat)] px-3 py-1.5 text-xs font-semibold text-white"
                data-testid="kb-new-confirm"
              >
                创建
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 重命名资料文件 */}
      {renameDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="w-[340px] rounded-xl border border-[var(--line)] bg-[var(--card)] p-5 shadow-xl" data-testid="kb-rename-dialog">
            <h3 className="mb-3 text-sm font-bold">重命名资料文件</h3>
            <input
              autoFocus
              defaultValue={renameDialog.m.path.split("/").pop()?.replace(/\.md$/, "") ?? ""}
              data-testid="kb-rename-input"
              onKeyDown={async (e) => {
                if (e.key === "Enter") {
                  const name = (e.target as HTMLInputElement).value.trim();
                  if (name) {
                    await api.renameMaterialFile(renameDialog.m.id, name);
                    await load();
                  }
                  setRenameDialog(null);
                }
              }}
              className="mb-4 w-full rounded-lg border border-[var(--line)] px-3 py-2 text-sm outline-none focus:border-[var(--cat)]"
            />
            <div className="flex justify-end gap-2">
              <button onClick={() => setRenameDialog(null)} className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-xs">
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 移动资料（输入目录路径） */}
      {moveDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="w-[340px] rounded-xl border border-[var(--line)] bg-[var(--card)] p-5 shadow-xl" data-testid="kb-move-dialog">
            <h3 className="mb-3 text-sm font-bold">移动资料</h3>
            <p className="mb-2 text-xs text-[var(--muted)]">
              {moveDialog.m.path} → 引用与关联会自动同步
            </p>
            <input
              autoFocus
              defaultValue={moveDialog.m.folder ?? ""}
              list="kb-dirs"
              data-testid="kb-move-input"
              placeholder="目标目录（如 研究/子目录；空 = kb 根）"
              onKeyDown={async (e) => {
                if (e.key === "Enter") {
                  const dir = (e.target as HTMLInputElement).value.trim();
                  await api.moveMaterial(moveDialog.m.id, dir);
                  await load();
                  setMoveDialog(null);
                }
              }}
              className="mb-4 w-full rounded-lg border border-[var(--line)] px-3 py-2 text-sm outline-none focus:border-[var(--cat)]"
            />
            <div className="flex justify-end gap-2">
              <button onClick={() => setMoveDialog(null)} className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-xs">
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 重命名目录 */}
      {renameDir && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="w-[340px] rounded-xl border border-[var(--line)] bg-[var(--card)] p-5 shadow-xl" data-testid="kb-rename-dir-dialog">
            <h3 className="mb-3 text-sm font-bold">重命名目录</h3>
            <p className="mb-2 text-xs text-[var(--muted)]">{renameDir.from} →（引用自动同步）</p>
            <input
              autoFocus
              defaultValue={renameDir.from.split("/").pop() ?? ""}
              data-testid="kb-rename-dir-input"
              onKeyDown={async (e) => {
                if (e.key === "Enter") {
                  const name = (e.target as HTMLInputElement).value.trim();
                  if (name) {
                    await api.renameKbDir(`kb/${renameDir.from}`, name);
                    await load();
                  }
                  setRenameDir(null);
                }
              }}
              className="mb-4 w-full rounded-lg border border-[var(--line)] px-3 py-2 text-sm outline-none focus:border-[var(--cat)]"
            />
            <div className="flex justify-end gap-2">
              <button onClick={() => setRenameDir(null)} className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-xs">
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
