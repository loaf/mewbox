import { useCallback, useEffect, useRef, useState } from "react";
import MDEditor from "@uiw/react-md-editor";
import "@uiw/react-md-editor/markdown-editor.css";
import { api } from "../lib/api";
import { useApp, ViewMode } from "../stores/app";
import { assetContext, editorPreviewOptions } from "../lib/markdown";
import { PublishDialog, PublishRecordDialog } from "./PublishDialog";
import { SyncVersionDialog } from "./SyncVersionDialog";

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
  const view = useApp((s) => s.view);
  const selected = useApp((s) => s.selected);
  const selectedId = useApp((s) => s.selectedId);
  const version = useApp((s) => s.version);
  const posts = useApp((s) => s.posts);
  const viewMode = useApp((s) => s.viewMode);
  const setViewMode = useApp((s) => s.setViewMode);
  const saveState = useApp((s) => s.saveState);
  const savedAt = useApp((s) => s.savedAt);
  const load = useApp((s) => s.load);
  const reloadPost = useApp((s) => s.reloadPost);
  const backToPost = useApp((s) => s.backToPost);

  const isVersion = view.kind === "version";
  const active = isVersion ? version : selected;
  const activeId = isVersion ? (version?.id ?? null) : (selected?.id ?? null);
  const activeBody = active?.body ?? "";

  const [body, setBody] = useState(activeBody);
  const [titleDraft, setTitleDraft] = useState(selected?.title ?? "");
  const latestBody = useRef(body);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [publishOpen, setPublishOpen] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  const [recordOpen, setRecordOpen] = useState(false);

  latestBody.current = body;

  // 贴图/相对资源的解析基准：当前预览文件所在目录（文稿 or 版本）
  useEffect(() => {
    if (view.kind === "version") {
      assetContext.baseDir = `.versions/${view.baseId}/publish`;
    } else {
      assetContext.baseDir = selected?.path
        ? selected.path.split("/").slice(0, -1).join("/")
        : "posts";
    }
  }, [view, selected?.path]);

  // 切换目标（文稿/版本）时重置本地态
  useEffect(() => {
    setBody(activeBody);
    setTitleDraft(selected?.title ?? "");
  }, [activeId, activeBody, selected?.title]);

  const doSave = useCallback(async () => {
    const st = useApp.getState();
    const content = latestBody.current;
    if (st.view.kind === "version") {
      const { baseId, target } = st.view;
      if (!st.version || content === st.version.body) return;
      st.setSaving();
      try {
        const r = await api.savePublishVersion(baseId, target, content);
        if (latestBody.current === content) {
          useApp.setState((s) => ({
            version: s.version ? { ...s.version, body: content } : null,
          }));
          st.setSaved(r.updatedAt);
        }
      } catch (e) {
        console.error("版本保存失败", e);
        st.setDirty();
      }
      return;
    }
    const id = st.selected?.id;
    if (!id) return;
    const current = st.selected?.body;
    if (content === current) return;
    st.setSaving();
    try {
      const r = await api.savePost(id, content);
      if (latestBody.current === content) {
        useApp.setState((s) => ({
          selected: s.selected ? { ...s.selected, body: content } : null,
        }));
        st.setSaved(r.updatedAt);
      }
    } catch (e) {
      console.error("保存失败", e);
      st.setDirty();
    }
  }, []);

  // 注册 flush：切换文稿/版本前强制落盘
  useEffect(() => {
    const flush = async () => {
      if (timer.current) clearTimeout(timer.current);
      await doSave();
    };
    useApp.getState().registerFlush(flush);
    window.addEventListener("beforeunload", () => void doSave());
    return () => {
      if (useApp.getState().flushFn === flush) useApp.getState().registerFlush(null);
    };
  }, [doSave]);

  // 防抖自动保存（800ms）
  useEffect(() => {
    if (!active) return;
    if (body === activeBody) return;
    useApp.getState().setDirty();
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void doSave(), 800);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [body, active, activeBody, doSave]);

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
    if (!items || !active) return;
    for (const item of Array.from(items)) {
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        const ta = e.currentTarget;
        const file = item.getAsFile();
        if (!file) return;
        const buf = new Uint8Array(await file.arrayBuffer());
        const ext = (item.type.split("/")[1] || "png").replace("jpeg", "jpg");
        const rel = isVersion && view.kind === "version"
          ? await api.savePastedImageAt(`.versions/${view.baseId}/publish/${view.target}.md`, buf, ext)
          : await api.savePastedImage((active as { id: string }).id, buf, ext);
        const next = insertAtCursor(ta, `![](${rel})`);
        setBody(next);
        return;
      }
    }
  };

  if (!active) return null;

  const saveLabel =
    saveState === "dirty" ? "未保存…" : saveState === "saving" ? "保存中…" : savedAt ? `已保存 · ${savedAt.slice(11)}` : "已保存";

  const baseTitle = view.kind === "version" ? posts.find((p) => p.id === view.baseId)?.title : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {isVersion && view.kind === "version" && (
        <div className="flex items-center gap-2 border-b border-[var(--line)] bg-[var(--cat-bg)] px-5 py-1.5 text-xs" data-testid="version-banner">
          <span className="font-semibold">📣 {view.target} 版</span>
          <span className="text-[var(--muted)]">属于《{baseTitle ?? view.baseId}》· 编辑不影响母版</span>
          {version?.publishedUrl && (
            <a href={version.publishedUrl} className="underline" target="_blank" rel="noreferrer">
              已发布 ↗
            </a>
          )}
          <div className="ml-auto flex gap-1">
            <button className="rounded-md border border-[var(--line)] bg-white px-2 py-0.5" onClick={() => setSyncOpen(true)} data-testid="sync-btn">
              从文稿同步…
            </button>
            <button className="rounded-md border border-[var(--line)] bg-white px-2 py-0.5" onClick={() => setRecordOpen(true)} data-testid="record-btn">
              发布记录…
            </button>
            <button className="rounded-md bg-[var(--cat)] px-2 py-0.5 font-semibold text-white" onClick={() => void backToPost()} data-testid="back-to-post">
              回到母版
            </button>
          </div>
        </div>
      )}

      {/* 顶部：标题 + 状态 + 模式 + 保存指示 */}
      <div className="flex items-center gap-3 border-b border-[var(--line)] bg-[var(--card)] px-5 py-2">
        {isVersion ? (
          <span className="min-w-0 flex-1 truncate text-lg font-bold" data-testid="version-title">
            {version?.title || `${(view as { target: string }).target} 版`}
          </span>
        ) : (
          <input
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={onTitleCommit}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            className="min-w-0 flex-1 bg-transparent text-lg font-bold outline-none"
            data-testid="editor-title"
          />
        )}
        {isVersion ? (
          <button
            onClick={() => setPublishOpen(true)}
            className="rounded-md border border-[var(--line)] bg-white px-2 py-1 text-xs"
            data-testid="open-publish-menu"
          >
            发布版本…
          </button>
        ) : (
          <select
            value={selected?.status ?? "draft"}
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
        )}
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
        {!isVersion && selected && (
          <button
            onClick={() => setPublishOpen(true)}
            className="ml-auto rounded-md border border-[var(--line)] bg-white px-2 py-0.5"
            data-testid="publish-entry"
          >
            发布版本…
          </button>
        )}
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
          previewOptions={editorPreviewOptions}
        />
      </div>

      {view.kind === "post" && selectedId && (
        <PublishDialog open={publishOpen} baseId={selectedId} onClose={() => setPublishOpen(false)} />
      )}
      {view.kind === "version" && (
        <>
          <SyncVersionDialog open={syncOpen} baseId={view.baseId} target={view.target} onClose={() => setSyncOpen(false)} />
          <PublishRecordDialog
            open={recordOpen}
            baseId={view.baseId}
            target={view.target}
            initialUrl={version?.publishedUrl ?? null}
            initialDate={version?.publishedAt ?? null}
            onClose={() => setRecordOpen(false)}
          />
        </>
      )}
    </div>
  );
}
