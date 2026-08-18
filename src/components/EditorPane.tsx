import { useCallback, useEffect, useRef, useState } from "react";
import MDEditor from "@uiw/react-md-editor";
import "@uiw/react-md-editor/markdown-editor.css";
import { api } from "../lib/api";
import { useApp, ViewMode } from "../stores/app";
import { previewComponents, previewRehypePlugins, previewRemarkPlugins } from "../lib/markdown";

const STATUS_OPTIONS = [
  ["draft", "草稿"],
  ["writing", "写作中"],
  ["done", "完稿"],
  ["archived", "归档"],
] as const;

function insertAtCursor(ta: HTMLTextAreaElement, text: string): string {
  const { selectionStart: s, selectionEnd: e, value } = ta;
  const next = value.slice(0, s) + text + value.slice(e);
  const pos = s + text.length;
  ta.value = next;
  ta.setSelectionRange(pos, pos);
  return next;
}

export function EditorPane() {
  const selected = useApp((s) => s.selected);
  const viewMode = useApp((s) => s.viewMode);
  const setViewMode = useApp((s) => s.setViewMode);
  const saveState = useApp((s) => s.saveState);
  const savedAt = useApp((s) => s.savedAt);
  const load = useApp((s) => s.load);
  const reloadPost = useApp((s) => s.reloadPost);

  const [body, setBody] = useState(selected?.body ?? "");
  const [titleDraft, setTitleDraft] = useState(selected?.title ?? "");
  const latestBody = useRef(body);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  latestBody.current = body;

  // 切换文稿时重置本地态
  useEffect(() => {
    setBody(selected?.body ?? "");
    setTitleDraft(selected?.title ?? "");
  }, [selected?.id, selected?.title, selected?.body]);

  const doSave = useCallback(async () => {
    const id = useApp.getState().selected?.id;
    if (!id) return;
    const content = latestBody.current;
    const current = useApp.getState().selected?.body;
    if (content === current) return;
    useApp.getState().setSaving();
    try {
      const r = await api.savePost(id, content);
      // 只有内容仍是本次保存的值时才覆盖（避免竞态回退）
      if (latestBody.current === content) {
        useApp.setState((s) => ({
          selected: s.selected ? { ...s.selected, body: content } : null,
        }));
        useApp.getState().setSaved(r.updatedAt);
      }
    } catch (e) {
      console.error("保存失败", e);
      useApp.getState().setDirty();
    }
  }, []);

  // 注册 flush：切换文稿 / 关闭前强制落盘
  useEffect(() => {
    const flush = async () => {
      if (timer.current) clearTimeout(timer.current);
      await doSave();
    };
    useApp.getState().registerFlush(flush);
    const beforeUnload = () => {
      void doSave();
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      if (useApp.getState().flushFn === flush) useApp.getState().registerFlush(null);
    };
  }, [doSave]);

  // 防抖自动保存（800ms）
  useEffect(() => {
    if (!selected) return;
    if (body === selected.body) return;
    useApp.getState().setDirty();
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void doSave(), 800);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [body, selected, doSave]);

  const onTitleCommit = async () => {
    if (!selected) return;
    const title = titleDraft.trim();
    if (!title || title === selected.title) {
      setTitleDraft(selected.title);
      return;
    }
    await api.setPostTitle(selected.id, title);
    await load();
    await reloadPost();
  };

  const onStatusChange = async (status: string) => {
    if (!selected) return;
    await api.setPostStatus(selected.id, status);
    await load();
    await reloadPost();
  };

  const onPaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items || !selected) return;
    for (const item of Array.from(items)) {
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        const ta = e.currentTarget; // currentTarget 在 await 之后会被清空，先捕获
        const file = item.getAsFile();
        if (!file) return;
        const buf = new Uint8Array(await file.arrayBuffer());
        const ext = (item.type.split("/")[1] || "png").replace("jpeg", "jpg");
        const rel = await api.savePastedImage(selected.id, buf, ext);
        const next = insertAtCursor(ta, `![](${rel})`);
        setBody(next);
        return;
      }
    }
  };

  if (!selected) return null;

  const saveLabel =
    saveState === "dirty" ? "未保存…" : saveState === "saving" ? "保存中…" : savedAt ? `已保存 · ${savedAt.slice(11)}` : "已保存";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 顶部：标题 + 状态 + 模式 + 保存指示 */}
      <div className="flex items-center gap-3 border-b border-[var(--line)] bg-[var(--card)] px-5 py-2">
        <input
          value={titleDraft}
          onChange={(e) => setTitleDraft(e.target.value)}
          onBlur={onTitleCommit}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          className="min-w-0 flex-1 bg-transparent text-lg font-bold outline-none"
          data-testid="editor-title"
        />
        <select
          value={selected.status}
          onChange={(e) => void onStatusChange(e.target.value)}
          className="rounded-md border border-[var(--line)] bg-white px-2 py-1 text-xs"
          data-testid="editor-status"
        >
          {STATUS_OPTIONS.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
        <span className="text-[11px] text-[var(--muted)]" data-testid="save-indicator">
          {saveLabel}
        </span>
      </div>

      {/* 模式切换（prototype subbar 样式） */}
      <div className="flex items-center gap-2 border-b border-[var(--line)] bg-[#fbf7ef] px-5 py-1.5 text-xs">
        <div className="inline-flex rounded-lg bg-[var(--cream)] p-0.5">
          {(
            [
              ["edit", "源码"],
              ["live", "分栏"],
              ["preview", "预览"],
            ] as const
          ).map(([mode, label]) => (
            <button
              key={mode}
              onClick={() => setViewMode(mode as ViewMode)}
              className={`rounded-md px-3 py-1 ${viewMode === mode ? "bg-white font-semibold shadow-sm" : "text-[var(--muted)]"}`}
              data-testid={`mode-${mode}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* 编辑器 */}
      <div className="min-h-0 flex-1" data-color-mode="light">
        <MDEditor
          value={body}
          onChange={(v) => setBody(v ?? "")}
          preview={viewMode === "edit" ? "edit" : viewMode === "live" ? "live" : "preview"}
          height="100%"
          style={{ background: "var(--bg)" }}
          textareaProps={
            {
              onPaste: onPaste,
              "data-testid": "md-textarea",
            } as unknown as NonNullable<
              Parameters<typeof MDEditor>[0]["textareaProps"]
            >
          }
          previewOptions={{
            remarkPlugins: previewRemarkPlugins,
            rehypePlugins: previewRehypePlugins,
            components: previewComponents,
          }}
        />
      </div>
    </div>
  );
}
