import { buildKbTree, kbDirPaths, INBOX, KB_ROOT } from "./kbTreeOps";
import type { MaterialSummary } from "./api";

const mat = (id: string, title: string, folder: string | null): MaterialSummary => ({
  id,
  title,
  path: `kb/${folder ? `${folder}/` : ""}${id}.md`,
  folder,
  updatedAt: "2026-08-19T10:00:00",
});

describe("kbTreeOps", () => {
  test("物理目录树：Inbox 固定第一，其余按名称排序，资料挂目录下", () => {
    const tree = buildKbTree([
      mat("m1", "设计笔记", "研究"),
      mat("m2", "待整理资料", INBOX),
      mat("m3", "论文PDF容器", "论文"),
      mat("m4", "子目录资料", "研究/子目录"),
    ]);
    expect(tree.map((n) => n.name)).toEqual([INBOX, "论文", "研究"]); // zh 拼音序：lun < yan
    expect(tree[0].materials.map((m) => m.title)).toEqual(["待整理资料"]);
    expect(tree[1].materials.map((m) => m.title)).toEqual(["论文PDF容器"]);
    expect(tree[2].materials.map((m) => m.title)).toEqual(["设计笔记"]);
    expect(Object.values(tree[2].children).map((n) => n.name)).toEqual(["子目录"]);
    expect(tree[2].children["子目录"].materials[0].id).toBe("m4");
  });

  test("目录内资料按标题排序（zh locale）", () => {
    const tree = buildKbTree([
      mat("a", "乙资料", INBOX),
      mat("b", "甲资料", INBOX),
    ]);
    expect(tree[0].materials.map((m) => m.title)).toEqual(["甲资料", "乙资料"]);
  });

  test("kb 根目录散资料挂 KB_ROOT 节点（最后）", () => {
    const tree = buildKbTree([mat("m1", "散资料", null), mat("m2", "在盒资料", INBOX)]);
    expect(tree.map((n) => n.name)).toEqual([INBOX, KB_ROOT]);
    expect(tree[1].materials[0].title).toBe("散资料");
  });

  test("kbDirPaths 汇总全部目录（含中间层），Inbox 在前", () => {
    const dirs = kbDirPaths([
      mat("m1", "a", "研究/子目录"),
      mat("m2", "b", "论文"),
      mat("m3", "c", INBOX),
      mat("m4", "d", null),
    ]);
    expect(dirs[0]).toBe(INBOX);
    expect(dirs).toContain("研究");
    expect(dirs).toContain("研究/子目录");
    expect(dirs).toContain("论文");
  });

  test("空列表 → 空树（空 KB）", () => {
    expect(buildKbTree([])).toEqual([]);
    expect(kbDirPaths([])).toEqual([]);
  });
});
