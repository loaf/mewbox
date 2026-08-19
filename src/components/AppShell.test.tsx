import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppShell } from "./AppShell";

const listPostsMock = vi.fn();
const createPostMock = vi.fn();
const listTrashMock = vi.fn();
const readPostMock = vi.fn();
const listAllVersionsMock = vi.fn();
const workspaceRootMock = vi.fn();
const listMaterialsMock = vi.fn();
const listMaterialTrashMock = vi.fn();
const assocTargetsMock = vi.fn();

vi.mock("../lib/api", () => ({
  api: {
    listPosts: (...a: unknown[]) => listPostsMock(...a),
    createPost: (...a: unknown[]) => createPostMock(...a),
    listTrash: (...a: unknown[]) => listTrashMock(...a),
    readPost: (...a: unknown[]) => readPostMock(...a),
    listAllVersions: (...a: unknown[]) => listAllVersionsMock(...a),
    workspaceRoot: (...a: unknown[]) => workspaceRootMock(...a),
    listMaterials: (...a: unknown[]) => listMaterialsMock(...a),
    listMaterialTrash: (...a: unknown[]) => listMaterialTrashMock(...a),
    assocTargets: (...a: unknown[]) => assocTargetsMock(...a),
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
    listMaterialsMock.mockResolvedValue([]);
    listMaterialTrashMock.mockResolvedValue([]);
    assocTargetsMock.mockResolvedValue([]);
    useApp.setState({
      loading: true,
      tree: [],
      posts: [],
      trash: [],
      materials: [],
      materialTrash: [],
      material: null,
      selectedId: null,
      selected: null,
      version: null,
      flushFn: null,
      saveState: "saved",
      assocPicker: null,
      trashOpen: false,
    });
  });

  test("渲染左栏三区（文稿/知识库/搜索）与右栏页签（大纲/反链/历史）", async () => {
    render(<AppShell />);
    expect(await screen.findByLabelText("文稿")).toBeInTheDocument();
    expect(screen.getByLabelText("知识库")).toBeInTheDocument();
    expect(screen.getByLabelText("全局搜索")).toBeInTheDocument();
    expect(await screen.findByTestId("tab-outline")).toBeInTheDocument();
    expect(screen.getByTestId("tab-backlinks")).toBeInTheDocument();
    expect(screen.getByTestId("tab-history")).toBeInTheDocument();
  });

  test("知识库树渲染资料（load 拉取 materials）；资料回收站入口计数", async () => {
    listMaterialsMock.mockResolvedValue([
      { id: "m1", title: "设计笔记", path: "kb/Inbox/m1.md", folder: "Inbox", updatedAt: "t" },
      { id: "m2", title: "论文", path: "kb/研究/m2.md", folder: "研究", updatedAt: "t" },
    ]);
    listMaterialTrashMock.mockResolvedValue([{ id: "m9", title: "旧资料", folder: null, deletedAt: "t", daysLeft: 5 }]);
    render(<AppShell />);
    expect(await screen.findByText("设计笔记")).toBeInTheDocument();
    expect(screen.getByTestId("kb-folder-Inbox")).toBeInTheDocument();
    expect(screen.getByTestId("kb-folder-研究")).toBeInTheDocument();
    expect(screen.getByTestId("kb-trash-entry").textContent).toContain("1");
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

  test("资料模式下主区渲染资料编辑器（横幅 + 无空状态）", async () => {
    listPostsMock.mockResolvedValue({ tree: [], posts: [] });
    const { unmount } = render(<AppShell />);
    await screen.findByTestId("empty-state");
    useApp.setState({
      view: { kind: "material", id: "m1" },
      selectedId: null,
      selected: null,
      material: { id: "m1", title: "设计笔记", body: "资料内容", path: "kb/Inbox/m1.md", folder: "Inbox", assoc: null },
    });
    await waitFor(() => expect(screen.queryByTestId("empty-state")).not.toBeInTheDocument());
    expect(screen.getByTestId("material-banner")).toBeInTheDocument();
    expect(screen.getByTestId("editor-title")).toHaveValue("设计笔记");
    unmount();
  });

  test("健康检查入口打开面板", async () => {
    render(<AppShell />);
    await screen.findByTestId("health-entry");
  });
});
