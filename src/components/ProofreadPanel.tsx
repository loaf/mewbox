import { useEffect, useRef, useState } from "react";
import { api, type ContextEntry } from "../lib/api";
import { parseSuggestions, type Suggestion } from "../lib/jsonTolerant";
import { newCallId, useAIStream } from "../lib/useAIStream";

export interface SuggestionPanelProps {
  /** 审阅对象（post / material；后端按条目读全文） */
  target: ContextEntry;
  /** 当前编辑器正文（采纳时按此精确替换） */
  body: string;
  onApply: (newBody: string) => void;
  onClose: () => void;
}

const btn = "rounded-md border border-[var(--line)] bg-white px-3 py-1 text-[13px] hover:border-[var(--cat)]";

/**
 * 全文润色建议（T12）：全文经 proofread_suggestions 流式收集 → 容错解析 →
 * 分条（原段/改段/理由）逐条或全部采纳 = aiApplySuggestions 精确替换（修订决策 3）。
 */
export function ProofreadPanel({ target, body, onApply, onClose }: SuggestionPanelProps) {
  const stream = useAIStream();
  const [items, setItems] = useState<Suggestion[] | null>(null);
  const [states, setStates] = useState<Record<number, "adopted" | "skipped">>({});
  const callIdRef = useRef(newCallId());
  const adoptedAnyRef = useRef(false);

  useEffect(() => {
    const id = callIdRef.current;
    void stream.run(id, () => api.aiRunOp(id, "proofread_suggestions", [target]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (stream.status === "done") setItems(parseSuggestions(stream.text));
  }, [stream.status, stream.text]);

  const pendingIdx = () =>
    (items ?? []).map((_, i) => i).filter((i) => states[i] === undefined);

  const adopt = async (idxs: number[]) => {
    if (!items || idxs.length === 0) return;
    const list = idxs.map((i) => items[i]);
    const r = await api.aiApplySuggestions(body, list);
    if (r.applied.length > 0) onApply(r.body);
    setStates((s) => {
      const n = { ...s };
      r.applied.forEach((k) => (n[idxs[k]] = "adopted"));
      r.skipped.forEach((k) => (n[idxs[k]] = "skipped"));
      return n;
    });
    adoptedAnyRef.current = true;
    await api.aiAdoptResult(callIdRef.current, `采纳 ${r.applied.length}/${idxs.length} 条`).catch(() => undefined);
  };

  const close = () => {
    if (!adoptedAnyRef.current && stream.status === "done") {
      void api.aiDiscardResult(callIdRef.current).catch(() => undefined);
    }
    onClose();
  };

  return (
    <div
      className="fixed bottom-4 right-4 z-40 flex max-h-[60vh] w-[420px] flex-col rounded-xl border border-[var(--line)] bg-[var(--card)] shadow-xl"
      data-testid="proofread-panel"
    >
      <div className="flex items-center gap-2 border-b border-[var(--line)] px-3 py-2 text-[13px]">
        <span className="font-bold">✍ 润色建议</span>
        {stream.status === "streaming" && <span className="text-[var(--muted)]">审阅中…</span>}
        {stream.status === "error" && <span className="text-red-500">{stream.error}</span>}
        <button className="ml-auto text-[var(--muted)]" onClick={close} data-testid="proofread-close">✕</button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2 text-xs">
        {items === null && stream.status !== "error" && (
          <pre className="whitespace-pre-wrap text-[var(--muted)]" data-testid="proofread-streaming">{stream.text || "…"}</pre>
        )}
        {items !== null && items.length === 0 && (
          <div className="text-[var(--muted)]" data-testid="proofread-empty">没有发现需要润色的段落。</div>
        )}
        {items?.map((it, i) => (
          <div key={i} className={`mb-2 rounded-lg border p-2 ${states[i] === "skipped" ? "border-[var(--line)] opacity-50" : "border-[var(--line)]"}`} data-testid="proofread-item">
            <div className="text-[var(--muted)] line-through">{it.original}</div>
            <div className="mt-1">{it.revised}</div>
            {it.reason && <div className="mt-1 text-[11px] text-[var(--muted)]">理由：{it.reason}</div>}
            {states[i] === undefined && (
              <button className={`${btn} mt-1`} onClick={() => void adopt([i])} data-testid={`proofread-adopt-${i}`}>采纳</button>
            )}
            {states[i] === "adopted" && <span className="mt-1 inline-block text-[11px] text-green-600">已采纳</span>}
            {states[i] === "skipped" && <span className="mt-1 inline-block text-[11px] text-[var(--muted)]">原文已变化</span>}
          </div>
        ))}
      </div>
      {items !== null && items.length > 0 && pendingIdx().length > 0 && (
        <div className="border-t border-[var(--line)] p-2">
          <button
            className="rounded-md bg-[var(--cat)] px-3.5 py-1.5 text-[13px] font-semibold text-white"
            onClick={() => void adopt(pendingIdx())}
            data-testid="proofread-adopt-all"
          >
            全部采纳（{pendingIdx().length} 条）
          </button>
        </div>
      )}
    </div>
  );
}
