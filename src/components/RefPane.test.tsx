import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { RefPane } from "./RefPane";

const readPostMock = vi.fn();
const resolveWikiMock = vi.fn();

vi.mock("../lib/api", () => ({
  api: {
    readPost: (...a: unknown[]) => readPostMock(...a),
    resolveWiki: (...a: unknown[]) => resolveWikiMock(...a),
  },
}));

import { useApp } from "../stores/app";

const post = (id: string, title: string, body: string) => ({
  id,
  title,
  folder: null,
  status: "draft",
  tags: [] as string[],
  body,
  path: `posts/${id}.md`,
  assoc: null,
});

describe("RefPane（分栏·只读参考栏）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useApp.setState({
      pane2: null,
      pane2LastId: null,
      view: { kind: "post" },
      selectedId: null,
      selected: null,
      flushFn: null,
    });
  });

  test("无 pane2 时不渲染", () => {
    const { container } = render(<RefPane />);
    expect(container).toBeEmptyDOMElement();
  });

  test("渲染标题、wiki 正文与字数；关闭清空 pane2 并记住最近一篇", () => {
    useApp.setState({ pane2: post("p1", "参考篇", "Hello world") });
    render(<RefPane />);
    expect(screen.getByTestId("ref-pane")).toBeInTheDocument();
    expect(screen.getByText(/参考篇/)).toBeInTheDocument();
    expect(screen.getByTestId("ref-body").textContent).toContain("Hello world");
    expect(screen.getByText(/共 \d+ 字/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("ref-close"));
    expect(useApp.getState().pane2).toBeNull();
    expect(useApp.getState().pane2LastId).toBe("p1");
  });

  test("closePane2 后 togglePane2 重开最近一篇", async () => {
    readPostMock.mockResolvedValue(post("p9", "九", "九的正文"));
    useApp.setState({ pane2: post("p9", "九", "九的正文"), pane2LastId: "p9" });
    useApp.getState().closePane2();
    expect(useApp.getState().pane2).toBeNull();
    await useApp.getState().togglePane2();
    expect(useApp.getState().pane2?.id).toBe("p9");
  });

  test("wiki 链接点击：唯一命中文稿 → 本栏加载该篇（主栏不动）", async () => {
    resolveWikiMock.mockResolvedValue({ matched: { kind: "post", id: "p2", title: "目标" }, candidates: [] });
    readPostMock.mockResolvedValue(post("p2", "目标", "正文 B"));
    useApp.setState({ pane2: post("p1", "参考篇", "看 [[目标]]") });
    render(<RefPane />);
    fireEvent.click(screen.getByText("目标"));
    await waitFor(() => expect(useApp.getState().pane2?.id).toBe("p2"));
    expect(useApp.getState().selectedId).toBeNull();
  });

  test("悬空 wiki 链接 → 顶部提示，本栏不跳转", async () => {
    resolveWikiMock.mockResolvedValue({ matched: null, candidates: [] });
    useApp.setState({ pane2: post("p1", "参考篇", "看 [[幽灵]]") });
    render(<RefPane />);
    fireEvent.click(screen.getByText("幽灵"));
    await waitFor(() => expect(screen.getByTestId("ref-note").textContent).toContain("幽灵"));
    expect(useApp.getState().pane2?.id).toBe("p1");
  });

  test("换到主栏：参考篇成为主栏文稿，原主栏篇移入参考栏", async () => {
    readPostMock.mockImplementation(async (id: string) => post(id, `篇${id}`, `正文${id}`));
    useApp.setState({
      pane2: post("p1", "参考篇", "参考正文"),
      selectedId: "main1",
      selected: post("main1", "主篇", "主正文"),
    });
    render(<RefPane />);
    fireEvent.click(screen.getByTestId("ref-swap"));
    await waitFor(() => {
      expect(useApp.getState().selectedId).toBe("p1");
      expect(useApp.getState().pane2?.id).toBe("main1");
    });
  });
});
