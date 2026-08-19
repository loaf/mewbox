import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { CheckErrorsPanel } from "./CheckErrorsPanel";

const apiMocks = vi.hoisted(() => ({
  aiRunOp: vi.fn().mockResolvedValue(undefined),
  aiAdoptResult: vi.fn().mockResolvedValue(undefined),
  aiDiscardResult: vi.fn().mockResolvedValue(undefined),
  aiApplySuggestions: vi.fn(),
  aiCancel: vi.fn().mockResolvedValue(undefined),
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

const target = { kind: "material" as const, id: "m1" };

function mount(body: string) {
  const onApply = vi.fn();
  const onClose = vi.fn();
  render(<CheckErrorsPanel target={target} body={body} onApply={onApply} onClose={onClose} />);
  return { onApply, onClose };
}

describe("CheckErrorsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handlers.clear();
  });

  test("挂载即跑 check_errors；解析条目（类型/定位/建议）", async () => {
    mount("从新开始写");
    await waitFor(() =>
      expect(apiMocks.aiRunOp).toHaveBeenCalledWith(expect.any(String), "check_errors", [target]),
    );
    await act(async () => {
      emitAI({ kind: "delta", text: '[{"类型":"错别字","定位":"从新开始","建议":"重新开始"}]' });
      emitAI({ kind: "done", tokensIn: 4, tokensOut: 4 });
    });
    const item = await screen.findByTestId("issue-item");
    expect(item.textContent).toContain("错别字");
    expect(item.textContent).toContain("重新开始");
  });

  test("采纳 = 定位→original、建议→revised 的精确替换", async () => {
    const { onApply } = mount("从新开始写");
    await waitFor(() => expect(apiMocks.aiRunOp).toHaveBeenCalled());
    await act(async () => {
      emitAI({ kind: "delta", text: '[{"类型":"错别字","定位":"从新","建议":"重新","kind2":"x"},]' });
      emitAI({ kind: "done", tokensIn: 4, tokensOut: 4 });
    });
    apiMocks.aiApplySuggestions.mockResolvedValue({ body: "重新开始写", applied: [0], skipped: [] });
    fireEvent.click(await screen.findByTestId("issue-adopt-0"));
    await waitFor(() =>
      expect(apiMocks.aiApplySuggestions).toHaveBeenCalledWith("从新开始写", [
        { original: "从新", revised: "重新", reason: "错别字" },
      ]),
    );
    await waitFor(() => expect(onApply).toHaveBeenCalledWith("重新开始写"));
    await waitFor(() => expect(apiMocks.aiAdoptResult).toHaveBeenCalledWith(expect.any(String), "采纳 1/1 条"));
  });

  test("定位点击：无编辑器 textarea 时不抛错；skipped 标灰", async () => {
    mount("正文");
    await waitFor(() => expect(apiMocks.aiRunOp).toHaveBeenCalled());
    await act(async () => {
      emitAI({ kind: "delta", text: '[{"类型":"标点","定位":"正文","建议":"正文。"}]' });
      emitAI({ kind: "done", tokensIn: 1, tokensOut: 1 });
    });
    expect(() => fireEvent.click(screen.getByTestId("issue-locate-0"))).not.toThrow();
    // skipped 路径
    apiMocks.aiApplySuggestions.mockResolvedValue({ body: "正文", applied: [], skipped: [0] });
    fireEvent.click(screen.getByTestId("issue-adopt-0"));
    await waitFor(() =>
      expect(screen.getByTestId("issue-item").textContent).toContain("原文已变化"),
    );
    expect(screen.queryByTestId("issue-adopt-all")).not.toBeInTheDocument();
  });
});
