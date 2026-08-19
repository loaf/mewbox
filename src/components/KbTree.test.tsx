import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { KbTree } from "./KbTree";

const dialogMocks = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: (...a: unknown[]) => dialogMocks.open(...a) }));

const apiMocks = vi.hoisted(() => ({
  readMaterial: vi.fn(),
  createMaterial: vi.fn(),
  renameMaterialFile: vi.fn().mockResolvedValue({}),
  moveMaterial: vi.fn().mockResolvedValue({}),
  renameKbDir: vi.fn().mockResolvedValue([]),
  convertMaterialToPost: vi.fn(),
  moveMaterialToTrash: vi.fn().mockResolvedValue(undefined),
  importMdFiles: vi.fn().mockResolvedValue([]),
  importFilesContainerized: vi.fn().mockResolvedValue([]),
  listPosts: vi.fn().mockResolvedValue({ tree: [], posts: [] }),
  listTrash: vi.fn().mockResolvedValue([]),
  listMaterialTrash: vi.fn().mockResolvedValue([]),
  listMaterials: vi.fn().mockResolvedValue([]),
  listAllVersions: vi.fn().mockResolvedValue([]),
  workspaceRoot: vi.fn().mockResolvedValue(""),
  readPost: vi.fn(),
}));

vi.mock("../lib/api", () => ({ api: apiMocks }));

import { useApp } from "../stores/app";
import type { MaterialSummary, TrashItem } from "../lib/api";

const mat = (id: string, title: string, folder: string | null): MaterialSummary => ({
  id,
  title,
  path: `kb/${folder ? `${folder}/` : ""}${id}.md`,
  folder,
  updatedAt: "2026-08-19T10:00:00",
});

const M1 = mat("m1", "设计笔记", "研究");
const M2 = mat("m2", "待整理资料", "Inbox");
const M3 = mat("m3", "子目录资料", "研究/子目录");

async function mount(materials: MaterialSummary[], materialTrash: TrashItem[] = []) {
  useApp.setState({
    materials,
    materialTrash,
    view: { kind: "post" },
    material: null,
    selectedId: null,
    selected: null,
    flushFn: null,
    loading: false,
  });
  render(<KbTree />);
}

