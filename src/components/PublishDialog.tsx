import { useEffect, useState } from "react";
import { api, PublishTarget, PublishVersionSummary, SnapshotEntry } from "../lib/api";
import { useApp } from "../stores/app";

/** 文稿编辑器「发布版本…」入口：已有版本列表 + 新建（可选从历史版本分叉）。 */
export function PublishDialog({
  open,
  baseId,
  onClose,
}: {
  open: boolean;
  baseId: string | null;
  onClose: () => void;
}) {
  const selectVersion = useApp((s) => s.selectVersion);
  const [versions, setVersions] = useState<PublishVersionSummary[]>([]);
  const [targets, setTargets] = useState<PublishTarget[]>([]);
  const [snapshots, setSnapshots] = useState<SnapshotEntry[]>([]);
  const [targetName, setTargetName] = useState("");
  const [fromSnapshot, setFromSnapshot] = useState("");
  const [saveToRegistry, setSaveToRegistry] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = async () => {
    if (!baseId) return;
    setVersions(await api.listPublishVersions(baseId));
    setTargets(await api.listPublishTargets());
    setSnapshots(await api.listSnapshots(baseId));
  };

  useEffect(() => {
    if (!open) return;
    setError(null);
    setTargetName("");
    setFromSnapshot("");
    void reload();
  }, [open, baseId]);

  if (!open || !baseId) return null;

  const onCreate = async () => {
    const name = targetName.trim();
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      // 先强制保存母版（防抖中的未落盘内容不能成为分叉来源）
      const flush = useApp.getState().flushFn;
      if (flush) await flush();
      if (saveToRegistry && !targets.some((t) => t.id === name)) {
        await api.addPublishTarget(name, name, "").catch(() => undefined); // 注册表是便利设施，失败不阻塞
      }
      // 双保险：把 flush 后 store 中的母版正文显式传给创建命令（文件读取仅兜底），
      // 杜绝「已保存但读文件仍见旧内容」的可见性竞态
      const currentBody = useApp.getState().selected?.body ?? null;
      await api.createPublishVersion(baseId, name, fromSnapshot || null, currentBody);
      await selectVersion(baseId, name);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" data-testid="publish-dialog">
      <div className="max-h-[80vh] w-[440px] overflow-auto rounded-xl border border-[var(--line)] bg-[var(--card)] p-6 shadow-xl">
        <h3 className="mb-3 text-base font-bold">发布版本</h3>

        <div className="mb-3 max-h-[180px] overflow-auto" data-testid="version-list">
          {versions.length === 0 && (
            <div className="rounded-lg bg-[var(--cream)] px-3 py-4 text-center text-xs text-[var(--muted)]">
              还没有发布版本——从当前文稿内容创建一个渠道适配版
            </div>
          )}
          {versions.map((v) => (
            <button
              key={v.id}
              className="mb-1 flex w-full items-center gap-2 rounded-lg border border-[var(--line)] px-3 py-2 text-left text-xs hover:bg-[var(--cream)]"
              onClick={async () => {
                await selectVersion(baseId, v.target);
                onClose();
              }}
              data-testid="open-version"
            >
              <span className="font-semibold">{v.target}</span>
              {v.publishedUrl && (
                <span className="rounded-full bg-[#e0ecdd] px-2 py-px text-[10px] font-semibold text-[var(--green)]">
                  已发布
                </span>
              )}
              <span className="ml-auto text-[10px] text-[var(--muted)]">{v.updatedAt.slice(0, 10)}</span>
            </button>
          ))}
        </div>

        <div className="rounded-lg border border-dashed border-[var(--line)] p-3">
          <div className="mb-2 text-xs font-semibold">新建版本</div>
          <input
            list="publish-targets"
            value={targetName}
            onChange={(e) => setTargetName(e.target.value)}
            placeholder="目标名，如 wechat / blog / weibo"
            className="mb-2 w-full rounded-md border border-[var(--line)] px-2 py-1.5 text-xs outline-none focus:border-[var(--cat)]"
            data-testid="new-target-name"
          />
          <datalist id="publish-targets">
            {targets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.display}
              </option>
            ))}
          </datalist>
          <div className="mb-2 flex items-center gap-2">
            <select
              value={fromSnapshot}
              onChange={(e) => setFromSnapshot(e.target.value)}
              className="flex-1 rounded-md border border-[var(--line)] bg-white px-2 py-1 text-[11px]"
              data-testid="fork-snapshot"
            >
              <option value="">从文稿当前内容创建</option>
              {snapshots.map((s) => (
                <option key={s.fileName} value={s.fileName}>
                  分叉自快照 {s.ts.slice(0, 16).replace("T", " ")} {s.milestone ? `🚩${s.milestone}` : ""}
                </option>
              ))}
            </select>
          </div>
          <label className="flex items-center gap-1 text-[10px] text-[var(--muted)]">
            <input type="checkbox" checked={saveToRegistry} onChange={(e) => setSaveToRegistry(e.target.checked)} />
            新目标名加入 config.toml 注册表（便利设施，不强制）
          </label>
          <div className="mt-2 flex items-center justify-between">
            <span className="text-[10px] text-[var(--muted)]">同一目标只能有一个版本；重发请新建目标名</span>
            <button
              disabled={busy || !targetName.trim()}
              onClick={onCreate}
              className="rounded-lg bg-[var(--cat)] px-3 py-1.5 text-[13px] font-semibold text-white disabled:opacity-50"
              data-testid="create-version-btn"
            >
              创建并打开
            </button>
          </div>
          {error && <div className="mt-2 text-[11px] text-[var(--red)]" data-testid="publish-error">{error}</div>}
        </div>

        <div className="mt-3 flex justify-end">
          <button onClick={onClose} className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-[13px]">
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

