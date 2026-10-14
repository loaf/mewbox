import { create } from "zustand";
import {
  api,
  ContextEntry,
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
export type RightTab = "outline" | "backlinks" | "history" | "material-search" | "ai";
export type SaveState = "saved" | "saving" | "dirty";
/** 编辑目标：文稿 / 发布版本 / 资料（M3；版本不进侧栏，由入口切换，DESIGN §5.2/§6） */
export type EditorView =
  | { kind: "post" }
  | { kind: "version"; baseId: string; target: string }
  | { kind: "material"; id: string };

/** AssocPanel 的多选关联器打开状态（编辑器横幅与关联面板共用） */
export type AssocPickerKind = "posts" | "materials";

/** 分栏：主栏 / 次栏（次栏为完整编辑器，与主栏字段一一对应、后缀 2） */
export type PaneId = "primary" | "secondary";

/** 单栏编辑状态字段的形状（主栏裸名，次栏 `${字段}2`）——stores/pane.ts 的映射基准 */
export type PaneFields = {
  view: EditorView;
  selectedId: string | null;
  selected: PostContent | null;
  version: VersionContent | null;
  material: MaterialContent | null;
  saveState: SaveState;
  savedAt: string | null;
  viewMode: ViewMode;
};

/** AI 工作台上下文（M4；当次会话内保持，切页签不丢） */
export interface AIContextState {
  entries: ContextEntry[];
  includeAttachmentText: boolean;
}

/** 界面偏好（侧栏显隐 / 编辑器字号缩放）localStorage 持久化 */
const UI_PREFS_KEY = "mewbox:ui-prefs";

interface UiPrefs {
  leftOpen: boolean;
  rightOpen: boolean;
  editorZoom: number;
}

function loadUiPrefs(): UiPrefs {
  const fallback: UiPrefs = { leftOpen: true, rightOpen: true, editorZoom: 1 };
  try {
    const raw = localStorage.getItem(UI_PREFS_KEY);
    if (!raw) return fallback;
    const p = JSON.parse(raw) as Partial<UiPrefs>;
    return {
      leftOpen: p.leftOpen !== false,
      rightOpen: p.rightOpen !== false,
      editorZoom: typeof p.editorZoom === "number" && p.editorZoom > 0 ? p.editorZoom : 1,
    };
  } catch {
    return fallback;
  }
}

function saveUiPrefs(p: UiPrefs) {
  try {
    localStorage.setItem(UI_PREFS_KEY, JSON.stringify(p));
  } catch {
    /* jsdom / 隐私模式下忽略 */
  }
}

export const ZOOM_MIN = 0.7;
export const ZOOM_MAX = 2;
export const ZOOM_STEP = 0.1;

const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100));

/** 主/次栏统一取一片编辑状态（次栏字段名加后缀 2，形状与 PaneFields 一致） */
export function paneSlice(st: AppStore, pane: PaneId): PaneFields & { flushFn: (() => Promise<void>) | null } {
  return pane === "primary"
    ? {
        view: st.view, selectedId: st.selectedId, selected: st.selected, version: st.version,
        material: st.material, saveState: st.saveState, savedAt: st.savedAt, viewMode: st.viewMode, flushFn: st.flushFn,
      }
    : {
        view: st.view2, selectedId: st.selectedId2, selected: st.selected2, version: st.version2,
        material: st.material2, saveState: st.saveState2, savedAt: st.savedAt2, viewMode: st.viewMode2, flushFn: st.flushFn2,
      };
}

/** Partial<PaneFields> → 对应栏的 store patch（次栏键名加 2） */
export function panePatch(pane: PaneId, f: Partial<PaneFields>): Partial<AppStore> {
  if (pane === "primary") return f;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(f) as (keyof PaneFields)[]) out[`${k}2`] = f[k];
  return out as Partial<AppStore>;
}

