import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
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
const listKbDirsMock = vi.fn();

// M4：AI 流事件 mock（useAIStream 依赖）
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => undefined),
}));

const aiMocks = vi.hoisted(() => ({
  aiListProviders: vi.fn().mockResolvedValue({ providers: [], routes: {}, fallbacks: {}, budget: { dailyCents: 0, monthlyCents: 0, paused: false } }),
  aiHasKey: vi.fn().mockResolvedValue(false),
  aiUsage: vi.fn().mockResolvedValue([]),
  aiCancel: vi.fn().mockResolvedValue(undefined),
  aiAdoptResult: vi.fn().mockResolvedValue(undefined),
  aiDiscardResult: vi.fn().mockResolvedValue(undefined),
  aiSearchMaterials: vi.fn().mockResolvedValue([]),
  aiRunOp: vi.fn().mockResolvedValue(undefined),
}));

const exportMdMock = vi.fn();
const searchAllMock = vi.fn().mockResolvedValue([]);

// M5：目录导出走系统目录选择对话框；全局搜索覆盖层
const dialogMocks = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...a: unknown[]) => dialogMocks.open(...a),
}));

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
    listKbDirs: (...a: unknown[]) => listKbDirsMock(...a),
    exportMd: (...a: unknown[]) => exportMdMock(...a),
    searchAll: (...a: unknown[]) => searchAllMock(...a),
    ...aiMocks,
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
    listKbDirsMock.mockResolvedValue([]);
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
      rightTab: "outline",
      settingsOpen: false,
      aiContext: { entries: [], includeAttachmentText: false },
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

  // ───── M4：AI 页签 / 设置 / 快捷搜索 ─────

  test("右栏页签含 资料检索 与 AI；点击切换面板", async () => {
    render(<AppShell />);
    expect(await screen.findByTestId("tab-material-search")).toBeInTheDocument();
    expect(screen.getByTestId("tab-ai")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("tab-material-search"));
    await waitFor(() => expect(useApp.getState().rightTab).toBe("material-search"));
    expect(screen.getByTestId("material-search")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("tab-ai"));
    await waitFor(() => expect(useApp.getState().rightTab).toBe("ai"));
    expect(await screen.findByTestId("ai-workbench")).toBeInTheDocument();
  });

  test("左栏 ⚙ 设置 打开 AI 设置弹窗（拉取配置）", async () => {
    render(<AppShell />);
    await screen.findByTestId("settings-entry");
    fireEvent.click(screen.getByTestId("settings-entry"));
    await waitFor(() => expect(useApp.getState().settingsOpen).toBe(true));
    expect(await screen.findByTestId("settings-modal")).toBeInTheDocument();
    expect(aiMocks.aiListProviders).toHaveBeenCalled();
  });

  test("Ctrl+K → 切到资料检索页签并聚焦输入框", async () => {
    render(<AppShell />);
    await screen.findByTestId("tab-outline");
    await act(async () => {
      fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    });
    await waitFor(() => expect(useApp.getState().rightTab).toBe("material-search"));
    expect(screen.getByTestId("material-search-input")).toHaveFocus();
  });

  // ───── M5：全局搜索入口 / Markdown 导出 ─────

  test("左栏「🔍 全局搜索」入口打开覆盖层", async () => {
    render(<AppShell />);
    fireEvent.click(await screen.findByTestId("search-entry"));
    await waitFor(() => expect(useApp.getState().searchOpen).toBe(true));
    expect(screen.getByTestId("global-search")).toBeInTheDocument();
  });

  test("底部工具坞「📤 导出」菜单：选目录 → exportMd(scope, dir)，提示导出结果", async () => {
    dialogMocks.open.mockResolvedValue("C:/out/md");
    exportMdMock.mockResolvedValue({ files: 3, assets: 2 });
    render(<AppShell />);
    // 导出两项收进上拉菜单（视觉方案 §3.1）：先开菜单再点导出
    fireEvent.click(await screen.findByTestId("export-entry"));
    fireEvent.click(screen.getByTestId("export-posts"));
    await waitFor(() =>
      expect(exportMdMock).toHaveBeenCalledWith("posts", "C:/out/md"),
    );
    await waitFor(() =>
      expect(screen.getByTestId("export-note").textContent).toContain("已导出 3 个文件、2 个附件"),
    );
    fireEvent.click(screen.getByTestId("export-kb"));
    await waitFor(() => expect(exportMdMock).toHaveBeenCalledWith("kb", "C:/out/md"));
  });

  test("导出对话框取消 → 不调 exportMd", async () => {
    dialogMocks.open.mockResolvedValue(null);
    render(<AppShell />);
    fireEvent.click(await screen.findByTestId("export-entry"));
    fireEvent.click(screen.getByTestId("export-posts"));
    await waitFor(() => expect(dialogMocks.open).toHaveBeenCalled());
    expect(exportMdMock).not.toHaveBeenCalled();
  });
});
