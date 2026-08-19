import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SettingsPanel } from "./SettingsPanel";
import { useApp } from "../stores/app";

const apiMocks = vi.hoisted(() => ({
  aiListProviders: vi.fn(),
  aiSaveProvider: vi.fn().mockResolvedValue(undefined),
  aiDeleteProvider: vi.fn().mockResolvedValue(undefined),
  aiSaveAiConfig: vi.fn().mockResolvedValue(undefined),
  aiSetKey: vi.fn().mockResolvedValue(undefined),
  aiDeleteKey: vi.fn().mockResolvedValue(undefined),
  aiHasKey: vi.fn(),
  aiTestConnection: vi.fn(),
  aiUsage: vi.fn().mockResolvedValue([]),
  aiClearCalls: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/api", () => ({ api: apiMocks }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));

const cfg = () => ({
  providers: [
    {
      id: "cloud",
      type: "openai",
      baseUrl: "https://api.example.com/v1",
      model: "gpt-x",
      maxContext: 8000,
      pricePer1kInCents: 1,
      pricePer1kOutCents: 2,
    },
    {
      id: "local",
      type: "ollama",
      baseUrl: "http://localhost:11434",
      model: "qwen",
      maxContext: null,
      pricePer1kInCents: null,
      pricePer1kOutCents: null,
    },
  ],
  routes: { summarize: "cloud", rewrite: "local:qwen2" },
  fallbacks: { summarize: "local" },
  budget: { dailyCents: 100, monthlyCents: 3000, paused: false },
});

async function mount() {
  apiMocks.aiListProviders.mockResolvedValue(cfg());
  apiMocks.aiHasKey.mockResolvedValue(true); // cloud 已存密钥
  useApp.setState({ settingsOpen: true });
  render(<SettingsPanel open onClose={() => useApp.setState({ settingsOpen: false })} />);
  await screen.findByTestId("settings-modal");
}

describe("SettingsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useApp.setState({ settingsOpen: false });
  });

  test("打开即拉配置：模型页签渲染 provider 行 + 密钥不回显（placeholder 已保存）+ 出站说明", async () => {
    await mount();
    expect(apiMocks.aiListProviders).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("provider-row-cloud")).toBeInTheDocument();
    expect(screen.getByTestId("provider-row-local")).toBeInTheDocument();
    const keyInput = screen.getByTestId("provider-key-input-cloud") as HTMLInputElement;
    expect(keyInput.value).toBe("");
    expect(keyInput.placeholder).toContain("已保存");
    expect(screen.getByTestId("settings-outbound-note").textContent).toContain("Ollama");
    expect(screen.getByTestId("settings-outbound-note").textContent).toContain("钥匙串");
  });

  test("编辑 provider 字段 → 保存走 aiSaveProvider", async () => {
    await mount();
    fireEvent.change(screen.getByTestId("provider-id-local"), { target: { value: "local2" } });
    fireEvent.click(screen.getByTestId("provider-save-cloud"));
    await waitFor(() => expect(apiMocks.aiSaveProvider).toHaveBeenCalled());
    expect(apiMocks.aiSaveProvider.mock.calls[0][0]).toMatchObject({ id: "cloud", type: "openai", model: "gpt-x" });
  });

  test("存密钥 → aiSetKey；清除 → aiDeleteKey", async () => {
    await mount();
    fireEvent.change(screen.getByTestId("provider-key-input-cloud"), { target: { value: "sk-secret" } });
    fireEvent.click(screen.getByTestId("provider-key-save-cloud"));
    await waitFor(() => expect(apiMocks.aiSetKey).toHaveBeenCalledWith("cloud", "sk-secret"));
    fireEvent.click(screen.getByTestId("provider-key-clear-cloud"));
    await waitFor(() => expect(apiMocks.aiDeleteKey).toHaveBeenCalledWith("cloud"));
  });

  test("测试连接 → 结果内联显示", async () => {
    await mount();
    apiMocks.aiTestConnection.mockResolvedValue({ ok: true, message: "连接成功（gpt-x，回复 1 字符）", tokensIn: 2, tokensOut: 1 });
    fireEvent.click(screen.getByTestId("provider-test-cloud"));
    await waitFor(() =>
      expect(screen.getByTestId("provider-test-result-cloud").textContent).toContain("连接成功"),
    );
  });

  test("路由页签：op→provider + 模型覆盖 + fallback 链 → 保存走 aiSaveAiConfig", async () => {
    await mount();
    fireEvent.click(screen.getByTestId("settings-tab-routes"));
    const row = await screen.findByTestId("route-row-summarize");
    expect(row).toBeInTheDocument();
    // rewrite 路由解析为 provider=local + 模型覆盖 qwen2
    const rewriteRow = screen.getByTestId("route-row-rewrite");
    const modelInput = rewriteRow.querySelectorAll("input")[0] as HTMLInputElement;
    expect(modelInput.value).toBe("qwen2");
    // 改 fallback 链
    const fbInput = row.querySelectorAll("input")[1] as HTMLInputElement;
    fireEvent.change(fbInput, { target: { value: "local,cloud:gpt-y" } });
    fireEvent.click(screen.getByTestId("routes-save"));
    await waitFor(() => expect(apiMocks.aiSaveAiConfig).toHaveBeenCalled());
    const [routes, fallbacks, budget] = apiMocks.aiSaveAiConfig.mock.calls[0];
    expect(routes.summarize).toBe("cloud");
    expect(routes.rewrite).toBe("local:qwen2");
    expect(fallbacks.summarize).toBe("local,cloud:gpt-y");
    expect(budget).toEqual({ dailyCents: 100, monthlyCents: 3000, paused: false });
  });

  test("预算页签：当前用量 + 暂停开关 → 保存", async () => {
    apiMocks.aiUsage.mockResolvedValue([{ periodKey: "2026-08-19", op: "summarize", model: "gpt-x", provider: "cloud", tokensIn: 100, tokensOut: 50, cents: 12, calls: 2 }]);
    await mount();
    fireEvent.click(screen.getByTestId("settings-tab-budget"));
    await waitFor(() => expect(screen.getByTestId("budget-current").textContent).toContain("12"));
    fireEvent.click(screen.getByTestId("budget-paused"));
    fireEvent.click(screen.getByTestId("budget-save"));
    await waitFor(() => expect(apiMocks.aiSaveAiConfig).toHaveBeenCalled());
    const budget = apiMocks.aiSaveAiConfig.mock.calls[0][2];
    expect(budget.paused).toBe(true);
  });

  test("用量页签：表格渲染 + 清空留痕（confirm）", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    apiMocks.aiUsage.mockResolvedValue([{ periodKey: "2026-08", op: "qa", model: "qwen", provider: "local", tokensIn: 10, tokensOut: 20, cents: 0, calls: 3 }]);
    await mount();
    fireEvent.click(screen.getByTestId("settings-tab-usage"));
    const row = await screen.findByTestId("usage-row");
    expect(row.textContent).toContain("qa");
    fireEvent.click(screen.getByTestId("usage-clear"));
    await waitFor(() => expect(apiMocks.aiClearCalls).toHaveBeenCalled());
    expect(confirmSpy).toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  test("confirm 取消时不清空留痕", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    await mount();
    fireEvent.click(screen.getByTestId("settings-tab-usage"));
    fireEvent.click(await screen.findByTestId("usage-clear"));
    expect(apiMocks.aiClearCalls).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
});
