import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { parseIssues, type Issue } from "../lib/jsonTolerant";
import { newCallId, useAIStream } from "../lib/useAIStream";
import type { SuggestionPanelProps } from "./ProofreadPanel";

const btn = "rounded-md border border-[var(--line)] bg-white px-2 py-0.5 text-xs hover:border-[var(--cat)]";

/** 定位：按定位片段在正文中近似找行号，滚动编辑器 textarea */
function scrollToLocation(body: string, location: string) {
  const ta = document.querySelector<HTMLTextAreaElement>('[data-testid="md-textarea"]');
  if (!ta || !location) return;
  const idx = body.indexOf(location);
  if (idx < 0) return;
  const line = body.slice(0, idx).split("\n").length;
  ta.scrollTop = Math.max(0, (line - 1) * 21);
  ta.focus();
}

/**
 * 全文查错（T12）：check_errors 流式收集 → 容错解析 → 分条（类型/定位/建议）。
 * 定位点击滚动编辑器到行；采纳 = 定位片段替换为建议（aiApplySuggestions 精确替换）。
 */
export function CheckErrorsPanel({ target, body, onApply, onClose }: SuggestionPanelProps) {
  const stream = useAIStream();
  const [items, setItems] = useState<Issue[] | null>(null);
  const [states, setStates] = useState<Record<number, "adopted" | "skipped">>({});
  const callIdRef = useRef(newCallId());
  const adoptedAnyRef = useRef(false);

  useEffect(() => {
    const id = callIdRef.current;
    void stream.run(id, () => api.aiRunOp(id, "check_errors", [target]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (stream.status === "done") setItems(parseIssues(stream.text));
  }, [stream.status, stream.text]);

  const pendingIdx = () =>
    (items ?? []).map((_, i) => i).filter((i) => states[i] === undefined);

  const adopt = async (idxs: number[]) => {
    if (!items || idxs.length === 0) return;
    const list = idxs.map((i) => ({
      original: items[i].location,
      revised: items[i].advice,
      reason: items[i].kind,
    }));
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
      data-testid="checkerrors-panel"
    >
      <div className="flex items-center gap-2 border-b border-[var(--line)] px-3 py-2 text-xs">
        <span className="font-bold">🔎 查错</span>
        {stream.status === "streaming" && <span className="text-[var(--muted)]">检查中…</span>}
        {stream.status === "error" && <span className="text-red-500">{stream.error}</span>}
        <button className="ml-auto text-[var(--muted)]" onClick={close} data-testid="checkerrors-close">✕</button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2 text-xs">
        {items === null && stream.status !== "error" && (
          <pre className="whitespace-pre-wrap text-[var(--muted)]" data-testid="checkerrors-streaming">{stream.text || "…"}</pre>
        )}
        {items !== null && items.length === 0 && (
          <div className="text-[var(--muted)]" data-testid="checkerrors-empty">没有发现问题。</div>
        )}
        {items?.map((it, i) => (
          <div key={i} className={`mb-2 rounded-lg border border-[var(--line)] p-2 ${states[i] === "skipped" ? "opacity-50" : ""}`} data-testid="issue-item">
            <div className="font-semibold">{it.kind || "问题"}</div>
            <button className="mt-1 text-left text-[var(--muted)] underline" onClick={() => scrollToLocation(body, it.location)} data-testid={`issue-locate-${i}`}>
              定位：{it.location || "（未提供）"}
            </button>
            <div className="mt-1">{it.advice}</div>
            {states[i] === undefined && (
              <button className={`${btn} mt-1`} onClick={() => void adopt([i])} data-testid={`issue-adopt-${i}`}>采纳</button>
            )}
            {states[i] === "adopted" && <span className="mt-1 inline-block text-[11px] text-green-600">已采纳</span>}
            {states[i] === "skipped" && <span className="mt-1 inline-block text-[11px] text-[var(--muted)]">原文已变化</span>}
          </div>
        ))}
      </div>
      {items !== null && items.length > 0 && pendingIdx().length > 0 && (
        <div className="border-t border-[var(--line)] p-2">
          <button
            className="rounded-md bg-[var(--cat)] px-3 py-1 text-xs font-semibold text-white"
            onClick={() => void adopt(pendingIdx())}
            data-testid="issue-adopt-all"
          >
            全部采纳（{pendingIdx().length} 条）
          </button>
        </div>
      )}
    </div>
  );
}
