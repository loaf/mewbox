import { useCallback, useEffect, useState } from "react";
import { api, BrokenLink, HealthReport } from "../lib/api";

function ListSection({
  title,
  hint,
  items,
}: {
  title: string;
  hint?: string;
  items: string[];
}) {
  return (
    <div className="mb-3" data-testid={`health-section`}>
      <div className="text-[11px] font-bold">
        {title}（{items.length}）
      </div>
      {hint && <div className="text-[10px] text-[var(--muted)]">{hint}</div>}
      {items.length > 0 && (
        <ul className="mt-1 max-h-[100px] overflow-auto rounded-lg border border-[var(--line)] px-2 py-1 font-mono text-[10px] leading-4">
          {items.map((s, i) => (
            <li key={i} data-testid="health-item">
              {s}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function linkText(l: BrokenLink): string {
  return `${l.from} → ${l.dest}`;
}

/** 健康检查面板（§7.4）：四类清单 + 孤儿附件勾选清理 */
export function HealthPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [report, setReport] = useState<HealthReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [checked, setChecked] = useState<Record<string, boolean>>({});

  const run = useCallback(async () => {
    setBusy(true);
    try {
      setReport(await api.healthCheck());
      setChecked({});
    } finally {
      setBusy(false);
    }
  }, []);

  // 打开时自动跑一次
  useEffect(() => {
    if (open) void run();
  }, [open, run]);

  if (!open) return null;

  const cleanSelected = async () => {
    const fingerprints = Object.entries(checked)
      .filter(([, v]) => v)
      .map(([k]) => k);
    if (fingerprints.length === 0) return;
    if (!window.confirm(`删除选中的 ${fingerprints.length} 个孤儿附件？此操作不可恢复。`)) return;
    setBusy(true);
    try {
      await api.cleanOrphanAssets(fingerprints);
      await run();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onClose}>
      <div
        className="flex max-h-[80vh] w-[460px] flex-col rounded-xl border border-[var(--line)] bg-[var(--card)] p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        data-testid="health-dialog"
      >
        <div className="mb-3 flex items-center gap-2">
          <h3 className="text-sm font-bold">🩺 健康检查</h3>
          <button
            onClick={() => void run()}
            disabled={busy}
            className="rounded-md border border-[var(--line)] bg-white px-2 py-0.5 text-[11px] disabled:opacity-50"
            data-testid="health-refresh"
          >
            重新检查
          </button>
          <button onClick={onClose} className="ml-auto text-xs text-[var(--muted)]">
            关闭
          </button>
        </div>

        {!report ? (
          <div className="py-6 text-center text-xs text-[var(--muted)]">检查中…</div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto">
            <ListSection title="断链" items={report.brokenLinks.map(linkText)} hint="指向不存在的文件" />
            <ListSection
              title="回收站目标"
              items={report.trashTargets.map(linkText)}
              hint="目标在回收站（不算断链，恢复后自愈）"
            />
            <ListSection title="孤儿历史" items={report.orphanHistories} hint="有历史快照但找不到主人" />
            <ListSection title="无主发布版本" items={report.orphanVersions} />
            <div className="mb-3" data-testid="health-section">
              <div className="text-[11px] font-bold">孤儿附件（{report.orphanAssets.length}）</div>
              <div className="text-[10px] text-[var(--muted)]">未被任何内容引用（含历史快照）的 _assets 文件</div>
              {report.orphanAssets.length > 0 && (
                <div className="mt-1 max-h-[120px] overflow-auto rounded-lg border border-[var(--line)] px-2 py-1 font-mono text-[10px] leading-5">
                  {report.orphanAssets.map((fp) => (
                    <label key={fp} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={!!checked[fp]}
                        onChange={(e) => setChecked((c) => ({ ...c, [fp]: e.target.checked }))}
                        data-testid="health-asset-check"
                      />
                      <span>{fp}</span>
                    </label>
                  ))}
                </div>
              )}
              <button
                onClick={() => void cleanSelected()}
                disabled={busy || Object.values(checked).every((v) => !v)}
                className="mt-1 rounded-md border border-[var(--red)] bg-white px-2 py-0.5 text-[11px] text-[var(--red)] disabled:opacity-40"
                data-testid="health-clean"
              >
                清理选中…
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
