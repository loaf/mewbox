import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AssocPanel, parseVersionTarget } from "./AssocPanel";

const apiMocks = vi.hoisted(() => ({
  assocTargets: vi.fn(),
  updateAssoc: vi.fn().mockResolvedValue(undefined),
  readPost: vi.fn(),
  readMaterial: vi.fn(),
  readPublishVersion: vi.fn(),
  listPosts: vi.fn().mockResolvedValue({ tree: [], posts: [] }),
  listTrash: vi.fn().mockResolvedValue([]),
  listMaterialTrash: vi.fn().mockResolvedValue([]),
  listMaterials: vi.fn().mockResolvedValue([]),
  listAllVersions: vi.fn().mockResolvedValue([]),
  workspaceRoot: vi.fn().mockResolvedValue("X:/ws"),
}));

vi.mock("../lib/api", () => ({ api: apiMocks }));

import { useApp } from "../stores/app";

const ASSOC = {
  posts: [{ title: "另一篇", target: "../posts/p2.md" }],
  materials: [{ title: "设计笔记", target: "../kb/Inbox/m1.md" }],
  versions: [{ title: "wechat 版", target: "../.versions/p1/publish/wechat.md" }],
};

async function mountPost(assoc: typeof ASSOC | null = ASSOC) {
  apiMocks.listPosts.mockResolvedValue({ tree: [], posts: [] });
  useApp.setState({
    view: { kind: "post" },
    selectedId: "p1",
    selected: { id: "p1", title: "第一篇", folder: null, status: "draft", tags: [], body: "正文", path: "posts/p1.md", assoc },
    material: null,
    version: null,
    posts: [
      { id: "p1", title: "第一篇", folder: null, status: "draft", tags: [], path: "posts/p1.md", updatedAt: "t" },
      { id: "p2", title: "另一篇", folder: null, status: "draft", tags: [], path: "posts/p2.md", updatedAt: "t" },
    ],
    materials: [
      { id: "m1", title: "设计笔记", path: "kb/Inbox/m1.md", folder: "Inbox", updatedAt: "t" },
    ],
    loading: false,
    flushFn: null,
    assocPicker: null,
  });
  render(<AssocPanel />);
}

describe("parseVersionTarget", () => {
  test("从相对路径解析 base/target", () => {
    expect(parseVersionTarget("../.versions/p1/publish/wechat.md")).toEqual({ baseId: "p1", target: "wechat" });
    expect(parseVersionTarget(".versions/abc-123/publish/mp.md")).toEqual({ baseId: "abc-123", target: "mp" });
    expect(parseVersionTarget("../kb/普通资料.md")).toBeNull();
    expect(parseVersionTarget("posts/a.md")).toBeNull();
  });
});

