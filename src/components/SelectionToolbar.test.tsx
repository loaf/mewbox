import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { SelectionToolbar } from "./SelectionToolbar";

const apiMocks = vi.hoisted(() => ({
  aiRunOp: vi.fn().mockResolvedValue(undefined),
  aiCancel: vi.fn().mockResolvedValue(undefined),
  aiAdoptResult: vi.fn().mockResolvedValue(undefined),
  aiDiscardResult: vi.fn().mockResolvedValue(undefined),
  aiListProviders: vi.fn().mockResolvedValue({
    providers: [
      { id: "local", type: "ollama", baseUrl: "http://127.0.0.1:11434", model: "qwen", maxContext: null, pricePer1kInCents: null, pricePer1kOutCents: null },
    ],
    routes: { rewrite: "local" },
    fallbacks: {},
    budget: { dailyCents: 0, monthlyCents: 0, paused: false },
  }),
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

const anchor = { start: 2, end: 6, text: "旧文", x: 200, y: 300 };

function mount(enabled = true) {
  const clear = vi.fn();
  const lock = vi.fn();
  const onReplaceRange = vi.fn();
  render(
    <SelectionToolbar
      anchor={anchor}
      clear={clear}
      lock={lock}
      onReplaceRange={onReplaceRange}
      enabled={enabled}
    />,
  );
  return { clear, lock, onReplaceRange };
}

describe("SelectionToolbar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handlers.clear();
  });

  test("选区浮条：七个操作按钮 + 出站提示（Ollama=完全本地，异步加载）", async () => {
    mount();
    const bar = screen.getByTestId("selection-toolbar");
    expect(bar).toBeInTheDocument();
    for (const id of ["rewrite", "expand", "shorten", "tone", "translate", "polish", "custom"]) {
      expect(screen.getByTestId(`sel-btn-${id}`)).toBeInTheDocument();
    }
    await waitFor(() => expect(screen.getByTestId("sel-outbound-note").textContent).toContain("完全本地"));
  });

  test("enabled=false（预览模式）不渲染", () => {
    mount(false);
    expect(screen.queryByTestId("selection-toolbar")).not.toBeInTheDocument();
  });

  test("改写 → aiRunOp(selection)；done → 替换选区 = onReplaceRange(触发时 range) + aiAdoptResult", async () => {
    const { onReplaceRange } = mount();
    fireEvent.click(screen.getByTestId("sel-btn-rewrite"));
    await waitFor(() => expect(apiMocks.aiRunOp).toHaveBeenCalledTimes(1));
    const [callId, op, contexts, params] = apiMocks.aiRunOp.mock.calls[0];
    expect(op).toBe("rewrite");
    expect(contexts).toEqual([]);
    expect(params.selection).toBe("旧文");
    await act(async () => {
      emitAI({ kind: "delta", text: "新文" });
      emitAI({ kind: "done", tokensIn: 3, tokensOut: 4 });
    });
    await waitFor(() => expect(screen.getByTestId("sel-result")).toBeInTheDocument());
    expect(screen.getByTestId("sel-result-text").textContent).toBe("新文");
    fireEvent.click(screen.getByTestId("sel-replace"));
    await waitFor(() => expect(onReplaceRange).toHaveBeenCalledWith(2, 6, "新文"));
    await waitFor(() => expect(apiMocks.aiAdoptResult).toHaveBeenCalledWith(callId));
    expect(screen.queryByTestId("sel-result")).not.toBeInTheDocument();
  });

  test("翻译：内联目标语言输入随 selection 调用传入 targetLang", async () => {
    mount();
    fireEvent.click(screen.getByTestId("sel-btn-translate"));
    fireEvent.change(screen.getByTestId("sel-lang-input"), { target: { value: "日语" } });
    fireEvent.click(screen.getByTestId("sel-translate-run"));
    await waitFor(() => expect(apiMocks.aiRunOp).toHaveBeenCalled());
    expect(apiMocks.aiRunOp.mock.calls[0][3].targetLang).toBe("日语");
  });

  test("插入光标后 → 派发 mewbox:insert（EditorPane 监听插入）+ aiAdoptResult", async () => {
    const insertSpy = vi.fn();
    window.addEventListener("mewbox:insert", insertSpy);
    mount();
    fireEvent.click(screen.getByTestId("sel-btn-polish"));
    await waitFor(() => expect(apiMocks.aiRunOp).toHaveBeenCalled());
    await act(async () => {
      emitAI({ kind: "delta", text: "润色后" });
      emitAI({ kind: "done", tokensIn: 1, tokensOut: 1 });
    });
    fireEvent.click(screen.getByTestId("sel-insert"));
    await waitFor(() => expect(apiMocks.aiAdoptResult).toHaveBeenCalled());
    expect(insertSpy).toHaveBeenCalledTimes(1);
    expect((insertSpy.mock.calls[0][0] as CustomEvent).detail).toEqual({ text: "润色后" });
    window.removeEventListener("mewbox:insert", insertSpy);
  });

  test("复制 → clipboard + aiAdoptResult；放弃 → aiDiscardResult", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    mount();
    fireEvent.click(screen.getByTestId("sel-btn-expand"));
    await waitFor(() => expect(apiMocks.aiRunOp).toHaveBeenCalled());
    await act(async () => {
      emitAI({ kind: "delta", text: "扩写结果" });
      emitAI({ kind: "done", tokensIn: 1, tokensOut: 1 });
    });
    fireEvent.click(screen.getByTestId("sel-copy"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("扩写结果"));
    await waitFor(() => expect(apiMocks.aiAdoptResult).toHaveBeenCalled());
    // 再跑一次 → 放弃
    fireEvent.click(screen.getByTestId("sel-btn-shorten"));
    await waitFor(() => expect(apiMocks.aiRunOp).toHaveBeenCalledTimes(2));
    await act(async () => {
      emitAI({ kind: "done", tokensIn: 1, tokensOut: 1 });
    });
    fireEvent.click(screen.getByTestId("sel-discard"));
    await waitFor(() => expect(apiMocks.aiDiscardResult).toHaveBeenCalled());
  });

  test("Esc 关闭：空闲直接收起；已 done 时丢弃留痕", async () => {
    const { clear } = mount();
    fireEvent.keyDown(window, { key: "Escape", bubbles: true });
    await waitFor(() => expect(clear).toHaveBeenCalled());
    expect(apiMocks.aiDiscardResult).not.toHaveBeenCalled();
    // done 后 Esc → discard
    fireEvent.click(screen.getByTestId("sel-btn-rewrite"));
    await waitFor(() => expect(apiMocks.aiRunOp).toHaveBeenCalled());
    await act(async () => {
      emitAI({ kind: "done", tokensIn: 1, tokensOut: 1 });
    });
    fireEvent.keyDown(window, { key: "Escape", bubbles: true });
    await waitFor(() => expect(apiMocks.aiDiscardResult).toHaveBeenCalled());
  });

  test("取消进行中的流 → aiCancel", async () => {
    mount();
    fireEvent.click(screen.getByTestId("sel-btn-rewrite"));
    await waitFor(() => expect(apiMocks.aiRunOp).toHaveBeenCalled());
    await act(async () => {
      emitAI({ kind: "delta", text: "…" });
    });
    fireEvent.click(screen.getByTestId("sel-cancel"));
    await waitFor(() => expect(apiMocks.aiCancel).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("sel-result")).not.toBeInTheDocument();
  });
});