/** 发布记录回填（url/日期；状态由 url 派生）。 */
export function PublishRecordDialog({
  open,
  baseId,
  target,
  initialUrl,
  initialDate,
  onClose,
}: {
  open: boolean;
  baseId: string;
  target: string;
  initialUrl: string | null;
  initialDate: string | null;
  onClose: () => void;
}) {
  const reloadVersion = useApp((s) => s.reloadVersion);
  const [url, setUrl] = useState(initialUrl ?? "");
  const [date, setDate] = useState(initialDate ?? "");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setUrl(initialUrl ?? "");
    setDate(initialDate ?? "");
  }, [open, initialUrl, initialDate]);

  if (!open) return null;

  const onSave = async () => {
    setBusy(true);
    try {
      await api.setPublishPublished(baseId, target, url.trim() || null, date || null);
      await reloadVersion();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" data-testid="publish-record-dialog">
      <div className="w-[380px] rounded-xl border border-[var(--line)] bg-[var(--card)] p-6 shadow-xl">
        <h3 className="mb-3 text-base font-bold">发布记录 · {target}</h3>
        <label className="mb-1 block text-[11px] text-[var(--muted)]">发布后的 URL（回填后标记为已发布）</label>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://mp.weixin.qq.com/s/…"
          className="mb-3 w-full rounded-md border border-[var(--line)] px-2 py-1.5 text-xs outline-none focus:border-[var(--cat)]"
          data-testid="publish-url"
        />
        <label className="mb-1 block text-[11px] text-[var(--muted)]">发布日期</label>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="mb-4 w-full rounded-md border border-[var(--line)] px-2 py-1.5 text-xs"
          data-testid="publish-date"
        />
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-[13px]">
            取消
          </button>
          <button
            disabled={busy}
            onClick={onSave}
            className="rounded-lg bg-[var(--cat)] px-3 py-1.5 text-[13px] font-semibold text-white disabled:opacity-50"
            data-testid="publish-record-save"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
