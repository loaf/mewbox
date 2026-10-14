import { useApp, AppStore, PaneId, PaneFields } from "./app";

/** 双栏动作名（主栏裸名 / 次栏后缀 2） */
type PaneActionNames =
  | "select"
  | "selectVersion"
  | "selectMaterial"
  | "backToPost"
  | "reloadPost"
  | "reloadVersion"
  | "reloadMaterial"
  | "registerFlush"
  | "setDirty"
  | "setSaving"
  | "setSaved"
  | "setViewMode";

type PaneActions = Pick<AppStore, PaneActionNames>;

/** 非响应式：从当前 store 快照取某栏的绑定动作（doSave 等命令式路径用） */
export function paneOps(st: AppStore, pane: PaneId): PaneActions {
  if (pane === "primary") return st;
  return {
    select: st.select2,
    selectVersion: st.selectVersion2,
    selectMaterial: st.selectMaterial2,
    backToPost: st.backToPost2,
    reloadPost: st.reloadPost2,
    reloadVersion: st.reloadVersion2,
    reloadMaterial: st.reloadMaterial2,
    registerFlush: st.registerFlush2,
    setDirty: st.setDirty2,
    setSaving: st.setSaving2,
    setSaved: st.setSaved2,
    setViewMode: st.setViewMode2,
  };
}

/** 响应式订阅：某栏的状态字段（EditorPane pane 参数化的取数入口） */
export function usePaneValue<K extends keyof PaneFields>(pane: PaneId, key: K): PaneFields[K] {
  return useApp((s) => (pane === "primary" ? s[key] : s[`${key}2` as keyof AppStore as K]));
}

/** 响应式订阅：某栏的动作（zustand 动作引用稳定，不会引发多余渲染） */
export function usePaneAction<K extends PaneActionNames>(pane: PaneId, name: K): PaneActions[K] {
  return useApp((s) => (pane === "primary" ? s[name] : s[`${name}2` as keyof AppStore as K]));
}

/** 响应式订阅：活动栏的状态字段（右栏面板跟随活动栏） */
export function useActiveValue<K extends keyof PaneFields>(key: K): PaneFields[K] {
  return useApp((s) => (s.activePane === "primary" ? s[key] : s[`${key}2` as keyof AppStore as K]));
}

/** 响应式订阅：活动栏的动作（跳转/重载应作用于活动栏） */
export function useActiveAction<K extends PaneActionNames>(name: K): PaneActions[K] {
  return useApp((s) => (s.activePane === "primary" ? s[name] : s[`${name}2` as keyof AppStore as K]));
}
