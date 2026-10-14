import { useCallback, useEffect, useState } from "react";
import { api, AssocEntry, PostSummary, MaterialSummary } from "../lib/api";
import { useApp, PaneId, paneSlice } from "../stores/app";
import { usePaneValue, usePaneAction, paneOps } from "../stores/pane";

/** 版本条目 target（相对路径）→ (baseId, target)；形如 ../.versions/{base}/publish/{target}.md */
export function parseVersionTarget(target: string): { baseId: string; target: string } | null {
  const m = target.match(/\.versions\/([^/]+)\/publish\/([^/]+)\.md$/);
  return m ? { baseId: m[1], target: m[2] } : null;
}

/** 当前编辑目标（文稿/资料）的 id */
export function currentFileId(): string | null {
  const st = useApp.getState();
  if (st.view.kind === "material") return st.view.id;
  if (st.view.kind === "post") return st.selectedId;
  return null;
}

function Section({
  label,
  entries,
  idOf,
  onJump,
  onRemove,
}: {
  label: string;
  entries: AssocEntry[];
  idOf: (target: string) => string | null;
  onJump: (e: AssocEntry, id: string | null) => void;
  onRemove: (e: AssocEntry, id: string) => void;
}) {
  if (entries.length === 0) return null;
  return (
    <div className="flex items-center gap-1" data-testid={`assoc-section-${label}`}>
      <span className="text-[10px] font-semibold text-[var(--muted)]">{label}</span>
      {entries.map((e) => {
        const id = idOf(e.target);
        return (
          <span
            key={e.target}
            className="inline-flex items-center gap-1 rounded-full border border-[var(--line)] bg-white px-2 py-px text-[11px]"
            data-testid="assoc-entry"
          >
            <button
              className="max-w-[160px] truncate hover:underline disabled:no-underline disabled:opacity-50"
              disabled={!id}
              onClick={() => onJump(e, id)}
              title={e.target}
            >
              {e.title}
            </button>
            {id && (
              <button
                className="text-[10px] text-[var(--muted)] hover:text-[var(--red)]"
                onClick={() => onRemove(e, id)}
                data-testid="assoc-remove"
                title="解除关联"
              >
                ×
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
}

/** 关联多选器（posts/materials 二选一）；pane = 发起关联的栏（确认后刷新该栏） */
function AssocPicker({ kind, currentId, pane }: { kind: "posts" | "materials"; currentId: string; pane: PaneId }) {
  const posts = useApp((s) => s.posts);
  const materials = useApp((s) => s.materials);
  const closeAssocPicker = useApp((s) => s.closeAssocPicker);

  const list: { id: string; title: string; sub: string }[] =
    kind === "posts"
      ? posts.map((p: PostSummary) => ({ id: p.id, title: p.title, sub: p.folder ?? "未分类" }))
      : materials.map((m: MaterialSummary) => ({ id: m.id, title: m.title, sub: m.folder ?? "kb 根" }));
  const [checked, setChecked] = useState<Record<string, boolean>>({});

  const confirm = async () => {
    closeAssocPicker();
    for (const item of list.filter((i) => checked[i.id] && i.id !== currentId)) {
      await api.updateAssoc(currentId, item.id, true);
    }
    await reloadAll(pane);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
      <div
        className="flex max-h-[60vh] w-[380px] flex-col rounded-xl border border-[var(--line)] bg-[var(--card)] p-6 shadow-xl"
        data-testid="assoc-picker"
      >
        <h3 className="mb-3 text-base font-bold">关联{kind === "posts" ? "文稿" : "资料"}（可多选）</h3>
        <div className="min-h-0 flex-1 overflow-auto">
          {list.filter((i) => i.id !== currentId).length === 0 && (
            <div className="py-4 text-center text-xs text-[var(--muted)]">没有可关联的条目</div>
          )}
          {list
            .filter((i) => i.id !== currentId)
            .map((i) => (
              <label key={i.id} className="mb-1 flex items-center gap-2 rounded-lg px-2 py-1 text-xs hover:bg-[var(--cream)]">
                <input
                  type="checkbox"
                  checked={!!checked[i.id]}
                  onChange={(e) => setChecked((c) => ({ ...c, [i.id]: e.target.checked }))}
                  data-testid="assoc-picker-check"
                />
                <span className="font-semibold">{i.title}</span>
                <span className="ml-auto text-[10px] text-[var(--muted)]">{i.sub}</span>
              </label>
            ))}
        </div>
        <div className="mt-3 flex justify-end gap-2">
          <button onClick={closeAssocPicker} className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-[13px]">
            取消
          </button>
          <button
            onClick={() => void confirm()}
            className="rounded-lg bg-[var(--cat)] px-3 py-1.5 text-[13px] font-semibold text-white"
            data-testid="assoc-picker-confirm"
          >
            关联
          </button>
        </div>
      </div>
    </div>
  );
}

/** 关联命令后统一刷新：列表 + 当前内容 + 目标反查（刷新发起栏的目标） */
async function reloadAll(pane: PaneId) {
  const st = useApp.getState();
  await st.load();
  const now = useApp.getState();
  const sl = paneSlice(now, pane);
  if (sl.view.kind === "material") await paneOps(now, pane).reloadMaterial();
  else if (sl.selectedId) await paneOps(now, pane).reloadPost();
}

/** 编辑器底部的关联块只读渲染（§7.1）：三区 + 点击跳转 + × 解除 + 多选关联器 */
export function AssocPanel({ pane = "primary" }: { pane?: PaneId }) {
  const view = usePaneValue(pane, "view");
  const selected = usePaneValue(pane, "selected");
  const material = usePaneValue(pane, "material");
  const select = usePaneAction(pane, "select");
  const selectMaterial = usePaneAction(pane, "selectMaterial");
  const selectVersion = usePaneAction(pane, "selectVersion");
  const assocPicker = useApp((s) => s.assocPicker);
  const openAssocPicker = useApp((s) => s.openAssocPicker);
  const activePane = useApp((s) => s.activePane);

  const isMaterial = view.kind === "material";
  const currentId = isMaterial ? view.id : selected?.id ?? null;
  const block = isMaterial ? material?.assoc : selected?.assoc ?? null;

  const [targets, setTargets] = useState<{ title: string; target: string; id: string | null }[]>([]);

  const refresh = useCallback(async () => {
    const st = paneSlice(useApp.getState(), pane);
    const id = st.view.kind === "material" ? st.view.id : st.view.kind === "post" ? st.selectedId : null;
    if (!id) {
      setTargets([]);
      return;
    }
    setTargets(await api.assocTargets(id).catch(() => []));
  }, [pane]);

  useEffect(() => {
    void refresh();
  }, [refresh, currentId, block]);

  if (view.kind === "version" || !currentId) return null;

  const idOf = (target: string) => targets.find((t) => t.target === target)?.id ?? null;

  const onRemove = async (_e: AssocEntry, entryId: string) => {
    await api.updateAssoc(currentId, entryId, false);
    await reloadAll(pane);
    await refresh();
  };

  const onJumpPost = (_e: AssocEntry, id: string | null) => id && void select(id);
  const onJumpMaterial = (_e: AssocEntry, id: string | null) => id && void selectMaterial(id);
  const onJumpVersion = (e: AssocEntry) => {
    const parsed = parseVersionTarget(e.target);
    if (parsed) void selectVersion(parsed.baseId, parsed.target);
  };

  return (
    <div
      className="flex flex-wrap items-center gap-2 border-t border-[var(--line)] bg-[var(--card)] px-5 py-2 text-[13px]"
      data-testid="assoc-panel"
    >
      <span className="font-semibold text-[var(--muted)]">🔗 关联</span>
      <Section label="文稿" entries={block?.posts ?? []} idOf={idOf} onJump={onJumpPost} onRemove={onRemove} />
      <Section label="资料" entries={block?.materials ?? []} idOf={idOf} onJump={onJumpMaterial} onRemove={onRemove} />
      {!isMaterial && (block?.versions ?? []).length > 0 && (
        <div className="flex items-center gap-1" data-testid="assoc-section-发布版本">
          <span className="text-[10px] font-semibold text-[var(--muted)]">发布版本</span>
          {(block?.versions ?? []).map((e) => (
            <button
              key={e.target}
              className="max-w-[160px] truncate rounded-full border border-[var(--line)] bg-white px-2 py-px text-[11px] hover:underline"
              onClick={() => onJumpVersion(e)}
              title={e.target}
              data-testid="assoc-version-entry"
            >
              {e.title}
            </button>
          ))}
        </div>
      )}
      <div className="ml-auto flex gap-1">
        <button
          onClick={() => openAssocPicker("posts")}
          className="rounded-md border border-[var(--line)] bg-white px-3 py-1 text-[12px]"
          data-testid="assoc-add-posts"
        >
          + 关联文稿…
        </button>
        <button
          onClick={() => openAssocPicker("materials")}
          className="rounded-md border border-[var(--line)] bg-white px-3 py-1 text-[12px]"
          data-testid="assoc-add-materials"
        >
          + 关联资料…
        </button>
      </div>

      {/* 双栏时 picker 只在活动栏实例渲染一次，避免两份叠层 */}
      {assocPicker && activePane === pane && <AssocPicker kind={assocPicker.kind} currentId={currentId} pane={pane} />}
    </div>
  );
}
