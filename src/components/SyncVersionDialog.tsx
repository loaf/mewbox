import { useEffect, useState } from "react";
import { diffLines } from "diff";
import { api } from "../lib/api";
import { useApp } from "../stores/app";

/** 从文稿同步：diff 预览 + 确认整体导入（后端先自动快照进版本自身历史）。 */
export function SyncVersionDialog({
  open,
  baseId,
  target,
  onClose,
}: {
  open: boolean;
  baseId: string;
  target: string;
  onClose: () => void;
}) {
  const reloadVersion = useApp((s) => s.reloadVersion);
  const [postBody, setPostBody] = useState("");
  const [versionBody, setVersionBody] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    void (async () => {
      const [post, version] = await Promise.all([api.readPost(baseId), api.readPublishVersion(baseId, target)]);
      setPostBody(post.body);
      setVersionBody(version.body);
    })();
  }, [open, baseId, target]);

  if (!open) return null;

  const diff = diffLines(versionBody, postBody);
  const changed = diff.some((p) => p.added || p.removed);

  const onConfirm = async () => {
    setBusy(true);
    try {
      await api.syncPublishFromPost(baseId, target);
      await reloadVersion();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" data-testid="sync-dialog">
      <div className="flex max-h-[80vh] w-[620px] flex-col rounded-xl border border-[var(--line)] bg-[var(--card)] p-6 shadow-xl">
        <h3 className="mb-1 text-base font-bold">从文稿同步 → {target} 版</h3>
        <p className="mb-3 text-[11px] text-[var(--muted)]">
          覆盖前会自动把当前版本内容存入版本历史（不会丢失）。
          <span style={{ color: "var(--green)" }}>＋来自文稿</span> / <span style={{ color: "var(--red)" }}>－将被替换</span>
        </p>
        <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-[var(--line)] p-2 font-mono text-[11px] leading-5">
          {changed ? (
            diff.map((part, i) =>
              part.value
                .split("\n")
                .filter((l, j, arr) => l !== "" || j < arr.length - 1)
                .map((line, j) => (
                  <div
                    key={`${i}-${j}`}
                    className={
                      part.added
                        ? "bg-[#e9f2e9] text-[var(--green)]"
                        : part.removed
                          ? "bg-[#f5e3df] text-[var(--red)]"
                          : "text-[var(--muted)]"
                    }
                  >
                    {part.added ? "＋" : part.removed ? "－" : "　"}
                    {line}
                  </div>
                )),
            )
          ) : (
            <div className="py-6 text-center text-xs text-[var(--muted)]">版本与文稿当前内容一致，无需同步。</div>
          )}
        </div>
        <div className="mt-3 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-[13px]">
            取消
          </button>
          <button
            disabled={busy || !changed}
            onClick={onConfirm}
            className="rounded-lg bg-[var(--cat)] px-3 py-1.5 text-[13px] font-semibold text-white disabled:opacity-50"
            data-testid="sync-confirm"
          >
            确认同步
          </button>
        </div>
      </div>
    </div>
  );
}
