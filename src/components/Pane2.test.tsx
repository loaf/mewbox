import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppShell } from "./AppShell";

// 分栏第二步：次栏为完整编辑器（可编辑/保存/flush/防呆/交换/insert 路由/右栏跟随）

const listPostsMock = vi.fn();
const listTrashMock = vi.fn();
const readPostMock = vi.fn();
const savePostMock = vi.fn();
const listAllVersionsMock = vi.fn();
const workspaceRootMock = vi.fn();
const listMaterialsMock = vi.fn();
const listMaterialTrashMock = vi.fn();
const assocTargetsMock = vi.fn();
const listKbDirsMock = vi.fn();
const searchAllMock = vi.fn().mockResolvedValue([]);
const exportMdMock = vi.fn();

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => undefined),
}));
const dialogMocks = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...a: unknown[]) => dialogMocks.open(...a),
}));
const aiMocks = vi.hoisted(() => ({
  aiListProviders: vi.fn().mockResolvedValue({ providers: [], routes: {}, fallbacks: {}, budget: { dailyCents: 0, monthlyCents: 0, paused: false } }),
  aiHasKey: vi.fn().mockResolvedValue(false),
  aiUsage: vi.fn().mockResolvedValue([]),
  aiCancel: vi.fn().mockResolvedValue(undefined),
  aiRunOp: vi.fn().mockResolvedValue(undefined),
  aiAdoptResult: vi.fn().mockResolvedValue(undefined),
  aiDiscardResult: vi.fn().mockResolvedValue(undefined),
  aiSearchMaterials: vi.fn().mockResolvedValue([]),
}));

vi.mock("../lib/api", () => ({
  api: {
    listPosts: (...a: unknown[]) => listPostsMock(...a),
    listTrash: (...a: unknown[]) => listTrashMock(...a),
    readPost: (...a: unknown[]) => readPostMock(...a),
    savePost: (...a: unknown[]) => savePostMock(...a),
    listAllVersions: (...a: unknown[]) => listAllVersionsMock(...a),
    workspaceRoot: (...a: unknown[]) => workspaceRootMock(...a),
    listMaterials: (...a: unknown[]) => listMaterialsMock(...a),
    listMaterialTrash: (...a: unknown[]) => listMaterialTrashMock(...a),
    assocTargets: (...a: unknown[]) => assocTargetsMock(...a),
    listKbDirs: (...a: unknown[]) => listKbDirsMock(...a),
    searchAll: (...a: unknown[]) => searchAllMock(...a),
    exportMd: (...a: unknown[]) => exportMdMock(...a),
    ...aiMocks,
  },
}));

import { useApp } from "../stores/app";

const post = (id: string, title: string, body: string) => ({
  id,
  title,
  folder: null,
  status: "draft",
  tags: [] as string[],
  body,
  path: `posts/${id}.md`,
});

const summaries = [
  { id: "p1", title: "主篇", folder: null, status: "draft", tags: [], path: "posts/p1.md", updatedAt: "t" },
  { id: "p2", title: "次篇", folder: null, status: "draft", tags: [], path: "posts/p2.md", updatedAt: "t" },
];

