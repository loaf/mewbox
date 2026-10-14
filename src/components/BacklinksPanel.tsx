import { useCallback, useEffect, useState } from "react";
import { api, Backlink } from "../lib/api";
import { useApp } from "../stores/app";

const KIND_LABEL: Record<Backlink["kind"], string> = {
  wiki: "正文链接",
  assoc: "关联块",
};

/** 右栏「反链」：谁在引用我（正文 [[wiki]] 与尾部关联块两来源标注，§7.2） */
export function BacklinksPanel() {
  const view = useApp((s) => s.view);
  const selectedId = useApp((s) => s.selectedId);
  const posts = useApp((s) => s.posts);
  const materials = useApp((s) => s.materials);
  const select = useApp((s) => s.select);
  const selectMaterial = useApp((s) => s.selectMaterial);

  const currentId = view.kind === "material" ? view.id : view.kind === "post" ? selectedId : null;

  const [links, setLinks] = useState<Backlink[]>([]);

  const refresh = useCallback(async () => {
    if (!currentId) {
      setLinks([]);
      return;
    }
    setLinks(await api.backlinks(currentId).catch(() => []));
  }, [currentId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const jump = (fromId: string) => {
    if (posts.some((p) => p.id === fromId)) void select(fromId);
    else if (materials.some((m) => m.id === fromId)) void selectMaterial(fromId);
  };

  if (!currentId) {
    return (
      <div className="text-[12.5px] text-[var(--muted)]" data-testid="backlinks-empty">
        选中文稿或资料后，这里显示谁在引用它。
      </div>
    );
  }

  if (links.length === 0) {
    return (
      <div className="text-[12.5px] text-[var(--muted)]" data-testid="backlinks-empty">
        暂无反向链接——别人用 [[标题]] 或「关联」指向这里时会列出。
      </div>
    );
  }

  return (
    <div data-testid="backlinks-list">
      {links.map((b, i) => (
        <button
          key={`${b.fromId}-${b.kind}-${i}`}
          onClick={() => jump(b.fromId)}
          className="mb-1.5 block w-full rounded-lg border border-[var(--line)] bg-white px-3 py-2 text-left text-[12.5px] hover:bg-[var(--cream)]"
          data-testid="backlink-item"
        >
          <div className="flex items-center gap-2">
            <span className="truncate font-semibold">{b.fromTitle}</span>
            <span className="ml-auto rounded-full bg-[var(--cream)] px-2 py-px text-[10px] text-[var(--muted)]" data-testid="backlink-kind">
              来源：{KIND_LABEL[b.kind] ?? b.kind}
            </span>
          </div>
        </button>
      ))}
    </div>
  );
}
