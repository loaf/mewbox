import { useEffect, useMemo, useRef, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { api } from "../lib/api";
import { useApp } from "../stores/app";
import { PostTree } from "./PostTree";
import { NewPostDialog } from "./NewPostDialog";
import { EditorPane } from "./EditorPane";
import { OutlinePanel } from "./OutlinePanel";
import { HistoryPanel } from "./HistoryPanel";
import { BacklinksPanel } from "./BacklinksPanel";
import { TrashPanel } from "./TrashPanel";
import { KbTree } from "./KbTree";
import { HealthPanel } from "./HealthPanel";
import { MaterialSearchPanel } from "./MaterialSearchPanel";
import { AIWorkbench } from "./AIWorkbench";
import { SettingsPanel } from "./SettingsPanel";
import { GlobalSearch } from "./GlobalSearch";

/** Markdown 目录导出（M5，DESIGN §12）：posts 平铺 / kb 树，frontmatter 透传、附件随行。
 *  视觉方案 §3.1：两项收进底部工具坞「📤 导出」的上拉菜单，不再常驻导航 */
function ExportMenu() {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const run = async (scope: "posts" | "kb") => {
    const dir = await openFileDialog({
      directory: true,
      title: scope === "posts" ? "选择文稿导出目录" : "选择知识库导出目录",
    });
    if (typeof dir !== "string" || !dir) return;
    try {
      const r = await api.exportMd(scope, dir);
      setNote(`已导出 ${r.files} 个文件、${r.assets} 个附件`);
    } catch (err) {
      setNote(`导出失败：${err}`);
    }
  };

  return (
    <div className="relative flex items-center">
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div
            className="absolute bottom-full left-0 z-40 mb-1.5 w-[200px] rounded-lg border border-[var(--line)] bg-white py-1 shadow-lg"
            data-testid="export-menu"
          >
            <button
              onClick={() => void run("posts")}
              className="block w-full px-3 py-1.5 text-left text-[12px] text-[var(--ink)] hover:bg-[var(--cream)]"
              data-testid="export-posts"
            >
              📤 导出文稿 Markdown…
            </button>
            <button
              onClick={() => void run("kb")}
              className="block w-full px-3 py-1.5 text-left text-[12px] text-[var(--ink)] hover:bg-[var(--cream)]"
              data-testid="export-kb"
            >
              📤 导出知识库 Markdown…
            </button>
            {note && (
              <p className="px-3 pb-1 pt-1 text-[10.5px] text-[var(--green)]" data-testid="export-note">
                {note}
              </p>
            )}
          </div>
        </>
      )}
      <button
        onClick={() => setOpen((v) => !v)}
        className="whitespace-nowrap rounded-md px-2 py-1 text-[12px] text-[var(--muted)] hover:bg-[var(--cream)] hover:text-[var(--ink)]"
        title="导出文稿 / 知识库 Markdown"
        data-testid="export-entry"
      >
        📤 导出
      </button>
    </div>
  );
}

/** 左栏：文稿区 / 知识库区（M3）/ 底部搜索触发条 + 单行工具坞（视觉方案 §3.1） */
function LeftColumn({ onCreate }: { onCreate: () => void }) {
  const posts = useApp((s) => s.posts);
  const setTrashOpen = useApp((s) => s.setTrashOpen);
  const setSettingsOpen = useApp((s) => s.setSettingsOpen);
  const setSearchOpen = useApp((s) => s.setSearchOpen);
  const toggleLeft = useApp((s) => s.toggleLeft);
  const trashCount = useApp((s) => s.trash.length);
  const [healthOpen, setHealthOpen] = useState(false);

  const dockBtn =
    "whitespace-nowrap rounded-md px-2 py-1 text-[12px] text-[var(--muted)] hover:bg-[var(--cream)] hover:text-[var(--ink)]";

  return (
    <aside className="flex w-[240px] flex-none flex-col overflow-hidden border-r border-[var(--line)] bg-[var(--card)]">
      <div className="flex items-center justify-between px-3.5 pb-2 pt-3.5">
        <span className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--cat)] px-3 py-1.5 text-[13px] font-bold text-white">
          🐾 喵盒
        </span>
        <button
          onClick={toggleLeft}
          className="flex h-7 w-7 items-center justify-center rounded text-[13px] text-[var(--muted)] hover:bg-[var(--cream)] hover:text-[var(--ink)]"
          title="隐藏左栏（Ctrl+B）"
          data-testid="collapse-left"
        >
          «
        </button>
      </div>

      {/* 树区独占滚动：底部入口收拢后，目录树拿到全部剩余高度 */}
      <div className="min-h-0 flex-1 overflow-auto">
        <PostTree onNewPost={onCreate} />
        <KbTree />
      </div>

      <section aria-label="全局搜索">
        <button
          onClick={() => setSearchOpen(true)}
          className="mx-3 mb-2 mt-2 flex w-[calc(100%-1.5rem)] items-center justify-between rounded-lg bg-[var(--cream)] px-3 py-1.5 text-[12px] text-[var(--muted)] hover:text-[var(--ink)]"
          data-testid="search-entry"
        >
          <span>🔍 全局搜索</span>
          <span className="rounded border border-[var(--line)] bg-white px-1.5 py-px font-mono text-[10px] leading-[1.4]">
            Ctrl+Shift+F
          </span>
        </button>
      </section>

      {/* 低频入口工具坞：单行四项，为目录树腾出 150px+ 高度 */}
      <div className="flex h-[38px] flex-none items-center justify-between border-t border-[var(--line)] px-3">
        <button onClick={() => setSettingsOpen(true)} className={dockBtn} data-testid="settings-entry">
          ⚙ 设置
        </button>
        <button onClick={() => setHealthOpen(true)} className={dockBtn} data-testid="health-entry">
          🩺 体检
        </button>
        <ExportMenu />
        <button onClick={() => setTrashOpen(true)} className={dockBtn} data-testid="trash-entry">
          🗑 回收站{trashCount > 0 ? ` (${trashCount})` : ""}
        </button>
      </div>
      <div className="hidden">{posts.length}</div>

      <HealthPanel open={healthOpen} onClose={() => setHealthOpen(false)} />
    </aside>
  );
}

