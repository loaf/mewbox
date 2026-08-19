import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EditorPane } from "./EditorPane";

const apiMocks = vi.hoisted(() => ({
  savePost: vi.fn(),
  setPostTitle: vi.fn(),
  setPostStatus: vi.fn(),
  savePastedImage: vi.fn(),
  savePastedImageAt: vi.fn(),
  savePublishVersion: vi.fn(),
  readPublishVersion: vi.fn(),
  listPosts: vi.fn(),
  listTrash: vi.fn().mockResolvedValue([]),
  readPost: vi.fn(),
}));

vi.mock("../lib/api", () => ({ api: apiMocks }));

import { useApp } from "../stores/app";
import type { PostContent } from "../lib/api";

const post = (over: Partial<PostContent> = {}): PostContent =>
  ({
    id: "p1",
    title: "第一篇",
    folder: null,
    status: "draft",
    tags: [],
    body: "# 标题\n\n正文",
    path: "posts/p1.md",
    ...over,
  }) as PostContent;

async function mount(p: PostContent) {
  apiMocks.listPosts.mockResolvedValue({ tree: [], posts: [] });
  useApp.setState({
    selected: p,
    selectedId: p.id,
    saveState: "saved",
    savedAt: null,
    flushFn: null,
    viewMode: "edit",
    loading: false,
  });
  render(<EditorPane />);
}

