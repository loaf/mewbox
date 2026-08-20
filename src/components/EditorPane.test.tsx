import { render, screen, fireEvent, waitFor, act, cleanup } from "@testing-library/react";
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
  // M3
  saveMaterial: vi.fn(),
  setMaterialTitle: vi.fn(),
  readMaterial: vi.fn(),
  convertMaterialToPost: vi.fn(),
  assocTargets: vi.fn().mockResolvedValue([]),
  resolveWiki: vi.fn(),
  updateAssoc: vi.fn().mockResolvedValue(undefined),
  listMaterials: vi.fn().mockResolvedValue([]),
  listMaterialTrash: vi.fn().mockResolvedValue([]),
  listAllVersions: vi.fn().mockResolvedValue([]),
  workspaceRoot: vi.fn().mockResolvedValue("X:/ws"),
  // M4（AI）
  aiRunOp: vi.fn().mockResolvedValue(undefined),
  aiCancel: vi.fn().mockResolvedValue(undefined),
  aiAdoptResult: vi.fn().mockResolvedValue(undefined),
  aiDiscardResult: vi.fn().mockResolvedValue(undefined),
  aiApplySuggestions: vi.fn(),
  aiSaveAsMaterial: vi.fn(),
  aiDescribeAttachment: vi.fn().mockResolvedValue(undefined),
  aiListProviders: vi.fn().mockResolvedValue({ providers: [], routes: {}, fallbacks: {}, budget: { dailyCents: 0, monthlyCents: 0, paused: false } }),
  aiTestConnection: vi.fn(),
  aiSaveProvider: vi.fn().mockResolvedValue(undefined),
  aiDeleteProvider: vi.fn().mockResolvedValue(undefined),
  aiSaveAiConfig: vi.fn().mockResolvedValue(undefined),
  aiSetKey: vi.fn().mockResolvedValue(undefined),
  aiHasKey: vi.fn().mockResolvedValue(false),
  aiDeleteKey: vi.fn().mockResolvedValue(undefined),
  aiUsage: vi.fn().mockResolvedValue([]),
  aiClearCalls: vi.fn().mockResolvedValue(undefined),
  aiSearchMaterials: vi.fn().mockResolvedValue([]),
}));

vi.mock("../lib/api", () => ({ api: apiMocks }));

// M4：AI 流事件 mock（捕获 handler 供测试模拟流）
const eventState = vi.hoisted(() => ({
  handlers: new Map<string, (e: { payload: unknown }) => void>(),
  order: [] as string[],
  lastEvent: null as string | null,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: (e: { payload: unknown }) => void) => {
    eventState.handlers.set(event, handler);
    eventState.order.push(event);
    eventState.lastEvent = event;
    return () => eventState.handlers.delete(event);
  }),
}));

import { useApp } from "../stores/app";
import type { PostContent } from "../lib/api";

