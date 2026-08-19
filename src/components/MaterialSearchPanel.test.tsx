import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MaterialSearchPanel } from "./MaterialSearchPanel";
import { useApp } from "../stores/app";

const apiMocks = vi.hoisted(() => ({
  aiSearchMaterials: vi.fn().mockResolvedValue([]),
  updateAssoc: vi.fn().mockResolvedValue(undefined),
  readPost: vi.fn(),
  readMaterial: vi.fn(),
}));
vi.mock("../lib/api", () => ({ api: apiMocks }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));

const hits = [
  { id: "m1", path: "kb/Inbox/m1.md", title: "深度工作" },
  { id: "m2", path: "kb/研究/m2.md", title: "深度学习" },
];

describe("MaterialSearchPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useApp.setState({
      view: { kind: "post" },
      selectedId: "p1",
      selected: { id: "p1", title: "文稿", folder: null, status: "draft", tags: [], body: "", path: "posts/p1.md" },
      material: null,
      version: null,
    });
  });

  test("渲染：自动聚焦 + 「仅搜索知识库资料」说明", () => {
    render(<MaterialSearchPanel />);
    expect(screen.getByTestId("material-search-input")).toHaveFocus();
    expect(screen.getByTestId("material-search").textContent).toContain("仅搜索知识库资料");
  });

  test("输入回车 → aiSearchMaterials → 结果渲染（标题 + 路径）", async () => {
    apiMocks.aiSearchMaterials.mockResolvedValue(hits);
    render(<MaterialSearchPanel />);
    fireEvent.change(screen.getByTestId("material-search-input"), { target: { value: "深度" } });
    fireEvent.keyDown(screen.getByTestId("material-search-input"), { key: "Enter" });
    await waitFor(() => expect(apiMocks.aiSearchMaterials).toHaveBeenCalledWith("深度"));
    expect(await screen.findAllByTestId("material-search-hit")).toHaveLength(2);
    expect(screen.getByTestId("material-search-results").textContent).toContain("kb/研究/m2.md");
  });

  test("插入链接 → 派发 mewbox:insert（[[标题]]）", async () => {
    const insertSpy = vi.fn();
    window.addEventListener("mewbox:insert", insertSpy);
    apiMocks.aiSearchMaterials.mockResolvedValue(hits);
    render(<MaterialSearchPanel />);
    fireEvent.change(screen.getByTestId("material-search-input"), { target: { value: "深度" } });
    fireEvent.click(screen.getByTestId("material-search-btn"));
    (await screen.findAllByTestId("material-search-hit"))[0];
    fireEvent.click(screen.getByTestId("hit-insert-m1"));
    expect(insertSpy).toHaveBeenCalledTimes(1);
    expect((insertSpy.mock.calls[0][0] as CustomEvent).detail).toEqual({ text: "[[深度工作]]" });
    window.removeEventListener("mewbox:insert", insertSpy);
  });

  test("添加为关联：文稿打开 → updateAssoc(p1, m1, true) 并刷新内容", async () => {
    apiMocks.readPost.mockResolvedValue({ id: "p1", title: "文稿", folder: null, status: "draft", tags: [], body: "新内容", path: "posts/p1.md" });
    apiMocks.aiSearchMaterials.mockResolvedValue(hits);
    render(<MaterialSearchPanel />);
    fireEvent.change(screen.getByTestId("material-search-input"), { target: { value: "深度" } });
    fireEvent.click(screen.getByTestId("material-search-btn"));
    (await screen.findAllByTestId("material-search-hit"))[0];
    fireEvent.click(screen.getByTestId("hit-assoc-m1"));
    await waitFor(() => expect(apiMocks.updateAssoc).toHaveBeenCalledWith("p1", "m1", true));
    await waitFor(() => expect(apiMocks.readPost).toHaveBeenCalledWith("p1"));
    await waitFor(() => expect(screen.getByTestId("material-search-note").textContent).toContain("已关联"));
  });

  test("无打开对象时添加为关联 → 提示先打开文稿/资料，不调 updateAssoc", async () => {
    useApp.setState({ view: { kind: "post" }, selectedId: null, selected: null });
    apiMocks.aiSearchMaterials.mockResolvedValue(hits);
    render(<MaterialSearchPanel />);
    fireEvent.change(screen.getByTestId("material-search-input"), { target: { value: "深度" } });
    fireEvent.click(screen.getByTestId("material-search-btn"));
    (await screen.findAllByTestId("material-search-hit"))[0];
    fireEvent.click(screen.getByTestId("hit-assoc-m2"));
    await waitFor(() =>
      expect(screen.getByTestId("material-search-note").textContent).toContain("先打开"),
    );
    expect(apiMocks.updateAssoc).not.toHaveBeenCalled();
  });
});
