import { useApp } from "./app";

const apiMocks = vi.hoisted(() => ({
  listPosts: vi.fn(),
  listTrash: vi.fn(),
  readPost: vi.fn(),
  readPublishVersion: vi.fn(),
}));

vi.mock("../lib/api", () => ({ api: apiMocks }));

describe("app store（发布版本视图态）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.listPosts.mockResolvedValue({ tree: [], posts: [] });
    apiMocks.listTrash.mockResolvedValue([]);
    useApp.setState({
      loading: false,
      view: { kind: "post" },
      selectedId: "p1",
      selected: { id: "p1", title: "T", folder: null, status: "draft", tags: [], body: "b", path: "posts/p1.md" },
      version: null,
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
});