/** 模拟后端向最近的 ai-stream:{callId} 监听者推送事件 */
function emitAI(payload: unknown) {
  const ev = eventState.lastEvent;
  if (!ev) throw new Error("没有已注册的流监听");
  eventState.handlers.get(ev)!({ payload });
}

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
    view: { kind: "post" },
    selected: p,
    selectedId: p.id,
    material: null,
    version: null,
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
    apiMocks.listMaterials.mockResolvedValue([]);
    apiMocks.listMaterialTrash.mockResolvedValue([]);
    apiMocks.listAllVersions.mockResolvedValue([]);
    apiMocks.assocTargets.mockResolvedValue([]);
    useApp.setState({ assocPicker: null });
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

  test("分栏模式下 ~下标~ 仍渲染为 <sub>（自定义预览共享管线）", async () => {
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

  // ───── wiki 链接（M3，§7.2） ─────

  test("预览 [[wiki]] 渲染为 data-wiki 锚点；唯一命中点击跳转文稿", async () => {
    apiMocks.resolveWiki.mockResolvedValue({
      matched: { id: "p2", kind: "post", title: "深度工作", path: "posts/p2.md" },
      candidates: [],
    });
    apiMocks.readPost.mockResolvedValue(post({ id: "p2", title: "深度工作" }));
    await mount(post({ body: "看 [[深度工作]] 一书" }));
    fireEvent.click(screen.getByTestId("mode-preview"));
    const anchor = await waitFor(() => {
      const a = document.querySelector("a[data-wiki]");
      expect(a).toBeTruthy();
      return a as HTMLAnchorElement;
    });
    fireEvent.click(anchor);
    await waitFor(() => expect(apiMocks.resolveWiki).toHaveBeenCalledWith("深度工作"));
    await waitFor(() => expect(useApp.getState().view).toEqual({ kind: "post" }));
    await waitFor(() => expect(useApp.getState().selectedId).toBe("p2"));
  });

  test("wiki 重名 → 候选弹窗 → 点候选跳资料", async () => {
    apiMocks.resolveWiki.mockResolvedValue({
      matched: null,
      candidates: [
        { id: "m1", kind: "material", title: "深度工作", path: "kb/Inbox/m1.md" },
        { id: "p9", kind: "post", title: "深度工作", path: "posts/p9.md" },
      ],
    });
    apiMocks.readMaterial.mockResolvedValue({
      id: "m1", title: "深度工作", body: "", path: "kb/Inbox/m1.md", folder: "Inbox", assoc: null,
    });
    await mount(post({ body: "[[深度工作]]" }));
    fireEvent.click(screen.getByTestId("mode-preview"));
    const anchor = await waitFor(() => {
      const a = document.querySelector("a[data-wiki]");
      expect(a).toBeTruthy();
      return a as HTMLAnchorElement;
    });
    fireEvent.click(anchor);
    await waitFor(() => expect(screen.getByTestId("wiki-candidates-dialog")).toBeInTheDocument());
    const candidates = screen.getAllByTestId("wiki-candidate");
    expect(candidates).toHaveLength(2);
    fireEvent.click(candidates[0]);
    await waitFor(() => expect(useApp.getState().view).toEqual({ kind: "material", id: "m1" }));
  });

  test("wiki 悬空（无匹配无候选）→ 悬空提示弹窗", async () => {
    apiMocks.resolveWiki.mockResolvedValue({ matched: null, candidates: [] });
    await mount(post({ body: "[[不存在的标题]]" }));
    fireEvent.click(screen.getByTestId("mode-preview"));
    const anchor = await waitFor(() => {
      const a = document.querySelector("a[data-wiki]");
      expect(a).toBeTruthy();
      return a as HTMLAnchorElement;
    });
    fireEvent.click(anchor);
    await waitFor(() => expect(screen.getByTestId("wiki-dangling")).toBeInTheDocument());
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
      material: null,
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

  // ───── 资料模式（M3，§6） ─────

  const materialContent = {
    id: "m1",
    title: "设计笔记",
    body: "资料正文",
    path: "kb/Inbox/m1.md",
    folder: "Inbox",
    assoc: null,
  };

  async function mountMaterial(over: Partial<typeof materialContent> = {}) {
    apiMocks.listPosts.mockResolvedValue({ tree: [], posts: [] });
    useApp.setState({
      view: { kind: "material", id: "m1" },
      selectedId: null,
      selected: null,
      material: { ...materialContent, ...over },
      version: null,
      saveState: "saved",
      savedAt: null,
      flushFn: null,
      viewMode: "edit",
      loading: false,
    });
    render(<EditorPane />);
  }

  test("资料态：横幅「📚 资料 · 目录」+ 升格/关联按钮；无状态与发布入口", async () => {
    await mountMaterial();
    const banner = screen.getByTestId("material-banner");
    expect(banner.textContent).toContain("资料");
    expect(banner.textContent).toContain("Inbox");
    expect(screen.getByTestId("convert-to-post")).toBeInTheDocument();
    expect(screen.getByTestId("link-to-posts")).toBeInTheDocument();
    // 无发布/状态
    expect(screen.queryByTestId("editor-status")).not.toBeInTheDocument();
    expect(screen.queryByTestId("publish-entry")).not.toBeInTheDocument();
    expect(screen.queryByTestId("open-publish-menu")).not.toBeInTheDocument();
  });

  test("资料保存走 save_material；标题修改走 setMaterialTitle", async () => {
    vi.useFakeTimers();
    apiMocks.saveMaterial.mockResolvedValue({ updatedAt: "2026-08-19T12:00:00", snapshotted: false });
    await mountMaterial();
    fireEvent.change(screen.getByTestId("md-textarea"), { target: { value: "资料新内容" } });
    await act(async () => {
      vi.advanceTimersByTime(900);
    });
    expect(apiMocks.saveMaterial).toHaveBeenCalledWith("m1", "资料新内容");
    expect(apiMocks.savePost).not.toHaveBeenCalled();
    vi.useRealTimers();
    // 标题
    apiMocks.setMaterialTitle.mockResolvedValue({});
    apiMocks.readMaterial.mockResolvedValue({ ...materialContent, title: "新笔记名" });
    const title = screen.getByTestId("editor-title") as HTMLInputElement;
    await userEvent.clear(title);
    await userEvent.type(title, "新笔记名");
    fireEvent.blur(title);
    await waitFor(() => expect(apiMocks.setMaterialTitle).toHaveBeenCalledWith("m1", "新笔记名"));
  });

  test("资料贴图走 savePastedImageAt（资料文件路径）", async () => {
    apiMocks.savePastedImageAt.mockResolvedValue("../../_assets/xyz.png");
    await mountMaterial();
    const ta = screen.getByTestId("md-textarea") as HTMLTextAreaElement;
    const file = new File([new Uint8Array([1])], "x.png", { type: "image/png" });
    await act(async () => {
      fireEvent.paste(ta, {
        clipboardData: { items: [{ type: "image/png", getAsFile: () => file }] },
      });
    });
    await waitFor(() =>
      expect(apiMocks.savePastedImageAt).toHaveBeenCalledWith(
        "kb/Inbox/m1.md",
        expect.any(Uint8Array),
        "png",
      ),
    );
  });

  test("资料升格为文稿 → convertMaterialToPost → 选中新文稿", async () => {
    apiMocks.convertMaterialToPost.mockResolvedValue({
      id: "p9", title: "设计笔记", folder: null, status: "draft", tags: [], path: "posts/x.md", updatedAt: "t",
    });
    apiMocks.readPost.mockResolvedValue(post({ id: "p9", title: "设计笔记" }));
    await mountMaterial();
    fireEvent.click(screen.getByTestId("convert-to-post"));
    await waitFor(() => expect(apiMocks.convertMaterialToPost).toHaveBeenCalledWith("m1"));
    await waitFor(() => expect(useApp.getState().view).toEqual({ kind: "post" }));
    await waitFor(() => expect(useApp.getState().selectedId).toBe("p9"));
  });

  // ───── M4：AI 写作辅助（T11/T12） ─────

  test("post 模式显示 润色建议/查错 按钮；版本模式不显示", async () => {
    await mount(post());
    expect(screen.getByTestId("btn-proofread")).toBeInTheDocument();
    expect(screen.getByTestId("btn-check-errors")).toBeInTheDocument();
    cleanup();
    await mountVersion();
    expect(screen.queryByTestId("btn-proofread")).not.toBeInTheDocument();
    expect(screen.queryByTestId("btn-check-errors")).not.toBeInTheDocument();
  });

  test("mewbox:insert 事件 → 文本插入光标处（AI 结果/资料链接共用通道）", async () => {
    await mount(post({ body: "开头" }));
    const ta = screen.getByTestId("md-textarea") as HTMLTextAreaElement;
    ta.setSelectionRange(2, 2);
    window.dispatchEvent(new CustomEvent("mewbox:insert", { detail: { text: "插入的" } }));
    await waitFor(() => expect(ta.value).toBe("开头插入的"));
  });

  test("选区后浮条出现（edit/live 模式）；预览模式不出现", async () => {
    await mount(post({ body: "一段旧文字后面" }));
    const ta = screen.getByTestId("md-textarea") as HTMLTextAreaElement;
    ta.setSelectionRange(0, 4);
    fireEvent.mouseUp(ta, { clientX: 120, clientY: 160 });
    expect(screen.getByTestId("selection-toolbar")).toBeInTheDocument();
    // 预览模式隐藏
    fireEvent.click(screen.getByTestId("mode-preview"));
    expect(screen.queryByTestId("selection-toolbar")).not.toBeInTheDocument();
  });

  test("选区工具条：改写 → aiRunOp(selection) → 流式预览 → 替换选区精确拼接 + aiAdoptResult", async () => {
    await mount(post({ body: "一段旧文字后面" }));
    const ta = screen.getByTestId("md-textarea") as HTMLTextAreaElement;
    ta.setSelectionRange(0, 4);
    fireEvent.mouseUp(ta, { clientX: 120, clientY: 160 });
    fireEvent.click(screen.getByTestId("sel-btn-rewrite"));
    await waitFor(() => expect(apiMocks.aiRunOp).toHaveBeenCalledTimes(1));
    const [callId, op, contexts, params] = apiMocks.aiRunOp.mock.calls[0];
    expect(callId).toEqual(expect.any(String));
    expect(op).toBe("rewrite");
    expect(contexts).toEqual([]);
    expect(params.selection).toBe("一段旧文");
    await act(async () => {
      emitAI({ kind: "delta", text: "新的四" });
      emitAI({ kind: "done", tokensIn: 8, tokensOut: 9 });
    });
    await waitFor(() => expect(screen.getByTestId("sel-result")).toBeInTheDocument());
    expect(screen.getByTestId("sel-result-text").textContent).toBe("新的四");
    fireEvent.click(screen.getByTestId("sel-replace"));
    await waitFor(() => expect(apiMocks.aiAdoptResult).toHaveBeenCalledWith(callId));
    await waitFor(() => expect(ta.value).toBe("新的四字后面"));
    // 浮条与结果卡均收起
    expect(screen.queryByTestId("sel-result")).not.toBeInTheDocument();
  });

  test("选区工具条：放弃 → aiDiscardResult 且正文不变", async () => {
    await mount(post({ body: "保持原样" }));
    const ta = screen.getByTestId("md-textarea") as HTMLTextAreaElement;
    ta.setSelectionRange(0, 4);
    fireEvent.mouseUp(ta, { clientX: 120, clientY: 160 });
    fireEvent.click(screen.getByTestId("sel-btn-polish"));
    await waitFor(() => expect(apiMocks.aiRunOp).toHaveBeenCalled());
    await act(async () => {
      emitAI({ kind: "delta", text: "改后" });
      emitAI({ kind: "done", tokensIn: 1, tokensOut: 1 });
    });
    fireEvent.click(screen.getByTestId("sel-discard"));
    await waitFor(() => expect(apiMocks.aiDiscardResult).toHaveBeenCalled());
    expect(ta.value).toBe("保持原样");
    // discard 异步收尾（留痕 → 清理 UI）：等结果卡消失
    await waitFor(() => expect(screen.queryByTestId("sel-result")).not.toBeInTheDocument());
  });

  test("润色建议：全文 op → 解析建议 → 逐条采纳 = aiApplySuggestions 精确替换", async () => {
    await mount(post({ body: "旧句子在文中" }));
    fireEvent.click(screen.getByTestId("btn-proofread"));
    await waitFor(() =>
      expect(apiMocks.aiRunOp).toHaveBeenCalledWith(expect.any(String), "proofread_suggestions", [{ kind: "post", id: "p1" }]),
    );
    await act(async () => {
      emitAI({ kind: "delta", text: '```json\n[{"原段":"旧句子","改段":"新句子","理由":"更顺"},]' });
      emitAI({ kind: "done", tokensIn: 10, tokensOut: 20 });
    });
    await waitFor(() => expect(screen.getByTestId("proofread-item")).toBeInTheDocument());
    apiMocks.aiApplySuggestions.mockResolvedValue({ body: "新句子在文中", applied: [0], skipped: [] });
    fireEvent.click(screen.getByTestId("proofread-adopt-0"));
    await waitFor(() => expect(apiMocks.aiApplySuggestions).toHaveBeenCalledWith("旧句子在文中", [
      { original: "旧句子", revised: "新句子", reason: "更顺" },
    ]));
    await waitFor(() => expect((screen.getByTestId("md-textarea") as HTMLTextAreaElement).value).toBe("新句子在文中"));
    await waitFor(() => expect(apiMocks.aiAdoptResult).toHaveBeenCalledWith(expect.any(String), "采纳 1/1 条"));
  });

  test("查错：解析条目 → 全部采纳；定位点击滚动不报错", async () => {
    await mount(post({ body: "第一行\n从新开始" }));
    fireEvent.click(screen.getByTestId("btn-check-errors"));
    await waitFor(() =>
      expect(apiMocks.aiRunOp).toHaveBeenCalledWith(expect.any(String), "check_errors", [{ kind: "post", id: "p1" }]),
    );
    await act(async () => {
      emitAI({ kind: "delta", text: '[{"类型":"错别字","定位":"从新开始","建议":"重新开始"}]' });
      emitAI({ kind: "done", tokensIn: 6, tokensOut: 6 });
    });
    const item = await waitFor(() => {
      const el = screen.getByTestId("issue-item");
      expect(el).toBeInTheDocument();
      return el;
    });
    expect(item.textContent).toContain("错别字");
    fireEvent.click(screen.getByTestId("issue-locate-0")); // 定位滚动（近似行号）
    apiMocks.aiApplySuggestions.mockResolvedValue({ body: "第一行\n重新开始", applied: [0], skipped: [] });
    fireEvent.click(screen.getByTestId("issue-adopt-all"));
    await waitFor(() => expect(apiMocks.aiApplySuggestions).toHaveBeenCalled());
    await waitFor(() =>
      expect((screen.getByTestId("md-textarea") as HTMLTextAreaElement).value).toBe("第一行\n重新开始"),
    );
  });
});
