import { useMemo } from "react";
import { useApp } from "../stores/app";
import { extractHeadings } from "../lib/outline";

/** 右栏大纲：标题层级列表；点击跳转（预览模式按锚点滚动，源码模式提示切换） */
export function OutlinePanel() {
  const selected = useApp((s) => s.selected);
  const viewMode = useApp((s) => s.viewMode);
  const headings = useMemo(() => extractHeadings(selected?.body ?? ""), [selected?.body]);

  if (headings.length === 0) {
    return <div className="p-3 text-xs text-[var(--muted)]">暂无标题结构（用 # 开始一级标题）</div>;
  }

  const onJump = (slug: string) => {
    if (viewMode === "preview" || viewMode === "live") {
      const el = document.getElementById(`user-content-${slug}`) ?? document.getElementById(slug);
      el?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  return (
    <nav className="p-2" data-testid="outline-list">
      {headings.map((h) => (
        <button
          key={h.slug}
          onClick={() => onJump(h.slug)}
          className="block w-full truncate rounded-md px-2 py-1 text-left text-xs hover:bg-[var(--cream)]"
          style={{ paddingLeft: 8 + (h.level - 1) * 12, fontWeight: h.level === 1 ? 600 : 400 }}
          title={h.text}
        >
          {h.text}
        </button>
      ))}
    </nav>
  );
}
