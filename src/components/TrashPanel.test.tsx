import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { TrashPanel } from "./TrashPanel";

const apiMocks = vi.hoisted(() => ({
  listTrash: vi.fn(),
  listMaterialTrash: vi.fn(),
  restorePost: vi.fn(),
  restoreMaterial: vi.fn(),
  listPosts: vi.fn(),
  listMaterials: vi.fn(),
  listAllVersions: vi.fn().mockResolvedValue([]),
  workspaceRoot: vi.fn().mockResolvedValue(""),
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

async function open(trash: ReturnType<typeof item>[], materialTrash: ReturnType<typeof item>[] = []) {
  apiMocks.listTrash.mockResolvedValue(trash);
  apiMocks.listMaterialTrash.mockResolvedValue(materialTrash);
  apiMocks.listPosts.mockResolvedValue({ tree: [], posts: [] });
  apiMocks.listMaterials.mockResolvedValue([]);
  useApp.setState({ trashOpen: true, trash, materialTrash, materials: [], loading: false, flushFn: null });
  render(<TrashPanel />);
  await screen.findByTestId("trash-panel");
}

describe("TrashPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.restorePost.mockResolvedValue({});
    apiMocks.restoreMaterial.mockResolvedValue({});
    apiMocks.listMaterialTrash.mockResolvedValue([]);
    apiMocks.listAllVersions.mockResolvedValue([]);
    apiMocks.workspaceRoot.mockResolvedValue("X:/ws");
  });

  test("列出已删文稿：标题/原虚拟目录/剩余天数", async () => {
    await open([item("p1", "旧文一篇", "技术/分布式", 21)]);
    expect(screen.getByText("旧文一篇")).toBeInTheDocument();
    expect(screen.getByText(/技术\/分布式/)).toBeInTheDocument();
    expect(screen.getByText("剩 21 天")).toBeInTheDocument();
  });

  test("文稿/资料两区：资料区列出已删资料并恢复走 restoreMaterial", async () => {
    await open([item("p1", "旧文一篇", null, 10)], [item("m1", "旧资料", "研究", 5)]);
    expect(screen.getByTestId("trash-section-文稿")).toBeInTheDocument();
    const materialSection = screen.getByTestId("trash-section-资料");
    expect(materialSection.textContent).toContain("旧资料");
    expect(materialSection.textContent).toContain("原目录：研究");
    // 点资料区的恢复按钮（第二区的 trash-restore）
    const restoreBtn = materialSection.querySelector('[data-testid="trash-restore"]')!;
    apiMocks.listTrash.mockResolvedValue([item("p1", "旧文一篇", null, 10)]);
    apiMocks.listMaterialTrash.mockResolvedValue([]);
    fireEvent.click(restoreBtn);
    await waitFor(() => expect(apiMocks.restoreMaterial).toHaveBeenCalledWith("m1"));
    await waitFor(() => expect(apiMocks.listMaterials).toHaveBeenCalled());
  });

  test("恢复文稿 → restorePost → load", async () => {
    apiMocks.listTrash
      .mockResolvedValueOnce([item("p1", "旧文一篇", null, 10)])
      .mockResolvedValueOnce([]);
    useApp.setState({ trashOpen: true, trash: [item("p1", "旧文一篇", null, 10)], materialTrash: [], loading: false, flushFn: null });
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
