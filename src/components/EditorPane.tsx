import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MDEditor from "@uiw/react-md-editor";
import "@uiw/react-md-editor/markdown-editor.css";
import { api, WikiHit } from "../lib/api";
import { useApp, ViewMode, PaneId, panePatch, paneSlice } from "../stores/app";
import { usePaneValue, usePaneAction, paneOps } from "../stores/pane";
import {
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

/** 状态胶囊配色（视觉方案 §3.2：带语义色彩的圆角胶囊，对齐左栏 StatusChip） */
const STATUS_PILL: Record<string, string> = {
  draft: "bg-[#f3e3c8] text-[#9a7a3c]",
  writing: "bg-[var(--cat-bg)] text-[var(--cat)]",
  done: "bg-[#e0ecdd] text-[var(--green)]",
  archived: "bg-[var(--cream)] text-[var(--muted)]",
};

/** 顶部操作按钮（视觉方案 §3.2，原型 .mbtn）：轻边框卡片感，恢复可交互边界 */
const MBTN =
  "rounded-[7px] border border-[var(--line)] bg-white px-2.5 py-1 text-[12px] text-[var(--ink)] hover:bg-[var(--cream)]";
/** 主操作（回到母版等）：品牌色实底 */
const MBTN_PRIMARY =
  "rounded-[7px] border border-[var(--cat)] bg-[var(--cat)] px-2.5 py-1 text-[12px] font-semibold text-white hover:bg-[var(--cat-dk)]";

function insertAtCursor(ta: HTMLTextAreaElement, text: string): string {
  const { selectionStart: s, selectionEnd: e, value } = ta;
  const next = value.slice(0, s) + text + value.slice(e);
  const pos = s + text.length;
  ta.value = next;
  ta.setSelectionRange(pos, pos);
  return next;
}

/** 双栏（第二步）：同一组件渲染主栏/次栏两个实例，取数与动作经 pane 映射到对应切片 */
export function EditorPane({ pane = "primary" }: { pane?: PaneId }) {
  const view = usePaneValue(pane, "view");
  const selected = usePaneValue(pane, "selected");
  const selectedId = usePaneValue(pane, "selectedId");
  const version = usePaneValue(pane, "version");
  const material = usePaneValue(pane, "material");
  const viewMode = usePaneValue(pane, "viewMode");
  const saveState = usePaneValue(pane, "saveState");
  const savedAt = usePaneValue(pane, "savedAt");
  const setViewMode = usePaneAction(pane, "setViewMode");
  const reloadPost = usePaneAction(pane, "reloadPost");
  const reloadMaterial = usePaneAction(pane, "reloadMaterial");
  const backToPost = usePaneAction(pane, "backToPost");
  const select = usePaneAction(pane, "select");
  const selectMaterial = usePaneAction(pane, "selectMaterial");
  const posts = useApp((s) => s.posts);
  const load = useApp((s) => s.load);
  const openAssocPicker = useApp((s) => s.openAssocPicker);
  const openPane2 = useApp((s) => s.openPane2);
  const closePane2 = useApp((s) => s.closePane2);
  const swapPane2 = useApp((s) => s.swapPane2);
  const editorZoom = useApp((s) => s.editorZoom);
  const zoomEditor = useApp((s) => s.zoomEditor);
  const resetEditorZoom = useApp((s) => s.resetEditorZoom);

  /** 次栏实例的 testid 加后缀 -2，避免双栏时与主栏同名冲突 */
  const tid = (id: string) => (pane === "secondary" ? `${id}-2` : id);

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

  // Ctrl/Cmd+= 放大、Ctrl/Cmd+- 缩小、Ctrl/Cmd+0 重置字号（缩放是全局的，仅主栏实例注册）
  useEffect(() => {
    if (pane !== "primary") return;
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

  // 贴图/相对资源的解析基准：当前预览文件所在目录（文稿 / 版本 / 资料）。
  // 分栏后有多个预览实例同时渲染，目录按渲染作用域传给 MarkdownPreview，不再写全局
  const previewBaseDir = useMemo(() => {
    if (view.kind === "version") return `.versions/${view.baseId}/publish`;
    if (view.kind === "material" && material?.path) return material.path.split("/").slice(0, -1).join("/");
    return selected?.path ? selected.path.split("/").slice(0, -1).join("/") : "posts";
  }, [view, selected?.path, material?.path]);

  // 切换目标（文稿/版本/资料）时重置本地态
  useEffect(() => {
    setBody(activeBody);
    setTitleDraft(activeTitle);
  }, [activeId, activeBody, activeTitle]);

  const doSave = useCallback(async () => {
    const st = useApp.getState();
    const ops = paneOps(st, pane);
    const sl = paneSlice(st, pane);
    const content = latestBody.current;
    if (sl.view.kind === "version") {
      const { baseId, target } = sl.view;
      if (!sl.version || content === sl.version.body) return;
      ops.setSaving();
      try {
        const r = await api.savePublishVersion(baseId, target, content);
        if (latestBody.current === content) {
          useApp.setState((s) => {
            const cur = paneSlice(s, pane).version;
            return panePatch(pane, { version: cur ? { ...cur, body: content } : null });
          });
          ops.setSaved(r.updatedAt);
        }
      } catch (e) {
        console.error("版本保存失败", e);
        ops.setDirty();
      }
      return;
    }
    if (sl.view.kind === "material") {
      const id = sl.view.id;
      if (!sl.material || content === sl.material.body) return;
      ops.setSaving();
      try {
        const r = await api.saveMaterial(id, content);
        if (latestBody.current === content) {
          useApp.setState((s) => {
            const cur = paneSlice(s, pane).material;
            return panePatch(pane, { material: cur ? { ...cur, body: content } : null });
          });
          ops.setSaved(r.updatedAt);
        }
      } catch (e) {
        console.error("资料保存失败", e);
        ops.setDirty();
      }
      return;
    }
    const id = sl.selected?.id;
    if (!id) return;
    if (content === sl.selected?.body) return;
    ops.setSaving();
    try {
      const r = await api.savePost(id, content);
      if (latestBody.current === content) {
        useApp.setState((s) => {
          const cur = paneSlice(s, pane).selected;
          return panePatch(pane, { selected: cur ? { ...cur, body: content } : null });
        });
        ops.setSaved(r.updatedAt);
      }
    } catch (e) {
      console.error("保存失败", e);
      ops.setDirty();
    }
  }, [pane]);

  // 注册 flush：切换文稿/版本/资料前强制落盘（主/次栏各一个槽位）
  useEffect(() => {
    const flush = async () => {
      if (timer.current) clearTimeout(timer.current);
      await doSave();
    };
    paneOps(useApp.getState(), pane).registerFlush(flush);
    window.addEventListener("beforeunload", () => void doSave());
    return () => {
      if (paneSlice(useApp.getState(), pane).flushFn === flush) paneOps(useApp.getState(), pane).registerFlush(null);
    };
  }, [doSave, pane]);

  // 防抖自动保存（800ms）
  useEffect(() => {
    if (!active) return;
    if (body === activeBody) return;
    paneOps(useApp.getState(), pane).setDirty();
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void doSave(), 800);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [body, active, activeBody, doSave, pane]);

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

  // 预览里的 [[wiki]] 链接点击：唯一命中跳转，重名给候选，悬空给提示（§7.2）。
  // Alt+点击：文稿命中 → 开进「另一栏」（主栏 Alt → 次栏；次栏 Alt → 主栏）
  const onPreviewClick = async (e: React.MouseEvent) => {
    const anchor = (e.target as HTMLElement).closest?.("a[data-wiki]");
    if (!anchor) return;
    e.preventDefault();
    const title = wikiTitleFromAnchor(anchor);
    if (!title) return;
    const r = await api.resolveWiki(title).catch(() => null);
    if (!r) return;
    if (e.altKey && r.matched?.kind === "post") {
      if (pane === "primary") void openPane2(r.matched.id);
      else void useApp.getState().select(r.matched.id); // 同篇防呆在 store 内处理
      return;
    }
    const jump = (h: WikiHit) => (h.kind === "post" ? void select(h.id) : void selectMaterial(h.id));
    if (r.matched) jump(r.matched);
    else if (r.candidates.length > 0) setWikiCandidates(r.candidates);
    else setWikiDangling(title);
  };

  // ───── M4：AI 结果插入 / 选区替换 / 全文面板 ─────

  // 「插入当前文稿光标处」（AI 工作台 / 选区工具条 / 资料检索 都走这个事件）。
  // 双栏时按活动栏路由：仅 activePane 指向的实例执行插入
  useEffect(() => {
    const onInsert = (e: Event) => {
      if (useApp.getState().activePane !== pane) return;
      const text = (e as CustomEvent<{ text?: string }>).detail?.text;
      if (!text) return;
      const ta = wrapRef.current?.querySelector("textarea");
      if (!ta) return;
      setBody(insertAtCursor(ta as HTMLTextAreaElement, text));
    };
    window.addEventListener("mewbox:insert", onInsert);
    return () => window.removeEventListener("mewbox:insert", onInsert);
  }, [pane]);

  // 替换选区（SelectionToolbar 传入触发时的 range）
  const onReplaceRange = useCallback((start: number, end: number, text: string) => {
    const cur = latestBody.current;
    setBody(cur.slice(0, start) + text + cur.slice(end));
  }, []);

  // 全文润色/查错对象（post/material；版本不走这两个入口）
  const aiTarget: ContextEntry | null =
    view.kind === "post" && selected ? { kind: "post", id: selected.id } : view.kind === "material" ? { kind: "material", id: view.id } : null;

  // 打开全文面板前强制落盘（后端按文件读全文）——落的是本栏的盘
  const openProofread = async () => {
    await paneSlice(useApp.getState(), pane).flushFn?.();
    setErrorsOpen(false);
    setProofOpen(true);
  };
  const openCheckErrors = async () => {
    await paneSlice(useApp.getState(), pane).flushFn?.();
    setProofOpen(false);
    setErrorsOpen(true);
  };

  // 自定义预览：预处理 wiki 链接后走共享渲染管线（textarea 保持原文）
  const renderPreview = useCallback(
    (md: string) => (
      <div className="wmde-markdown wmde-markdown-color">
        <MarkdownPreview baseDir={previewBaseDir}>{isVersion ? md : withWikiLinks(md)}</MarkdownPreview>
      </div>
    ),
    [isVersion, previewBaseDir],
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
        <div className="flex items-center gap-2 border-b border-[var(--line)] bg-[var(--cat-bg)] px-5 py-2.5 text-[13px]" data-testid={tid("version-banner")}>
          <span className="font-semibold">📣 {view.target} 版</span>
          <span className="text-[var(--muted)]">属于《{baseTitle ?? view.baseId}》· 编辑不影响母版</span>
          {version?.publishedUrl && (
            <a href={version.publishedUrl} className="underline" target="_blank" rel="noreferrer">
              已发布 ↗
            </a>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button className={MBTN} onClick={() => setSyncOpen(true)} data-testid={tid("sync-btn")}>
              从文稿同步…
            </button>
            <button className={MBTN} onClick={() => setRecordOpen(true)} data-testid={tid("record-btn")}>
              发布记录…
            </button>
            <button className={MBTN_PRIMARY} onClick={() => void backToPost()} data-testid={tid("back-to-post")}>
              回到母版
            </button>
          </div>
        </div>
      )}

      {isMaterial && view.kind === "material" && (
        <div className="flex items-center gap-2 border-b border-[var(--line)] bg-[#eef3f7] px-5 py-2.5 text-[13px]" data-testid={tid("material-banner")}>
          <span className="font-semibold">📚 资料 · {material?.folder ?? "Inbox"}</span>
          <span className="text-[var(--muted)]">资料服务写作——升格后进入文稿区</span>
          <div className="ml-auto flex items-center gap-2">
            <button
              className={MBTN}
              onClick={() => void onConvertToPost()}
              data-testid={tid("convert-to-post")}
            >
              升格为文稿
            </button>
            <button
              className={MBTN}
              onClick={() => openAssocPicker("posts")}
              data-testid={tid("link-to-posts")}
            >
              关联到文稿…
            </button>
          </div>
        </div>
      )}

      {/* 顶部单层（视觉方案 §3.2）：标题 + 保存指示 + 状态胶囊 + 操作按钮 + 分段控制器。
          原独立模式切换横条已并入，中栏顶部少一层横条 */}
      <div className="flex items-center gap-2.5 border-b border-[var(--line)] bg-[var(--card)] px-5 py-2">
        {isVersion ? (
          <span
            className="min-w-0 flex-1 truncate text-[20px] font-bold tracking-tight"
            data-testid={tid("version-title")}
          >
            {version?.title || `${(view as { target: string }).target} 版`}
          </span>
        ) : (
          <input
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={() => void onTitleCommit()}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            className="min-w-0 flex-1 bg-transparent text-[20px] font-bold tracking-tight outline-none"
            data-testid={tid("editor-title")}
          />
        )}
        <span className="flex-none text-[12px] text-[var(--muted)]" data-testid={tid("save-indicator")}>
          {saveLabel}
        </span>
        {!isVersion && !isMaterial && (
          <select
            value={selected?.status ?? "draft"}
            onChange={(e) => void onStatusChange(e.target.value)}
            className={`flex-none cursor-pointer appearance-none rounded-full px-2.5 py-0.5 text-[11.5px] font-semibold outline-none ${
              STATUS_PILL[selected?.status ?? "draft"]
            }`}
            data-testid={tid("editor-status")}
          >
            {STATUS_OPTIONS.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        )}
        {view.kind === "post" && selectedId && (
          <button onClick={() => setPublishOpen(true)} className={MBTN} data-testid={tid("publish-entry")}>
            发布版本…
          </button>
        )}
        {isVersion && (
          <button onClick={() => setPublishOpen(true)} className={MBTN} data-testid={tid("open-publish-menu")}>
            发布版本…
          </button>
        )}
        {!isVersion && (
          <>
            <button onClick={() => void openProofread()} className={MBTN} data-testid={tid("btn-proofread")}>
              润色建议
            </button>
            <button onClick={() => void openCheckErrors()} className={MBTN} data-testid={tid("btn-check-errors")}>
              查错
            </button>
          </>
        )}
        <div className="ml-1 inline-flex flex-none rounded-lg border border-[var(--line)] bg-[var(--cream)] p-0.5">
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
              className={`rounded-md px-3 py-1 text-[12px] ${
                viewMode === mode
                  ? "bg-white font-semibold text-[var(--ink)] shadow-xs"
                  : "text-[var(--muted)] hover:text-[var(--ink)]"
              }`}
              data-testid={tid(`mode-${mode}`)}
            >
              {label}
            </button>
          ))}
        </div>
        {pane === "secondary" && (
          <>
            <button
              onClick={() => void swapPane2()}
              className={MBTN}
              title="与主栏交换（次栏篇转正，原主栏篇移到次栏）"
              data-testid="pane2-swap"
            >
              ⇄ 换到主栏
            </button>
            <button
              onClick={() => void closePane2()}
              className={MBTN}
              title="关闭次栏（Ctrl+\）"
              data-testid="pane2-close"
            >
              ×
            </button>
          </>
        )}
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
              "data-testid": tid("md-textarea"),
            } as unknown as NonNullable<
              Parameters<typeof MDEditor>[0]["textareaProps"]
            >
          }
          previewOptions={editorPreviewOptions}
          components={mdComponents}
        />
      </div>

      {/* 关联块（文稿/资料侧；版本无块）——随本栏目标 */}
      <AssocPanel pane={pane} />

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
            data-testid={tid("zoom-menu")}
          >
            <button
              className="flex w-full items-center justify-between px-3 py-1.5 text-left hover:bg-[var(--cream)]"
              onClick={() => {
                zoomEditor(0.1);
                setZoomMenu(null);
              }}
              data-testid={tid("zoom-in")}
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
              data-testid={tid("zoom-out")}
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
              data-testid={tid("zoom-reset")}
            >
              <span>重置字号（{Math.round(editorZoom * 100)}%）</span>
              <span className="text-[10px] text-[var(--muted)]">Ctrl+0</span>
            </button>
          </div>
        </>
      )}

      {/* 状态栏（视觉方案 §3.3：28px 高、浅米底，对齐原型 statusbar） */}
      <div
        className="flex h-[28px] flex-none items-center gap-2 border-t border-[var(--line)] bg-[#fbf8f1] px-4 text-[11.5px] text-[var(--muted)]"
        data-testid={tid("statusbar")}
      >
        <span>共 {body.replace(/\s/g, "").length} 字</span>
        <span className="opacity-50">·</span>
        <span>Markdown</span>
        <button
          className="ml-auto px-1 hover:text-[var(--ink)]"
          title="字号缩放（Ctrl+= 放大 / Ctrl+- 缩小 / Ctrl+0 重置）"
          onClick={resetEditorZoom}
          data-testid={tid("zoom-indicator")}
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
