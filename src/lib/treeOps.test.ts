import { buildTree, filterAndSort, onFolderDrop, onPostDrop } from "./treeOps";
import type { PostSummary } from "./api";

const post = (id: string, title: string, folder: string | null, status = "draft", updatedAt = "2026-08-18T10:00:00"): PostSummary => ({
  id,
  title,
  folder,
  status,
  tags: [],
  path: `posts/${id}.md`,
  updatedAt,
});

describe("treeOps", () => {
  test("drop post onto folder → set_post_folder 参数正确；原地不动返回 null", () => {
    expect(onPostDrop("p1", "技术", "随笔")).toEqual({ id: "p1", folder: "随笔" });
    expect(onPostDrop("p1", null, "随笔")).toEqual({ id: "p1", folder: "随笔" });
    expect(onPostDrop("p1", "随笔", null)).toEqual({ id: "p1", folder: null }); // 拖回未分类
    expect(onPostDrop("p1", "技术", "技术")).toBeNull();
  });

  test("drop folder onto folder → rename 参数正确；自身/子孙目标 no-op", () => {
    expect(onFolderDrop("技术", null)).toBeNull(); // 挪到根：路径不变
    expect(onFolderDrop("技术/后端", null)).toEqual({ from: "技术/后端", to: "后端" });
    expect(onFolderDrop("技术", "技术/后端")).toBeNull(); // 挪进子孙
    expect(onFolderDrop("技术", "随笔")).toEqual({ from: "技术", to: "随笔/技术" });
  });

  test("buildTree 聚合与未分类固定最后", () => {
    const tree = buildTree([
      post("1", "分布式笔记", "技术/分布式"),
      post("2", "技术随笔", "技术"),
      post("3", "随想", null),
    ]);
    expect(tree.map((n) => n.name)).toEqual(["技术", "未分类"]);
    expect(Object.keys(tree[0].children)).toEqual(["分布式"]);
    expect(tree[0].posts.map((p) => p.id)).toEqual(["2"]);
    expect(tree[1].posts.map((p) => p.id)).toEqual(["3"]);
  });

  test("filterAndSort 按状态过滤 + 按时间/标题排序", () => {
    const posts = [
      post("a", "alpha", null, "draft", "2026-08-01T10:00:00"),
      post("b", "beta", null, "done", "2026-08-10T10:00:00"),
      post("c", "gamma", null, "draft", "2026-08-05T10:00:00"),
    ];
    expect(filterAndSort(posts, "done", "updated").map((p) => p.id)).toEqual(["b"]);
    expect(filterAndSort(posts, "all", "updated").map((p) => p.id)).toEqual(["b", "c", "a"]);
    expect(filterAndSort(posts, "all", "title").map((p) => p.title)).toEqual(["alpha", "beta", "gamma"]);
  });
});