export interface AppStore {
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
  /** M4：AI 设置弹窗 */
  settingsOpen: boolean;
  /** M5：全局搜索覆盖层 */
  searchOpen: boolean;
  /** M4：AI 工作台上下文（会话级简单状态） */
  aiContext: AIContextState;
  /** EditorPane 注册的强制保存钩子（切换文稿前调用，防止丢字） */
  flushFn: (() => Promise<void>) | null;
  /** 左栏 / 右栏显隐（持久化） */
  leftOpen: boolean;
  rightOpen: boolean;
  /** 编辑器字号缩放倍率（1 = 100%，持久化） */
  editorZoom: number;
  /** 分栏第二步：次栏完整编辑切片（与主栏字段一一对应） */
  view2: EditorView;
  selectedId2: string | null;
  selected2: PostContent | null;
  version2: VersionContent | null;
  material2: MaterialContent | null;
  saveState2: SaveState;
  savedAt2: string | null;
  viewMode2: ViewMode;
  flushFn2: (() => Promise<void>) | null;
  /** 次栏是否打开（渲染第二个 EditorPane） */
  pane2Open: boolean;
  /** 次栏最近打开的文稿（关闭后 Ctrl+\ 重开用，会话级） */
  pane2LastId: string | null;
  /** 活动栏：右栏面板、AI 插入、快捷键的归属（点击/聚焦切换） */
  activePane: PaneId;

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
  setSettingsOpen(open: boolean): void;
  setSearchOpen(open: boolean): void;
  setAIContext(ctx: AIContextState): void;
  reloadPost(): Promise<void>;
  toggleLeft(): void;
  toggleRight(): void;
  setRightOpen(open: boolean): void;
  zoomEditor(delta: number): void;
  resetEditorZoom(): void;
  openPane2(id: string): Promise<void>;
  closePane2(): Promise<void>;
  togglePane2(): Promise<void>;
  swapPane2(): Promise<void>;
  setActivePane(pane: PaneId): void;
  /** 次栏并行导航/保存操作（与主栏同名动作语义一致） */
  select2(id: string | null): Promise<void>;
  selectVersion2(baseId: string, target: string): Promise<void>;
  selectMaterial2(id: string | null): Promise<void>;
  backToPost2(): Promise<void>;
  reloadPost2(): Promise<void>;
  reloadVersion2(): Promise<void>;
  reloadMaterial2(): Promise<void>;
  registerFlush2(fn: (() => Promise<void>) | null): void;
  setDirty2(): void;
  setSaving2(): void;
  setSaved2(updatedAt: string): void;
  setViewMode2(mode: ViewMode): void;
}

