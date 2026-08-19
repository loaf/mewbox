import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PostTree, makeDataTransfer } from "./PostTree";

const apiMocks = vi.hoisted(() => ({
  listPosts: vi.fn(),
  createPost: vi.fn(),
  listTrash: vi.fn().mockResolvedValue([]),
  setPostFolder: vi.fn().mockResolvedValue({}),
  renameVirtualFolder: vi.fn().mockResolvedValue({ tree: [], posts: [] }),
  setPostStatus: vi.fn().mockResolvedValue({}),
  setPostTitle: vi.fn().mockResolvedValue({}),
  movePostToTrash: vi.fn().mockResolvedValue(undefined),
  readPost: vi.fn(),
}));

vi.mock("../lib/api", () => ({ api: apiMocks }));

import { useApp } from "../stores/app";
import type { PostSummary } from "../lib/api";

const post = (id: string, title: string, folder: string | null, status = "draft"): PostSummary => ({
  id,
  title,
  folder,
  status,
  tags: [],
  path: `posts/${id}.md`,
  updatedAt: "2026-08-18T10:00:00",
});

const P1 = post("p1", "分布式笔记", "技术/分布式");
const P2 = post("p2", "技术随笔", "技术", "writing");
const P3 = post("p3", "随想", null, "done");

async function mount(posts: PostSummary[]) {
  useApp.setState({
    posts,
    tree: [],
    trash: [],
    selectedId: null,
    selected: null,
    flushFn: null,
    loading: false,
  });
  const onNewPost = vi.fn();
  render(<PostTree onNewPost={onNewPost} />);
  return { onNewPost };
}

describe("PostTree", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.listPosts.mockResolvedValue({ tree: [], posts: [] });
    apiMocks.listTrash.mockResolvedValue([]);
    useApp.setState({ versionCounts: {}, view: { kind: "post" } });
  });

  test("渲染聚合树：目录 > 子目录 > 文稿，未分类固定最后", async () => {
    await mount([P1, P2, P3]);
    expect(screen.getByTestId("folder-技术")).toBeInTheDocument();
    expect(screen.getByTestId("folder-技术-分布式")).toBeInTheDocument();
    expect(screen.getByTestId("folder-未分类")).toBeInTheDocument();
    // 顺序：技术在前、未分类最后
    const names = screen.getAllByTestId(/^folder-/).map((el) => el.getAttribute("data-testid"));
    expect(names.indexOf("folder-技术")).toBeLessThan(names.indexOf("folder-未分类"));
    expect(screen.getByText("随想")).toBeInTheDocument();
  });

  test("拖拽文稿到目录触发 setPostFolder（fireEvent.dragStart/drop）", async () => {
    await mount([P1, P2, P3]);
    const item = screen.getByText("随想").closest('[data-testid="post-item"]')!;
    fireEvent.dragStart(item, { dataTransfer: makeDataTransfer({ kind: "post", id: "p3" }) });
    const folder = screen.getByTestId("folder-技术").firstElementChild!;
    fireEvent.drop(folder, { dataTransfer: makeDataTransfer({ kind: "post", id: "p3" }) });
    await waitFor(() =>
      expect(apiMocks.setPostFolder).toHaveBeenCalledWith("p3", "技术"),
    );
  });

  test("状态 chips 渲染（draft/writing/done + archived 灰底）", async () => {
    await mount([P1, P2, P3, post("p4", "旧文", null, "archived")]);
    expect(screen.getByTestId("chip-draft")).toBeInTheDocument();
    expect(screen.getByTestId("chip-writing")).toBeInTheDocument();
    expect(screen.getByTestId("chip-done")).toBeInTheDocument();
    expect(screen.getByTestId("chip-archived")).toBeInTheDocument();
  });

  test("状态过滤 + 更新时间/标题排序下拉生效（DESIGN §4.3）", async () => {
    const a = { ...post("a", "alpha", null, "draft"), updatedAt: "2026-08-01T10:00:00" };
    const b = { ...post("b", "beta", null, "done"), updatedAt: "2026-08-10T10:00:00" };
    await mount([a, b]);
    // 只看 done
    await userEvent.selectOptions(screen.getByTestId("status-filter"), "done");
    expect(screen.queryByText("alpha")).not.toBeInTheDocument();
    expect(screen.getByText("beta")).toBeInTheDocument();
    // 全部 + 按标题（alpha < beta）
    await userEvent.selectOptions(screen.getByTestId("status-filter"), "all");
    await userEvent.selectOptions(screen.getByTestId("sort-key"), "title");
    const items = screen.getAllByTestId("post-item");
    expect(items[0].textContent).toContain("alpha");
  });

  test("右键目录 → 重命名对话框 → renameVirtualFolder", async () => {
    await mount([P1, P2]);
    const folder = screen.getByTestId("folder-技术").firstElementChild!;
    fireEvent.contextMenu(folder);
    expect(screen.getByTestId("context-menu")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("menu-rename-folder"));
    const input = screen.getByTestId("rename-folder-input");
    await userEvent.clear(input);
    await userEvent.type(input, "工程{Enter}");
    await waitFor(() =>
      expect(apiMocks.renameVirtualFolder).toHaveBeenCalledWith("技术", "工程"),
    );
  });

  test("版本数徽标渲染；版本态高亮母版（版本不进列表，DESIGN 决策 8）", async () => {
    await mount([P3]);
    // 无版本时无徽标
    expect(screen.queryByTestId("version-badge")).not.toBeInTheDocument();
    // 有版本 → 📣n
    useApp.setState({ versionCounts: { p3: 2 } });
    await waitFor(() => expect(screen.getByTestId("version-badge").textContent).toContain("2"));
    // 版本态：母版高亮
    useApp.setState({ view: { kind: "version", baseId: "p3", target: "wechat" }, selectedId: null });
    await waitFor(() => {
      const item = screen.getByText("随想").closest('[data-testid="post-item"]')!;
      expect(item.className).toContain("bg-[var(--cat-bg)]");
    });
  });
});
