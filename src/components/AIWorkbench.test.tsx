import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { AIWorkbench, attachmentsFromBody } from "./AIWorkbench";
import { useApp } from "../stores/app";
import type { AiConfigState } from "../lib/api";

const apiMocks = vi.hoisted(() => ({
  aiListProviders: vi.fn(),
  aiRunOp: vi.fn().mockResolvedValue(undefined),
  aiCancel: vi.fn().mockResolvedValue(undefined),
  aiAdoptResult: vi.fn().mockResolvedValue(undefined),
  aiDiscardResult: vi.fn().mockResolvedValue(undefined),
  aiSaveAsMaterial: vi.fn(),
  aiDescribeAttachment: vi.fn().mockResolvedValue(undefined),
  readPost: vi.fn(),
  readMaterial: vi.fn(),
  readPublishVersion: vi.fn(),
  listPosts: vi.fn().mockResolvedValue({ tree: [], posts: [] }),
  listTrash: vi.fn().mockResolvedValue([]),
  listMaterials: vi.fn().mockResolvedValue([]),
  listMaterialTrash: vi.fn().mockResolvedValue([]),
  listAllVersions: vi.fn().mockResolvedValue([]),
  workspaceRoot: vi.fn().mockResolvedValue("X:/ws"),
}));
vi.mock("../lib/api", () => ({ api: apiMocks }));

const handlers = new Map<string, (e: { payload: unknown }) => void>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: (e: { payload: unknown }) => void) => {
    handlers.set(event, handler);
    return () => handlers.delete(event);
  }),
}));

function emitAI(payload: unknown) {
  const keys = [...handlers.keys()];
  const key = keys[keys.length - 1];
  if (!key) throw new Error("没有已注册的流监听");
  handlers.get(key)!({ payload });
}

const POSTS = [
  { id: "p1", title: "深度工作", folder: null, status: "draft", tags: [], path: "posts/p1.md", updatedAt: "t" },
];
const MATERIALS = [
  { id: "m1", title: "设计笔记", path: "kb/Inbox/m1.md", folder: "Inbox", updatedAt: "t" },
  { id: "m2", title: "容器资料", path: "kb/Inbox/m2.md", folder: "Inbox", updatedAt: "t" },
];

const cfgCloud = (): AiConfigState => ({
  providers: [
    { id: "cloud", type: "openai", baseUrl: "https://x", model: "gpt", maxContext: null, pricePer1kInCents: null, pricePer1kOutCents: null },
    { id: "local", type: "ollama", baseUrl: "http://127.0.0.1:11434", model: "qwen", maxContext: null, pricePer1kInCents: null, pricePer1kOutCents: null },
  ],
  routes: { summarize: "cloud", rewrite: "local" },
  fallbacks: {},
  budget: { dailyCents: 0, monthlyCents: 0, paused: false },
});

async function mount(cfg: ReturnType<typeof cfgCloud> = cfgCloud()) {
  apiMocks.aiListProviders.mockResolvedValue(cfg);
  apiMocks.readPost.mockResolvedValue({ id: "p1", title: "深度工作", folder: null, status: "draft", tags: [], body: "深度工作的正文", path: "posts/p1.md" });
  apiMocks.readMaterial.mockImplementation(async (id: string) => {
    if (id === "m2") {
      return { id: "m2", title: "容器资料", body: "（待补描述：x）\n\n[原件：x.pdf](../../_assets/abc123.pdf)\n", path: "kb/Inbox/m2.md", folder: "Inbox", assoc: null };
    }
    return { id: "m1", title: "设计笔记", body: "设计笔记的正文", path: "kb/Inbox/m1.md", folder: "Inbox", assoc: null };
  });
  apiMocks.readPublishVersion.mockResolvedValue({ id: "v1", base: "p1", target: "wechat", title: "t", body: "版本正文", publishedUrl: null, publishedAt: null, path: "x" });
  useApp.setState({
    posts: POSTS,
    materials: MATERIALS,
    view: { kind: "post" },
    selectedId: null,
    selected: null,
    version: null,
    material: null,
    aiContext: { entries: [], includeAttachmentText: false },
    loading: false,
  });
  render(<AIWorkbench />);
  await screen.findByTestId("ai-workbench");
}

