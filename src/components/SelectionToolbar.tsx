import { useEffect, useRef, useState } from "react";
import { api, type AiConfigState } from "../lib/api";
import { newCallId, routeLabel, useAIStream } from "../lib/useAIStream";

/** 触发时的选区快照（修订决策 4：浮条锚定鼠标抬起点） */
export interface SelectionAnchor {
  start: number;
  end: number;
  text: string;
  x: number;
  y: number;
}

/**
 * 选区锚点 hook：EditorPane 把 handlers 展开进 MDEditor textareaProps
 * （与 onPaste 同通道）。AI 运行期间 lock，选区塌缩不清除浮条。
 */
export function useSelectionAnchor() {
  const [anchor, setAnchor] = useState<SelectionAnchor | null>(null);
  const lockedRef = useRef(false);
  const mouseRef = useRef({ x: 96, y: 96 });

  const evaluate = (el: HTMLTextAreaElement) => {
    if (lockedRef.current) return;
    const { selectionStart: s, selectionEnd: e } = el;
    if (s !== e && el.value.slice(s, e).trim().length > 0) {
      setAnchor({ start: s, end: e, text: el.value.slice(s, e), x: mouseRef.current.x, y: mouseRef.current.y });
    } else {
      setAnchor(null);
    }
  };

  const handlers = {
    onSelect: (e: React.SyntheticEvent<HTMLTextAreaElement>) => evaluate(e.currentTarget),
    onMouseUp: (e: React.MouseEvent<HTMLTextAreaElement>) => {
      mouseRef.current = { x: e.clientX, y: e.clientY };
      evaluate(e.currentTarget);
    },
    onKeyUp: (e: React.KeyboardEvent<HTMLTextAreaElement>) => evaluate(e.currentTarget),
  };

  return { anchor, setAnchor, handlers, lock: (v: boolean) => (lockedRef.current = v) };
}

type MiniOp = "rewrite" | "expand" | "shorten" | "tone" | "translate" | "polish" | "custom";

const MINI_OPS: [MiniOp, string][] = [
  ["rewrite", "改写"],
  ["expand", "扩写"],
  ["shorten", "缩写"],
  ["tone", "改语气"],
  ["translate", "翻译"],
  ["polish", "润色"],
  ["custom", "自定义"],
];

export interface SelectionToolbarProps {
  anchor: SelectionAnchor | null;
  clear: () => void;
  lock: (v: boolean) => void;
  /** 替换选区（EditorPane 持有 body，按触发时的 range 精确拼接） */
  onReplaceRange: (start: number, end: number, text: string) => void;
  /** 仅 edit/live 模式显示 */
  enabled: boolean;
}

const btn = "rounded-md border border-[var(--line)] bg-white px-3 py-1 text-[13px] hover:border-[var(--cat)]";

