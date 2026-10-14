import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HistoryPanel } from "./HistoryPanel";

const apiMocks = vi.hoisted(() => ({
  listSnapshots: vi.fn(),
  readSnapshot: vi.fn(),
  restoreSnapshot: vi.fn(),
  setSnapshotMilestone: vi.fn(),
  readPost: vi.fn(),
  listVersionSnapshots: vi.fn(),
  readVersionSnapshot: vi.fn(),
  restoreVersionSnapshot: vi.fn(),
  setVersionMilestone: vi.fn(),
  readPublishVersion: vi.fn(),
}));

const storeState = vi.hoisted(() => ({
  view: { kind: "post" } as { kind: "post" } | { kind: "version"; baseId: string; target: string },
  selectedId: "p1",
  // stores/pane 的 useActiveValue 按活动栏取主/次栏字段：主栏即本 mock 的裸名字段
  activePane: "primary" as "primary" | "secondary",
  reloadPost: async () => {},
  reloadVersion: async () => {},
}));

vi.mock("../lib/api", () => ({ api: apiMocks }));
vi.mock("../stores/app", () => ({
  useApp: (sel: (s: unknown) => unknown) => sel(storeState),
}));

const SNAP = (ts: string, hash8: string, milestone: string | null = null) => ({
  fileName: `${ts.replace(/[-:T]/g, "").slice(0, 15)}-${hash8}.md`,
  ts,
  tsUtc: ts,
  hash8,
  milestone,
});

describe("HistoryPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    apiMocks.readPost.mockResolvedValue({ id: "p1", title: "T", folder: null, status: "draft", tags: [], body: "当前内容\n第二行" });
  });

  test("渲染快照列表：时间/哈希/里程碑 chip；无快照时空状态", async () => {
    apiMocks.listSnapshots.mockResolvedValue([
      SNAP("2026-08-18T10:00:00", "aaaa1111", "初稿"),
      SNAP("2026-08-18T11:00:00", "bbbb2222"),
    ]);
    const { unmount } = render(<HistoryPanel />);
    expect(await screen.findByTestId("history-list")).toBeInTheDocument();
    expect(screen.getByText(/初稿/)).toBeInTheDocument();
    expect(screen.getByText("bbbb2222")).toBeInTheDocument();
    unmount();

    apiMocks.listSnapshots.mockResolvedValue([]);
    render(<HistoryPanel />);
    expect(await screen.findByTestId("history-empty")).toBeInTheDocument();
  });

  test("选中快照 → diff 显示增删行（+当前/－快照）", async () => {
    apiMocks.listSnapshots.mockResolvedValue([SNAP("2026-08-18T10:00:00", "aaaa1111")]);
    apiMocks.readSnapshot.mockResolvedValue("旧内容\n共同行");
    apiMocks.readPost.mockResolvedValue({ id: "p1", title: "T", folder: null, status: "draft", tags: [], body: "共同行\n新内容" });
    render(<HistoryPanel />);
    await screen.findByTestId("history-list");
    fireEvent.click(screen.getByTestId("snapshot-item"));
    await waitFor(() => expect(screen.getByTestId("diff-view")).toBeInTheDocument());
    const diff = screen.getByTestId("diff-view");
    expect(within(diff).getByText(/－旧内容/)).toBeInTheDocument();
    expect(within(diff).getByText(/＋新内容/)).toBeInTheDocument();
  });

  test("恢复需确认弹窗 → restoreSnapshot → 刷新列表（恢复产生新快照，列表 +1）", async () => {
    apiMocks.listSnapshots.mockResolvedValue([SNAP("2026-08-18T10:00:00", "aaaa1111")]);
    apiMocks.restoreSnapshot.mockResolvedValue({ id: "p1", title: "T", folder: null, status: "draft", tags: [], body: "旧内容", path: "posts/p1.md" });
    render(<HistoryPanel />);
    await screen.findByTestId("history-list");
    fireEvent.click(screen.getByTestId("restore-btn"));
    await waitFor(() => expect(apiMocks.restoreSnapshot).toHaveBeenCalledWith("p1", expect.stringContaining("aaaa1111")));
    expect(window.confirm).toHaveBeenCalled();
    // 刷新：第二次 listSnapshots 被调用
    await waitFor(() => expect(apiMocks.listSnapshots.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  test("取消确认则不恢复", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    apiMocks.listSnapshots.mockResolvedValue([SNAP("2026-08-18T10:00:00", "aaaa1111")]);
    render(<HistoryPanel />);
    await screen.findByTestId("history-list");
    fireEvent.click(screen.getByTestId("restore-btn"));
    await waitFor(() => expect(window.confirm).toHaveBeenCalled());
    expect(apiMocks.restoreSnapshot).not.toHaveBeenCalled();
  });

  test("里程碑命名 → setSnapshotMilestone → 刷新", async () => {
    apiMocks.listSnapshots.mockResolvedValue([SNAP("2026-08-18T10:00:00", "aaaa1111")]);
    apiMocks.setSnapshotMilestone.mockResolvedValue(undefined);
    render(<HistoryPanel />);
    await screen.findByTestId("history-list");
    fireEvent.click(screen.getByTestId("milestone-btn"));
    const input = screen.getByTestId("milestone-input");
    await userEvent.type(input, "交稿版{Enter}");
    await waitFor(() =>
      expect(apiMocks.setSnapshotMilestone).toHaveBeenCalledWith(
        "p1",
        expect.stringContaining("aaaa1111"),
        "交稿版",
      ),
    );
  });

  test("版本态下列表/恢复走版本历史命令", async () => {
    storeState.view = { kind: "version", baseId: "p1", target: "wechat" };
    apiMocks.listVersionSnapshots.mockResolvedValue([SNAP("2026-08-18T10:00:00", "vvvv0001")]);
    apiMocks.readPublishVersion.mockResolvedValue({
      id: "v1", base: "p1", target: "wechat", title: "T", body: "版本当前", publishedUrl: null, publishedAt: null, path: ".versions/p1/publish/wechat.md",
    });
    apiMocks.restoreVersionSnapshot.mockResolvedValue({});
    render(<HistoryPanel />);
    await screen.findByTestId("history-list");
    expect(apiMocks.listVersionSnapshots).toHaveBeenCalledWith("p1", "wechat");
    fireEvent.click(screen.getByTestId("restore-btn"));
    await waitFor(() =>
      expect(apiMocks.restoreVersionSnapshot).toHaveBeenCalledWith("p1", "wechat", expect.stringContaining("vvvv0001")),
    );
    storeState.view = { kind: "post" };
  });
});
