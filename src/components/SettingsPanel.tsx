import { useCallback, useEffect, useState } from "react";
import {
  api,
  type AiBudgetConfig,
  type AiConfigState,
  type AiProviderConfig,
  type UsageRow,
} from "../lib/api";
import { useApp } from "../stores/app";

/** 全部操作（与后端 prompts::OPS 一致；路由表按这些 op 配置） */
const OP_LABELS: [string, string][] = [
  ["summarize", "总结"],
  ["keypoints", "要点"],
  ["translate", "翻译"],
  ["compare", "对比"],
  ["qa", "问答"],
  ["rewrite", "改写（选区）"],
  ["expand", "扩写（选区）"],
  ["shorten", "缩写（选区）"],
  ["tone", "改语气（选区）"],
  ["polish", "润色（选区）"],
  ["proofread_suggestions", "润色建议"],
  ["check_errors", "查错"],
  ["custom", "自定义"],
  ["describe_attachment", "附件描述（需视觉模型）"],
];

const PROVIDER_TYPES = ["openai", "anthropic", "ollama"] as const;

type Tab = "model" | "routes" | "usage";

/** 预算功能按用户裁定移除（2026-08-20）：后端保留兼容，UI 不再暴露单价/限额，只记 token 与时间 */
const NO_BUDGET: AiBudgetConfig = { dailyCents: 0, monthlyCents: 0, paused: false };

function emptyProvider(): AiProviderConfig {
  return { id: "", type: "openai", baseUrl: "", model: "", maxContext: null, pricePer1kInCents: null, pricePer1kOutCents: null };
}

