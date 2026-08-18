import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { TrashPanel } from "./TrashPanel";

const apiMocks = vi.hoisted(() => ({
  listTrash: vi.fn(),
  restorePost: vi.fn(),
  listPosts: vi.fn(),
  listSnapshots: vi.fn(),
}));

vi.mock("../lib/api", () => ({ api: apiMocks }));

import { useApp } from "../stores/app";

const item = (id: string, title: string, folder: string | null, daysLeft: number) => ({
  id,
  title,
  folder,
  deletedAt: "2026-08-10T10:00:00",
  daysLeft,
});

async function open(trash: ReturnType<typeof item>[]) {
  apiMocks.listTrash.mockResolvedValue(trash);
  apiMocks.listPosts.mockResolvedValue({ tree: [], posts: [] });
  useApp.setState({ trashOpen: true, trash, loading: false, flushFn: null });
  render(<TrashPanel />);
  await screen.findByTestId("trash-panel");
}

describe("TrashPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.restorePost.mockResolvedValue({});
    apiMocks.listPosts.mockResolvedValue({ tree: [], posts: [] });
  });

  test("列出已删文稿：标题/原虚拟目录/剩余天数", async () => {
    await open([item("p1", "旧文一篇", "技术/分布式", 21)]);
    expect(screen.getByText("旧文一篇")).toBeInTheDocument();
    expect(screen.getByText(/技术\/分布式/)).toBeInTheDocument();
    expect(screen.getByText("剩 21 天")).toBeInTheDocument();
  });

  test("恢复 → restorePost → 从列表消失", async () => {
    apiMocks.listTrash
      .mockResolvedValueOnce([item("p1", "旧文一篇", null, 10)])
      .mockResolvedValueOnce([]);
    useApp.setState({ trashOpen: true, trash: [item("p1", "旧文一篇", null, 10)], loading: false, flushFn: null });
    render(<TrashPanel />);
    fireEvent.click(await screen.findByTestId("trash-restore"));
    await waitFor(() => expect(apiMocks.restorePost).toHaveBeenCalledWith("p1"));
    await waitFor(() => expect(screen.getByTestId("trash-empty")).toBeInTheDocument());
  });

  test("无永久删除按钮（原则 7）", async () => {
    await open([item("p1", "旧文", null, 5)]);
    expect(screen.queryByText(/彻底删除|永久删除/)).not.toBeInTheDocument();
  });

  test("空回收站空状态；关闭后不渲染", async () => {
    await open([]);
    expect(screen.getByTestId("trash-empty")).toBeInTheDocument();
    useApp.getState().setTrashOpen(false);
    await waitFor(() => expect(screen.queryByTestId("trash-panel")).not.toBeInTheDocument());
  });
});
