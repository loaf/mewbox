import { useState } from "react";
import { api } from "../lib/api";
import { useApp } from "../stores/app";
import { MarkdownPreview, withWikiLinks, wikiTitleFromAnchor } from "../lib/markdown";

/** 分栏·参考栏（方案 B 第一步，只读）：渲染一篇文稿与主编辑器互相参照。
 *  wiki 链接点击在本栏内跳转（保持主栏不动）；Alt+无修饰。 */
export function RefPane() {
  const pane2 = useApp((s) => s.pane2);
  const editorZoom = useApp((s) => s.editorZoom);
  const closePane2 = useApp((s) => s.closePane2);
  const swapPane2 = useApp((s) => s.swapPane2);
  const openPane2 = useApp((s) => s.openPane2);
  const [note, setNote] = useState<string | null>(null);

  if (!pane2) return null;

  const baseDir = pane2.path ? pane2.path.split("/").slice(0, -1).join("/") : "posts";

  // wiki 链接点击：唯一命中文稿 → 本栏加载；重名/悬空/资料 → 顶部横幅提示
  const onPreviewClick = async (e: React.MouseEvent) => {
    const anchor = (e.target as HTMLElement).closest?.("a[data-wiki]");
    if (!anchor) return;
    e.preventDefault();
    const title = wikiTitleFromAnchor(anchor);
    if (!title) return;
    const r = await api.resolveWiki(title).catch(() => null);
    if (!r) return;
    if (r.matched?.kind === "post") {
      setNote(null);
      await openPane2(r.matched.id);
    } else if (r.matched) {
      setNote(`「${title}」是资料，参考栏只支持文稿`);
    } else if (r.candidates.length > 0) {
      setNote(`「${title}」有 ${r.candidates.length} 篇同名，请到主栏打开`);
    } else {
      setNote(`「${title}」还不存在（悬空链接）`);
    }
  };

  return (
    <div
      className="flex h-full min-w-0 flex-col bg-[var(--card)]"
      style={{ "--editor-zoom": editorZoom } as React.CSSProperties}
      data-testid="ref-pane"
    >
      <div className="flex flex-none items-center gap-2 border-b border-[var(--line)] px-4 py-2.5">
        <span className="min-w-0 flex-1 truncate text-[13px] font-bold">📄 {pane2.title}</span>
        <button
          onClick={() => void swapPane2()}
          className="flex-none px-1.5 py-1 text-[12px] text-[var(--muted)] hover:text-[var(--ink)]"
          title="与主栏交换（参考篇转正，原主栏篇移到参考栏）"
          data-testid="ref-swap"
        >
          ⇄ 换到主栏
        </button>
        <button
          onClick={closePane2}
          className="flex-none px-1.5 py-1 text-[13px] text-[var(--muted)] hover:text-[var(--ink)]"
          title="关闭参考栏（Ctrl+\）"
          data-testid="ref-close"
        >
          ×
        </button>
      </div>

      {note && (
        <div className="flex-none border-b border-[var(--line)] bg-[var(--cream)] px-4 py-1.5 text-[12px] text-[var(--muted)]" data-testid="ref-note">
          {note}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto px-6 py-5" onClick={(e) => void onPreviewClick(e)}>
        <div className="mx-auto max-w-[720px] wmde-markdown wmde-markdown-color" data-testid="ref-body">
          <MarkdownPreview baseDir={baseDir}>{withWikiLinks(pane2.body)}</MarkdownPreview>
        </div>
      </div>

      <div className="flex h-[36px] flex-none items-center gap-2 border-t border-[var(--line)] px-[18px] text-[12px] text-[var(--muted)]">
        <span>共 {pane2.body.replace(/\s/g, "").length} 字</span>
        <span className="opacity-50">·</span>
        <span>只读参考</span>
      </div>
    </div>
  );
}
