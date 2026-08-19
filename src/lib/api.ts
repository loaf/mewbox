import { invoke } from "@tauri-apps/api/core";

// 与 src-tauri/src 各结构体的 camelCase 序列化一一对应

export interface PostRef {
  id: string;
  title: string;
  folder: string | null;
}

export interface TreeNode {
  name: string;
  children: Record<string, TreeNode>;
  posts: PostRef[];
}

export interface PostSummary {
  id: string;
  title: string;
  folder: string | null;
  status: string;
  tags: string[];
  path: string;
  updatedAt: string;
}

export interface PostsPayload {
  tree: TreeNode[];
  posts: PostSummary[];
}

export interface PostContent {
  id: string;
  title: string;
  folder: string | null;
  status: string;
  tags: string[];
  body: string;
}

export interface SaveResult {
  updatedAt: string;
  snapshotted: boolean;
}

export interface TrashItem {
  id: string;
  title: string;
  folder: string | null;
  deletedAt: string;
  daysLeft: number;
}

export interface SnapshotEntry {
  fileName: string;
  ts: string;
  tsUtc: string;
  hash8: string;
  milestone: string | null;
}

export interface SearchHit {
  id: string;
  path: string;
  title: string;
}

export interface ScanReport {
  posts: unknown[];
  pathChanges: { id: string; oldPath: string; newPath: string }[];
  pendingImport: { path: string }[];
  slugConflicts: string[];
  missing: string[];
  orphanVersions: string[];
}

export interface PublishVersionSummary {
  id: string;
  base: string;
  target: string;
  title: string;
  publishedUrl: string | null;
  publishedAt: string | null;
  updatedAt: string;
  path: string;
}

export interface VersionContent {
  id: string;
  base: string;
  target: string;
  title: string;
  body: string;
  publishedUrl: string | null;
  publishedAt: string | null;
}

export interface PublishTarget {
  id: string;
  display: string;
  note: string;
}

export const api = {
  listPosts: (): Promise<PostsPayload> => invoke("list_posts"),
  createPost: (title: string, folder?: string): Promise<PostSummary> =>
    invoke("create_post", { title, folder: folder ?? null }),
  readPost: (id: string): Promise<PostContent> => invoke("read_post", { id }),
  savePost: (id: string, content: string): Promise<SaveResult> =>
    invoke("save_post", { id, content }),
  setPostTitle: (id: string, title: string): Promise<PostSummary> =>
    invoke("set_post_title", { id, title }),
  setPostStatus: (id: string, status: string): Promise<PostSummary> =>
    invoke("set_post_status", { id, status }),
  setPostFolder: (id: string, folder: string | null): Promise<PostSummary> =>
    invoke("set_post_folder", { id, folder }),
  renameVirtualFolder: (from: string, to: string): Promise<PostsPayload> =>
    invoke("rename_virtual_folder", { from, to }),
  movePostToTrash: (id: string): Promise<void> => invoke("move_post_to_trash", { id }),
  listTrash: (): Promise<TrashItem[]> => invoke("list_trash"),
  restorePost: (id: string): Promise<PostSummary> => invoke("restore_post", { id }),
  listSnapshots: (id: string): Promise<SnapshotEntry[]> => invoke("list_snapshots", { id }),
  readSnapshot: (id: string, snapshotFile: string): Promise<string> =>
    invoke("read_snapshot", { id, snapshotFile }),
  restoreSnapshot: (id: string, snapshotFile: string): Promise<PostContent> =>
    invoke("restore_snapshot", { id, snapshotFile }),
  setSnapshotMilestone: (id: string, snapshotFile: string, name: string): Promise<void> =>
    invoke("set_snapshot_milestone", { id, snapshotFile, name }),
  savePastedImage: (postId: string, bytes: Uint8Array, ext: string): Promise<string> =>
    invoke("save_pasted_image", { postId, bytes: Array.from(bytes), ext }),
  savePastedImageAt: (fileRelPath: string, bytes: Uint8Array, ext: string): Promise<string> =>
    invoke("save_pasted_image_at", { fileRelPath, bytes: Array.from(bytes), ext }),
  searchPosts: (query: string): Promise<SearchHit[]> => invoke("search_posts", { query }),
  scanRefresh: (): Promise<ScanReport> => invoke("scan_refresh"),
  importExternal: (path: string): Promise<PostSummary> =>
    invoke("import_external", { path }),
  // ───── 发布版本（M2） ─────
  listPublishVersions: (baseId: string): Promise<PublishVersionSummary[]> =>
    invoke("list_publish_versions", { baseId }),
  createPublishVersion: (
    baseId: string,
    target: string,
    fromSnapshot?: string | null,
  ): Promise<VersionContent> =>
    invoke("create_publish_version", { baseId, target, fromSnapshot: fromSnapshot ?? null }),
  readPublishVersion: (baseId: string, target: string): Promise<VersionContent> =>
    invoke("read_publish_version", { baseId, target }),
  savePublishVersion: (baseId: string, target: string, content: string): Promise<SaveResult> =>
    invoke("save_publish_version", { baseId, target, content }),
  syncPublishFromPost: (baseId: string, target: string): Promise<VersionContent> =>
    invoke("sync_publish_from_post", { baseId, target }),
  setPublishPublished: (
    baseId: string,
    target: string,
    url: string | null,
    date: string | null,
  ): Promise<PublishVersionSummary> =>
    invoke("set_publish_published", { baseId, target, url, date }),
  listVersionSnapshots: (baseId: string, target: string): Promise<SnapshotEntry[]> =>
    invoke("list_version_snapshots", { baseId, target }),
  readVersionSnapshot: (baseId: string, target: string, snapshotFile: string): Promise<string> =>
    invoke("read_version_snapshot", { baseId, target, snapshotFile }),
  restoreVersionSnapshot: (baseId: string, target: string, snapshotFile: string): Promise<VersionContent> =>
    invoke("restore_version_snapshot", { baseId, target, snapshotFile }),
  setVersionMilestone: (baseId: string, target: string, snapshotFile: string, name: string): Promise<void> =>
    invoke("set_version_milestone", { baseId, target, snapshotFile, name }),
  listPublishTargets: (): Promise<PublishTarget[]> => invoke("list_publish_targets"),
  addPublishTarget: (id: string, display: string, note: string): Promise<void> =>
    invoke("add_publish_target", { id, display, note }),
};
