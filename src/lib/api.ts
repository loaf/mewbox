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
  path: string;
  /** 尾部关联块（M3；body 不含块） */
  assoc?: AssocBlock | null;
}

// ───── 知识库与关联体系（M3，DESIGN §6/§7） ─────

export interface AssocEntry {
  title: string;
  /** 目标文件相对本文件的相对路径 */
  target: string;
}

export interface AssocBlock {
  posts: AssocEntry[];
  materials: AssocEntry[];
  /** 发布版本区（仅文稿侧；自动维护） */
  versions: AssocEntry[];
}

export interface MaterialSummary {
  id: string;
  title: string;
  path: string;
  /** kb 下的目录（如 Inbox / 研究；根目录为 null） */
  folder: string | null;
  updatedAt: string;
}

export interface MaterialContent {
  id: string;
  title: string;
  body: string;
  path: string;
  folder: string | null;
  assoc: AssocBlock | null;
}

/** assoc_targets 返回：块条目 + 目标 id 反查（版本区恒 null） */
export interface AssocTargetEntry {
  title: string;
  target: string;
  id: string | null;
}

export interface Backlink {
  fromId: string;
  fromTitle: string;
  kind: "wiki" | "assoc";
}

export interface WikiHit {
  id: string;
  kind: "post" | "material";
  title: string;
  path: string;
}

export interface WikiResolve {
  matched: WikiHit | null;
  candidates: WikiHit[];
}

export interface BrokenLink {
  from: string;
  dest: string;
}

export interface HealthReport {
  brokenLinks: BrokenLink[];
  trashTargets: BrokenLink[];
  orphanHistories: string[];
  orphanVersions: string[];
  orphanAssets: string[];
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
  /** M3：kb 扫描结果 */
  materials?: unknown[];
  materialPendingImport?: { path: string }[];
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
  path: string;
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
  listAllVersions: (): Promise<PublishVersionSummary[]> => invoke("list_all_versions"),
  workspaceRoot: (): Promise<string> => invoke("workspace_root"),
  createPublishVersion: (
    baseId: string,
    target: string,
    fromSnapshot?: string | null,
    currentBody?: string | null,
  ): Promise<VersionContent> =>
    invoke("create_publish_version", {
      baseId,
      target,
      fromSnapshot: fromSnapshot ?? null,
      currentBody: currentBody ?? null,
    }),
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
  // ───── 知识库与关联体系（M3） ─────
  listMaterials: (): Promise<MaterialSummary[]> => invoke("list_materials"),
  createMaterial: (title: string, dir: string): Promise<MaterialContent> =>
    invoke("create_material", { title, dir }),
  readMaterial: (id: string): Promise<MaterialContent> => invoke("read_material", { id }),
  saveMaterial: (id: string, content: string): Promise<SaveResult> =>
    invoke("save_material", { id, content }),
  setMaterialTitle: (id: string, title: string): Promise<MaterialSummary> =>
    invoke("set_material_title", { id, title }),
  importMdFiles: (paths: string[], destDir: string): Promise<MaterialSummary[]> =>
    invoke("import_md_files", { paths, destDir }),
  importFilesContainerized: (paths: string[]): Promise<MaterialSummary[]> =>
    invoke("import_files_containerized", { paths }),
  moveMaterialToTrash: (id: string): Promise<void> => invoke("move_material_to_trash", { id }),
  listMaterialTrash: (): Promise<TrashItem[]> => invoke("list_material_trash"),
  restoreMaterial: (id: string): Promise<MaterialSummary> => invoke("restore_material", { id }),
  convertMaterialToPost: (id: string): Promise<PostSummary> =>
    invoke("convert_material_to_post", { id }),
  convertPostToMaterial: (id: string): Promise<MaterialSummary> =>
    invoke("convert_post_to_material", { id }),
  renamePostSlug: (id: string, newSlug: string): Promise<PostSummary> =>
    invoke("rename_post_slug", { id, newSlug }),
  renameMaterialFile: (id: string, newName: string): Promise<MaterialSummary> =>
    invoke("rename_material_file", { id, newName }),
  moveMaterial: (id: string, newDir: string): Promise<MaterialSummary> =>
    invoke("move_material", { id, newDir }),
  renameKbDir: (dir: string, newName: string): Promise<MaterialSummary[]> =>
    invoke("rename_kb_dir", { dir, newName }),
  updateAssoc: (aId: string, bId: string, add: boolean): Promise<void> =>
    invoke("update_assoc", { aId, bId, add }),
  assocTargets: (id: string): Promise<AssocTargetEntry[]> => invoke("assoc_targets", { id }),
  backlinks: (id: string): Promise<Backlink[]> => invoke("backlinks", { id }),
  resolveWiki: (title: string): Promise<WikiResolve> => invoke("resolve_wiki", { title }),
  healthCheck: (): Promise<HealthReport> => invoke("health_check"),
  cleanOrphanAssets: (fingerprints: string[]): Promise<number> =>
    invoke("clean_orphan_assets", { fingerprints }),
  listKbDirs: (): Promise<string[]> => invoke("list_kb_dirs"),
  createKbDir: (parent: string, name: string): Promise<string> =>
    invoke("create_kb_dir", { parent, name }),
};
