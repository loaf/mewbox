import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { ProofreadPanel } from "./ProofreadPanel";

const apiMocks = vi.hoisted(() => ({
  aiRunOp: vi.fn().mockResolvedValue(undefined),
  aiAdoptResult: vi.fn().mockResolvedValue(undefined),
  aiDiscardResult: vi.fn().mockResolvedValue(undefined),
  aiApplySuggestions: vi.fn(),
  aiCancel: vi.fn().mockResolvedValue(undefined),
  aiListProviders: vi.fn().mockResolvedValue({ providers: [], routes: {}, fallbacks: {}, budget: { dailyCents: 0, monthlyCents: 0, paused: false } }),
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

const target = { kind: "post" as const, id: "p1" };

function mount(body: string) {
  const onApply = vi.fn();
  const onClose = vi.fn();
  render(<ProofreadPanel target={target} body={body} onApply={onApply} onClose={onClose} />);
  return { onApply, onClose };
}

async function streamDone(text: string) {
  await act(async () => {
    emitAI({ kind: "delta", text });
    emitAI({ kind: "done", tokensIn: 5, tokensOut: 7 });
  });
}

describe("ProofreadPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handlers.clear();
  });

  test("挂载即对全文跑 proofread_suggestions（contexts=[target]）", async () => {
    mount("正文");
    await waitFor(() =>
      expect(apiMocks.aiRunOp).toHaveBeenCalledWith(expect.any(String), "proofread_suggestions", [target]),
    );
    await streamDone('[{"原段":"a","改段":"b","理由":"r"}]');
    await waitFor(() => expect(screen.getByTestId("proofread-item")).toBeInTheDocument());
  });

  test("逐条采纳 = aiApplySuggestions(body,[item]) → onApply(新正文) → aiAdoptResult 记采纳数", async () => {
    const { onApply } = mount("旧句子在文中");
    await waitFor(() => expect(apiMocks.aiRunOp).toHaveBeenCalled());
    await streamDone('[{"原段":"旧句子","改段":"新句子","理由":"更顺"}]');
    apiMocks.aiApplySuggestions.mockResolvedValue({ body: "新句子在文中", applied: [0], skipped: [] });
    fireEvent.click(await screen.findByTestId("proofread-adopt-0"));
    await waitFor(() =>
      expect(apiMocks.aiApplySuggestions).toHaveBeenCalledWith("旧句子在文中", [
        { original: "旧句子", revised: "新句子", reason: "更顺" },
      ]),
    );
    await waitFor(() => expect(onApply).toHaveBeenCalledWith("新句子在文中"));
    await waitFor(() => expect(apiMocks.aiAdoptResult).toHaveBeenCalledWith(expect.any(String), "采纳 1/1 条"));
    expect(screen.getByTestId("proofread-item").textContent).toContain("已采纳");
  });

  test("skipped 条目标灰「原文已变化」；全部采纳只传未处理条目", async () => {
    const { onApply } = mount("第一句第二句");
    await waitFor(() => expect(apiMocks.aiRunOp).toHaveBeenCalled());
    await streamDone('[{"原段":"一","改段":"壹","理由":""},{"原段":"二","改段":"贰","理由":""}]');
    // 第一条采纳成功
    apiMocks.aiApplySuggestions.mockResolvedValueOnce({ body: "第壹句第二句", applied: [0], skipped: [] });
    fireEvent.click(await screen.findByTestId("proofread-adopt-0"));
    await waitFor(() => expect(onApply).toHaveBeenCalled());
    // 全部采纳：只剩第 2 条未处理（body prop 为固定值，不随 onApply 变化）；模拟未命中
    apiMocks.aiApplySuggestions.mockResolvedValueOnce({ body: "第壹句第二句", applied: [], skipped: [0] });
    fireEvent.click(screen.getByTestId("proofread-adopt-all"));
    await waitFor(() =>
      expect(apiMocks.aiApplySuggestions).toHaveBeenLastCalledWith("第一句第二句", [
        { original: "二", revised: "贰", reason: "" },
      ]),
    );
    await waitFor(() =>
      expect(screen.getAllByTestId("proofread-item").map((el) => el.textContent).join()).toContain("原文已变化"),
    );
    expect(screen.queryByTestId("proofread-adopt-all")).not.toBeInTheDocument();
  });

  test("空建议与坏 JSON → 提示/空列表不抛错；未采纳关闭 → aiDiscardResult", async () => {
    const { onClose } = mount("正文");
    await waitFor(() => expect(apiMocks.aiRunOp).toHaveBeenCalled());
    await streamDone("抱歉，无法处理");
    await waitFor(() => expect(screen.getByTestId("proofread-empty")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("proofread-close"));
    await waitFor(() => expect(apiMocks.aiDiscardResult).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });
});
