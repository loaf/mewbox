import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppShell } from "./AppShell";

const listPostsMock = vi.fn();
const createPostMock = vi.fn();
const listTrashMock = vi.fn();
const readPostMock = vi.fn();
const listAllVersionsMock = vi.fn();
const workspaceRootMock = vi.fn();

vi.mock("../lib/api", () => ({
  api: {
    listPosts: (...a: unknown[]) => listPostsMock(...a),
    createPost: (...a: unknown[]) => createPostMock(...a),
    listTrash: (...a: unknown[]) => listTrashMock(...a),
    readPost: (...a: unknown[]) => readPostMock(...a),
    listAllVersions: (...a: unknown[]) => listAllVersionsMock(...a),
    workspaceRoot: (...a: unknown[]) => workspaceRootMock(...a),
  },
}));

import { useApp } from "../stores/app";

const emptyPayload = { tree: [], posts: [] };

describe("AppShell", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listPostsMock.mockResolvedValue(emptyPayload);
    listTrashMock.mockResolvedValue([]);
    listAllVersionsMock.mockResolvedValue([]);
    workspaceRootMock.mockResolvedValue("X:/ws");
    useApp.setState({
      loading: true,
      tree: [],
      posts: [],
      trash: [],
      selectedId: null,
      selected: null,
      flushFn: null,
      saveState: "saved",
    });
  });

  test("渲染左栏三区（文稿/知识库占位/搜索占位）与右栏页签（大纲/历史）", async () => {
    render(<AppShell />);
    expect(await screen.findByLabelText("文稿")).toBeInTheDocument();
    expect(screen.getByLabelText("知识库")).toBeInTheDocument();
    expect(screen.getByLabelText("全局搜索")).toBeInTheDocument();
    expect(await screen.findByTestId("tab-outline")).toBeInTheDocument();
    expect(screen.getByTestId("tab-history")).toBeInTheDocument();
  });

  test("无选中时主区显示空状态，点新建→输入标题→创建并选中", async () => {
    createPostMock.mockResolvedValue({ id: "p1", title: "第一篇", folder: null, status: "draft", tags: [], path: "posts/a.md", updatedAt: "t" });
    readPostMock.mockResolvedValue({ id: "p1", title: "第一篇", folder: null, status: "draft", tags: [], body: "", path: "posts/a.md" });
    listPostsMock.mockResolvedValue({
      tree: [{ name: "未分类", children: {}, posts: [{ id: "p1", title: "第一篇", folder: null }] }],
      posts: [{ id: "p1", title: "第一篇", folder: null, status: "draft", tags: [], path: "posts/a.md", updatedAt: "t" }],
    });
    render(<AppShell />);
    expect(await screen.findByTestId("empty-state")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("new-post"));
    await userEvent.type(screen.getByTestId("new-post-title"), "第一篇");
    await userEvent.click(screen.getByTestId("new-post-confirm"));

    await waitFor(() => expect(createPostMock).toHaveBeenCalledWith("第一篇", undefined));
    await waitFor(() => expect(useApp.getState().selectedId).toBe("p1"));
    await waitFor(() => expect(screen.getByTestId("editor-title")).toHaveValue("第一篇"));
  });

  test("渲染聚合树数据：目录与未分类", async () => {
    listPostsMock.mockResolvedValue({
      tree: [],
      posts: [
        { id: "1", title: "笔记", folder: "技术/分布式", status: "draft", tags: [], path: "posts/1.md", updatedAt: "t" },
        { id: "2", title: "随想", folder: null, status: "draft", tags: [], path: "posts/2.md", updatedAt: "t" },
      ],
    });
    render(<AppShell />);
    expect(await screen.findByText("技术")).toBeInTheDocument();
    expect(screen.getByText("分布式")).toBeInTheDocument();
    expect(screen.getByText("随想")).toBeInTheDocument();
  });

  test("版本模式下主区渲染版本编辑器（而不是「新建文稿」空状态）", async () => {
    listPostsMock.mockResolvedValue({ tree: [], posts: [] });
    const { unmount } = render(<AppShell />);
    await screen.findByTestId("empty-state");
    useApp.setState({
      view: { kind: "version", baseId: "p1", target: "wechat" },
      selectedId: null,
      selected: null,
      version: {
        id: "v1", base: "p1", target: "wechat", title: "深度工作（公众号版）",
        body: "继承的内容", publishedUrl: null, publishedAt: null, path: ".versions/p1/publish/wechat.md",
      },
    });
    // 空状态消失，编辑器（版本标题 + 横幅）出现
    await waitFor(() => expect(screen.queryByTestId("empty-state")).not.toBeInTheDocument());
    expect(screen.getByTestId("version-banner")).toBeInTheDocument();
    expect(screen.getByTestId("version-title").textContent).toContain("公众号版");
    unmount();
  });
});
