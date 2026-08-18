import { create } from "zustand";
import { api, PostContent, PostSummary, TreeNode, TrashItem } from "../lib/api";

export type ViewMode = "edit" | "live" | "preview";
export type RightTab = "outline" | "history";
export type SaveState = "saved" | "saving" | "dirty";

interface AppStore {
  loading: boolean;
  tree: TreeNode[];
  posts: PostSummary[];
  trash: TrashItem[];
  selectedId: string | null;
  selected: PostContent | null;
  saveState: SaveState;
  savedAt: string | null;
  viewMode: ViewMode;
  rightTab: RightTab;
  trashOpen: boolean;
  /** EditorPane 注册的强制保存钩子（切换文稿前调用，防止丢字） */
  flushFn: (() => Promise<void>) | null;

  load(): Promise<void>;
  select(id: string | null): Promise<void>;
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
  selectedId: null,
  selected: null,
  saveState: "saved",
  savedAt: null,
  viewMode: "edit",
  rightTab: "outline",
  trashOpen: false,
  flushFn: null,

  load: async () => {
    const payload = await api.listPosts();
    const trash = await api.listTrash();
    set({ tree: payload.tree, posts: payload.posts, trash, loading: false });
  },

  select: async (id) => {
    const { flushFn, selectedId } = get();
    if (id === selectedId) return;
    if (flushFn) await flushFn(); // 切换前强制落盘
    if (id === null) {
      set({ selectedId: null, selected: null, saveState: "saved" });
      return;
    }
    const selected = await api.readPost(id);
    set({ selectedId: id, selected, saveState: "saved", savedAt: null });
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
