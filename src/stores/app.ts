import { create } from "zustand";
import {
  api,
  MaterialContent,
  MaterialSummary,
  PostContent,
  PostSummary,
  TreeNode,
  TrashItem,
  VersionContent,
} from "../lib/api";
import { assetContext } from "../lib/markdown";

export type ViewMode = "edit" | "live" | "preview";
export type RightTab = "outline" | "backlinks" | "history";
export type SaveState = "saved" | "saving" | "dirty";
/** 编辑目标：文稿 / 发布版本 / 资料（M3；版本不进侧栏，由入口切换，DESIGN §5.2/§6） */
export type EditorView =
  | { kind: "post" }
  | { kind: "version"; baseId: string; target: string }
  | { kind: "material"; id: string };

/** AssocPanel 的多选关联器打开状态（编辑器横幅与关联面板共用） */
export type AssocPickerKind = "posts" | "materials";

interface AppStore {
  loading: boolean;
  tree: TreeNode[];
  posts: PostSummary[];
  trash: TrashItem[];
  view: EditorView;
  selectedId: string | null;
  selected: PostContent | null;
  version: VersionContent | null;
  /** M3：资料库 */
  materials: MaterialSummary[];
  materialTrash: TrashItem[];
  material: MaterialContent | null;
  /** 各文稿的发布版本数（侧栏 📣 徽标） */
  versionCounts: Record<string, number>;
  saveState: SaveState;
  savedAt: string | null;
  viewMode: ViewMode;
  rightTab: RightTab;
  trashOpen: boolean;
  /** M3：关联多选器（posts/materials） */
  assocPicker: { kind: AssocPickerKind } | null;
  /** EditorPane 注册的强制保存钩子（切换文稿前调用，防止丢字） */
  flushFn: (() => Promise<void>) | null;

  load(): Promise<void>;
  select(id: string | null): Promise<void>;
  selectVersion(baseId: string, target: string): Promise<void>;
  selectMaterial(id: string | null): Promise<void>;
  backToPost(): Promise<void>;
  reloadVersion(): Promise<void>;
  reloadMaterial(): Promise<void>;
  create(title: string, folder?: string): Promise<void>;
  createMaterial(title: string, dir?: string): Promise<void>;
  registerFlush(fn: (() => Promise<void>) | null): void;
  setDirty(): void;
  setSaving(): void;
  setSaved(updatedAt: string): void;
  setViewMode(mode: ViewMode): void;
  setRightTab(tab: RightTab): void;
  setTrashOpen(open: boolean): void;
  openAssocPicker(kind: AssocPickerKind): void;
  closeAssocPicker(): void;
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
  materials: [],
  materialTrash: [],
  material: null,
  versionCounts: {},
  saveState: "saved",
  savedAt: null,
  viewMode: "edit",
  rightTab: "outline",
  trashOpen: false,
  assocPicker: null,
  flushFn: null,

  load: async () => {
    const payload = await api.listPosts();
    const trash = await api.listTrash();
    const materialTrash = await api.listMaterialTrash().catch(() => []);
    const materials = await api.listMaterials().catch(() => []);
    const versions = await api.listAllVersions().catch(() => []);
    const versionCounts: Record<string, number> = {};
    for (const v of versions) versionCounts[v.base] = (versionCounts[v.base] ?? 0) + 1;
    // 工作区根（贴图等相对资源 → asset 协议 URL 的解析基准）只取一次
    if (!assetContext.root) {
      assetContext.root = await api.workspaceRoot().catch(() => "");
    }
    set({ tree: payload.tree, posts: payload.posts, trash, materialTrash, materials, versionCounts, loading: false });
  },

  select: async (id) => {
    const { flushFn, selectedId, view } = get();
    if (id === selectedId && view.kind === "post") return;
    if (flushFn) await flushFn(); // 切换前强制落盘
    if (id === null) {
      set({ view: { kind: "post" }, selectedId: null, selected: null, version: null, material: null, saveState: "saved" });
      return;
    }
    const selected = await api.readPost(id);
    set({ view: { kind: "post" }, selectedId: id, selected, version: null, material: null, saveState: "saved", savedAt: null });
  },

  selectVersion: async (baseId, target) => {
    const { flushFn } = get();
    if (flushFn) await flushFn();
    const version = await api.readPublishVersion(baseId, target);
    set({
      view: { kind: "version", baseId, target },
      selectedId: null,
      selected: null,
      material: null,
      version,
      saveState: "saved",
      savedAt: null,
    });
  },

  selectMaterial: async (id) => {
    const { flushFn, view } = get();
    if (id === null) {
      if (flushFn) await flushFn();
      set({ view: { kind: "post" }, selectedId: null, selected: null, material: null, saveState: "saved" });
      return;
    }
    if (view.kind === "material" && id === view.id) return;
    if (flushFn) await flushFn();
    const material = await api.readMaterial(id);
    set({
      view: { kind: "material", id },
      selectedId: null,
      selected: null,
      version: null,
      material,
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

  reloadMaterial: async () => {
    const { view } = get();
    if (view.kind !== "material") return;
    const material = await api.readMaterial(view.id);
    set({ material });
  },

  create: async (title, folder) => {
    const p = await api.createPost(title, folder);
    await get().load();
    await get().select(p.id);
  },

  createMaterial: async (title, dir) => {
    const m = await api.createMaterial(title, dir ?? "");
    await get().load();
    await get().selectMaterial(m.id);
  },

  registerFlush: (fn) => set({ flushFn: fn }),

  setDirty: () => set({ saveState: "dirty" }),
  setSaving: () => set({ saveState: "saving" }),
  setSaved: (updatedAt) => set({ saveState: "saved", savedAt: updatedAt }),

  setViewMode: (viewMode) => set({ viewMode }),
  setRightTab: (rightTab) => set({ rightTab }),
  setTrashOpen: (trashOpen) => set({ trashOpen }),
  openAssocPicker: (kind) => set({ assocPicker: { kind } }),
  closeAssocPicker: () => set({ assocPicker: null }),

  reloadPost: async () => {
    const id = get().selectedId;
    if (!id) return;
    const selected = await api.readPost(id);
    set({ selected });
  },
}));