describe("AIWorkbench", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handlers.clear();
  });

  test("上下文列表：文稿 + 资料混选 → store entries 更新；正文拉取用于 token 估算", async () => {
    await mount();
    expect(screen.getByTestId("ctx-post-p1")).toBeInTheDocument();
    expect(screen.getByTestId("ctx-material-m1")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("ctx-post-p1"));
    await waitFor(() => expect(useApp.getState().aiContext.entries).toEqual([{ kind: "post", id: "p1" }]));
    await waitFor(() => expect(apiMocks.readPost).toHaveBeenCalledWith("p1"));
    // 预估按 chars/4（修订决策 8）：7 字符 → 2 tokens
    await waitFor(() => expect(screen.getByTestId("ai-token-estimate").textContent).toContain("2"));
    // 再点一次取消勾选
    fireEvent.click(screen.getByTestId("ctx-post-p1"));
    await waitFor(() => expect(useApp.getState().aiContext.entries).toEqual([]));
  });

  test("版本模式：加入当前版本按钮 → entries 含 version 条目（base+target）", async () => {
    await mount();
    useApp.setState({ view: { kind: "version", baseId: "p1", target: "wechat" }, version: { id: "v1", base: "p1", target: "wechat", title: "t", body: "", publishedUrl: null, publishedAt: null, path: "x" } });
    fireEvent.click(await screen.findByTestId("ctx-add-version"));
    await waitFor(() =>
      expect(useApp.getState().aiContext.entries).toEqual([{ kind: "version", base: "p1", target: "wechat" }]),
    );
  });

  test("出站提示（铁律 5）：cloud 路由明示将发送至；Ollama 完全本地；未配置给出设置指引", async () => {
    await mount();
    expect(screen.getByTestId("ai-outbound-note").textContent).toContain("将发送至 cloud（openai）");
    // 切到改写不在工作台 op 列表 → 用 op 下拉切翻译（路由表无 translate）→ 提示未配置
    fireEvent.change(screen.getByTestId("ai-op-select"), { target: { value: "translate" } });
    expect(screen.getByTestId("ai-outbound-note").textContent).toContain("未配置路由");
  });

  test("token 超限警告：估算超 maxContext → 分批/截断/换模型提示", async () => {
    const small = cfgCloud();
    small.providers = [
      { ...small.providers[0], maxContext: 1 },
      small.providers[1],
    ];
    await mount(small);
    fireEvent.click(screen.getByTestId("ctx-post-p1"));
    await waitFor(() => expect(screen.getByTestId("ai-token-warning")).toBeInTheDocument());
    expect(screen.getByTestId("ai-token-warning").textContent).toContain("分批");
  });

  test("开始 → aiRunOp（上下文/操作/附件原文开关）→ 流式预览卡 → 插入光标处 + aiAdoptResult", async () => {
    const insertSpy = vi.fn();
    window.addEventListener("mewbox:insert", insertSpy);
    await mount();
    // 打开一篇文稿（插入按钮可用）
    useApp.setState({
      selected: { id: "p1", title: "深度工作", folder: null, status: "draft", tags: [], body: "", path: "posts/p1.md" },
      selectedId: "p1",
    });
    fireEvent.click(screen.getByTestId("ctx-post-p1"));
    fireEvent.click(screen.getByTestId("ctx-material-m2"));
    fireEvent.click(screen.getByTestId("ai-start"));
    await waitFor(() => expect(apiMocks.aiRunOp).toHaveBeenCalledTimes(1));
    const [callId, op, contexts, params] = apiMocks.aiRunOp.mock.calls[0];
    expect(op).toBe("summarize");
    expect(contexts).toEqual([
      { kind: "post", id: "p1" },
      { kind: "material", id: "m2" },
    ]);
    expect(params.includeAttachmentText).toBeUndefined();
    expect(callId).toEqual(expect.any(String));
    // 流式 → 完成
    await act(async () => {
      emitAI({ kind: "delta", text: "总结：深度" });
      emitAI({ kind: "delta", text: "工作" });
      emitAI({ kind: "done", tokensIn: 30, tokensOut: 40 });
    });
    await waitFor(() => expect(screen.getByTestId("ai-preview-text").textContent).toBe("总结：深度工作"));
    expect(screen.getByTestId("ai-preview").textContent).toContain("30 / 40");
    fireEvent.click(screen.getByTestId("ai-insert"));
    await waitFor(() => expect(apiMocks.aiAdoptResult).toHaveBeenCalledWith(callId));
    expect(insertSpy).toHaveBeenCalledTimes(1);
    expect((insertSpy.mock.calls[0][0] as CustomEvent).detail).toEqual({ text: "总结：深度工作" });
    await waitFor(() => expect(screen.queryByTestId("ai-preview")).not.toBeInTheDocument());
    window.removeEventListener("mewbox:insert", insertSpy);
  });

  test("存为资料：标题 + 关联来源 → aiSaveAsMaterial（outcome=saved）并刷新资料列表", async () => {
    apiMocks.aiSaveAsMaterial.mockResolvedValue({ id: "m9", title: "AI 总结", path: "kb/Inbox/x.md", folder: "Inbox", updatedAt: "t" });
    await mount();
    fireEvent.click(screen.getByTestId("ctx-post-p1"));
    fireEvent.click(screen.getByTestId("ai-start"));
    await waitFor(() => expect(apiMocks.aiRunOp).toHaveBeenCalled());
    await act(async () => {
      emitAI({ kind: "delta", text: "结果正文" });
      emitAI({ kind: "done", tokensIn: 1, tokensOut: 1 });
    });
    fireEvent.click(screen.getByTestId("ai-save-as"));
    fireEvent.change(screen.getByTestId("ai-save-title"), { target: { value: "AI 总结" } });
    fireEvent.click(screen.getByTestId("ai-save-confirm"));
    await waitFor(() => expect(apiMocks.aiSaveAsMaterial).toHaveBeenCalled());
    const [callId, title, body, sourceIds, assocIds] = apiMocks.aiSaveAsMaterial.mock.calls[0];
    expect(title).toBe("AI 总结");
    expect(body).toBe("结果正文");
    expect(sourceIds).toEqual(["p1"]);
    expect(assocIds).toEqual(["p1"]);
    expect(callId).toEqual(expect.any(String));
    // 存为资料本身即 outcome=saved：不再调 aiAdoptResult
    expect(apiMocks.aiAdoptResult).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId("ai-note").textContent).toContain("已存为资料"));
    expect(apiMocks.listMaterials).toHaveBeenCalled();
  });

  test("丢弃 → aiDiscardResult；关闭预览（已 done）同样丢弃", async () => {
    await mount();
    fireEvent.click(screen.getByTestId("ctx-post-p1"));
    fireEvent.click(screen.getByTestId("ai-start"));
    await waitFor(() => expect(apiMocks.aiRunOp).toHaveBeenCalled());
    await act(async () => {
      emitAI({ kind: "done", tokensIn: 1, tokensOut: 1 });
    });
    fireEvent.click(screen.getByTestId("ai-discard"));
    await waitFor(() => expect(apiMocks.aiDiscardResult).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByTestId("ai-preview")).not.toBeInTheDocument());
  });

  test("流中取消 → aiCancel + 预览复位；错误事件显示消息", async () => {
    await mount();
    fireEvent.click(screen.getByTestId("ctx-post-p1"));
    fireEvent.click(screen.getByTestId("ai-start"));
    await waitFor(() => expect(apiMocks.aiRunOp).toHaveBeenCalled());
    await act(async () => {
      emitAI({ kind: "delta", text: "半截" });
    });
    fireEvent.click(screen.getByTestId("ai-cancel"));
    await waitFor(() => expect(apiMocks.aiCancel).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByTestId("ai-preview")).not.toBeInTheDocument());
    // 错误路径
    fireEvent.click(screen.getByTestId("ai-start"));
    await waitFor(() => expect(apiMocks.aiRunOp).toHaveBeenCalledTimes(2));
    await act(async () => {
      emitAI({ kind: "error", text: "预算超限" });
    });
    await waitFor(() => expect(screen.getByTestId("ai-error").textContent).toContain("预算超限"));
  });

  test("附件：容器资料探测出附件 → 附件原文开关；附件描述走 aiDescribeAttachment", async () => {
    await mount();
    fireEvent.click(screen.getByTestId("ctx-material-m2"));
    await waitFor(() => expect(screen.getByTestId("ctx-include-attachments")).toBeInTheDocument());
    expect(screen.getByTestId("ctx-include-attachments").closest("label")!.textContent).toContain("abc123.pdf");
    // 开附件原文后开始 → includeAttachmentText=true
    fireEvent.click(screen.getByTestId("ctx-include-attachments"));
    fireEvent.click(screen.getByTestId("ai-start"));
    await waitFor(() => expect(apiMocks.aiRunOp).toHaveBeenCalled());
    expect(apiMocks.aiRunOp.mock.calls[0][3].includeAttachmentText).toBe(true);
    // 附件描述
    fireEvent.change(screen.getByTestId("ai-op-select"), { target: { value: "describe_attachment" } });
    await waitFor(() => expect(screen.getByTestId("attach-pick-list")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("ai-start"));
    await waitFor(() => expect(apiMocks.aiDescribeAttachment).toHaveBeenCalledTimes(1));
    expect(apiMocks.aiDescribeAttachment.mock.calls[0].slice(1)).toEqual(["m2", "abc123.pdf"]);
  });

  test("attachmentsFromBody：正文 _assets 链接提取附件名（去重）", () => {
    const body = "[a](../_assets/x.pdf) [b](_assets/y.png) [c](../_assets/x.pdf) 普通文字";
    expect(attachmentsFromBody(body)).toEqual(["x.pdf", "y.png"]);
    expect(attachmentsFromBody("无附件正文")).toEqual([]);
  });
});
