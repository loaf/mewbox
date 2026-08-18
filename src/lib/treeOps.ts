import type { PostSummary, TreeNode } from "./api";

export const UNCATEGORIZED = "未分类";

type TreeLevel = Record<string, TreeNode>;

/** 与 Rust vfolder::build_tree 同义的客户端聚合（过滤/排序后重建用） */
export function buildTree(posts: PostSummary[]): TreeNode[] {
  const root: TreeLevel = {};
  const uncategorized: TreeNode = { name: UNCATEGORIZED, children: {}, posts: [] };

  for (const p of posts) {
    const target =
      p.folder && p.folder.trim()
        ? ensurePath(root, p.folder)
        : uncategorized;
    target.posts.push({ id: p.id, title: p.title, folder: p.folder });
  }

  const sortLevelObj = (level: TreeLevel): TreeLevel => {
    const out: TreeLevel = {};
    for (const n of Object.values(level).sort((a, b) => a.name.localeCompare(b.name, "zh"))) {
      out[n.name] = { ...n, children: sortLevelObj(n.children) };
    }
    return out;
  };

  const result = Object.values(sortLevelObj(root));
  if (uncategorized.posts.length > 0) result.push(uncategorized);
  return result;
}

function ensurePath(root: TreeLevel, path: string): TreeNode {
  let level = root;
  let node: TreeNode | null = null;
  for (const seg of path.split("/")) {
    node = level[seg];
    if (!node) {
      node = { name: seg, children: {}, posts: [] };
      level[seg] = node;
    }
    level = node.children;
  }
  return node!;
}

/** 文稿拖到目录上：返回应调用的 setPostFolder 参数；未分类目标 = folder null */
export function onPostDrop(
  postId: string,
  currentFolder: string | null,
  targetFolderPath: string | null,
): { id: string; folder: string | null } | null {
  if (currentFolder === targetFolderPath) return null; // 原地不动
  return { id: postId, folder: targetFolderPath };
}

/** 目录拖到目录上：返回 renameVirtualFolder 参数；非法目标（自身/子孙/未分类）返回 null */
export function onFolderDrop(
  dragFolderPath: string,
  targetFolderPath: string | null,
): { from: string; to: string } | null {
  const lastSeg = dragFolderPath.split("/").pop();
  if (!lastSeg) return null;
  const to = targetFolderPath === null ? lastSeg : `${targetFolderPath}/${lastSeg}`;
  if (to === dragFolderPath) return null; // 没有变化
  if (to.startsWith(`${dragFolderPath}/`)) return null; // 挪进自己的子孙
  return { from: dragFolderPath, to };
}

export type SortKey = "updated" | "title";

/** 状态过滤 + 排序（DESIGN §4.3） */
export function filterAndSort(
  posts: PostSummary[],
  statusFilter: string | "all",
  sortKey: SortKey,
): PostSummary[] {
  const filtered =
    statusFilter === "all" ? posts : posts.filter((p) => p.status === statusFilter);
  return [...filtered].sort((a, b) => {
    if (sortKey === "title") return a.title.localeCompare(b.title, "zh");
    return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""); // 更新时间新→旧
  });
}
