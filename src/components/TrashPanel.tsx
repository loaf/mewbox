import { useEffect, useState } from "react";
import { api, TrashItem } from "../lib/api";
import { useApp } from "../stores/app";

function TrashSection({
  title,
  items,
  busy,
  onRestore,
  emptyHint,
}: {
  title: string;
  items: TrashItem[];
  busy: boolean;
  onRestore: (id: string) => void;
  emptyHint: string;
}) {
  return (
    <div className="mb-2" data-testid={`trash-section-${title}`}>
      <div className="px-2 py-1 text-[10px] font-bold text-[var(--muted)]">{title}</div>
      {items.length === 0 && <div className="px-3 py-1 text-[10px] text-[var(--muted)]">{emptyHint}</div>}
      {items.map((t) => (
        <div key={t.id} className="mb-1.5 rounded-lg border border-[var(--line)] px-3 py-2 text-[13px]" data-testid="trash-item">
          <div className="flex items-center gap-2">
            <span className="truncate font-semibold">{t.title}</span>
            <span className="ml-auto rounded-full bg-[var(--cream)] px-2 py-px text-[10px] text-[var(--muted)]">
              剩 {t.daysLeft} 天
            </span>
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-[10px] text-[var(--muted)]">
            <span>原目录：{t.folder ?? "未分类"}</span>
            <button
              disabled={busy}
              onClick={() => onRestore(t.id)}
              className="ml-auto rounded border border-[var(--line)] bg-white px-3 py-1 text-[12px] disabled:opacity-50"
              data-testid="trash-restore"
            >
              恢复
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

/** 回收站抽屉：文稿/资料两区（仅恢复——无永久删除入口，原则 7）。 */
export function TrashPanel() {
  const trashOpen = useApp((s) => s.trashOpen);
  const setTrashOpen = useApp((s) => s.setTrashOpen);
  const load = useApp((s) => s.load);
  const [posts, setPosts] = useState<TrashItem[]>([]);
  const [materials, setMaterials] = useState<TrashItem[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    const [p, m] = await Promise.all([api.listTrash(), api.listMaterialTrash().catch(() => [] as TrashItem[])]);
    setPosts(p);
    setMaterials(m);
  };

  useEffect(() => {
    if (trashOpen) void refresh();
  }, [trashOpen]);

  if (!trashOpen) return null;

  const onRestorePost = async (id: string) => {
    setBusy(true);
    try {
      await api.restorePost(id);
      await refresh();
      await load();
    } finally {
      setBusy(false);
    }
  };

  const onRestoreMaterial = async (id: string) => {
    setBusy(true);
    try {
      await api.restoreMaterial(id);
      await refresh();
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/20" onClick={() => setTrashOpen(false)}>
      <div
        className="flex h-full w-[320px] flex-col border-l border-[var(--line)] bg-[var(--card)] shadow-xl"
        onClick={(e) => e.stopPropagation()}
        data-testid="trash-panel"
      >
        <div className="flex items-center justify-between border-b border-[var(--line)] px-4 py-3">
          <h3 className="text-sm font-bold">🗑 回收站</h3>
          <button onClick={() => setTrashOpen(false)} className="text-xs text-[var(--muted)]">
            关闭
          </button>
        </div>
        <div className="flex items-center justify-between px-4 py-2 text-[11px] text-[var(--muted)]">
          <span>30 天后自动清除（连同历史）</span>
        </div>
        <div className="flex-1 overflow-auto p-2">
          {posts.length === 0 && materials.length === 0 && (
            <div className="p-4 text-center text-[13px] text-[var(--muted)]" data-testid="trash-empty">
              回收站是空的
            </div>
          )}
          <TrashSection
            title="文稿"
            items={posts}
            busy={busy}
            onRestore={(id) => void onRestorePost(id)}
            emptyHint="没有已删文稿"
          />
          <TrashSection
            title="资料"
            items={materials}
            busy={busy}
            onRestore={(id) => void onRestoreMaterial(id)}
            emptyHint="没有已删资料"
          />
        </div>
        <div className="border-t border-dashed border-[var(--line)] px-4 py-2 text-[11px] text-[var(--muted)]">
          喵盒不提供不可逆的删除入口——删除的内容总能在 30 天内找回。
        </div>
      </div>
    </div>
  );
}
