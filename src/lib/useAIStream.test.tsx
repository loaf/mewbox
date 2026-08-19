import { act, renderHook } from "@testing-library/react";
import { useAIStream, newCallId } from "./useAIStream";

// 事件模块 mock：捕获 handler 供测试模拟后端流；记录 listen 调用时序
const state = vi.hoisted(() => ({
  handlers: new Map<string, (e: { payload: unknown }) => void>(),
  order: [] as string[],
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: (e: { payload: unknown }) => void) => {
    state.handlers.set(event, handler);
    state.order.push(`listen:${event}`);
    return () => state.handlers.delete(event);
  }),
}));

const aiCancelMock = vi.fn().mockResolvedValue(undefined);
vi.mock("./api", () => ({ api: { aiCancel: (...a: unknown[]) => aiCancelMock(...a) } }));

function emit(callId: string, payload: unknown) {
  state.handlers.get(`ai-stream:${callId}`)?.({ payload });
}

describe("useAIStream", () => {
  beforeEach(() => {
    state.handlers.clear();
    state.order.length = 0;
    aiCancelMock.mockClear();
  });

  test("run：先 listen 再 invoke；delta 累积、done 汇总 tokens 并停听", async () => {
    const { result } = renderHook(() => useAIStream());
    const invokeMock = vi.fn(async () => undefined);
    const callId = newCallId();
    await act(async () => {
      const p = result.current.run(callId, invokeMock);
      emit(callId, { kind: "delta", text: "第一" });
      emit(callId, { kind: "delta", text: "段" });
      emit(callId, { kind: "done", tokensIn: 12, tokensOut: 34 });
      await p;
    });
    // 修订决策 5：listen 先于 invoke
    expect(state.order[0]).toBe(`listen:ai-stream:${callId}`);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(result.current.text).toBe("第一段");
    expect(result.current.status).toBe("done");
    expect(result.current.tokens).toEqual({ in: 12, out: 34 });
  });

  test("error 事件 → status=error 且带消息", async () => {
    const { result } = renderHook(() => useAIStream());
    const callId = newCallId();
    await act(async () => {
      const p = result.current.run(callId, vi.fn().mockResolvedValue(undefined));
      await Promise.resolve();
      emit(callId, { kind: "error", text: "预算超限" });
      await p;
    });
    expect(result.current.status).toBe("error");
    expect(result.current.error).toBe("预算超限");
  });

  test("invoke 本身抛错（同步校验失败）→ status=error", async () => {
    const { result } = renderHook(() => useAIStream());
    await act(async () => {
      await result.current.run(newCallId(), vi.fn().mockRejectedValue(new Error("未知 AI 操作：ghost")));
    });
    expect(result.current.status).toBe("error");
    expect(result.current.error).toContain("未知 AI 操作");
  });

  test("cancel → 调 aiCancel(callId) 并复位 idle", async () => {
    const { result } = renderHook(() => useAIStream());
    const callId = newCallId();
    await act(async () => {
      const p = result.current.run(callId, vi.fn().mockResolvedValue(undefined));
      await Promise.resolve();
      emit(callId, { kind: "delta", text: "流中" });
      await p;
    });
    expect(result.current.status).toBe("streaming");
    await act(async () => {
      await result.current.cancel();
    });
    expect(aiCancelMock).toHaveBeenCalledWith(callId);
    expect(result.current.status).toBe("idle");
    expect(result.current.text).toBe("");
  });

  test("reset → 本地复位且不调 aiCancel", async () => {
    const { result } = renderHook(() => useAIStream());
    const callId = newCallId();
    await act(async () => {
      const p = result.current.run(callId, vi.fn().mockResolvedValue(undefined));
      await Promise.resolve();
      emit(callId, { kind: "done", tokensIn: 1, tokensOut: 2 });
      await p;
    });
    act(() => result.current.reset());
    expect(result.current.status).toBe("idle");
    expect(aiCancelMock).not.toHaveBeenCalled();
  });

  test("unmount 清理监听（不抛错）", async () => {
    const { result, unmount } = renderHook(() => useAIStream());
    const callId = newCallId();
    await act(async () => {
      const p = result.current.run(callId, vi.fn().mockResolvedValue(undefined));
      await Promise.resolve();
      emit(callId, { kind: "delta", text: "x" });
      await p;
    });
    expect(() => unmount()).not.toThrow();
  });
});
