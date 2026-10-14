import { useCallback, useEffect, useState } from "react";
import { diffLines } from "diff";
import { api, SnapshotEntry } from "../lib/api";
import { useActiveValue, useActiveAction } from "../stores/pane";

function formatTs(ts: string): string {
  const m = ts.match(/^\d{4}-(\d{2}-\d{2})T(\d{2}:\d{2})/);
  return m ? `${m[1]} ${m[2]}` : ts;
}

export function HistoryPanel() {
  const view = useActiveValue("view");
  const selectedId = useActiveValue("selectedId");
  const reloadPost = useActiveAction("reloadPost");
  const reloadVersion = useActiveAction("reloadVersion");
  const reloadMaterial = useActiveAction("reloadMaterial");
  const [snapshots, setSnapshots] = useState<SnapshotEntry[]>([]);
  const [openSnap, setOpenSnap] = useState<string | null>(null);
  const [snapBody, setSnapBody] = useState("");
  const [currentBody, setCurrentBody] = useState("");
  const [milestoneFor, setMilestoneFor] = useState<string | null>(null);

  const isVersion = view.kind === "version";
  const isMaterial = view.kind === "material";
  const baseId = isVersion ? view.baseId : isMaterial ? view.id : selectedId;
  const target = isVersion ? view.target : null;

  const refresh = useCallback(async () => {
    if (!baseId) return;
    if (isVersion && target) {
      const [snaps, v] = await Promise.all([
        api.listVersionSnapshots(baseId, target),
        api.readPublishVersion(baseId, target),
      ]);
      setSnapshots(snaps);
      setCurrentBody(v.body);
    } else if (isMaterial) {
      const [snaps, m] = await Promise.all([api.listSnapshots(baseId!), api.readMaterial(baseId!)]);
      setSnapshots(snaps);
      setCurrentBody(m.body);
    } else {
      const [snaps, post] = await Promise.all([api.listSnapshots(baseId!), api.readPost(baseId!)]);
      setSnapshots(snaps);
      setCurrentBody(post.body);
    }
  }, [baseId, target, isVersion, isMaterial]);

  useEffect(() => {
    setOpenSnap(null);
    void refresh();
  }, [refresh]);

  const openDiff = async (fileName: string) => {
    if (!baseId) return;
    if (openSnap === fileName) {
      setOpenSnap(null);
      return;
    }
    setSnapBody(
      isVersion && target
        ? await api.readVersionSnapshot(baseId, target, fileName)
        : await api.readSnapshot(baseId!, fileName),
    );
    setOpenSnap(fileName);
  };

  const onRestore = async (fileName: string) => {
    if (!baseId) return;
    if (!window.confirm("恢复到这份快照？当前内容会先自动存入历史（不会丢失）。")) return;
    if (isVersion && target) {
      await api.restoreVersionSnapshot(baseId, target, fileName);
      await reloadVersion();
    } else if (isMaterial) {
      await api.restoreSnapshot(baseId!, fileName);
      await reloadMaterial();
    } else {
      await api.restoreSnapshot(baseId!, fileName);
      await reloadPost();
    }
    await refresh();
  };

  const onMilestone = async (name: string) => {
    if (!baseId || !milestoneFor) return;
    if (isVersion && target) {
      await api.setVersionMilestone(baseId, target, milestoneFor, name);
    } else {
      await api.setSnapshotMilestone(baseId!, milestoneFor, name);
    }
    setMilestoneFor(null);
    await refresh();
  };

  if (snapshots.length === 0) {
    return (
      <div className="text-[12.5px] text-[var(--muted)]" data-testid="history-empty">
        暂无历史快照——保存时的实质修改会自动留档。
      </div>
    );
  }

  const diff = openSnap !== null ? diffLines(snapBody, currentBody) : [];

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="history-list">
      <div className="flex-1 overflow-auto">
        {snapshots.map((s) => (
          <div
            key={s.fileName}
            className={`mb-1.5 rounded-lg border bg-white px-3 py-2 text-[12.5px] ${
              openSnap === s.fileName ? "border-[var(--cat)] bg-[var(--cat-bg)]" : "border-[var(--line)]"
            }`}
          >
            <button className="block w-full text-left" onClick={() => void openDiff(s.fileName)} data-testid="snapshot-item">
              <div className="flex items-center gap-1">
                <span className="font-semibold">{formatTs(s.ts)}</span>
                {s.milestone && (
                  <span className="rounded-full bg-[#e0ecdd] px-2 py-px text-[10px] font-semibold text-[var(--green)]" data-testid="milestone-chip">
                    🚩 {s.milestone}
                  </span>
                )}
              </div>
              <div className="text-[10px] text-[var(--muted)]">{s.hash8}</div>
            </button>
            <div className="mt-1 flex gap-2">
              <button
                className="rounded border border-[var(--line)] bg-white px-2.5 py-1 text-[11px]"
                onClick={() => void onRestore(s.fileName)}
                data-testid="restore-btn"
              >
                恢复
              </button>
              <button
                className="rounded border border-[var(--line)] bg-white px-2.5 py-1 text-[11px]"
                onClick={() => setMilestoneFor(s.fileName)}
                data-testid="milestone-btn"
              >
                {s.milestone ? "改里程碑名" : "设为里程碑"}
              </button>
            </div>
          </div>
        ))}
      </div>

      {openSnap !== null && (
        <div className="flex min-h-0 flex-1 flex-col border-t border-[var(--line)]" data-testid="diff-view">
          <div className="px-2 py-1 text-[10px] font-semibold text-[var(--muted)]">
            与当前内容比较（<span style={{ color: "var(--green)" }}>＋新增</span> / <span style={{ color: "var(--red)" }}>－删除</span>）
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-2 pb-2 font-mono text-[11px] leading-5">
            {diff.map((part, i) =>
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
            )}
          </div>
        </div>
      )}

      {milestoneFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="w-[320px] rounded-xl border border-[var(--line)] bg-[var(--card)] p-5 shadow-xl" data-testid="milestone-dialog">
            <h3 className="mb-3 text-base font-bold">里程碑命名（永久保留）</h3>
            <input
              autoFocus
              className="mb-4 w-full rounded-lg border border-[var(--line)] px-3 py-2 text-sm outline-none focus:border-[var(--cat)]"
              data-testid="milestone-input"
              placeholder="如：初稿 / 交稿版"
              onKeyDown={(e) => {
                if (e.key === "Enter") void onMilestone((e.target as HTMLInputElement).value.trim());
              }}
            />
            <div className="flex justify-end gap-2">
              <button onClick={() => setMilestoneFor(null)} className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-[13px]">
                取消
              </button>
              <button
                onClick={() => {
                  const input = document.querySelector('[data-testid="milestone-input"]') as HTMLInputElement;
                  void onMilestone(input.value.trim());
                }}
                className="rounded-lg bg-[var(--cat)] px-3 py-1.5 text-[13px] font-semibold text-white"
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
