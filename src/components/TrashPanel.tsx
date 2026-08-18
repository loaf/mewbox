import { useEffect, useState } from "react";
import { api, TrashItem } from "../lib/api";
import { useApp } from "../stores/app";

/** 回收站抽屉：列出已删文稿（剩余天数），仅恢复——无永久删除入口（原则 7）。 */
export function TrashPanel() {
  const trashOpen = useApp((s) => s.trashOpen);
  const setTrashOpen = useApp((s) => s.setTrashOpen);
  const load = useApp((s) => s.load);
  const [items, setItems] = useState<TrashItem[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (trashOpen) void api.listTrash().then(setItems);
  }, [trashOpen]);

  if (!trashOpen) return null;

  const onRestore = async (id: string) => {
    setBusy(true);
    try {
      await api.restorePost(id);
      setItems(await api.listTrash());
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
        <div className="flex items-center justify-between px-4 py-2 text-[10px] text-[var(--muted)]">
          <span>30 天后自动清除（连同历史）</span>
        </div>
        <div className="flex-1 overflow-auto p-2">
          {items.length === 0 && (
            <div className="p-4 text-center text-xs text-[var(--muted)]" data-testid="trash-empty">
              回收站是空的
            </div>
          )}
          {items.map((t) => (
            <div key={t.id} className="mb-1 rounded-lg border border-[var(--line)] px-3 py-2 text-xs" data-testid="trash-item">
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
                  onClick={() => void onRestore(t.id)}
                  className="ml-auto rounded border border-[var(--line)] bg-white px-2 py-0.5 disabled:opacity-50"
                  data-testid="trash-restore"
                >
                  恢复
                </button>
              </div>
            </div>
          ))}
        </div>
        <div className="border-t border-dashed border-[var(--line)] px-4 py-2 text-[10px] text-[var(--muted)]">
          喵盒不提供不可逆的删除入口——删除的文稿总能在 30 天内找回。
        </div>
      </div>
    </div>
  );
}