/** 侧栏收起后的窄条（点击恢复） */
function SideRail({ side, onExpand }: { side: "left" | "right"; onExpand: () => void }) {
  return (
    <button
      onClick={onExpand}
      className={`flex w-7 flex-none flex-col items-center border-[var(--line)] bg-[var(--card)] pt-3 text-[13px] text-[var(--muted)] hover:text-[var(--ink)] ${
        side === "left" ? "border-r" : "border-l"
      }`}
      title={side === "left" ? "展开左栏（Ctrl+B）" : "展开右栏（Ctrl+Shift+B）"}
      data-testid={`expand-${side}`}
    >
      {side === "left" ? "»" : "«"}
    </button>
  );
}

/** 主区空状态（prototype/09-empty 基调） */
function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-1 items-center justify-center" data-testid="empty-state">
      <div className="max-w-md text-center">
        <div className="mb-4 text-6xl">🐱📦</div>
        <h2 className="mb-2 text-2xl font-bold">喵盒等你落笔</h2>
        <p className="mb-6 text-sm text-[var(--muted)]">
          本地优先的写作工作台——文稿是裸 Markdown，拷走目录即迁移。
        </p>
        <button
          onClick={onCreate}
          className="rounded-lg bg-[var(--cat)] px-6 py-2.5 text-sm font-semibold text-white"
        >
          新建文稿
        </button>
      </div>
    </div>
  );
}

const RIGHT_TABS = [
  ["outline", "大纲"],
  ["backlinks", "反链"],
  ["history", "历史"],
  ["material-search", "资料"],
  ["ai", "AI"],
] as const;

