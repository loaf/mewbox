import { create } from "zustand";
import { api, PostContent, PostSummary, TreeNode, TrashItem, VersionContent } from "../lib/api";
import { assetContext } from "../lib/markdown";

export type ViewMode = "edit" | "live" | "preview";
export type RightTab = "outline" | "history";
export type SaveState = "saved" | "saving" | "dirty";
/** 编辑目标：文稿 或 发布版本（版本不进侧栏，由入口切换；DESIGN §5.2） */
export type EditorView = { kind: "post" } | { kind: "version"; baseId: string; target: string };

interface AppStore {
  loading: boolean;
  tree: TreeNode[];
  posts: PostSummary[];
  trash: TrashItem[];
  view: EditorView;
  selectedId: string | null;
  selected: PostContent | null;
  version: VersionContent | null;
  /** 各文稿的发布版本数（侧栏 📣 徽标） */
  versionCounts: Record<string, number>;
  saveState: SaveState;
  savedAt: string | null;
  viewMode: ViewMode;
  rightTab: RightTab;
  trashOpen: boolean;
  /** EditorPane 注册的强制保存钩子（切换文稿前调用，防止丢字） */
  flushFn: (() => Promise<void>) | null;

  load(): Promise<void>;
  select(id: string | null): Promise<void>;
  selectVersion(baseId: string, target: string): Promise<void>;
  backToPost(): Promise<void>;
  reloadVersion(): Promise<void>;
  create(title: string, folder?: string): Promise<void>;
  registerFlush(fn: (() => Promise<void>) | null): void;
  setDirty(): void;
  setSaving(): void;
  setSaved(updatedAt: string): void;
  setViewMode(mode: ViewMode): void;
  setRightTab(tab: RightTab): void;
  setTrashOpen(open: boolean): void;
  reloadPost(): Promise<void>;
}

export const useApp = create<AppStore>((set, get) => ({
  loading: true,
  tree: [],
  posts: [],
  trash: [],
  view: { kind: "post" },
  selectedId: null,
  selected: null,
  version: null,
  versionCounts: {},
  saveState: "saved",
  savedAt: null,
  viewMode: "edit",
  rightTab: "outline",
  trashOpen: false,
  flushFn: null,

  load: async () => {
    const payload = await api.listPosts();
    const trash = await api.listTrash();
    const versions = await api.listAllVersions().catch(() => []);
    const versionCounts: Record<string, number> = {};
    for (const v of versions) versionCounts[v.base] = (versionCounts[v.base] ?? 0) + 1;
    // 工作区根（贴图等相对资源 → asset 协议 URL 的解析基准）只取一次
    if (!assetContext.root) {
      assetContext.root = await api.workspaceRoot().catch(() => "");
    }
    set({ tree: payload.tree, posts: payload.posts, trash, versionCounts, loading: false });
  },

  select: async (id) => {
    const { flushFn, selectedId, view } = get();
    if (id === selectedId && view.kind === "post") return;
    if (flushFn) await flushFn(); // 切换前强制落盘
    if (id === null) {
      set({ view: { kind: "post" }, selectedId: null, selected: null, version: null, saveState: "saved" });
      return;
    }
    const selected = await api.readPost(id);
    set({ view: { kind: "post" }, selectedId: id, selected, version: null, saveState: "saved", savedAt: null });
  },

  selectVersion: async (baseId, target) => {
    const { flushFn } = get();
    if (flushFn) await flushFn();
    const version = await api.readPublishVersion(baseId, target);
    set({
      view: { kind: "version", baseId, target },
      selectedId: null,
      selected: null,
      version,
      saveState: "saved",
      savedAt: null,
    });
  },

  backToPost: async () => {
    const { view } = get();
    if (view.kind !== "version") return;
    const baseId = view.baseId;
    await get().select(baseId);
  },

  reloadVersion: async () => {
    const { view } = get();
    if (view.kind !== "version") return;
    const version = await api.readPublishVersion(view.baseId, view.target);
    set({ version });
  },

  create: async (title, folder) => {
    const p = await api.createPost(title, folder);
    await get().load();
    await get().select(p.id);
  },

  registerFlush: (fn) => set({ flushFn: fn }),

  setDirty: () => set({ saveState: "dirty" }),
  setSaving: () => set({ saveState: "saving" }),
  setSaved: (updatedAt) => set({ saveState: "saved", savedAt: updatedAt }),

  setViewMode: (viewMode) => set({ viewMode }),
  setRightTab: (rightTab) => set({ rightTab }),
  setTrashOpen: (trashOpen) => set({ trashOpen }),

  reloadPost: async () => {
    const id = get().selectedId;
    if (!id) return;
    const selected = await api.readPost(id);
    set({ selected });
  },
}));
