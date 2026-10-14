import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { api, SearchHit } from "../lib/api";
import { useApp } from "../stores/app";

/** 分组顺序：文稿 / 资料 / 发布版本（M5，DESIGN §9/§10 左栏入口） */
const GROUPS: ReadonlyArray<{ kind: string; label: string }> = [
  { kind: "post", label: "📄 文稿" },
  { kind: "material", label: "📚 资料" },
  { kind: "publish", label: "📣 发布版本" },
];

/** 发布版本命中行的路径形如 .versions/{base}/publish/{target}.md */
function parseVersionPath(path: string): { base: string; target: string } | null {
  const m = path.match(/^\.versions\/([^/]+)\/publish\/(.+)\.md$/);
  return m ? { base: m[1], target: m[2] } : null;
}

/** 命中词高亮：按查询词（空白切分）在文本中逐个匹配，命中片段包 <mark> */
function highlightNodes(text: string, tokens: string[], keyBase = ""): ReactNode[] {
  if (tokens.length === 0 || !text) return [text];
  const [head, ...rest] = tokens;
  const idx = text.toLowerCase().indexOf(head.toLowerCase());
  if (idx < 0) return highlightNodes(text, rest, keyBase);
  return [
    ...highlightNodes(text.slice(0, idx), rest, `${keyBase}a`),
    <mark key={`${keyBase}m`} className="rounded bg-[var(--cat-bg)] px-0.5 text-inherit">
      {text.slice(idx, idx + head.length)}
    </mark>,
    ...highlightNodes(text.slice(idx + head.length), rest, `${keyBase}b`),
  ];
}

/** 全局搜索覆盖层（Ctrl+Shift+F / 左栏入口）：输入 → 分组结果 → 点击跳转对应视图 */
export function GlobalSearch() {
  const open = useApp((s) => s.searchOpen);
  const setSearchOpen = useApp((s) => s.setSearchOpen);
  const select = useApp((s) => s.select);
  const selectMaterial = useApp((s) => s.selectMaterial);
  const selectVersion = useApp((s) => s.selectVersion);
  const openPane2 = useApp((s) => s.openPane2);

  const [query, setQuery] = useState("");
  const [includeVersions, setIncludeVersions] = useState(false);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Ctrl/Cmd+Shift+F 打开（全局热键，组件常驻）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setSearchOpen]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const run = async () => {
    const q = query.trim();
    if (!q || busy) return;
    setBusy(true);
    try {
      setHits(await api.searchAll(q, includeVersions));
    } catch (e) {
      console.error(e);
      setHits([]);
    } finally {
      setBusy(false);
    }
  };

  const jump = async (hit: SearchHit) => {
    setSearchOpen(false);
    if (hit.kind === "material") {
      await selectMaterial(hit.id);
    } else if (hit.kind === "publish") {
      const v = parseVersionPath(hit.path);
      if (v) await selectVersion(v.base, v.target);
    } else {
      await select(hit.id);
    }
  };

  const grouped = useMemo(
    () =>
      GROUPS.map((g) => ({
        ...g,
        items: (hits ?? []).filter((h) => (h.kind ?? "post") === g.kind),
      })),
    [hits],
  );

  if (!open) return null;
  const tokens = query.trim().split(/\s+/).filter(Boolean);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-24"
      onClick={() => setSearchOpen(false)}
      data-testid="global-search-overlay"
    >
      <div
        className="w-[560px] max-w-[90vw] rounded-2xl border border-[var(--line)] bg-[var(--card)] p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        data-testid="global-search"
      >
        <div className="mb-3 flex items-center gap-2">
          <input
            ref={inputRef}
            data-testid="global-search-input"
            value={query}
            placeholder="搜索文稿、资料…（Ctrl+Shift+F）"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void run();
              if (e.key === "Escape") setSearchOpen(false);
            }}
            className="flex-1 rounded-lg border border-[var(--line)] px-3 py-2 text-sm outline-none focus:border-[var(--cat)]"
          />
          <button
            onClick={() => void run()}
            className="rounded-lg bg-[var(--cat)] px-3 py-2 text-sm font-semibold text-white"
            data-testid="global-search-btn"
          >
            搜索
          </button>
        </div>
        <label className="mb-3 flex cursor-pointer items-center gap-2 text-xs text-[var(--muted)]">
          <input
            type="checkbox"
            data-testid="global-search-versions"
            checked={includeVersions}
            onChange={(e) => setIncludeVersions(e.target.checked)}
          />
          包含发布版本
        </label>

        <div className="max-h-[50vh] overflow-auto" data-testid="global-search-results">
          {busy && <p className="py-4 text-center text-xs text-[var(--muted)]">搜索中…</p>}
          {!busy && hits !== null && hits.length === 0 && (
            <p className="py-4 text-center text-xs text-[var(--muted)]" data-testid="global-search-empty">
              没有匹配的内容
            </p>
          )}
          {grouped.map(
            (g) =>
              g.items.length > 0 && (
                <section key={g.kind} className="mb-3" data-testid={`global-search-group-${g.kind}`}>
                  <h4 className="mb-1 text-[13px] font-bold tracking-wide text-[var(--muted)]">
                    {g.label}（{g.items.length}）
                  </h4>
                  {g.items.map((h) => (
                    <div
                      key={`${h.kind}-${h.id}`}
                      data-testid={`global-search-hit-${h.id}`}
                      onClick={() => void jump(h)}
                      className="flex w-full cursor-pointer items-center rounded-lg px-2 py-1.5 text-left hover:bg-[var(--cream)]"
                    >
                      <span className="min-w-0 flex-1 truncate text-sm">{highlightNodes(h.title, tokens)}</span>
                      <span className="ml-2 flex-none text-xs text-[var(--muted)]">{h.path}</span>
                      {(h.kind ?? "post") === "post" && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setSearchOpen(false);
                            void openPane2(h.id);
                          }}
                          className="ml-2 flex-none rounded px-1.5 py-0.5 text-[11px] text-[var(--muted)] hover:bg-white hover:text-[var(--ink)]"
                          title="在参考栏打开（分栏互参）"
                          data-testid={`global-search-pane2-${h.id}`}
                        >
                          ⫲ 分栏
                        </button>
                      )}
                    </div>
                  ))}
                </section>
              ),
          )}
        </div>
      </div>
    </div>
  );
}