describe("AssocPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.listPosts.mockResolvedValue({ tree: [], posts: [] });
    apiMocks.listMaterials.mockResolvedValue([]);
    apiMocks.listMaterialTrash.mockResolvedValue([]);
    apiMocks.listAllVersions.mockResolvedValue([]);
    useApp.setState({ assocPicker: null });
  });

  test("渲染三区条目；assoc_targets 反查 id 后可点击跳转（文稿/资料/版本）", async () => {
    apiMocks.assocTargets.mockResolvedValue([
      { title: "另一篇", target: "../posts/p2.md", id: "p2" },
      { title: "设计笔记", target: "../kb/Inbox/m1.md", id: "m1" },
      { title: "wechat 版", target: "../.versions/p1/publish/wechat.md", id: null },
    ]);
    await mountPost();
    expect(screen.getByTestId("assoc-panel")).toBeInTheDocument();
    expect(screen.getByTestId("assoc-section-文稿")).toBeInTheDocument();
    expect(screen.getByTestId("assoc-section-资料")).toBeInTheDocument();
    expect(screen.getByTestId("assoc-section-发布版本")).toBeInTheDocument();
    expect(apiMocks.assocTargets).toHaveBeenCalledWith("p1");
    // 等目标 id 反查就绪（条目从禁用变可点）
    await waitFor(() => expect(screen.getByText("另一篇")).not.toBeDisabled());

    // 点文稿条目 → select
    apiMocks.readPost.mockResolvedValue({ id: "p2", title: "另一篇", folder: null, status: "draft", tags: [], body: "", path: "posts/p2.md" });
    fireEvent.click(screen.getByText("另一篇"));
    await waitFor(() => expect(useApp.getState().selectedId).toBe("p2"));
    // 回到 p1 后点版本条目 → selectVersion(base, target)
    useApp.setState({ view: { kind: "post" }, selectedId: "p1", selected: { id: "p1", title: "第一篇", folder: null, status: "draft", tags: [], body: "正文", path: "posts/p1.md", assoc: ASSOC } });
    apiMocks.readPublishVersion.mockResolvedValue({ id: "v", base: "p1", target: "wechat", title: "wechat 版", body: "", publishedUrl: null, publishedAt: null, path: ".versions/p1/publish/wechat.md" });
    fireEvent.click(await screen.findByText("wechat 版"));
    await waitFor(() =>
      expect(useApp.getState().view).toEqual({ kind: "version", baseId: "p1", target: "wechat" }),
    );
  });

  test("× 解除关联 → updateAssoc(currentId, entryId, false) → 刷新", async () => {
    apiMocks.assocTargets.mockResolvedValue([
      { title: "另一篇", target: "../posts/p2.md", id: "p2" },
    ]);
    await mountPost();
    fireEvent.click(await screen.findByTestId("assoc-remove"));
    await waitFor(() => expect(apiMocks.updateAssoc).toHaveBeenCalledWith("p1", "p2", false));
    // 刷新链路：load + reloadPost + assocTargets 重查
    await waitFor(() => expect(apiMocks.readPost).toHaveBeenCalled());
    await waitFor(() => expect(apiMocks.assocTargets.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  test("多选关联器：列出候选 → 勾选 → updateAssoc(currentId, id, true)", async () => {
    apiMocks.assocTargets.mockResolvedValue([]);
    await mountPost({ posts: [], materials: [], versions: [] });
    fireEvent.click(screen.getByTestId("assoc-add-posts"));
    expect(screen.getByTestId("assoc-picker")).toBeInTheDocument();
    // 不含自己
    expect(screen.queryByText("第一篇")).not.toBeInTheDocument();
    const checks = screen.getAllByTestId("assoc-picker-check");
    fireEvent.click(checks[0]);
    fireEvent.click(screen.getByTestId("assoc-picker-confirm"));
    await waitFor(() => expect(apiMocks.updateAssoc).toHaveBeenCalledWith("p1", "p2", true));
  });

  test("资料模式：从 material.assoc 渲染，条目跳转走 selectMaterial", async () => {
    apiMocks.assocTargets.mockResolvedValue([
      { title: "第一篇", target: "../../posts/p1.md", id: "p1" },
    ]);
    apiMocks.listPosts.mockResolvedValue({ tree: [], posts: [] });
    useApp.setState({
      view: { kind: "material", id: "m1" },
      selectedId: null,
      selected: null,
      material: {
        id: "m1", title: "设计笔记", body: "", path: "kb/Inbox/m1.md", folder: "Inbox",
        assoc: { posts: [{ title: "第一篇", target: "../../posts/p1.md" }], materials: [], versions: [] },
      },
      version: null,
      posts: [],
      materials: [{ id: "m1", title: "设计笔记", path: "kb/Inbox/m1.md", folder: "Inbox", updatedAt: "t" }],
      loading: false,
      flushFn: null,
      assocPicker: null,
    });
    render(<AssocPanel />);
    await waitFor(() => expect(apiMocks.assocTargets).toHaveBeenCalledWith("m1"));
    // 资料侧不显示发布版本区
    expect(screen.queryByTestId("assoc-section-发布版本")).not.toBeInTheDocument();
    apiMocks.readPost.mockResolvedValue({ id: "p1", title: "第一篇", folder: null, status: "draft", tags: [], body: "", path: "posts/p1.md" });
    fireEvent.click(screen.getByText("第一篇"));
    await waitFor(() => expect(useApp.getState().view).toEqual({ kind: "post" }));
  });

  test("版本模式不渲染；无关联时只显示添加按钮", async () => {
    useApp.setState({
      view: { kind: "version", baseId: "p1", target: "wechat" },
      selectedId: null,
      selected: null,
      material: null,
      loading: false,
    });
    const { unmount } = render(<AssocPanel />);
    expect(screen.queryByTestId("assoc-panel")).not.toBeInTheDocument();
    unmount();

    await mountPost(null);
    expect(screen.getByTestId("assoc-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("assoc-section-文稿")).not.toBeInTheDocument();
    expect(screen.getByTestId("assoc-add-posts")).toBeInTheDocument();
    expect(screen.getByTestId("assoc-add-materials")).toBeInTheDocument();
  });
});