export function AppShell() {
  const loading = useApp((s) => s.loading);
  const load = useApp((s) => s.load);
  const create = useApp((s) => s.create);
  const selected = useApp((s) => s.selected);
  const view = useApp((s) => s.view);
  const version = useApp((s) => s.version);
  const material = useApp((s) => s.material);
  const rightTab = useApp((s) => s.rightTab);
  const setRightTab = useApp((s) => s.setRightTab);
  const settingsOpen = useApp((s) => s.settingsOpen);
  const setSettingsOpen = useApp((s) => s.setSettingsOpen);
  const leftOpen = useApp((s) => s.leftOpen);
  const rightOpen = useApp((s) => s.rightOpen);
  const toggleLeft = useApp((s) => s.toggleLeft);
  const toggleRight = useApp((s) => s.toggleRight);
  const setRightOpen = useApp((s) => s.setRightOpen);
  const pane2 = useApp((s) => s.pane2Open);
  const togglePane2 = useApp((s) => s.togglePane2);
  const activePane = useApp((s) => s.activePane);
  const setActivePane = useApp((s) => s.setActivePane);

  const [creating, setCreating] = useState(false);
  const posts = useApp((s) => s.posts);
  const folders = useMemo(
    () => [...new Set(posts.map((p) => p.folder).filter(Boolean) as string[])],
    [posts],
  );

  useEffect(() => {
    load().catch(console.error);
  }, [load]);

  // Ctrl/Cmd+K → 资料检索页签并聚焦输入框（T13）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setRightOpen(true);
        setRightTab("material-search");
        window.dispatchEvent(new Event("mewbox:focus-material-search"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setRightTab, setRightOpen]);

  // Ctrl/Cmd+B → 左栏显隐；Ctrl/Cmd+Shift+B → 右栏显隐
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "b") return;
      e.preventDefault();
      if (e.shiftKey) toggleRight();
      else toggleLeft();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleLeft, toggleRight]);

  // Ctrl/Cmd+\ → 开关参考栏（重开最近一篇，无历史目标时取主栏当前文稿）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "\\") {
        e.preventDefault();
        void togglePane2();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePane2]);

  // 分栏：主区容器与参考栏宽度（百分比，可拖拽）
  const mainRef = useRef<HTMLElement>(null);
  const [pane2Pct, setPane2Pct] = useState(42);
  const startPaneDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const el = mainRef.current;
    if (!el) return;
    const move = (ev: MouseEvent) => {
      const r = el.getBoundingClientRect();
      const pct = ((r.right - ev.clientX) / r.width) * 100;
      setPane2Pct(Math.min(70, Math.max(22, pct)));
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const onCreate = () => setCreating(true);
  const onCreateConfirm = async (title: string, folder?: string) => {
    setCreating(false);
    await create(title, folder);
  };

  if (loading) {
    return <div className="flex h-full items-center justify-center text-sm text-[var(--muted)]">正在打开工作区…</div>;
  }

  const hasEditorTarget =
    selected !== null ||
    (view.kind === "version" && version !== null) ||
    (view.kind === "material" && material !== null);

  return (
    <div className="flex h-full">
      {leftOpen ? (
        <LeftColumn onCreate={onCreate} />
      ) : (
        <SideRail side="left" onExpand={toggleLeft} />
      )}
      <main ref={mainRef} className="flex min-w-0 flex-1 flex-col bg-[var(--bg)]">
        {/* 版本/资料模式下 selected 为空，但编辑器照常渲染（横幅标识归属）。
            分栏（第二步）：主/次两个完整编辑器，中间可拖拽分隔条；
            点击/聚焦切换活动栏（右栏面板与 AI 插入跟随），data-pane 供 DOM 定位 */}
        {hasEditorTarget || pane2 ? (
          <div className="flex min-h-0 min-w-0 flex-1">
            <div
              data-pane="primary"
              onMouseDownCapture={() => setActivePane("primary")}
              onFocusCapture={() => setActivePane("primary")}
              className={`flex min-w-0 flex-1 flex-col ${pane2 ? "split-measure" : ""} ${
                pane2 && activePane === "primary" ? "pane-active" : ""
              }`}
            >
              {hasEditorTarget ? <EditorPane /> : <EmptyState onCreate={onCreate} />}
            </div>
            {pane2 && (
              <>
                <div
                  className="w-1.5 flex-none cursor-col-resize bg-[var(--line)] transition-colors hover:bg-[var(--cat-lt)]"
                  onMouseDown={startPaneDrag}
                  onDoubleClick={() => setPane2Pct(42)}
                  title="拖动调整分栏宽度，双击复位"
                  data-testid="pane-divider"
                />
                <div
                  data-pane="secondary"
                  onMouseDownCapture={() => setActivePane("secondary")}
                  onFocusCapture={() => setActivePane("secondary")}
                  className={`min-w-0 flex-none border-l border-[var(--line)] ${activePane === "secondary" ? "pane-active" : ""}`}
                  style={{ width: `${pane2Pct}%` }}
                >
                  <EditorPane pane="secondary" />
                </div>
              </>
            )}
          </div>
        ) : (
          <EmptyState onCreate={onCreate} />
        )}
      </main>
      {rightOpen ? (
        <aside className="flex w-[312px] flex-none flex-col border-l border-[var(--line)] bg-[var(--card)]">
          {/* 视觉方案 §3.4：单行紧凑页签（不换行），312px 内排下 5 页签 + 折叠按钮 */}
          <div className="flex flex-nowrap items-center gap-1 border-b border-[var(--line)] bg-[#fbf8f1] px-2.5 py-2">
            {RIGHT_TABS.map(([tab, label]) => (
              <button
                key={tab}
                onClick={() => setRightTab(tab)}
                className={`whitespace-nowrap rounded-md px-2.5 py-1 text-[12px] ${
                  rightTab === tab
                    ? "bg-[var(--cat)] font-semibold text-white"
                    : "text-[var(--muted)] hover:bg-[var(--cream)] hover:text-[var(--ink)]"
                }`}
                data-testid={`tab-${tab}`}
              >
                {label}
              </button>
            ))}
            <button
              onClick={toggleRight}
              className="ml-auto px-1.5 py-1 text-[13px] text-[var(--muted)] hover:text-[var(--ink)]"
              title="隐藏右栏（Ctrl+Shift+B）"
              data-testid="collapse-right"
            >
              »
            </button>
          </div>
          <div className="flex min-h-0 flex-1 flex-col p-3.5" data-testid={`panel-${rightTab}`}>
            {rightTab === "outline" ? (
              <OutlinePanel />
            ) : rightTab === "backlinks" ? (
              <BacklinksPanel />
            ) : rightTab === "history" ? (
              <HistoryPanel />
            ) : rightTab === "material-search" ? (
              <MaterialSearchPanel />
            ) : (
              <AIWorkbench />
            )}
          </div>
        </aside>
      ) : (
        <SideRail side="right" onExpand={toggleRight} />
      )}

      <TrashPanel />

      <GlobalSearch />

      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      <NewPostDialog
        open={creating}
        folders={folders}
        onCancel={() => setCreating(false)}
        onCreate={onCreateConfirm}
      />
    </div>
  );
}
