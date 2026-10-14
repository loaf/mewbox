import { useEffect, useRef, useState } from "react";
import { api, type SearchHit } from "../lib/api";
import { useApp } from "../stores/app";

const btn = "rounded-md border border-[var(--line)] bg-white px-2.5 py-1 text-[12px] hover:border-[var(--cat)]";

/**
 * 资料检索（T13，DESIGN §9 复用 FTS）：默认仅知识库资料；
 * Ctrl+K（AppShell 全局监听）切到本页签并聚焦输入框。
 */
export function MaterialSearchPanel() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const view = useApp((s) => s.view);
  const selectedId = useApp((s) => s.selectedId);
  const reloadPost = useApp((s) => s.reloadPost);
  const reloadMaterial = useApp((s) => s.reloadMaterial);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Ctrl+K → 聚焦（AppShell 已先把页签切到「资料检索」）
  useEffect(() => {
    const focus = () => inputRef.current?.focus();
    window.addEventListener("mewbox:focus-material-search", focus);
    return () => window.removeEventListener("mewbox:focus-material-search", focus);
  }, []);

  const doSearch = async () => {
    if (!q.trim()) {
      setHits(null);
      return;
    }
    setHits(await api.aiSearchMaterials(q).catch(() => []));
    setNote(null);
  };

  /** 插入 [[标题]] 到当前文稿光标处（EditorPane 监听 mewbox:insert） */
  const insertLink = (hit: SearchHit) => {
    window.dispatchEvent(new CustomEvent("mewbox:insert", { detail: { text: `[[${hit.title}]]` } }));
    setNote(`已插入 [[${hit.title}]]`);
  };

  /** 添加为关联（update_assoc 双写），随后刷新当前对象内容 */
  const addAssoc = async (hit: SearchHit) => {
    const currentId = view.kind === "post" ? selectedId : view.kind === "material" ? view.id : null;
    if (!currentId) {
      setNote("先打开一篇文稿或资料，再添加关联");
      return;
    }
    await api.updateAssoc(currentId, hit.id, true);
    if (view.kind === "post") await reloadPost();
    else await reloadMaterial();
    setNote(`已关联《${hit.title}》`);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col text-xs" data-testid="material-search">
      <div className="flex gap-1">
        <input
          ref={inputRef}
          className="min-w-0 flex-1 rounded-md border border-[var(--line)] bg-white px-3 py-1.5 text-[12px] outline-none focus:border-[var(--cat)]"
          placeholder="搜索知识库资料…（Ctrl+K）"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void doSearch()}
          data-testid="material-search-input"
        />
        <button className={btn} onClick={() => void doSearch()} data-testid="material-search-btn">搜索</button>
      </div>
      <div className="mt-1 text-[11px] text-[var(--muted)]">仅搜索知识库资料（kb/）</div>
      {note && <div className="mt-1 text-[11px] text-[var(--muted)]" data-testid="material-search-note">{note}</div>}
      <div className="mt-2 min-h-0 flex-1 overflow-auto" data-testid="material-search-results">
        {hits === null && <div className="text-[var(--muted)]">输入关键词回车检索。</div>}
        {hits !== null && hits.length === 0 && <div className="text-[var(--muted)]">没有匹配的资料。</div>}
        {hits?.map((h) => (
          <div key={h.id} className="mb-1 rounded-lg border border-[var(--line)] bg-white p-2" data-testid="material-search-hit">
            <div className="font-semibold">{h.title}</div>
            <div className="truncate text-[11px] text-[var(--muted)]">{h.path}</div>
            <div className="mt-1 flex gap-1">
              <button className={btn} onClick={() => insertLink(h)} data-testid={`hit-insert-${h.id}`}>插入链接</button>
              <button className={btn} onClick={() => void addAssoc(h)} data-testid={`hit-assoc-${h.id}`}>添加为关联</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