describe("EditorPane", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.savePost.mockResolvedValue({ updatedAt: "2026-08-18T12:30:00", snapshotted: true });
  });

  test("三模式切换：源码 textarea / 分栏 / 预览渲染 html", async () => {
    await mount(post());
    // 源码模式：textarea 可见
    expect(screen.getByTestId("md-textarea")).toBeInTheDocument();
    // 预览模式：渲染出 markdown html
    fireEvent.click(screen.getByTestId("mode-preview"));
    await waitFor(() => {
      expect(document.querySelector(".wmde-markdown h1")).toBeTruthy();
    });
    // 分栏
    fireEvent.click(screen.getByTestId("mode-live"));
    expect(screen.getByTestId("md-textarea")).toBeInTheDocument();
    expect(document.querySelector(".wmde-markdown h1")).toBeTruthy();
  });

  test("分栏模式下 ~下标~ 仍渲染为 <sub>（pluginsFilter 生效，@uiw 追加的裸 gfm 被剔除）", async () => {
    await mount(post({ body: "H~2~O" }));
    fireEvent.click(screen.getByTestId("mode-live"));
    await waitFor(() => {
      expect(document.querySelector(".wmde-markdown sub")?.textContent).toBe("2");
    });
  });

  test("自动保存：假时钟下连续输入 1s 只触发一次 savePost，内容=最新值", async () => {
    vi.useFakeTimers();
    await mount(post());
    const ta = screen.getByTestId("md-textarea") as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(ta, { target: { value: "第一段" } });
    });
    await act(async () => {
      fireEvent.change(ta, { target: { value: "第一段+第二段" } });
    });
    expect(apiMocks.savePost).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(900);
    });
    expect(apiMocks.savePost).toHaveBeenCalledTimes(1);
    expect(apiMocks.savePost).toHaveBeenCalledWith("p1", "第一段+第二段");
    vi.useRealTimers();
  });

  test("切换文稿前 flush 强制保存（registerFlush 注册的钩子）", async () => {
    await mount(post());
    const ta = screen.getByTestId("md-textarea") as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "未保存的内容" } });
    const flush = useApp.getState().flushFn;
    expect(flush).toBeTypeOf("function");
    await flush!();
    expect(apiMocks.savePost).toHaveBeenCalledWith("p1", "未保存的内容");
  });

  test("粘贴图片 → savePastedImage 返回相对路径插入光标处", async () => {
    apiMocks.savePastedImage.mockResolvedValue("../_assets/abc123.png");
    await mount(post({ body: "开头" }));
    const ta = screen.getByTestId("md-textarea") as HTMLTextAreaElement;
    const file = new File([new Uint8Array([1, 2, 3])], "x.png", { type: "image/png" });
    await act(async () => {
      fireEvent.paste(ta, {
        clipboardData: {
          items: [{ type: "image/png", getAsFile: () => file }],
        },
      });
    });
    await waitFor(() => expect(apiMocks.savePastedImage).toHaveBeenCalled());
    expect((screen.getByTestId("md-textarea") as HTMLTextAreaElement).value).toContain(
      "![](../_assets/abc123.png)",
    );
  });

  test("保存指示器：dirty → 保存中… → 已保存", async () => {
    let resolveSave: (v: { updatedAt: string; snapshotted: boolean }) => void = () => {};
    apiMocks.savePost.mockReturnValue(
      new Promise((res) => {
        resolveSave = res;
      }),
    );
    await mount(post());
    expect(screen.getByTestId("save-indicator").textContent).toBe("已保存");
    fireEvent.change(screen.getByTestId("md-textarea"), { target: { value: "新内容" } });
    expect(screen.getByTestId("save-indicator").textContent).toContain("未保存");
    await waitFor(() => expect(apiMocks.savePost).toHaveBeenCalled());
    expect(screen.getByTestId("save-indicator").textContent).toContain("保存中");
    await act(async () => {
      resolveSave({ updatedAt: "2026-08-18T12:30:00", snapshotted: true });
    });
    await waitFor(() =>
      expect(screen.getByTestId("save-indicator").textContent).toContain("已保存"),
    );
  });

  test("标题编辑经 setPostTitle 落盘；状态切换经 setPostStatus", async () => {
    apiMocks.setPostTitle.mockResolvedValue({});
    apiMocks.setPostStatus.mockResolvedValue({});
    apiMocks.readPost.mockResolvedValue(post({ title: "新标题" }));
    await mount(post());
    const title = screen.getByTestId("editor-title") as HTMLInputElement;
    await userEvent.clear(title);
    await userEvent.type(title, "新标题");
    fireEvent.blur(title);
    await waitFor(() => expect(apiMocks.setPostTitle).toHaveBeenCalledWith("p1", "新标题"));
    fireEvent.change(screen.getByTestId("editor-status"), { target: { value: "done" } });
    await waitFor(() => expect(apiMocks.setPostStatus).toHaveBeenCalledWith("p1", "done"));
  });

  // ───── 发布版本模式（M2） ─────

  const versionContent = {
    id: "vid-1",
    base: "p1",
    target: "wechat",
    title: "公众号版",
    body: "版本初始内容",
    publishedUrl: null as string | null,
    publishedAt: null as string | null,
    path: ".versions/p1/publish/wechat.md",
  };

  async function mountVersion() {
    apiMocks.listPosts.mockResolvedValue({ tree: [], posts: [] });
    useApp.setState({
      view: { kind: "version", baseId: "p1", target: "wechat" },
      selectedId: null,
      selected: null,
      version: { ...versionContent },
      posts: [{ id: "p1", title: "母版标题", folder: null, status: "draft", tags: [], path: "posts/a.md", updatedAt: "t" }],
      saveState: "saved",
      savedAt: null,
      flushFn: null,
      viewMode: "edit",
      loading: false,
    });
    render(<EditorPane />);
  }

  test("版本态：归属横幅 + 回到母版 + 保存走 savePublishVersion", async () => {
    apiMocks.savePublishVersion.mockResolvedValue({ updatedAt: "2026-08-19T12:00:00", snapshotted: true });
    apiMocks.readPost.mockResolvedValue(post());
    await mountVersion();
    const banner = screen.getByTestId("version-banner");
    expect(banner.textContent).toContain("wechat 版");
    expect(banner.textContent).toContain("母版标题");
    // 编辑保存走版本命令
    fireEvent.change(screen.getByTestId("md-textarea"), { target: { value: "改公众号版" } });
    await waitFor(() =>
      expect(apiMocks.savePublishVersion).toHaveBeenCalledWith("p1", "wechat", "改公众号版"),
    );
    expect(apiMocks.savePost).not.toHaveBeenCalled();
    // 回到母版
    fireEvent.click(screen.getByTestId("back-to-post"));
    await waitFor(() =>
      expect(useApp.getState().view).toEqual({ kind: "post" }),
    );
  });

  test("版本态贴图走 savePastedImageAt（版本文件路径）", async () => {
    apiMocks.savePastedImageAt.mockResolvedValue("../../../_assets/abc.png");
    await mountVersion();
    const ta = screen.getByTestId("md-textarea") as HTMLTextAreaElement;
    const file = new File([new Uint8Array([1])], "x.png", { type: "image/png" });
    await act(async () => {
      fireEvent.paste(ta, {
        clipboardData: { items: [{ type: "image/png", getAsFile: () => file }] },
      });
    });
    await waitFor(() =>
      expect(apiMocks.savePastedImageAt).toHaveBeenCalledWith(
        ".versions/p1/publish/wechat.md",
        expect.any(Uint8Array),
        "png",
      ),
    );
  });
});
