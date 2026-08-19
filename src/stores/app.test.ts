import { useApp } from "./app";

const apiMocks = vi.hoisted(() => ({
  listPosts: vi.fn(),
  listTrash: vi.fn(),
  readPost: vi.fn(),
  readPublishVersion: vi.fn(),
  listAllVersions: vi.fn().mockResolvedValue([]),
  workspaceRoot: vi.fn().mockResolvedValue(""),
  listMaterials: vi.fn(),
  listMaterialTrash: vi.fn(),
  readMaterial: vi.fn(),
  createMaterial: vi.fn(),
}));

vi.mock("../lib/api", () => ({ api: apiMocks }));

describe("app store（发布版本视图态）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.listPosts.mockResolvedValue({ tree: [], posts: [] });
    apiMocks.listTrash.mockResolvedValue([]);
    apiMocks.listAllVersions.mockResolvedValue([]);
    apiMocks.listMaterials.mockResolvedValue([]);
    apiMocks.listMaterialTrash.mockResolvedValue([]);
    useApp.setState({
      loading: false,
      view: { kind: "post" },
      selectedId: "p1",
      selected: { id: "p1", title: "T", folder: null, status: "draft", tags: [], body: "b", path: "posts/p1.md" },
      version: null,
      material: null,
      materials: [],
      materialTrash: [],
      flushFn: null,
      saveState: "saved",
    });
  });

  test("selectVersion 先 flush 再加载版本内容，selected 置空", async () => {
    const flush = vi.fn().mockResolvedValue(undefined);
    useApp.setState({ flushFn: flush });
    apiMocks.readPublishVersion.mockResolvedValue({
      id: "v1", base: "p1", target: "wechat", title: "T", body: "版本正文", publishedUrl: null, publishedAt: null, path: ".versions/p1/publish/wechat.md",
    });
    await useApp.getState().selectVersion("p1", "wechat");
    expect(flush).toHaveBeenCalled();
    expect(apiMocks.readPublishVersion).toHaveBeenCalledWith("p1", "wechat");
    const s = useApp.getState();
    expect(s.view).toEqual({ kind: "version", baseId: "p1", target: "wechat" });
    expect(s.version?.body).toBe("版本正文");
    expect(s.selected).toBeNull();
  });

  test("backToPost 回到母版文稿", async () => {
    apiMocks.readPost.mockResolvedValue({ id: "p1", title: "T", folder: null, status: "draft", tags: [], body: "母版", path: "posts/p1.md" });
    useApp.setState({ view: { kind: "version", baseId: "p1", target: "wechat" } });
    await useApp.getState().backToPost();
    const s = useApp.getState();
    expect(s.view).toEqual({ kind: "post" });
    expect(s.selectedId).toBe("p1");
    expect(s.version).toBeNull();
  });

  // ───── 知识库视图态（M3） ─────

  test("load 拉取文稿 + 资料 + 双回收站", async () => {
    apiMocks.listMaterials.mockResolvedValue([
      { id: "m1", title: "笔记", path: "kb/Inbox/m1.md", folder: "Inbox", updatedAt: "t" },
    ]);
    apiMocks.listMaterialTrash.mockResolvedValue([{ id: "m2", title: "旧资料", folder: null, deletedAt: "t", daysLeft: 3 }]);
    await useApp.getState().load();
    const s = useApp.getState();
    expect(apiMocks.listMaterials).toHaveBeenCalled();
    expect(apiMocks.listMaterialTrash).toHaveBeenCalled();
    expect(s.materials).toHaveLength(1);
    expect(s.materialTrash).toHaveLength(1);
    expect(s.loading).toBe(false);
  });

  test("selectMaterial 先 flush 再读取，进入 material 视图（文稿态清空）", async () => {
    const flush = vi.fn().mockResolvedValue(undefined);
    useApp.setState({ flushFn: flush });
    apiMocks.readMaterial.mockResolvedValue({
      id: "m1", title: "笔记", body: "资料正文", path: "kb/Inbox/m1.md", folder: "Inbox", assoc: null,
    });
    await useApp.getState().selectMaterial("m1");
    expect(flush).toHaveBeenCalled();
    expect(apiMocks.readMaterial).toHaveBeenCalledWith("m1");
    const s = useApp.getState();
    expect(s.view).toEqual({ kind: "material", id: "m1" });
    expect(s.material?.body).toBe("资料正文");
    expect(s.selected).toBeNull();
    expect(s.selectedId).toBeNull();
    // 重复点同一资料不重复加载
    await useApp.getState().selectMaterial("m1");
    expect(apiMocks.readMaterial).toHaveBeenCalledTimes(1);
  });

  test("reloadMaterial 只在 material 视图生效", async () => {
    apiMocks.readMaterial.mockResolvedValue({
      id: "m1", title: "笔记", body: "新内容", path: "kb/Inbox/m1.md", folder: "Inbox", assoc: null,
    });
    useApp.setState({ view: { kind: "material", id: "m1" }, selected: null, material: null });
    await useApp.getState().reloadMaterial();
    expect(useApp.getState().material?.body).toBe("新内容");
    // 文稿视图下是空操作
    useApp.setState({ view: { kind: "post" }, selectedId: "p1" });
    apiMocks.readMaterial.mockClear();
    await useApp.getState().reloadMaterial();
    expect(apiMocks.readMaterial).not.toHaveBeenCalled();
  });
});