describe("分栏第二步：次栏完整编辑器", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listPostsMock.mockResolvedValue({ tree: [], posts: summaries });
    listTrashMock.mockResolvedValue([]);
    listAllVersionsMock.mockResolvedValue([]);
    workspaceRootMock.mockResolvedValue("X:/ws");
    listMaterialsMock.mockResolvedValue([]);
    listMaterialTrashMock.mockResolvedValue([]);
    listKbDirsMock.mockResolvedValue([]);
    assocTargetsMock.mockResolvedValue([]);
    readPostMock.mockImplementation(async (id: string) =>
      id === "p1" ? post("p1", "主篇", "主篇正文") : post("p2", "次篇", "次篇正文"),
    );
    savePostMock.mockResolvedValue({ updatedAt: "2026-10-14T12:00:00" });
    useApp.setState({
      loading: false,
      tree: [],
      posts: summaries,
      trash: [],
      materials: [],
      materialTrash: [],
      view: { kind: "post" },
      selectedId: null,
      selected: null,
      version: null,
      material: null,
      flushFn: null,
      saveState: "saved",
      view2: { kind: "post" },
      selectedId2: null,
      selected2: null,
      version2: null,
      material2: null,
      saveState2: "saved",
      savedAt2: null,
      viewMode2: "edit",
      flushFn2: null,
      pane2Open: false,
      pane2LastId: null,
      activePane: "primary",
      assocPicker: null,
      trashOpen: false,
      rightTab: "outline",
      settingsOpen: false,
      searchOpen: false,
      aiContext: { entries: [], includeAttachmentText: false },
    });
  });

  test("openPane2 渲染第二个编辑器；主栏内容不变", async () => {
    render(<AppShell />);
    await useApp.getState().select("p1");
    await screen.findByTestId("md-textarea");
    expect(screen.queryByTestId("md-textarea-2")).not.toBeInTheDocument();

    await useApp.getState().openPane2("p2");
    await screen.findByTestId("md-textarea-2");
    expect((screen.getByTestId("md-textarea") as HTMLTextAreaElement).value).toContain("主篇正文");
    expect((screen.getByTestId("md-textarea-2") as HTMLTextAreaElement).value).toContain("次篇正文");
    expect(useApp.getState().activePane).toBe("secondary");
  });

  test("次栏可编辑并自动保存（savePost 打到次栏的 id）", async () => {
    render(<AppShell />);
    await useApp.getState().select("p1");
    await useApp.getState().openPane2("p2");
    const ta2 = (await screen.findByTestId("md-textarea-2")) as HTMLTextAreaElement;
    fireEvent.change(ta2, { target: { value: "次篇新内容" } });
    expect(useApp.getState().saveState2).toBe("dirty");
    await waitFor(
      () => expect(savePostMock).toHaveBeenCalledWith("p2", "次篇新内容"),
      { timeout: 3000 },
    );
    await waitFor(() => expect(useApp.getState().saveState2).toBe("saved"));
  });

  test("同文档防呆：openPane2 与主栏同篇 → 聚焦主栏、不双开", async () => {
    render(<AppShell />);
    await useApp.getState().select("p1");
    await useApp.getState().openPane2("p1");
    expect(useApp.getState().pane2Open).toBe(false);
    expect(useApp.getState().activePane).toBe("primary");
    expect(screen.queryByTestId("md-textarea-2")).not.toBeInTheDocument();
  });

  test("关闭次栏前 flush：dirty 状态下 closePane2 先落盘", async () => {
    render(<AppShell />);
    await useApp.getState().select("p1");
    await useApp.getState().openPane2("p2");
    const ta2 = (await screen.findByTestId("md-textarea-2")) as HTMLTextAreaElement;
    fireEvent.change(ta2, { target: { value: "待存内容" } });
    await useApp.getState().closePane2();
    expect(useApp.getState().pane2Open).toBe(false);
    await waitFor(() => expect(savePostMock).toHaveBeenCalledWith("p2", "待存内容"));
    expect(useApp.getState().pane2LastId).toBe("p2");
  });

  test("swapPane2 交换两栏目标（各栏内容随切片切换）", async () => {
    render(<AppShell />);
    await useApp.getState().select("p1");
    await useApp.getState().openPane2("p2");
    await screen.findByTestId("md-textarea-2");
    await useApp.getState().swapPane2();
    expect(useApp.getState().selectedId).toBe("p2");
    expect(useApp.getState().selectedId2).toBe("p1");
    await waitFor(() =>
      expect((screen.getByTestId("md-textarea") as HTMLTextAreaElement).value).toContain("次篇正文"),
    );
    expect((screen.getByTestId("md-textarea-2") as HTMLTextAreaElement).value).toContain("主篇正文");
  });

  test("mewbox:insert 按活动栏路由：secondary 活动时插入次栏光标处", async () => {
    render(<AppShell />);
    await useApp.getState().select("p1");
    await useApp.getState().openPane2("p2");
    await screen.findByTestId("md-textarea-2");
    act(() => {
      window.dispatchEvent(new CustomEvent("mewbox:insert", { detail: { text: "插入文本" } }));
    });
    await waitFor(() =>
      expect((screen.getByTestId("md-textarea-2") as HTMLTextAreaElement).value).toContain("插入文本"),
    );
    expect((screen.getByTestId("md-textarea") as HTMLTextAreaElement).value).not.toContain("插入文本");
  });

  test("右栏大纲跟随活动栏（切到 secondary 显示次栏标题结构）", async () => {
    readPostMock.mockImplementation(async (id: string) =>
      id === "p1" ? post("p1", "主篇", "主篇正文") : post("p2", "次篇", "## 次栏小节"),
    );
    render(<AppShell />);
    await useApp.getState().select("p1");
    await useApp.getState().openPane2("p2");
    await screen.findByTestId("md-textarea-2");
    await screen.findByText("次栏小节", { selector: '[data-testid="outline-list"] button' });
    // 切回主栏：大纲不再显示次栏标题
    await userEvent.click(screen.getByTestId("editor-title"));
    await waitFor(() =>
      expect(screen.queryByText("次栏小节", { selector: '[data-testid="outline-list"] button' })).not.toBeInTheDocument(),
    );
  });

  test("次栏 × 按钮关闭分栏（先 flush）", async () => {
    render(<AppShell />);
    await useApp.getState().select("p1");
    await useApp.getState().openPane2("p2");
    const ta2 = (await screen.findByTestId("md-textarea-2")) as HTMLTextAreaElement;
    fireEvent.change(ta2, { target: { value: "点×前的内容" } });
    fireEvent.click(screen.getByTestId("pane2-close"));
    await waitFor(() => expect(useApp.getState().pane2Open).toBe(false));
    await waitFor(() => expect(savePostMock).toHaveBeenCalledWith("p2", "点×前的内容"));
    expect(screen.queryByTestId("md-textarea-2")).not.toBeInTheDocument();
  });
});
