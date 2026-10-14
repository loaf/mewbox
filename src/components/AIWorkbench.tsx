import { useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  type AiConfigState,
  type AiProviderConfig,
  type ContextEntry,
} from "../lib/api";
import { useApp } from "../stores/app";
import { useActiveValue } from "../stores/pane";
import { estimateTokens, newCallId, resolveRouteProvider, routeLabel, useAIStream } from "../lib/useAIStream";

const WORKBENCH_OPS: [string, string][] = [
  ["summarize", "总结"],
  ["keypoints", "要点"],
  ["translate", "翻译"],
  ["compare", "对比"],
  ["qa", "问答"],
  ["describe_attachment", "附件描述"],
  ["custom", "自定义"],
];

export function entryKey(e: ContextEntry): string {
  return e.kind === "version" ? `version:${e.base}/${e.target}` : `${e.kind}:${e.id}`;
}

/** 容器化资料的附件名：正文里指向 _assets/ 的链接（与 frontmatter attachments 同源） */
export function attachmentsFromBody(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(/_assets\/([A-Za-z0-9._\-]+)/g)) out.add(m[1]);
  return [...out];
}

const btn = "rounded-md border border-[var(--line)] bg-white px-2.5 py-1 text-[12px] hover:border-[var(--cat)]";

export function AIWorkbench() {
  const posts = useApp((s) => s.posts);
  const materials = useApp((s) => s.materials);
  const view = useActiveValue("view");
  const version = useActiveValue("version");
  const selected = useActiveValue("selected");
  const material = useActiveValue("material");
  const load = useApp((s) => s.load);
  const aiContext = useApp((s) => s.aiContext);
  const setAIContext = useApp((s) => s.setAIContext);
  const { entries, includeAttachmentText } = aiContext;

  const [op, setOp] = useState<string>("summarize");
  const [targetLang, setTargetLang] = useState("英文");
  const [question, setQuestion] = useState("");
  const [custom, setCustom] = useState("");
  const [qaHistory, setQaHistory] = useState<[string, string][]>([]);
  const [config, setConfig] = useState<AiConfigState | null>(null);
  const [bodies, setBodies] = useState<Record<string, string>>({});
  const [attachPick, setAttachPick] = useState<string | null>(null);
  const [saveForm, setSaveForm] = useState<{ title: string; assoc: boolean } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const stream = useAIStream();
  const callIdRef = useRef<string | null>(null);
  const previewRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    void api.aiListProviders().then(setConfig).catch(() => setConfig(null));
  }, []);

  // 勾选对象 → 拉正文（token 估算 + 附件探测）；问答窗口随上下文变化重置
  useEffect(() => {
    setQaHistory([]);
    let alive = true;
    void (async () => {
      for (const e of entries) {
        const k = entryKey(e);
        if (bodies[k] !== undefined) continue;
        try {
          const b =
            e.kind === "post"
              ? (await api.readPost(e.id!)).body
              : e.kind === "material"
                ? (await api.readMaterial(e.id!)).body
                : (await api.readPublishVersion(e.base!, e.target!)).body;
          if (alive) setBodies((m) => ({ ...m, [k]: b }));
        } catch {
          if (alive) setBodies((m) => ({ ...m, [k]: "" }));
        }
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries]);

  // 流式预览自动滚动
  useEffect(() => {
    if (previewRef.current) previewRef.current.scrollTop = previewRef.current.scrollHeight;
  }, [stream.text]);

  const toggleEntry = (e: ContextEntry) => {
    const k = entryKey(e);
    const has = entries.some((x) => entryKey(x) === k);
    setAIContext({
      entries: has ? entries.filter((x) => entryKey(x) !== k) : [...entries, e],
      includeAttachmentText,
    });
  };

  const removeEntry = (e: ContextEntry) => {
    setAIContext({ entries: entries.filter((x) => entryKey(x) !== entryKey(e)), includeAttachmentText });
  };

  // 上下文字符量与 token 粗估（修订决策 8：chars/4）
  const totalChars = entries.reduce((s, e) => s + (bodies[entryKey(e)]?.length ?? 0), 0);
  const estTokens = estimateTokens(totalChars);
  const routeProvider: AiProviderConfig | null = resolveRouteProvider(config, op);
  const overLimit = !!(routeProvider?.maxContext && estTokens > routeProvider.maxContext);

  // 已勾资料各自带的附件（正文 _assets 链接探测）
  const materialAttachments = useMemo(
    () =>
      entries.flatMap((e) => {
        if (e.kind !== "material") return [];
        const names = attachmentsFromBody(bodies[entryKey(e)] ?? "");
        return names.map((n) => ({ materialId: e.id!, name: n }));
      }),
    [entries, bodies],
  );
  const hasAttachments = materialAttachments.length > 0;

  const start = () => {
    const id = newCallId();
    callIdRef.current = id;
    setSaveForm(null);
    setNote(null);
    if (op === "describe_attachment") {
      const pick =
        materialAttachments.find((a) => `${a.materialId}|${a.name}` === attachPick) ??
        materialAttachments[0];
      if (!pick) return;
      void stream.run(id, () => api.aiDescribeAttachment(id, pick.materialId, pick.name));
      return;
    }
    void stream.run(
      id,
      () =>
        api.aiRunOp(id, op, entries, {
          custom: custom.trim() || undefined,
          question: op === "qa" ? question.trim() || undefined : undefined,
          history: op === "qa" && qaHistory.length > 0 ? qaHistory : undefined,
          targetLang: op === "translate" ? targetLang.trim() || undefined : undefined,
          includeAttachmentText: includeAttachmentText || undefined,
        }),
    );
  };

  const finish = (fn: () => Promise<void>) => {
    void (async () => {
      try {
        await fn();
      } catch (e) {
        setNote(`操作失败：${String(e)}`);
      }
    })();
  };

  /** 插入当前文稿光标处（EditorPane 监听 mewbox:insert） */
  const insertResult = () => {
    const id = callIdRef.current;
    if (!id) return;
    window.dispatchEvent(new CustomEvent("mewbox:insert", { detail: { text: stream.text } }));
    finish(async () => {
      await api.aiAdoptResult(id);
      stream.reset();
    });
  };

  const copyResult = () => {
    const id = callIdRef.current;
    if (!id) return;
    finish(async () => {
      try {
        await navigator.clipboard?.writeText(stream.text);
      } catch {
        /* 无剪贴板权限时忽略 */
      }
      await api.aiAdoptResult(id);
      setNote("已复制到剪贴板");
      stream.reset();
    });
  };

  const discard = () => {
    const id = callIdRef.current;
    if (!id) return;
    finish(async () => {
      await api.aiDiscardResult(id);
      stream.reset();
    });
  };

  const confirmSaveAsMaterial = () => {
    const id = callIdRef.current;
    if (!id || !saveForm) return;
    finish(async () => {
      const sourceIds = entries.flatMap((e) => (e.kind === "version" ? [] : e.id ? [e.id] : []));
      const m = await api.aiSaveAsMaterial(
        id,
        saveForm.title.trim() || "AI 结果",
        stream.text,
        sourceIds,
        saveForm.assoc ? sourceIds : [],
      );
      await load();
      setNote(`已存为资料《${m.title}》（kb/Inbox）`);
      setSaveForm(null);
      stream.reset();
    });
  };

  const onClosePreview = () => {
    if (stream.status === "streaming") void stream.cancel();
    else if (stream.status === "done") discard();
    else stream.reset();
  };

  // 追问：把本轮问答记入当次窗口历史
  const followUp = () => {
    if (!question.trim() || !stream.text) return;
    setQaHistory((h) => [...h, [question.trim(), stream.text] as [string, string]]);
    setQuestion("");
  };

  const hasEditorTarget = !!(selected || version || material);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-auto text-[12.5px]" data-testid="ai-workbench">
      {/* ① 上下文 */}
      <section>
        <div className="mb-1 text-[11.5px] font-bold tracking-[0.04em] text-[var(--muted)]">① 上下文（文稿 + 资料混选）</div>
        <div className="max-h-40 overflow-auto rounded-lg border border-[var(--line)] bg-white p-2">
          {posts.map((p) => (
            <label key={`p-${p.id}`} className="flex items-center gap-1 py-0.5">
              <input
                type="checkbox"
                checked={entries.some((e) => entryKey(e) === `post:${p.id}`)}
                onChange={() => toggleEntry({ kind: "post", id: p.id })}
                data-testid={`ctx-post-${p.id}`}
              />
              <span className="truncate">📄 {p.title}</span>
            </label>
          ))}
          {materials.map((m) => (
            <label key={`m-${m.id}`} className="flex items-center gap-1 py-0.5">
              <input
                type="checkbox"
                checked={entries.some((e) => entryKey(e) === `material:${m.id}`)}
                onChange={() => toggleEntry({ kind: "material", id: m.id })}
                data-testid={`ctx-material-${m.id}`}
              />
              <span className="truncate">📚 {m.title}</span>
            </label>
          ))}
          {posts.length === 0 && materials.length === 0 && (
            <div className="text-[var(--muted)]">（暂无文稿与资料）</div>
          )}
        </div>
        {view.kind === "version" && (
          <button
            className={`${btn} mt-1`}
            onClick={() => {
              if (!entries.some((e) => entryKey(e) === `version:${view.baseId}/${view.target}`)) {
                setAIContext({ entries: [...entries, { kind: "version", base: view.baseId, target: view.target }], includeAttachmentText });
              }
            }}
            data-testid="ctx-add-version"
          >
            ＋ 加入当前版本（{view.target}）
          </button>
        )}
        {entries.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {entries.map((e) => (
              <button
                key={entryKey(e)}
                className="rounded-full bg-[var(--cream)] px-2 py-0.5"
                onClick={() => removeEntry(e)}
                data-testid={`ctx-chip-${entryKey(e)}`}
              >
                {e.kind === "version" ? `📣 ${e.target} 版 ✕` : `${e.kind === "post" ? "📄" : "📚"} ${e.id} ✕`}
              </button>
            ))}
          </div>
        )}
        {hasAttachments && op !== "describe_attachment" && (
          <label className="mt-1 flex items-center gap-1 text-[11px] text-[var(--muted)]">
            <input
              type="checkbox"
              checked={includeAttachmentText}
              onChange={(e2) => setAIContext({ entries, includeAttachmentText: e2.target.checked })}
              data-testid="ctx-include-attachments"
            />
            包含资料附件原文（{materialAttachments.map((a) => a.name).join("、")}）
          </label>
        )}
        {op === "describe_attachment" && (
          <div className="mt-1" data-testid="attach-pick-list">
            {materialAttachments.length === 0 && <div className="text-[11px] text-[var(--muted)]">先勾选带附件的资料（容器化导入的 pdf/图片）</div>}
            {materialAttachments.map((a) => (
              <label key={`${a.materialId}|${a.name}`} className="flex items-center gap-1 py-0.5">
                <input
                  type="radio"
                  name="attach-pick"
                  checked={attachPick === `${a.materialId}|${a.name}` || (!attachPick && materialAttachments[0] === a)}
                  onChange={() => setAttachPick(`${a.materialId}|${a.name}`)}
                />
                {a.name}
              </label>
            ))}
          </div>
        )}
      </section>

      {/* ② 操作 */}
      <section>
        <div className="mb-1 text-[11.5px] font-bold tracking-[0.04em] text-[var(--muted)]">② 操作</div>
        <div className="flex flex-wrap items-center gap-1">
          <select value={op} onChange={(e) => setOp(e.target.value)} className="rounded-md border border-[var(--line)] bg-white px-3 py-1.5 text-[12px]" data-testid="ai-op-select">
            {WORKBENCH_OPS.map(([v, label]) => (
              <option key={v} value={v}>{label}</option>
            ))}
          </select>
          {op === "translate" && (
            <input
              className="w-20 rounded-md border border-[var(--line)] bg-white px-2 py-1"
              placeholder="目标语言"
              value={targetLang}
              onChange={(e) => setTargetLang(e.target.value)}
              data-testid="ai-target-lang"
            />
          )}
          {op === "qa" && qaHistory.length > 0 && (
            <span className="text-[11px] text-[var(--muted)]">当次对话 {qaHistory.length} 轮</span>
          )}
        </div>
        {op === "qa" && (
          <div className="mt-1 flex gap-1">
            <input
              className="min-w-0 flex-1 rounded-md border border-[var(--line)] bg-white px-2 py-1"
              placeholder="基于所选材料提问…"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              data-testid="ai-question"
            />
            {stream.status === "done" && stream.text && (
              <button className={btn} onClick={followUp} data-testid="ai-followup">追问</button>
            )}
          </div>
        )}
        {op === "custom" && (
          <textarea
            className="mt-1 h-16 w-full rounded-md border border-[var(--line)] bg-white px-2 py-1"
            placeholder="自定义指令（作用于所选上下文）"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            data-testid="ai-custom"
          />
        )}
      </section>

      {/* ③ 出站提示 + token 预估（铁律 5 / 修订决策 8） */}
      <section className="rounded-lg border border-dashed border-[var(--line)] p-2 text-[11px] text-[var(--muted)]">
        <div data-testid="ai-outbound-note">{routeLabel(config, op)}</div>
        <div data-testid="ai-token-estimate">
          预估 ≈ {estTokens.toLocaleString()} tokens（{totalChars.toLocaleString()} 字符 ÷ 4）
          {routeProvider?.maxContext ? ` / 模型上限 ${routeProvider.maxContext.toLocaleString()}` : ""}
        </div>
        {overLimit && (
          <div className="mt-1 text-red-500" data-testid="ai-token-warning">
            ⚠ 超出模型上下文上限：建议分批（减少勾选对象）、截断（编辑对象正文）或换更大上下文模型。
          </div>
        )}
      </section>

      {/* ④ 开始 / 流式预览 */}
      <button
        className="self-start rounded-md bg-[var(--cat)] px-4 py-1.5 text-[12px] font-semibold text-white disabled:opacity-40"
        disabled={entries.length === 0 || (op === "describe_attachment" && materialAttachments.length === 0)}
        onClick={start}
        data-testid="ai-start"
      >
        开始
      </button>

      {stream.status !== "idle" && (
        <section className="rounded-lg border border-[var(--line)] bg-white p-2" data-testid="ai-preview">
          <div className="mb-1 flex items-center gap-2">
            <span className="font-semibold">{stream.status === "streaming" ? "生成中…" : stream.status === "error" ? "出错" : "结果预览"}</span>
            {stream.status === "done" && (
              <span className="text-[11px] text-[var(--muted)]">tokens {stream.tokens.in} / {stream.tokens.out}</span>
            )}
            <button className="ml-auto text-[var(--muted)]" onClick={onClosePreview} data-testid="ai-preview-close">✕</button>
          </div>
          <pre ref={previewRef} className="max-h-72 overflow-auto whitespace-pre-wrap text-xs" data-testid="ai-preview-text">
            {stream.text || (stream.status === "streaming" ? "…" : "")}
          </pre>
          {stream.status === "error" && (
            <div className="mt-1 text-red-500" data-testid="ai-error">{stream.error}</div>
          )}

          {/* ⑤ 结果去向（铁律 2：先预览、采纳才落盘） */}
          {stream.status === "done" && (
            <div className="mt-2 flex flex-wrap gap-1">
              <button className={btn} disabled={!hasEditorTarget} onClick={insertResult} data-testid="ai-insert">插入当前文稿光标处</button>
              <button className={btn} onClick={() => setSaveForm({ title: `AI ${op} · ${new Date().toISOString().slice(0, 10)}`, assoc: true })} data-testid="ai-save-as">存为资料…</button>
              <button className={btn} onClick={copyResult} data-testid="ai-copy">复制</button>
              <button className={btn} onClick={discard} data-testid="ai-discard">丢弃</button>
            </div>
          )}
          {stream.status === "streaming" && (
            <button className={`${btn} mt-2`} onClick={() => void stream.cancel()} data-testid="ai-cancel">取消</button>
          )}
          {saveForm && (
            <div className="mt-2 rounded-md bg-[var(--cream)] p-2" data-testid="ai-save-form">
              <div className="flex items-center gap-1">
                <input
                  className="min-w-0 flex-1 rounded-md border border-[var(--line)] bg-white px-2 py-1"
                  value={saveForm.title}
                  onChange={(e) => setSaveForm({ ...saveForm, title: e.target.value })}
                  data-testid="ai-save-title"
                />
                <button className="rounded-md bg-[var(--cat)] px-2 py-1 font-semibold text-white" onClick={confirmSaveAsMaterial} data-testid="ai-save-confirm">存入 kb/Inbox</button>
                <button className={btn} onClick={() => setSaveForm(null)}>取消</button>
              </div>
              <label className="mt-1 flex items-center gap-1 text-[11px] text-[var(--muted)]">
                <input type="checkbox" checked={saveForm.assoc} onChange={(e) => setSaveForm({ ...saveForm, assoc: e.target.checked })} data-testid="ai-save-assoc" />
                关联来源对象
              </label>
            </div>
          )}
        </section>
      )}
      {note && <div className="text-[11px] text-[var(--muted)]" data-testid="ai-note">{note}</div>}
    </div>
  );
}
