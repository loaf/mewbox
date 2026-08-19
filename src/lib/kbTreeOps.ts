import type { MaterialSummary } from "./api";

/** kb 物理目录树的默认落点（也是导入默认目录，DESIGN §6） */
export const INBOX = "Inbox";
/** 直接放在 kb/ 根目录下的散资料（folder=null）的虚拟节点名 */
export const KB_ROOT = "（kb 根目录）";

export interface KbTreeNode {
  name: string;
  children: Record<string, KbTreeNode>;
  materials: MaterialSummary[];
}

type TreeLevel = Record<string, KbTreeNode>;

function ensurePath(root: TreeLevel, path: string): KbTreeNode {
  let level = root;
  let node: KbTreeNode | null = null;
  for (const seg of path.split("/")) {
    node = level[seg];
    if (!node) {
      node = { name: seg, children: {}, materials: [] };
      level[seg] = node;
    }
    level = node.children;
  }
  return node!;
}

function sortMaterials(list: MaterialSummary[]): MaterialSummary[] {
  return [...list].sort((a, b) => a.title.localeCompare(b.title, "zh"));
}

/**
 * 由资料列表构建 kb 物理目录树（与 treeOps.buildTree 对文稿的角色对应）：
 * Inbox 固定第一，其余目录按名称排序；散在 kb 根的资料挂在 KB_ROOT 节点（最后）。
 */
export function buildKbTree(materials: MaterialSummary[], physicalDirs: string[] = []): KbTreeNode[] {
  const root: TreeLevel = {};
  const kbRootFiles: MaterialSummary[] = [];

  for (const m of materials) {
    const folder = m.folder && m.folder.trim() ? m.folder.trim() : null;
    if (!folder) {
      kbRootFiles.push(m);
    } else {
      ensurePath(root, folder).materials.push(m);
    }
  }
  // 物理目录（含空目录）并入树：strip 掉 kb/ 前缀
  for (const d of physicalDirs) {
    const rel = d.replace(/^kb\/?/, "").replace(/\/+$/, "");
    if (rel) ensurePath(root, rel);
  }

  const sortLevelObj = (level: TreeLevel): TreeLevel => {
    const out: TreeLevel = {};
    for (const n of Object.values(level).sort((a, b) => a.name.localeCompare(b.name, "zh"))) {
      out[n.name] = {
        name: n.name,
        children: sortLevelObj(n.children),
        materials: sortMaterials(n.materials),
      };
    }
    return out;
  };

  const result = Object.values(sortLevelObj(root));
  const inboxIdx = result.findIndex((n) => n.name === INBOX);
  if (inboxIdx > 0) {
    const [inbox] = result.splice(inboxIdx, 1);
    result.unshift(inbox);
  }
  if (kbRootFiles.length > 0) {
    result.push({ name: KB_ROOT, children: {}, materials: sortMaterials(kbRootFiles) });
  }
  return result;
}

/** 目录树里出现过的全部目录路径（移动资料对话框的建议目录用；Inbox 在前）。
 *  physicalDirs 为磁盘上的物理目录（含空目录），一并纳入建议。 */
export function kbDirPaths(materials: MaterialSummary[], physicalDirs: string[] = []): string[] {
  const dirs = new Set<string>();
  for (const m of materials) {
    const folder = m.folder && m.folder.trim() ? m.folder.trim() : null;
    if (!folder) continue;
    const segs = folder.split("/");
    for (let i = 1; i <= segs.length; i++) dirs.add(segs.slice(0, i).join("/"));
  }
  for (const d of physicalDirs) {
    const rel = d.replace(/^kb\/?/, "").replace(/\/+$/, "");
    if (!rel || rel === ".trash") continue;
    const segs = rel.split("/");
    for (let i = 1; i <= segs.length; i++) dirs.add(segs.slice(0, i).join("/"));
  }
  const list = [...dirs].sort((a, b) => a.localeCompare(b, "zh"));
  const inboxIdx = list.indexOf(INBOX);
  if (inboxIdx > 0) {
    list.splice(inboxIdx, 1);
    list.unshift(INBOX);
  }
  return list;
}
