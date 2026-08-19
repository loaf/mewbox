import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { HealthPanel } from "./HealthPanel";

const apiMocks = vi.hoisted(() => ({
  healthCheck: vi.fn(),
  cleanOrphanAssets: vi.fn().mockResolvedValue(1),
}));

vi.mock("../lib/api", () => ({ api: apiMocks }));

const REPORT = {
  brokenLinks: [{ from: "posts/a.md", dest: "kb/missing.md" }],
  trashTargets: [{ from: "posts/a.md", dest: "kb/.trash/x.md" }],
  orphanHistories: ["dead-beef"],
  orphanVersions: ["wechat（base gone）"],
  orphanAssets: ["abc123", "def456"],
};

describe("HealthPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.cleanOrphanAssets.mockResolvedValue(1);
  });

  test("打开即检查：五类清单 + 计数 + 回收站目标提示", async () => {
    apiMocks.healthCheck.mockResolvedValue(REPORT);
    const { unmount } = render(<HealthPanel open onClose={() => {}} />);
    expect(apiMocks.healthCheck).toHaveBeenCalled();
    await screen.findByTestId("health-dialog");
    expect(screen.getByText(/断链（1）/)).toBeInTheDocument();
    expect(screen.getByText(/回收站目标（1）/)).toBeInTheDocument();
    expect(screen.getByText(/目标在回收站/)).toBeInTheDocument();
    expect(screen.getByText(/孤儿历史（1）/)).toBeInTheDocument();
    expect(screen.getByText(/无主发布版本（1）/)).toBeInTheDocument();
    expect(screen.getByText(/孤儿附件（2）/)).toBeInTheDocument();
    expect(screen.getByText(/posts\/a.md → kb\/missing\.md/)).toBeInTheDocument();
    // 关闭状态不渲染
    unmount();
    render(<HealthPanel open={false} onClose={() => {}} />);
    expect(screen.queryByTestId("health-dialog")).toBeNull();
  });

  test("勾选孤儿附件 + 确认 → cleanOrphanAssets(指纹) → 重新检查", async () => {
    apiMocks.healthCheck.mockResolvedValue(REPORT);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<HealthPanel open onClose={() => {}} />);
    await screen.findByTestId("health-dialog");
    const checks = screen.getAllByTestId("health-asset-check");
    fireEvent.click(checks[0]);
    fireEvent.click(screen.getByTestId("health-clean"));
    await waitFor(() => expect(apiMocks.cleanOrphanAssets).toHaveBeenCalledWith(["abc123"]));
    await waitFor(() => expect(apiMocks.healthCheck.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  test("取消确认不清理；无勾选时按钮禁用", async () => {
    apiMocks.healthCheck.mockResolvedValue(REPORT);
    const confirmSpy = vi.spyOn(window, "confirm");
    confirmSpy.mockReturnValue(false);
    render(<HealthPanel open onClose={() => {}} />);
    await screen.findByTestId("health-dialog");
    expect(screen.getByTestId("health-clean")).toBeDisabled();
    fireEvent.click(screen.getAllByTestId("health-asset-check")[0]);
    fireEvent.click(screen.getByTestId("health-clean"));
    expect(confirmSpy).toHaveBeenCalled();
    expect(apiMocks.cleanOrphanAssets).not.toHaveBeenCalled();
  });
});
