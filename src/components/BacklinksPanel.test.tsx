import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { BacklinksPanel } from "./BacklinksPanel";
import { useApp, EditorView } from "../stores/app";

const apiMocks = vi.hoisted(() => ({
  backlinks: vi.fn(),
  readPost: vi.fn(),
  readMaterial: vi.fn(),
}));

vi.mock("../lib/api", () => ({ api: apiMocks }));

const POSTS = [
  { id: "p1", title: "当前文稿", folder: null, status: "draft", tags: [], path: "posts/p1.md", updatedAt: "t" },
  { id: "p2", title: "引用者文稿", folder: null, status: "draft", tags: [], path: "posts/p2.md", updatedAt: "t" },
];
const MATERIALS = [
  { id: "m1", title: "引用资料", path: "kb/Inbox/m1.md", folder: "Inbox", updatedAt: "t" },
];

async function mount(view: EditorView = { kind: "post" }, selectedId: string | null = "p1") {
  useApp.setState({ view, selectedId, posts: POSTS, materials: MATERIALS, material: null, selected: null, loading: false });
  render(<BacklinksPanel />);
}

describe("BacklinksPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("列出反链并标注来源（正文链接 / 关联块）", async () => {
    apiMocks.backlinks.mockResolvedValue([
      { fromId: "p2", fromTitle: "引用者文稿", kind: "wiki" },
      { fromId: "m1", fromTitle: "引用资料", kind: "assoc" },
    ]);
    await mount();
    expect(apiMocks.backlinks).toHaveBeenCalledWith("p1");
    expect(await screen.findByTestId("backlinks-list")).toBeInTheDocument();
    const kinds = screen.getAllByTestId("backlink-kind").map((el) => el.textContent);
    expect(kinds).toContain("来源：正文链接");
    expect(kinds).toContain("来源：关联块");
  });

  test("点击反链跳转：文稿走 select，资料走 selectMaterial", async () => {
    apiMocks.backlinks.mockResolvedValue([
      { fromId: "p2", fromTitle: "引用者文稿", kind: "wiki" },
      { fromId: "m1", fromTitle: "引用资料", kind: "assoc" },
    ]);
    apiMocks.readPost.mockResolvedValue({ id: "p2", title: "引用者文稿", folder: null, status: "draft", tags: [], body: "", path: "posts/p2.md" });
    await mount();
    fireEvent.click(await screen.findByText("引用者文稿"));
    await waitFor(() => expect(useApp.getState().view).toEqual({ kind: "post" }));
    await waitFor(() => expect(useApp.getState().selectedId).toBe("p2"));

    apiMocks.readMaterial.mockResolvedValue({ id: "m1", title: "引用资料", body: "", path: "kb/Inbox/m1.md", folder: "Inbox", assoc: null });
    fireEvent.click(screen.getByText("引用资料"));
    await waitFor(() => expect(useApp.getState().view).toEqual({ kind: "material", id: "m1" }));
  });

  test("空状态文案；资料模式按 view.id 查询", async () => {
    apiMocks.backlinks.mockResolvedValue([]);
    await mount();
    expect(await screen.findByTestId("backlinks-empty")).toBeInTheDocument();

    apiMocks.backlinks.mockResolvedValue([]);
    useApp.getState().setRightTab("backlinks");
    useApp.setState({ view: { kind: "material", id: "m1" }, selectedId: null });
    await waitFor(() => expect(apiMocks.backlinks).toHaveBeenCalledWith("m1"));
  });
});
