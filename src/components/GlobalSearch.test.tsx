import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { GlobalSearch } from "./GlobalSearch";
import { useApp } from "../stores/app";

const apiMocks = vi.hoisted(() => ({
  searchAll: vi.fn().mockResolvedValue([]),
}));
vi.mock("../lib/api", () => ({ api: apiMocks }));

const hits = [
  { id: "p1", path: "posts/a.md", title: "深度工作实践记", kind: "post" },
  { id: "m1", path: "kb/研究/note.md", title: "深度学习研究", kind: "material" },
  {
    id: "v1",
    path: ".versions/p1/publish/wechat.md",
    title: "深度工作（公众号版）",
    kind: "publish",
  },
];

function openOverlay() {
  useApp.setState({ searchOpen: true });
}

describe("GlobalSearch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useApp.setState({
      searchOpen: false,
      select: vi.fn().mockResolvedValue(undefined),
      selectMaterial: vi.fn().mockResolvedValue(undefined),
      selectVersion: vi.fn().mockResolvedValue(undefined),
    });
  });

  test("输入回车 → api.searchAll(query, false)，分组渲染文稿/资料/发布版本", async () => {
    apiMocks.searchAll.mockResolvedValue(hits);
    openOverlay();
    render(<GlobalSearch />);
    fireEvent.change(screen.getByTestId("global-search-input"), { target: { value: "深度" } });
    fireEvent.keyDown(screen.getByTestId("global-search-input"), { key: "Enter" });
    await waitFor(() => expect(apiMocks.searchAll).toHaveBeenCalledWith("深度", false));
    await waitFor(() => expect(screen.getByTestId("global-search-group-post").textContent).toContain("文稿"));
    expect(screen.getByTestId("global-search-group-material").textContent).toContain("资料");
    expect(screen.getByTestId("global-search-group-publish").textContent).toContain("发布版本");
    // 命中词高亮
    expect(screen.getByTestId("global-search-hit-p1").querySelector("mark")?.textContent).toBe("深度");
  });

  test("勾选「包含发布版本」后再搜 → searchAll(…, true)", async () => {
    apiMocks.searchAll.mockResolvedValue([]);
    openOverlay();
    render(<GlobalSearch />);
    fireEvent.click(screen.getByTestId("global-search-versions"));
    fireEvent.change(screen.getByTestId("global-search-input"), { target: { value: "迁移" } });
    fireEvent.click(screen.getByTestId("global-search-btn"));
    await waitFor(() => expect(apiMocks.searchAll).toHaveBeenCalledWith("迁移", true));
  });

  test("点击文稿/资料/发布版本命中 → select / selectMaterial / selectVersion(base, target)", async () => {
    apiMocks.searchAll.mockResolvedValue(hits);
    openOverlay();
    render(<GlobalSearch />);
    fireEvent.change(screen.getByTestId("global-search-input"), { target: { value: "深度" } });
    fireEvent.click(screen.getByTestId("global-search-btn"));
    await waitFor(() => screen.getByTestId("global-search-hit-p1"));

    fireEvent.click(screen.getByTestId("global-search-hit-p1"));
    await waitFor(() => expect(useApp.getState().select).toHaveBeenCalledWith("p1"));

    useApp.setState({ searchOpen: true });
    fireEvent.click(await screen.findByTestId("global-search-hit-m1"));
    await waitFor(() => expect(useApp.getState().selectMaterial).toHaveBeenCalledWith("m1"));

    useApp.setState({ searchOpen: true });
    fireEvent.click(await screen.findByTestId("global-search-hit-v1"));
    await waitFor(() =>
      expect(useApp.getState().selectVersion).toHaveBeenCalledWith("p1", "wechat"),
    );
    // 点击后覆盖层关闭
    await waitFor(() => expect(useApp.getState().searchOpen).toBe(false));
  });

  test("Ctrl+Shift+F 打开覆盖层（组件常驻监听）", () => {
    render(<GlobalSearch />);
    expect(screen.queryByTestId("global-search")).toBeNull();
    fireEvent.keyDown(window, { key: "f", ctrlKey: true, shiftKey: true });
    expect(screen.getByTestId("global-search")).toBeInTheDocument();
    expect(screen.getByTestId("global-search-input")).toHaveFocus();
  });

  test("空结果提示", async () => {
    apiMocks.searchAll.mockResolvedValue([]);
    openOverlay();
    render(<GlobalSearch />);
    fireEvent.change(screen.getByTestId("global-search-input"), { target: { value: "不存在词" } });
    fireEvent.click(screen.getByTestId("global-search-btn"));
    await waitFor(() => expect(screen.getByTestId("global-search-empty")).toBeInTheDocument());
  });
});
