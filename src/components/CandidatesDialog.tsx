import { WikiHit } from "../lib/api";

/** `[[标题]]` 重名候选弹窗（§7.2：重名保持悬空并给候选） */
export function CandidatesDialog({
  candidates,
  onPick,
  onClose,
}: {
  candidates: WikiHit[];
  onPick: (hit: WikiHit) => void;
  onClose: () => void;
}) {
  if (candidates.length === 0) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onClose}>
      <div
        className="w-[360px] rounded-xl border border-[var(--line)] bg-[var(--card)] p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        data-testid="wiki-candidates-dialog"
      >
        <h3 className="mb-1 text-sm font-bold">同名条目，请选择</h3>
        <p className="mb-3 text-xs text-[var(--muted)]">wiki 链接的标题对应多个文件</p>
        <div className="max-h-[280px] overflow-auto">
          {candidates.map((c) => (
            <button
              key={c.id}
              onClick={() => onPick(c)}
              className="mb-1 block w-full rounded-lg border border-[var(--line)] px-3 py-2 text-left text-xs hover:bg-[var(--cream)]"
              data-testid="wiki-candidate"
            >
              <span className="font-semibold">{c.title}</span>
              <span className="ml-2 text-[10px] text-[var(--muted)]">
                {c.kind === "post" ? "文稿" : "资料"} · {c.path}
              </span>
            </button>
          ))}
        </div>
        <div className="mt-3 flex justify-end">
          <button onClick={onClose} className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-xs">
            取消
          </button>
        </div>
      </div>
    </div>
  );
}