describe("KbTree", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dialogMocks.open.mockResolvedValue(null);
    useApp.setState({ trashOpen: false });
  });

  test("渲染物理目录树：Inbox 第一，资料挂目录下，点击资料进入 material 视图", async () => {
    apiMocks.readMaterial.mockResolvedValue({
      id: "m2", title: "待整理资料", body: "内容", path: "kb/Inbox/m2.md", folder: "Inbox", assoc: null,
    });
    await mount([M1, M2, M3]);
    expect(screen.getByTestId("kb-folder-Inbox")).toBeInTheDocument();
    expect(screen.getByTestId("kb-folder-研究")).toBeInTheDocument();
    expect(screen.getByTestId("kb-folder-研究-子目录")).toBeInTheDocument();
    // Inbox 排最前
    const ids = screen.getAllByTestId(/^kb-folder-/).map((el) => el.getAttribute("data-testid"));
    expect(ids.indexOf("kb-folder-Inbox")).toBe(0);
    fireEvent.click(screen.getByText("待整理资料"));
    await waitFor(() => expect(useApp.getState().view).toEqual({ kind: "material", id: "m2" }));
  });

  test("资料右键菜单：打开/重命名/移动/升格为文稿/移入回收站", async () => {
    await mount([M2]);
    fireEvent.contextMenu(screen.getByText("待整理资料"));
    expect(screen.getByTestId("kb-context-menu")).toBeInTheDocument();
    for (const id of ["kb-menu-open", "kb-menu-rename", "kb-menu-move", "kb-menu-convert-post", "kb-menu-trash"]) {
      expect(screen.getByTestId(id)).toBeInTheDocument();
    }
  });

  test("升格为文稿 → convert_material_to_post → load → 选中新文稿", async () => {
    apiMocks.convertMaterialToPost.mockResolvedValue({ id: "p9", title: "设计笔记", folder: null, status: "draft", tags: [], path: "posts/x.md", updatedAt: "t" });
    apiMocks.readPost.mockResolvedValue({ id: "p9", title: "设计笔记", folder: null, status: "draft", tags: [], body: "", path: "posts/x.md" });
    await mount([M2]);
    fireEvent.contextMenu(screen.getByText("待整理资料"));
    fireEvent.click(screen.getByTestId("kb-menu-convert-post"));
    await waitFor(() => expect(apiMocks.convertMaterialToPost).toHaveBeenCalledWith("m2"));
    await waitFor(() => expect(useApp.getState().view).toEqual({ kind: "post" }));
    await waitFor(() => expect(useApp.getState().selectedId).toBe("p9"));
  });

  test("移入回收站：confirm 后 moveMaterialToTrash；当前编辑中的资料退出编辑", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await mount([M2]);
    useApp.setState({ view: { kind: "material", id: "m2" } });
    fireEvent.contextMenu(screen.getByText("待整理资料"));
    fireEvent.click(screen.getByTestId("kb-menu-trash"));
    await waitFor(() => expect(apiMocks.moveMaterialToTrash).toHaveBeenCalledWith("m2"));
    await waitFor(() => expect(useApp.getState().view).toEqual({ kind: "post" }));
  });

  test("重命名/移动资料与目录改名走对应命令", async () => {
    apiMocks.listMaterials.mockResolvedValue([M1, M3]); // load 后树仍在
    await mount([M1, M3]);
    // 重命名资料文件
    fireEvent.contextMenu(screen.getByText("设计笔记"));
    fireEvent.click(screen.getByTestId("kb-menu-rename"));
    const input = screen.getByTestId("kb-rename-input");
    await userEvent.clear(input);
    await userEvent.type(input, "renamed{Enter}");
    await waitFor(() => expect(apiMocks.renameMaterialFile).toHaveBeenCalledWith("m1", "renamed"));
    // 移动资料
    fireEvent.contextMenu(await screen.findByText("设计笔记"));
    fireEvent.click(screen.getByTestId("kb-menu-move"));
    await userEvent.clear(screen.getByTestId("kb-move-input"));
    await userEvent.type(screen.getByTestId("kb-move-input"), "论文{Enter}");
    await waitFor(() => expect(apiMocks.moveMaterial).toHaveBeenCalledWith("m1", "论文"));
    // 目录改名（kb 前缀由前端拼）
    fireEvent.contextMenu(screen.getByTestId("kb-folder-研究").firstElementChild!);
    fireEvent.click(screen.getByTestId("kb-menu-rename-dir"));
    await userEvent.clear(screen.getByTestId("kb-rename-dir-input"));
    await userEvent.type(screen.getByTestId("kb-rename-dir-input"), "调研{Enter}");
    await waitFor(() => expect(apiMocks.renameKbDir).toHaveBeenCalledWith("kb/研究", "调研"));
  });

  test("目录右键：重命名目录/新建资料（预设目录）", async () => {
    await mount([M2]);
    fireEvent.contextMenu(screen.getByTestId("kb-folder-Inbox").firstElementChild!);
    expect(screen.getByTestId("kb-menu-rename-dir")).toBeInTheDocument();
    expect(screen.getByTestId("kb-menu-new-material")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("kb-menu-new-material"));
    expect(screen.getByTestId("kb-new-dialog")).toBeInTheDocument();
    expect((screen.getByTestId("kb-new-dir") as HTMLInputElement).value).toBe("Inbox");
  });

  test("新建资料：标题 + 目录 → createMaterial → 选中", async () => {
    apiMocks.createMaterial.mockResolvedValue({
      id: "m9", title: "新资料", body: "", path: "kb/Inbox/m9.md", folder: "Inbox", assoc: null,
    });
    apiMocks.readMaterial.mockResolvedValue({
      id: "m9", title: "新资料", body: "", path: "kb/Inbox/m9.md", folder: "Inbox", assoc: null,
    });
    await mount([]);
    fireEvent.click(screen.getByTestId("kb-new-material"));
    await userEvent.type(screen.getByTestId("kb-new-title"), "新资料");
    fireEvent.click(screen.getByTestId("kb-new-confirm"));
    await waitFor(() => expect(apiMocks.createMaterial).toHaveBeenCalledWith("新资料", "Inbox"));
    await waitFor(() => expect(useApp.getState().view).toEqual({ kind: "material", id: "m9" }));
  });

  test("导入：.md 走 importMdFiles（当前资料目录），其他文件容器化", async () => {
    dialogMocks.open.mockResolvedValue(["C:/tmp/a.md", "C:/tmp/论文.pdf"]);
    await mount([M2]);
    useApp.setState({
      view: { kind: "material", id: "m2" },
      material: { id: "m2", title: "待整理资料", body: "", path: "kb/Inbox/m2.md", folder: "Inbox", assoc: null },
    });
    fireEvent.click(screen.getByTestId("kb-import"));
    await waitFor(() =>
      expect(apiMocks.importMdFiles).toHaveBeenCalledWith(["C:/tmp/a.md"], "Inbox"),
    );
    await waitFor(() =>
      expect(apiMocks.importFilesContainerized).toHaveBeenCalledWith(["C:/tmp/论文.pdf"]),
    );
  });

  test("资料回收站入口：显示计数，点击打开回收站面板", async () => {
    await mount([M2], [{ id: "m1", title: "旧资料", folder: null, deletedAt: "t", daysLeft: 9 }]);
    expect(screen.getByTestId("kb-trash-entry").textContent).toContain("1");
    fireEvent.click(screen.getByTestId("kb-trash-entry"));
    expect(useApp.getState().trashOpen).toBe(true);
  });
});
