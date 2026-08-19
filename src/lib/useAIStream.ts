import { useCallback, useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api, type AIStreamEvent, type AiConfigState, type AiProviderConfig } from "./api";

export type AIStreamStatus = "idle" | "streaming" | "done" | "error";

/** 前端生成调用 id（修订决策 5） */
export function newCallId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `call-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 共享流式 hook（T10-12）：先 listen(`ai-stream:{callId}`) 再 invoke；
 * done/error 后自动 unlisten；unmount 兜底清理。cancel 调 aiCancel 并复位 idle。
 */
export function useAIStream() {
  const [text, setText] = useState("");
  const [status, setStatus] = useState<AIStreamStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [tokens, setTokens] = useState<{ in: number; out: number }>({ in: 0, out: 0 });
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const activeRef = useRef<string | null>(null);

  const teardown = useCallback(() => {
    unlistenRef.current?.();
    unlistenRef.current = null;
  }, []);

  // unmount 兜底
  useEffect(() => teardown, [teardown]);

  /** run(callId, invokeFn)：listen 先于 invoke（修订决策 5） */
  const run = useCallback(
    async (callId: string, invokeFn: () => Promise<unknown>) => {
      teardown();
      activeRef.current = callId;
      setText("");
      setError(null);
      setTokens({ in: 0, out: 0 });
      setStatus("streaming");
      const un = await listen<AIStreamEvent>(`ai-stream:${callId}`, (ev) => {
        if (activeRef.current !== callId) return;
        const p = ev.payload;
        if (p.kind === "delta") {
          setText((t) => t + (p.text ?? ""));
        } else if (p.kind === "done") {
          setTokens({ in: p.tokensIn ?? 0, out: p.tokensOut ?? 0 });
          setStatus("done");
          teardown();
        } else {
          setError(p.text ?? "AI 调用失败");
          setStatus("error");
          teardown();
        }
      });
      // await 期间可能已有新 run：丢弃本次订阅
      if (activeRef.current !== callId) {
        un();
        return;
      }
      unlistenRef.current = un;
      try {
        await invokeFn();
      } catch (e) {
        if (activeRef.current === callId) {
          setError(String(e));
          setStatus("error");
          teardown();
        }
      }
    },
    [teardown],
  );

  /** 取消进行中的调用（abort 后端任务），前端复位 idle */
  const cancel = useCallback(
    async (callId?: string) => {
      const id = callId ?? activeRef.current;
      if (id) await api.aiCancel(id).catch(() => undefined);
      activeRef.current = null;
      teardown();
      setStatus("idle");
      setText("");
      setError(null);
      setTokens({ in: 0, out: 0 });
    },
    [teardown],
  );

  /** 本地复位（终态动作后清空预览卡） */
  const reset = useCallback(() => {
    activeRef.current = null;
    teardown();
    setStatus("idle");
    setText("");
    setError(null);
    setTokens({ in: 0, out: 0 });
  }, [teardown]);

  return { text, status, error, tokens, run, cancel, reset };
}

// ───── 路由与出站提示（铁律 5）/ token 估算（修订决策 8） ─────

/** 解析 op 的首选路由 provider（routes 未配置时看 fallbacks 首跳） */
export function resolveRouteProvider(
  cfg: AiConfigState | null | undefined,
  op: string,
): AiProviderConfig | null {
  if (!cfg) return null;
  const spec = cfg.routes[op] ?? cfg.fallbacks[op]?.split(",")[0] ?? "";
  const pid = spec.trim().split(":")[0];
  if (!pid) return null;
  return cfg.providers.find((p) => p.id === pid) ?? null;
}

/** 出站知情提示（铁律 5）：云模型明示「将发送至 {provider}」；Ollama 完全本地 */
export function routeLabel(cfg: AiConfigState | null | undefined, op: string): string {
  const p = resolveRouteProvider(cfg, op);
  if (!p) return "操作未配置路由（左栏 设置 → 路由）";
  return p.type === "ollama"
    ? `完全本地（Ollama · ${p.id}）`
    : `将发送至 ${p.id}（${p.type}）`;
}

/** 粗估 token：chars/4（修订决策 8 的简化口径） */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}