export function SelectionToolbar({ anchor, clear, lock, onReplaceRange, enabled }: SelectionToolbarProps) {
  const stream = useAIStream();
  const [op, setOp] = useState<MiniOp | null>(null);
  const [pending, setPending] = useState<MiniOp | null>(null);
  const [tone, setTone] = useState("更正式、更自然");
  const [targetLang, setTargetLang] = useState("英文");
  const [custom, setCustom] = useState("");
  const [callId, setCallId] = useState<string | null>(null);
  const [config, setConfig] = useState<AiConfigState | null>(null);
  const loadedRef = useRef(false);

  // 首次出现浮条时拉一次配置（出站提示，铁律 5）
  useEffect(() => {
    if (!anchor || loadedRef.current) return;
    loadedRef.current = true;
    void api.aiListProviders().then(setConfig).catch(() => setConfig(null));
  }, [anchor]);

  // Esc 关闭：流中取消、已 done 丢弃、空闲直接收起
  useEffect(() => {
    if (!anchor) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      close(true);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor, stream.status, callId, stream.text]);

  if (!enabled || !anchor) return null;

  const close = (viaEsc = false) => {
    if (stream.status === "streaming" && callId) void stream.cancel(callId);
    else if (stream.status === "done" && callId && viaEsc) void api.aiDiscardResult(callId).catch(() => undefined);
    lock(false);
    clear();
    setOp(null);
    setPending(null);
    setCallId(null);
    stream.reset();
  };

  /** 即跑型操作直接执行；带参操作（语气/翻译/自定义）先展开内联输入 */
  const clickOp = (v: MiniOp) => {
    if (v === "tone" || v === "translate" || v === "custom") {
      setPending((p) => (p === v ? null : v));
      return;
    }
    runOp(v);
  };

  const runOp = (nextOp: MiniOp) => {
    const id = newCallId();
    setCallId(id);
    setOp(nextOp);
    setPending(null);
    lock(true);
    void stream.run(
      id,
      () =>
        api.aiRunOp(id, nextOp, [], {
          selection: anchor.text,
          custom: custom.trim() || undefined,
          tone: nextOp === "tone" ? tone : undefined,
          targetLang: nextOp === "translate" ? targetLang : undefined,
        }),
    );
  };

  const adopt = async (mode: "replace" | "insert" | "copy") => {
    if (!callId) return;
    const text = stream.text;
    if (mode === "replace") onReplaceRange(anchor.start, anchor.end, text);
    if (mode === "insert") window.dispatchEvent(new CustomEvent("mewbox:insert", { detail: { text } }));
    if (mode === "copy") {
      try {
        await navigator.clipboard?.writeText(text);
      } catch {
        /* 忽略无剪贴板权限 */
      }
    }
    await api.aiAdoptResult(callId).catch(() => undefined);
    lock(false);
    clear();
    setOp(null);
    setPending(null);
    setCallId(null);
    stream.reset();
  };

  const discard = async () => {
    if (callId) await api.aiDiscardResult(callId).catch(() => undefined);
    lock(false);
    clear();
    setOp(null);
    setPending(null);
    setCallId(null);
    stream.reset();
  };

  // 浮条定位：锚定鼠标抬起点，屏幕边缘翻转（修订决策 4 的简化方案）
  const W = 360;
  const vw = typeof window !== "undefined" ? window.innerWidth : 1024;
  const vh = typeof window !== "undefined" ? window.innerHeight : 768;
  const left = Math.max(8, Math.min(anchor.x, vw - W - 8));
  const top = anchor.y + 14 > vh - 260 ? Math.max(8, anchor.y - 270) : anchor.y + 14;

  // 结果卡（流式预览 + 采纳动作；铁律 2）
  if (op && callId) {
    return (
      <div
        className="fixed z-50 flex w-[380px] flex-col gap-1.5 rounded-lg border border-[var(--line)] bg-[var(--card)] p-3 shadow-xl"
        style={{ left, top }}
        data-testid="sel-result"
      >
        <div className="flex items-center gap-2 text-[13px]">
          <span className="font-semibold">{stream.status === "streaming" ? "生成中…" : stream.status === "error" ? "出错" : "结果"}</span>
          <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--muted)]">{routeLabel(config, op)}</span>
          <button className="text-[var(--muted)]" onClick={() => close()} data-testid="sel-close">✕</button>
        </div>
        <pre className="max-h-52 overflow-auto whitespace-pre-wrap rounded bg-white p-1 text-xs" data-testid="sel-result-text">
          {stream.text}
        </pre>
        {stream.status === "error" && <div className="text-xs text-red-500" data-testid="sel-error">{stream.error}</div>}
        {stream.status === "streaming" && (
          <button className={`${btn} self-start`} onClick={() => close()} data-testid="sel-cancel">取消</button>
        )}
        {stream.status === "done" && (
          <div className="flex flex-wrap gap-1">
            <button className={btn} onClick={() => void adopt("replace")} data-testid="sel-replace">替换选区</button>
            <button className={btn} onClick={() => void adopt("insert")} data-testid="sel-insert">插入光标后</button>
            <button className={btn} onClick={() => void adopt("copy")} data-testid="sel-copy">复制</button>
            <button className={btn} onClick={() => void discard()} data-testid="sel-discard">放弃</button>
          </div>
        )}
      </div>
    );
  }

  // 选区浮条
  return (
    <div
      className="fixed z-50 flex w-[360px] flex-wrap items-center gap-1 rounded-lg border border-[var(--line)] bg-[var(--card)] px-2 py-1 shadow-xl"
      style={{ left, top }}
      data-testid="selection-toolbar"
    >
      {MINI_OPS.map(([v, label]) => (
        <button key={v} className={btn} onClick={() => clickOp(v)} data-testid={`sel-btn-${v}`}>
          {label}
        </button>
      ))}
      <button className="text-[var(--muted)]" onClick={() => close()} data-testid="sel-toolbar-close">✕</button>
      <div className="flex w-full flex-wrap items-center gap-1 text-[11px] text-[var(--muted)]">
        <span data-testid="sel-outbound-note">{routeLabel(config, "rewrite")}</span>
      </div>
      {pending === "tone" && (
        <div className="flex w-full items-center gap-1" data-testid="sel-tone-row">
          <select className="rounded-md border border-[var(--line)] bg-white px-1 py-0.5 text-xs" value={tone} onChange={(e) => setTone(e.target.value)} data-testid="sel-tone-select">
            <option value="更正式、更自然">更正式、更自然</option>
            <option value="轻松口语">轻松口语</option>
            <option value="学术严谨">学术严谨</option>
            <option value="简洁有力">简洁有力</option>
          </select>
          <button className={btn} onClick={() => runOp("tone")} data-testid="sel-tone-run">执行</button>
        </div>
      )}
      {pending === "translate" && (
        <div className="flex w-full items-center gap-1" data-testid="sel-translate-row">
          <input
            className="w-24 rounded-md border border-[var(--line)] bg-white px-1 py-0.5 text-xs"
            placeholder="目标语言"
            value={targetLang}
            onChange={(e) => setTargetLang(e.target.value)}
            data-testid="sel-lang-input"
          />
          <button className={btn} onClick={() => runOp("translate")} data-testid="sel-translate-run">执行</button>
        </div>
      )}
      {pending === "custom" && (
        <div className="flex w-full items-center gap-1" data-testid="sel-custom-row">
          <input
            className="min-w-0 flex-1 rounded-md border border-[var(--line)] bg-white px-1 py-0.5 text-xs"
            placeholder="对选区的自定义指令"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            data-testid="sel-custom-input"
          />
          <button className={btn} onClick={() => runOp("custom")} data-testid="sel-custom-run">执行</button>
        </div>
      )}
    </div>
  );
}