export const useApp = create<AppStore>((set, get) => {
  // ── 双栏共用的导航/保存实现：主栏与次栏只是字段组不同（分栏第二步） ──

  /** 同文档防呆：目标已在另一栏打开 → 聚焦那一栏（避免双开互相覆盖保存） */
  const otherPaneHas = (pane: PaneId, match: (sl: PaneFields) => boolean): boolean => {
    const st = get();
    const other: PaneId = pane === "primary" ? "secondary" : "primary";
    if (other === "secondary" && !st.pane2Open) return false;
    return match(paneSlice(st, other));
  };

  const doSelect = async (pane: PaneId, id: string | null) => {
    const sl = paneSlice(get(), pane);
    if (id !== null && otherPaneHas(pane, (osl) => osl.view.kind === "post" && osl.selectedId === id)) {
      set({ activePane: pane === "primary" ? "secondary" : "primary" });
      return;
    }
    if (id === sl.selectedId && sl.view.kind === "post") return;
    if (sl.flushFn) await sl.flushFn(); // 切换前强制落盘
    if (id === null) {
      set(panePatch(pane, { view: { kind: "post" }, selectedId: null, selected: null, version: null, material: null, saveState: "saved" }));
      return;
    }
    const selected = await api.readPost(id);
    set(panePatch(pane, { view: { kind: "post" }, selectedId: id, selected, version: null, material: null, saveState: "saved", savedAt: null }));
  };

  const doSelectVersion = async (pane: PaneId, baseId: string, target: string) => {
    if (otherPaneHas(pane, (osl) => osl.view.kind === "version" && osl.view.baseId === baseId && osl.view.target === target)) {
      set({ activePane: pane === "primary" ? "secondary" : "primary" });
      return;
    }
    const sl = paneSlice(get(), pane);
    if (sl.flushFn) await sl.flushFn();
    const version = await api.readPublishVersion(baseId, target);
    set(panePatch(pane, { view: { kind: "version", baseId, target }, selectedId: null, selected: null, material: null, version, saveState: "saved", savedAt: null }));
  };

  const doSelectMaterial = async (pane: PaneId, id: string | null) => {
    const sl = paneSlice(get(), pane);
    if (id === null) {
      if (sl.flushFn) await sl.flushFn();
      set(panePatch(pane, { view: { kind: "post" }, selectedId: null, selected: null, material: null, saveState: "saved" }));
      return;
    }
    if (otherPaneHas(pane, (osl) => osl.view.kind === "material" && osl.view.id === id)) {
      set({ activePane: pane === "primary" ? "secondary" : "primary" });
      return;
    }
    if (sl.view.kind === "material" && id === sl.view.id) return;
    if (sl.flushFn) await sl.flushFn();
    const material = await api.readMaterial(id);
    set(panePatch(pane, { view: { kind: "material", id }, selectedId: null, selected: null, version: null, material, saveState: "saved", savedAt: null }));
  };

  const doBackToPost = async (pane: PaneId) => {
    const sl = paneSlice(get(), pane);
    if (sl.view.kind !== "version") return;
    await doSelect(pane, sl.view.baseId);
  };

  const doReloadPost = async (pane: PaneId) => {
    const sl = paneSlice(get(), pane);
    if (!sl.selectedId) return;
    const selected = await api.readPost(sl.selectedId);
    set(panePatch(pane, { selected }));
  };

  const doReloadVersion = async (pane: PaneId) => {
    const sl = paneSlice(get(), pane);
    if (sl.view.kind !== "version") return;
    const version = await api.readPublishVersion(sl.view.baseId, sl.view.target);
    set(panePatch(pane, { version }));
  };

  const doReloadMaterial = async (pane: PaneId) => {
    const sl = paneSlice(get(), pane);
    if (sl.view.kind !== "material") return;
    const material = await api.readMaterial(sl.view.id);
    set(panePatch(pane, { material }));
  };

  return ({
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
  settingsOpen: false,
  searchOpen: false,
  aiContext: { entries: [], includeAttachmentText: false },
  flushFn: null,
  ...loadUiPrefs(),
  view2: { kind: "post" },
  selectedId2: null,
  selected2: null,
  version2: null,
  material2: null,
  saveState2: "saved",
  savedAt2: null,
  viewMode2: "edit",
  flushFn2: null,
  pane2Open: false,
  pane2LastId: null,
  activePane: "primary",

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

  select: (id) => doSelect("primary", id),
  selectVersion: (baseId, target) => doSelectVersion("primary", baseId, target),
  selectMaterial: (id) => doSelectMaterial("primary", id),
  backToPost: () => doBackToPost("primary"),

  reloadVersion: () => doReloadVersion("primary"),
  reloadMaterial: () => doReloadMaterial("primary"),

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
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setSearchOpen: (searchOpen) => set({ searchOpen }),
  setAIContext: (aiContext) => set({ aiContext }),

  reloadPost: () => doReloadPost("primary"),

  // ───── 次栏并行操作（实现与主栏共用，见上方 doXxx） ─────
  select2: (id) => doSelect("secondary", id),
  selectVersion2: (baseId, target) => doSelectVersion("secondary", baseId, target),
  selectMaterial2: (id) => doSelectMaterial("secondary", id),
  backToPost2: () => doBackToPost("secondary"),
  reloadPost2: () => doReloadPost("secondary"),
  reloadVersion2: () => doReloadVersion("secondary"),
  reloadMaterial2: () => doReloadMaterial("secondary"),
  registerFlush2: (fn) => set({ flushFn2: fn }),
  setDirty2: () => set({ saveState2: "dirty" }),
  setSaving2: () => set({ saveState2: "saving" }),
  setSaved2: (updatedAt) => set({ saveState2: "saved", savedAt2: updatedAt }),
  setViewMode2: (viewMode2) => set({ viewMode2 }),
  setActivePane: (activePane) => set({ activePane }),

  toggleLeft: () => {
    const leftOpen = !get().leftOpen;
    set({ leftOpen });
    saveUiPrefs({ leftOpen, rightOpen: get().rightOpen, editorZoom: get().editorZoom });
  },
  toggleRight: () => {
    const rightOpen = !get().rightOpen;
    set({ rightOpen });
    saveUiPrefs({ leftOpen: get().leftOpen, rightOpen, editorZoom: get().editorZoom });
  },
  setRightOpen: (rightOpen) => {
    set({ rightOpen });
    saveUiPrefs({ leftOpen: get().leftOpen, rightOpen, editorZoom: get().editorZoom });
  },
  zoomEditor: (delta) => {
    const editorZoom = clampZoom(get().editorZoom + delta);
    set({ editorZoom });
    saveUiPrefs({ leftOpen: get().leftOpen, rightOpen: get().rightOpen, editorZoom });
  },
  resetEditorZoom: () => {
    set({ editorZoom: 1 });
    saveUiPrefs({ leftOpen: get().leftOpen, rightOpen: get().rightOpen, editorZoom: 1 });
  },

  // ───── 分栏（第二步）：次栏为完整编辑器 ─────
  openPane2: async (id) => {
    const st = get();
    // 同文档防呆：与主栏同篇 → 聚焦主栏
    if (st.view.kind === "post" && st.selectedId === id) {
      set({ activePane: "primary" });
      return;
    }
    if (st.flushFn2) await st.flushFn2();
    const selected = await api.readPost(id);
    set({
      ...panePatch("secondary", { view: { kind: "post" }, selectedId: id, selected, version: null, material: null, saveState: "saved", savedAt: null }),
      pane2Open: true,
      pane2LastId: id,
      activePane: "secondary",
    });
  },
  closePane2: async () => {
    const st = get();
    const lastId = st.selectedId2 ?? st.pane2LastId;
    if (st.flushFn2) await st.flushFn2(); // 关闭前强制落盘
    set({ pane2Open: false, pane2LastId: lastId, activePane: "primary" });
  },
  togglePane2: async () => {
    const st = get();
    if (st.pane2Open) {
      await get().closePane2();
      return;
    }
    // 重开最近一篇；没有历史目标时尝试当前主栏文稿
    const target = st.pane2LastId ?? (st.view.kind === "post" ? st.selectedId : null);
    if (target) await get().openPane2(target);
  },
  swapPane2: async () => {
    const st = get();
    if (!st.pane2Open) return;
    if (st.flushFn) await st.flushFn();
    if (st.flushFn2) await st.flushFn2();
    const a = paneSlice(st, "primary");
    const b = paneSlice(st, "secondary");
    set({
      ...panePatch("primary", { view: b.view, selectedId: b.selectedId, selected: b.selected, version: b.version, material: b.material, saveState: "saved", savedAt: null }),
      ...panePatch("secondary", { view: a.view, selectedId: a.selectedId, selected: a.selected, version: a.version, material: a.material, saveState: "saved", savedAt: null }),
      activePane: "primary",
      pane2LastId: b.selectedId ?? st.pane2LastId,
    });
  },
  });
});
