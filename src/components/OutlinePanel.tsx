import { useMemo } from "react";
import { useApp } from "../stores/app";
import { useActiveValue } from "../stores/pane";
import { extractHeadings, Heading } from "../lib/outline";
import { scrollElementWithin, scrollOffsetWithin } from "../lib/editorScroll";

/** 右栏大纲：标题层级列表，点击跳转——跟随活动栏。
 *  源码：光标落到标题行并滚动；预览：滚到标题锚点；分栏（live）：两侧同步。
 *  滚动容器判定见 lib/editorScroll（源码/预览/分栏各不相同，不硬编码选择器）。 */
export function OutlinePanel() {
  const selected = useActiveValue("selected");
  const view = useActiveValue("view");
  const material = useActiveValue("material");
  const viewMode = useActiveValue("viewMode");
  const activePane = useApp((s) => s.activePane);
  const body = view.kind === "material" ? (material?.body ?? "") : (selected?.body ?? "");
  const headings = useMemo(() => extractHeadings(body), [body]);

  if (headings.length === 0) {
    return <div className="text-[12.5px] text-[var(--muted)]">暂无标题结构（用 # 开始一级标题）</div>;
  }

  /** 源码侧：围栏跳过 + 标题行匹配 → 光标定位 → 按镜像层该行的真实位置滚动。
   *  textarea 只是绝对定位的透明输入层（内容不溢出），滚动的是外层容器 */
  const jumpSourceSide = (root: Element | null, h: Heading) => {
    const scope: ParentNode = root ?? document;
    const ta = scope.querySelector("textarea") as HTMLTextAreaElement | null;
    if (!ta) return;
    const lines = ta.value.split("\n");
    let inFence = false;
    for (let i = 0; i < lines.length; i++) {
      const fence = lines[i].trimStart().match(/^(`{3,}|~{3,})/);
      if (fence) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      const m = lines[i].match(new RegExp(`^#{${h.level}}\\s+(.*)$`));
      if (m && m[1].trim() === h.text) {
        const offset = i > 0 ? lines.slice(0, i).join("\n").length + 1 : 0;
        ta.focus();
        ta.setSelectionRange(offset, offset + lines[i].length);
        const code = scope.querySelector(".w-md-editor-text-pre > code");
        if (code) scrollOffsetWithin(code, offset, root);
        return;
      }
    }
  };

  /** 预览侧：标题锚点（预览管线 rehypeHeadingIds 注入 id）→ 容器内滚动 */
  const jumpPreviewSide = (root: Element | null, h: Heading) => {
    const scope: ParentNode = root ?? document;
    const el =
      (scope.querySelector(`#${CSS.escape(h.slug)}`) as HTMLElement | null) ??
      document.getElementById(h.slug);
    if (!el) return;
    if (!scrollElementWithin(el, root)) el.scrollIntoView({ block: "start" });
  };

  const onJump = (h: Heading) => {
    const root = document.querySelector(`[data-pane="${activePane}"]`) as Element | null;
    const go = () => {
      if (viewMode !== "preview") jumpSourceSide(root, h);
      if (viewMode !== "edit") jumpPreviewSide(root, h);
    };
    go();
    // 聚焦/设选区会触发浏览器自带的 caret 滚动，下一帧按真实 rect 校正一次（幂等）
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(go);
  };

  return (
    <nav data-testid="outline-list">
      {headings.map((h) => (
        <button
          key={h.slug}
          onClick={() => onJump(h)}
          className="block w-full truncate rounded-lg py-1.5 pr-2 text-left text-[12.5px] hover:bg-[var(--cream)]"
          style={{ paddingLeft: 12 + (h.level - 1) * 12, fontWeight: h.level === 1 ? 600 : 400 }}
          title={h.text}
        >
          {h.text}
        </button>
      ))}
    </nav>
  );
}