function num(v: string): number | null {
  const t = v.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

const inputCls =
  "w-full rounded-md border border-[var(--line)] bg-white px-2 py-1 text-xs outline-none focus:border-[var(--cat)]";
const btnCls = "rounded-md border border-[var(--line)] bg-white px-3 py-1 text-[13px] hover:border-[var(--cat)]";

/** 单个 provider 行（模型页签）：字段内联编辑 + 密钥（不回显）+ 测试连接 */
function ProviderRow({
  provider,
  hasKey,
  onChange,
  onRemove,
  onSaved,
}: {
  provider: AiProviderConfig;
  hasKey: boolean;
  onChange: (p: AiProviderConfig) => void;
  onRemove: () => void;
  onSaved: () => Promise<void>;
}) {
  const [keyDraft, setKeyDraft] = useState("");
  const [keyNote, setKeyNote] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  const set = (patch: Partial<AiProviderConfig>) => onChange({ ...provider, ...patch });

  const saveKey = async () => {
    if (!keyDraft.trim()) return;
    await api.aiSetKey(provider.id, keyDraft);
    setKeyDraft("");
    setKeyNote("密钥已存入系统钥匙串");
  };
  const clearKey = async () => {
    await api.aiDeleteKey(provider.id);
    setKeyNote("密钥已清除");
  };
  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      // 测试前自动保存草稿密钥（验收反馈：先输密钥直接测试 → 未入库 → 401）
      if (keyDraft.trim() && provider.type !== "ollama") {
        await api.aiSetKey(provider.id, keyDraft);
        setKeyDraft("");
        setKeyNote("密钥已存入系统钥匙串");
        await onSaved();
      }
      const r = await api.aiTestConnection(provider.id);
      setTestResult(r.message);
    } catch (e) {
      setTestResult(`测试失败：${String(e)}`);
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="rounded-lg border border-[var(--line)] p-3" data-testid={`provider-row-${provider.id}`}>
      <div className="grid grid-cols-2 gap-2">
        <label className="text-[11px] text-[var(--muted)]">
          标识
          <input className={inputCls} value={provider.id} onChange={(e) => set({ id: e.target.value })} data-testid={`provider-id-${provider.id}`} />
        </label>
        <label className="text-[11px] text-[var(--muted)]">
          类型
          <select className={inputCls} value={provider.type} onChange={(e) => set({ type: e.target.value })} data-testid={`provider-type-${provider.id}`}>
            {PROVIDER_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </label>
        <label className="text-[11px] text-[var(--muted)]">
          Base URL
          <input className={inputCls} value={provider.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} />
        </label>
        <label className="text-[11px] text-[var(--muted)]">
          模型
          <input className={inputCls} value={provider.model} onChange={(e) => set({ model: e.target.value })} />
        </label>
        <label className="text-[11px] text-[var(--muted)]">
          最大上下文（tokens）
          <input className={inputCls} inputMode="numeric" value={provider.maxContext ?? ""} onChange={(e) => set({ maxContext: num(e.target.value) })} />
        </label>
        <div className="grid grid-cols-2 gap-1">
          <label className="text-[11px] text-[var(--muted)]">
            入价（美分/1k）
            <input className={inputCls} inputMode="numeric" value={provider.pricePer1kInCents ?? ""} onChange={(e) => set({ pricePer1kInCents: num(e.target.value) })} />
          </label>
          <label className="text-[11px] text-[var(--muted)]">
            出价（美分/1k）
            <input className={inputCls} inputMode="numeric" value={provider.pricePer1kOutCents ?? ""} onChange={(e) => set({ pricePer1kOutCents: num(e.target.value) })} />
          </label>
        </div>
      </div>

      {/* 密钥：写入系统钥匙串，不回显、不落工作区 */}
      <div className="mt-2 flex items-center gap-1">
        <input
          type="password"
          className={inputCls}
          placeholder={hasKey ? "已保存（输入以更换）" : "输入 API 密钥"}
          value={keyDraft}
          onChange={(e) => setKeyDraft(e.target.value)}
          data-testid={`provider-key-input-${provider.id}`}
        />
        <button className={btnCls} onClick={() => void saveKey()} data-testid={`provider-key-save-${provider.id}`}>存密钥</button>
        {hasKey && (
          <button className={btnCls} onClick={() => void clearKey()} data-testid={`provider-key-clear-${provider.id}`}>清除</button>
        )}
      </div>
      {keyNote && <div className="mt-1 text-[11px] text-[var(--muted)]">{keyNote}</div>}

      <div className="mt-2 flex items-center gap-1">
        <button className={btnCls} disabled={testing} onClick={() => void test()} data-testid={`provider-test-${provider.id}`}>
          {testing ? "测试中…" : "测试连接"}
        </button>
        <button
          className="rounded-md bg-[var(--cat)] px-3 py-1 text-[13px] font-semibold text-white"
          onClick={() => void api.aiSaveProvider(provider).then(onSaved)}
          data-testid={`provider-save-${provider.id}`}
        >
          保存
        </button>
        <button className={btnCls} onClick={onRemove} data-testid={`provider-delete-${provider.id}`}>删除</button>
        {testResult && (
          <span className="ml-1 min-w-0 flex-1 truncate text-[11px] text-[var(--muted)]" data-testid={`provider-test-result-${provider.id}`}>
            {testResult}
          </span>
        )}
      </div>
    </div>
  );
}

export function SettingsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const setSettingsOpen = useApp((s) => s.setSettingsOpen);
  const [tab, setTab] = useState<Tab>("model");
  const [providers, setProviders] = useState<AiProviderConfig[]>([]);
  const [routes, setRoutes] = useState<Record<string, string>>({});
  const [fallbacks, setFallbacks] = useState<Record<string, string>>({});
  const [hasKey, setHasKey] = useState<Record<string, boolean>>({});
  const [usage, setUsage] = useState<UsageRow[]>([]);
  const [usageMonth, setUsageMonth] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const cfg: AiConfigState = await api.aiListProviders();
    setProviders(cfg.providers.map((p) => ({ ...p })));
    setRoutes({ ...cfg.routes });
    setFallbacks({ ...cfg.fallbacks });
    const keys: Record<string, boolean> = {};
    for (const p of cfg.providers) keys[p.id] = await api.aiHasKey(p.id).catch(() => false);
    setHasKey(keys);
  }, []);

  useEffect(() => {
    if (!open) return;
    setNote(null);
    void refresh().catch(console.error);
  }, [open, refresh]);

  useEffect(() => {
    if (!open || tab !== "usage") return;
    void api.aiUsage(usageMonth).then(setUsage).catch(() => setUsage([]));
  }, [open, tab, usageMonth]);

  if (!open) return null;

  const close = () => {
    setSettingsOpen(false);
    onClose();
  };

  const saveConfig = async (r: Record<string, string>, f: Record<string, string>, b: AiBudgetConfig) => {
    await api.aiSaveAiConfig(r, f, b);
    setNote("已保存");
    await refresh();
  };


  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" data-testid="settings-overlay" onClick={close}>
      <div
        className="flex max-h-[85vh] w-[640px] flex-col rounded-xl bg-[var(--card)] shadow-xl"
        onClick={(e) => e.stopPropagation()}
        data-testid="settings-modal"
      >
        <div className="flex items-center gap-2 border-b border-[var(--line)] px-4 py-2">
          <span className="text-base font-bold">⚙ 设置 · AI</span>
          <div className="ml-auto flex gap-1">
            {(
              [
                ["model", "模型"],
                ["routes", "路由"],
                ["usage", "用量"],
              ] as const
            ).map(([t, label]) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`rounded-md px-2 py-1 text-xs ${tab === t ? "bg-[var(--cat-bg)] font-semibold" : "text-[var(--muted)]"}`}
                data-testid={`settings-tab-${t}`}
              >
                {label}
              </button>
            ))}
          </div>
          <button className="ml-2 text-xs text-[var(--muted)]" onClick={close} data-testid="settings-close">✕</button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-4 text-xs">
          {note && <div className="mb-2 text-[11px] text-[var(--muted)]" data-testid="settings-note">{note}</div>}

          {tab === "model" && (
            <div className="flex flex-col gap-3" data-testid="settings-model-tab">
              {providers.map((p, i) => (
                <ProviderRow
                  key={i}
                  provider={p}
                  hasKey={!!hasKey[p.id]}
                  onChange={(np) => setProviders((list) => list.map((x, j) => (j === i ? np : x)))}
                  onRemove={() => {
                    if (!window.confirm(`删除 provider ${p.id}？`)) return;
                    void api.aiDeleteProvider(p.id).then(() => refresh());
                  }}
                  onSaved={refresh}
                />
              ))}
              <button className={`${btnCls} self-start`} onClick={() => setProviders((l) => [...l, emptyProvider()])} data-testid="provider-add">
                ＋ 新增 provider
              </button>
              <div className="rounded-lg border border-dashed border-[var(--line)] p-2 text-[11px] leading-5 text-[var(--muted)]" data-testid="settings-outbound-note">
                内容出站说明：云模型（openai / anthropic）会把所选内容发送至对应服务；Ollama 在本机运行，完全本地。
                密钥存于系统钥匙串，不落工作区（换机需重配）。
              </div>
            </div>
          )}

          {tab === "routes" && (
            <div data-testid="settings-routes-tab">
              <div className="mb-3 rounded-lg bg-[var(--cream)] p-3 text-[11px] leading-5 text-[var(--muted)]" data-testid="routes-help">
                <b>路由</b>：每类 AI 操作用哪个 provider（和可选的模型覆盖）。留空＝该操作未配置，调用时会报「无路由」。
                <br />
                <b>Fallback 链</b>：主 provider 失败（连接/鉴权/限流，且尚未输出任何内容）时依次尝试的备选，格式
                <code className="rounded bg-white px-1">provider</code> 或
                <code className="rounded bg-white px-1">provider:模型</code>，逗号分隔。例：
                <code className="rounded bg-white px-1">deepseek,ollama:qwen3</code>——deepseek 挂了先用本地 ollama 的 qwen3。
                <br />
                <b>附件描述</b>需视觉模型（云多模态或本地视觉模型），路由到不具备视觉能力的模型会失败。
              </div>
              <div className="mb-2 flex items-center gap-2">
                <button
                  className="rounded-md border border-[var(--line)] bg-white px-2 py-1 text-xs"
                  onClick={() => {
                    // 一键默认：所有操作 → 首个云端 provider（无云端则 ollama）
                    const primary =
                      providers.find((p) => p.type !== "ollama") ?? providers[0];
                    if (!primary) {
                      window.alert("请先在「模型」页签添加 provider");
                      return;
                    }
                    const next: Record<string, string> = {};
                    for (const [op] of OP_LABELS) next[op] = primary.id;
                    setRoutes(next);
                  }}
                  data-testid="routes-default"
                >
                  一键默认（全部操作 → 首个 provider）
                </button>
                <span className="text-[10px] text-[var(--muted)]">生成后仍可逐行调整，记得点「保存路由」</span>
              </div>
              <table className="w-full">
                <thead>
                  <tr className="text-left text-[11px] text-[var(--muted)]">
                    <th className="py-1">操作</th>
                    <th className="py-1">Provider</th>
                    <th className="py-1">模型覆盖（可空）</th>
                    <th className="py-1">Fallback 链（provider[:model],…）</th>
                  </tr>
                </thead>
                <tbody>
                  {OP_LABELS.map(([op, label]) => {
                    const spec = routes[op] ?? "";
                    const [pid, model] = spec.includes(":") ? spec.split(":", 2) : [spec, ""];
                    return (
                      <tr key={op} className="border-t border-[var(--line)]" data-testid={`route-row-${op}`}>
                        <td className="py-1 pr-2">{label}</td>
                        <td className="py-1 pr-2">
                          <select
                            className={inputCls}
                            value={pid}
                            onChange={(e) => {
                              const m = model;
                              setRoutes((r) => ({ ...r, [op]: e.target.value ? (m ? `${e.target.value}:${m}` : e.target.value) : "" }));
                            }}
                          >
                            <option value="">（未配置）</option>
                            {providers.map((p) => (
                              <option key={p.id} value={p.id}>{p.id}</option>
                            ))}
                          </select>
                        </td>
                        <td className="py-1 pr-2">
                          <input
                            className={inputCls}
                            value={model}
                            onChange={(e) => {
                              const m = e.target.value.trim();
                              setRoutes((r) => ({ ...r, [op]: pid ? (m ? `${pid}:${m}` : pid) : "" }));
                            }}
                          />
                        </td>
                        <td className="py-1">
                          <input
                            className={inputCls}
                            value={fallbacks[op] ?? ""}
                            placeholder="provider,provider:model"
                            onChange={(e) => setFallbacks((f) => ({ ...f, [op]: e.target.value }))}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <button
                className="mt-3 rounded-md bg-[var(--cat)] px-3.5 py-1.5 text-[13px] font-semibold text-white"
                onClick={() => void saveConfig(routes, fallbacks, NO_BUDGET)}
                data-testid="routes-save"
              >
                保存路由
              </button>
            </div>
          )}

          {tab === "usage" && (
            <div data-testid="settings-usage-tab">
              <div className="mb-2 flex items-center gap-2">
                <label className="flex items-center gap-1 text-[11px] text-[var(--muted)]">
                  <input type="checkbox" checked={usageMonth} onChange={(e) => setUsageMonth(e.target.checked)} data-testid="usage-month-toggle" />
                  按月聚合（默认按日）
                </label>
                <button
                  className="ml-auto rounded-md border border-red-200 bg-white px-3 py-1 text-[13px] text-red-500"
                  onClick={() => {
                    if (!window.confirm("清空全部 AI 调用留痕？此操作不可撤销（§8.5 一键清空）。")) return;
                    void api.aiClearCalls().then(() => setUsage([]));
                  }}
                  data-testid="usage-clear"
                >
                  清空留痕
                </button>
              </div>
              <table className="w-full" data-testid="usage-table">
                <thead>
                  <tr className="text-left text-[11px] text-[var(--muted)]">
                    <th className="py-1">期间</th>
                    <th className="py-1">操作</th>
                    <th className="py-1">模型</th>
                    <th className="py-1">入/出 tokens</th>
                    <th className="py-1">次数</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.length === 0 && (
                    <tr><td colSpan={5} className="py-2 text-center text-[var(--muted)]">暂无用量记录</td></tr>
                  )}
                  {usage.map((r, i) => (
                    <tr key={i} className="border-t border-[var(--line)]" data-testid="usage-row">
                      <td className="py-1">{r.periodKey}</td>
                      <td className="py-1">{r.op}</td>
                      <td className="py-1">{r.model}</td>
                      <td className="py-1">{r.tokensIn} / {r.tokensOut}</td>
                      <td className="py-1">{r.calls}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
