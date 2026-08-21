import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MDEditor from "@uiw/react-md-editor";
import "@uiw/react-md-editor/markdown-editor.css";
import { api, WikiHit } from "../lib/api";
import { useApp, ViewMode } from "../stores/app";
import {
  assetContext,
  editorPreviewOptions,
  MarkdownPreview,
  withWikiLinks,
  wikiTitleFromAnchor,
} from "../lib/markdown";
import { PublishDialog, PublishRecordDialog } from "./PublishDialog";
import { SyncVersionDialog } from "./SyncVersionDialog";
import { AssocPanel } from "./AssocPanel";
import { CandidatesDialog } from "./CandidatesDialog";
import { SelectionToolbar, useSelectionAnchor } from "./SelectionToolbar";
import { ProofreadPanel } from "./ProofreadPanel";
import { CheckErrorsPanel } from "./CheckErrorsPanel";
import type { ContextEntry } from "../lib/api";

const STATUS_OPTIONS = [
  ["draft", "草稿"],
  ["writing", "写作中"],
  ["done", "完稿"],
  ["archived", "归档"],
] as const;

/** 标题栏/菜单栏按钮：纯文字（无圆角方框），hover 显色；字号对齐「已保存」基准 */
const TEXT_BTN = "px-2 py-1 text-[13px] text-[var(--muted)] hover:text-[var(--ink)]";
/** 主操作（回到母版等）：纯文字但保留品牌色与加重 */
const TEXT_BTN_PRIMARY = "px-2 py-1 text-[13px] font-semibold text-[var(--cat)] hover:text-[var(--cat-dk)]";

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
  const material = useApp((s) => s.material);
  const posts = useApp((s) => s.posts);
  const viewMode = useApp((s) => s.viewMode);
  const setViewMode = useApp((s) => s.setViewMode);
  const saveState = useApp((s) => s.saveState);
  const savedAt = useApp((s) => s.savedAt);
  const load = useApp((s) => s.load);
  const reloadPost = useApp((s) => s.reloadPost);
  const reloadMaterial = useApp((s) => s.reloadMaterial);
  const backToPost = useApp((s) => s.backToPost);
  const select = useApp((s) => s.select);
  const selectMaterial = useApp((s) => s.selectMaterial);
  const openAssocPicker = useApp((s) => s.openAssocPicker);
  const editorZoom = useApp((s) => s.editorZoom);
  const zoomEditor = useApp((s) => s.zoomEditor);
  const resetEditorZoom = useApp((s) => s.resetEditorZoom);

  const isVersion = view.kind === "version";
  const isMaterial = view.kind === "material";
  const active = isVersion ? version : isMaterial ? material : selected;
  const activeId = isVersion ? (version?.id ?? null) : isMaterial ? (material?.id ?? null) : (selected?.id ?? null);
  const activeBody = active?.body ?? "";
  const activeTitle = active?.title ?? "";

  const [body, setBody] = useState(activeBody);
  const [titleDraft, setTitleDraft] = useState(activeTitle);
  const latestBody = useRef(body);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [publishOpen, setPublishOpen] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  const [recordOpen, setRecordOpen] = useState(false);
  const [wikiCandidates, setWikiCandidates] = useState<WikiHit[]>([]);
  const [wikiDangling, setWikiDangling] = useState<string | null>(null);

  // M4：选区工具条（锚定鼠标抬起点）+ 全文润色/查错面板
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const selAnchor = useSelectionAnchor();
  const [proofOpen, setProofOpen] = useState(false);
  const [errorsOpen, setErrorsOpen] = useState(false);
  // 编辑器右键菜单（字号缩放）
  const [zoomMenu, setZoomMenu] = useState<{ x: number; y: number } | null>(null);

  // Ctrl/Cmd+= 放大、Ctrl/Cmd+- 缩小、Ctrl/Cmd+0 重置字号
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        zoomEditor(0.1);
      } else if (e.key === "-") {
        e.preventDefault();
        zoomEditor(-0.1);
      } else if (e.key === "0") {
        e.preventDefault();
        resetEditorZoom();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomEditor, resetEditorZoom]);

  latestBody.current = body;

  // 贴图/相对资源的解析基准：当前预览文件所在目录（文稿 / 版本 / 资料）
  useEffect(() => {
    if (view.kind === "version") {
      assetContext.baseDir = `.versions/${view.baseId}/publish`;
    } else if (view.kind === "material" && material?.path) {
      assetContext.baseDir = material.path.split("/").slice(0, -1).join("/");
    } else {
      assetContext.baseDir = selected?.path ? selected.path.split("/").slice(0, -1).join("/") : "posts";
    }
  }, [view, selected?.path, material?.path]);

  // 切换目标（文稿/版本/资料）时重置本地态
  useEffect(() => {
    setBody(activeBody);
    setTitleDraft(activeTitle);
  }, [activeId, activeBody, activeTitle]);

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
    if (st.view.kind === "material") {
      const id = st.view.id;
      if (!st.material || content === st.material.body) return;
      st.setSaving();
      try {
        const r = await api.saveMaterial(id, content);
        if (latestBody.current === content) {
          useApp.setState((s) => ({
            material: s.material ? { ...s.material, body: content } : null,
          }));
          st.setSaved(r.updatedAt);
        }
      } catch (e) {
        console.error("资料保存失败", e);
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

  // 注册 flush：切换文稿/版本/资料前强制落盘
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
    const title = titleDraft.trim();
    if (!title || title === activeTitle) {
      setTitleDraft(activeTitle);
      return;
    }
    if (isMaterial && view.kind === "material") {
      await api.setMaterialTitle(view.id, title);
      await load();
      await reloadMaterial();
      return;
    }
    if (!selected) return;
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

  // 资料横幅：升格为文稿 / 关联到文稿
  const onConvertToPost = async () => {
    if (view.kind !== "material" || !material) return;
    const p = await api.convertMaterialToPost(material.id);
    await load();
    await select(p.id);
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
          : isMaterial && view.kind === "material" && material
            ? await api.savePastedImageAt(material.path, buf, ext)
            : await api.savePastedImage((active as { id: string }).id, buf, ext);
        const next = insertAtCursor(ta, `![](${rel})`);
        setBody(next);
        return;
      }
    }
  };

  // 预览里的 [[wiki]] 链接点击：唯一命中跳转，重名给候选，悬空给提示（§7.2）
  const onPreviewClick = async (e: React.MouseEvent) => {
    const anchor = (e.target as HTMLElement).closest?.("a[data-wiki]");
    if (!anchor) return;
    e.preventDefault();
    const title = wikiTitleFromAnchor(anchor);
    if (!title) return;
    const r = await api.resolveWiki(title).catch(() => null);
    if (!r) return;
    const jump = (h: WikiHit) => (h.kind === "post" ? void select(h.id) : void selectMaterial(h.id));
    if (r.matched) jump(r.matched);
    else if (r.candidates.length > 0) setWikiCandidates(r.candidates);
    else setWikiDangling(title);
  };

  // ───── M4：AI 结果插入 / 选区替换 / 全文面板 ─────

  // 「插入当前文稿光标处」（AI 工作台 / 选区工具条 / 资料检索 都走这个事件）
  useEffect(() => {
    const onInsert = (e: Event) => {
      const text = (e as CustomEvent<{ text?: string }>).detail?.text;
      if (!text) return;
      const ta = wrapRef.current?.querySelector("textarea");
      if (!ta) return;
      setBody(insertAtCursor(ta as HTMLTextAreaElement, text));
    };
    window.addEventListener("mewbox:insert", onInsert);
    return () => window.removeEventListener("mewbox:insert", onInsert);
  }, []);

  // 替换选区（SelectionToolbar 传入触发时的 range）
  const onReplaceRange = useCallback((start: number, end: number, text: string) => {
    const cur = latestBody.current;
    setBody(cur.slice(0, start) + text + cur.slice(end));
  }, []);

  // 全文润色/查错对象（post/material；版本不走这两个入口）
  const aiTarget: ContextEntry | null =
    view.kind === "post" && selected ? { kind: "post", id: selected.id } : view.kind === "material" ? { kind: "material", id: view.id } : null;

  // 打开全文面板前强制落盘（后端按文件读全文）
  const openProofread = async () => {
    await useApp.getState().flushFn?.();
    setErrorsOpen(false);
    setProofOpen(true);
  };
  const openCheckErrors = async () => {
    await useApp.getState().flushFn?.();
    setProofOpen(false);
    setErrorsOpen(true);
  };

  // 自定义预览：预处理 wiki 链接后走共享渲染管线（textarea 保持原文）
  const renderPreview = useCallback(
    (md: string) => (
      <div className="wmde-markdown wmde-markdown-color">
        <MarkdownPreview>{isVersion ? md : withWikiLinks(md)}</MarkdownPreview>
      </div>
    ),
    [isVersion],
  );
  const mdComponents = useMemo(
    () => ({ preview: renderPreview }) as unknown as NonNullable<Parameters<typeof MDEditor>[0]["components"]>,
    [renderPreview],
  );

  if (!active) return null;

  const saveLabel =
    saveState === "dirty" ? "未保存…" : saveState === "saving" ? "保存中…" : savedAt ? `已保存 · ${savedAt.slice(11)}` : "已保存";

  const baseTitle = view.kind === "version" ? posts.find((p) => p.id === view.baseId)?.title : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {isVersion && view.kind === "version" && (
        <div className="flex items-center gap-2 border-b border-[var(--line)] bg-[var(--cat-bg)] px-5 py-2.5 text-[13px]" data-testid="version-banner">
          <span className="font-semibold">📣 {view.target} 版</span>
          <span className="text-[var(--muted)]">属于《{baseTitle ?? view.baseId}》· 编辑不影响母版</span>
          {version?.publishedUrl && (
            <a href={version.publishedUrl} className="underline" target="_blank" rel="noreferrer">
              已发布 ↗
            </a>
          )}
          <div className="ml-auto flex items-center gap-3">
            <button className={TEXT_BTN} onClick={() => setSyncOpen(true)} data-testid="sync-btn">
              从文稿同步…
            </button>
            <button className={TEXT_BTN} onClick={() => setRecordOpen(true)} data-testid="record-btn">
              发布记录…
            </button>
            <button className={TEXT_BTN_PRIMARY} onClick={() => void backToPost()} data-testid="back-to-post">
              回到母版
            </button>
            <span className="w-1 flex-none" aria-hidden />
          </div>
        </div>
      )}

      {isMaterial && view.kind === "material" && (
        <div className="flex items-center gap-2 border-b border-[var(--line)] bg-[#eef3f7] px-5 py-2.5 text-[13px]" data-testid="material-banner">
          <span className="font-semibold">📚 资料 · {material?.folder ?? "Inbox"}</span>
          <span className="text-[var(--muted)]">资料服务写作——升格后进入文稿区</span>
          <div className="ml-auto flex items-center gap-3">
            <button
              className={TEXT_BTN}
              onClick={() => void onConvertToPost()}
              data-testid="convert-to-post"
            >
              升格为文稿
            </button>
            <button
              className={TEXT_BTN}
              onClick={() => openAssocPicker("posts")}
              data-testid="link-to-posts"
            >
              关联到文稿…
            </button>
            <span className="w-1 flex-none" aria-hidden />
          </div>
        </div>
      )}

      {/* 顶部：标题 + 状态 + 模式 + 保存指示（资料无状态/发布）。按钮纯文字，两端留白 */}
      <div className="flex items-center gap-3 border-b border-[var(--line)] bg-[var(--card)] px-6 py-3.5">
        {isVersion ? (
          <span className="min-w-0 flex-1 truncate text-lg font-bold" data-testid="version-title">
            {version?.title || `${(view as { target: string }).target} 版`}
          </span>
        ) : (
          <input
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={() => void onTitleCommit()}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            className="min-w-0 flex-1 bg-transparent text-lg font-bold outline-none"
            data-testid="editor-title"
          />
        )}
        {isVersion && (
          <button
            onClick={() => setPublishOpen(true)}
            className={TEXT_BTN}
            data-testid="open-publish-menu"
          >
            发布版本…
          </button>
        )}
        {!isVersion && !isMaterial && (
          <select
            value={selected?.status ?? "draft"}
            onChange={(e) => void onStatusChange(e.target.value)}
            className="cursor-pointer bg-transparent px-1 py-1 text-[13px] text-[var(--muted)] outline-none hover:text-[var(--ink)]"
            data-testid="editor-status"
          >
            {STATUS_OPTIONS.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        )}
        <span className="text-[13px] text-[var(--muted)]" data-testid="save-indicator">
          {saveLabel}
        </span>
        {!isVersion && (
          <div className="flex items-center gap-3">
            <button
              onClick={() => void openProofread()}
              className={TEXT_BTN}
              data-testid="btn-proofread"
            >
              润色建议
            </button>
            <button
              onClick={() => void openCheckErrors()}
              className={TEXT_BTN}
              data-testid="btn-check-errors"
            >
              查错
            </button>
            <span className="w-1 flex-none" aria-hidden />
          </div>
        )}
      </div>

      {/* 模式切换条：发布入口居左；源码/分栏/预览开关贴右端（靠近右栏） */}
      <div className="flex items-center gap-2 border-b border-[var(--line)] bg-[#fbf7ef] py-2.5 pl-6 pr-3 text-[13px]">
        {view.kind === "post" && selectedId && (
          <button
            onClick={() => setPublishOpen(true)}
            className={TEXT_BTN}
            data-testid="publish-entry"
          >
            发布版本…
          </button>
        )}
        <div className="ml-auto inline-flex gap-2 rounded-md bg-[var(--cream)] p-1.5">
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
              className={`rounded px-6 py-2.5 ${viewMode === mode ? "bg-white font-semibold shadow-sm" : "text-[var(--muted)]"}`}
              data-testid={`mode-${mode}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* 编辑器（预览管线预处理 wiki 链接；textarea 保持原文）。
          充满整栏：侧栏收起时随中栏一起扩宽；右键弹出字号缩放菜单 */}
      <div
        ref={wrapRef}
        className="min-h-0 flex-1"
        data-color-mode="light"
        style={{ "--editor-zoom": editorZoom } as React.CSSProperties}
        onClick={(e) => void onPreviewClick(e)}
        onContextMenu={(e) => {
          e.preventDefault();
          setZoomMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        <MDEditor
          value={body}
          onChange={(v) => setBody(v ?? "")}
          preview={viewMode === "edit" ? "edit" : viewMode === "live" ? "live" : "preview"}
          height="100%"
          style={{
            background: "var(--card)",
          }}
          textareaProps={
            {
              onPaste: onPaste,
              onSelect: selAnchor.handlers.onSelect,
              onMouseUp: selAnchor.handlers.onMouseUp,
              onKeyUp: selAnchor.handlers.onKeyUp,
              "data-testid": "md-textarea",
            } as unknown as NonNullable<
              Parameters<typeof MDEditor>[0]["textareaProps"]
            >
          }
          previewOptions={editorPreviewOptions}
          components={mdComponents}
        />
      </div>

      {/* 关联块（文稿/资料侧；版本无块） */}
      <AssocPanel />

      {/* 编辑器右键菜单：字号缩放（与 Ctrl+= / Ctrl+- / Ctrl+0 等价） */}
      {zoomMenu && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setZoomMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setZoomMenu(null);
            }}
          />
          <div
            className="fixed z-50 min-w-[180px] rounded-lg border border-[var(--line)] bg-white py-1.5 text-[13px] shadow-lg"
            style={{ left: zoomMenu.x, top: zoomMenu.y }}
            data-testid="zoom-menu"
          >
            <button
              className="flex w-full items-center justify-between px-3 py-1.5 text-left hover:bg-[var(--cream)]"
              onClick={() => {
                zoomEditor(0.1);
                setZoomMenu(null);
              }}
              data-testid="zoom-in"
            >
              <span>放大字体</span>
              <span className="text-[10px] text-[var(--muted)]">Ctrl+=</span>
            </button>
            <button
              className="flex w-full items-center justify-between px-3 py-1.5 text-left hover:bg-[var(--cream)]"
              onClick={() => {
                zoomEditor(-0.1);
                setZoomMenu(null);
              }}
              data-testid="zoom-out"
            >
              <span>缩小字体</span>
              <span className="text-[10px] text-[var(--muted)]">Ctrl+-</span>
            </button>
            <button
              className="flex w-full items-center justify-between px-3 py-1.5 text-left hover:bg-[var(--cream)]"
              onClick={() => {
                resetEditorZoom();
                setZoomMenu(null);
              }}
              data-testid="zoom-reset"
            >
              <span>重置字号（{Math.round(editorZoom * 100)}%）</span>
              <span className="text-[10px] text-[var(--muted)]">Ctrl+0</span>
            </button>
          </div>
        </>
      )}

      {/* 状态栏（原型 statusbar：字数/Markdown） */}
      <div
        className="flex h-[36px] flex-none items-center gap-2 border-t border-[var(--line)] bg-[var(--card)] px-[18px] text-[12px] text-[var(--muted)]"
        data-testid="statusbar"
      >
        <span>共 {body.replace(/\s/g, "").length} 字</span>
        <span className="opacity-50">·</span>
        <span>Markdown</span>
        <button
          className="ml-auto px-1 hover:text-[var(--ink)]"
          title="字号缩放（Ctrl+= 放大 / Ctrl+- 缩小 / Ctrl+0 重置）"
          onClick={resetEditorZoom}
          data-testid="zoom-indicator"
        >
          字号 {Math.round(editorZoom * 100)}%
        </button>
      </div>

      {/* M4：选区工具条（edit/live 模式且有选区时浮起） */}
      <SelectionToolbar
        anchor={selAnchor.anchor}
        clear={() => selAnchor.setAnchor(null)}
        lock={selAnchor.lock}
        onReplaceRange={onReplaceRange}
        enabled={viewMode === "edit" || viewMode === "live"}
      />

      {/* M4：全文润色建议 / 查错（post/material；版本不走） */}
      {proofOpen && aiTarget && (
        <ProofreadPanel
          target={aiTarget}
          body={body}
          onApply={(nb) => setBody(nb)}
          onClose={() => setProofOpen(false)}
        />
      )}
      {errorsOpen && aiTarget && (
        <CheckErrorsPanel
          target={aiTarget}
          body={body}
          onApply={(nb) => setBody(nb)}
          onClose={() => setErrorsOpen(false)}
        />
      )}

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

      <CandidatesDialog
        candidates={wikiCandidates}
        dangling={wikiDangling}
        onPick={(h) => {
          setWikiCandidates([]);
          if (h.kind === "post") void select(h.id);
          else void selectMaterial(h.id);
        }}
        onClose={() => {
          setWikiCandidates([]);
          setWikiDangling(null);
        }}
      />
    </div>
  );
}
