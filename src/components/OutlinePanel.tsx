import { useMemo } from "react";
import { useApp } from "../stores/app";
import { extractHeadings } from "../lib/outline";

/** 右栏大纲：标题层级列表；点击跳转（预览模式按锚点滚动，源码模式提示切换） */
export function OutlinePanel() {
  const selected = useApp((s) => s.selected);
  const view = useApp((s) => s.view);
  const material = useApp((s) => s.material);
  const viewMode = useApp((s) => s.viewMode);
  const body = view.kind === "material" ? (material?.body ?? "") : (selected?.body ?? "");
  const headings = useMemo(() => extractHeadings(body), [body]);

  if (headings.length === 0) {
    return <div className="p-3 text-[13px] text-[var(--muted)]">暂无标题结构（用 # 开始一级标题）</div>;
  }

  const onJump = (slug: string) => {
    if (viewMode === "preview" || viewMode === "live") {
      const el = document.getElementById(`user-content-${slug}`) ?? document.getElementById(slug);
      el?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  return (
    <nav className="p-3" data-testid="outline-list">
      {headings.map((h) => (
        <button
          key={h.slug}
          onClick={() => onJump(h.slug)}
          className="block w-full truncate rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-[var(--cream)]"
          style={{ paddingLeft: 8 + (h.level - 1) * 12, fontWeight: h.level === 1 ? 600 : 400 }}
          title={h.text}
        >
          {h.text}
        </button>
      ))}
    </nav>
  );
}
