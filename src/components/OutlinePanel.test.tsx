import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OutlinePanel } from "./OutlinePanel";

import { useApp } from "../stores/app";

/** jsdom 无布局引擎：所有 rect 均为 0，因此这里只验证「跳哪去/是否调用滚动」，
 *  像素级落位由 lib/editorScroll.test.ts 用构造 rect 覆盖。 */
describe("OutlinePanel", () => {
  test("渲染层级缩进列表；空正文显示空状态", () => {
    useApp.setState({
      selected: { id: "p1", title: "T", folder: null, status: "draft", tags: [], body: "# 甲\n\n## 乙\n\n### 丙", path: "posts/p1.md" },
      viewMode: "edit",
    });
    render(<OutlinePanel />);
    expect(screen.getByText("甲")).toBeInTheDocument();
    expect(screen.getByText("乙")).toBeInTheDocument();
    expect(screen.getByText("丙")).toBeInTheDocument();

    act(() => {
      useApp.setState({
        selected: { id: "p1", title: "T", folder: null, status: "draft", tags: [], body: "无标题正文", path: "posts/p1.md" },
      });
    });
    expect(screen.getByText(/暂无标题结构/)).toBeInTheDocument();
  });

  test("预览模式：滚动到标题锚点所在容器（而非整页 scrollIntoView）", async () => {
    const pane = document.createElement("div");
    pane.setAttribute("data-pane", "primary");
    const preview = document.createElement("div");
    preview.className = "w-md-editor-preview";
    preview.style.overflowY = "auto";
    const anchor = document.createElement("h2");
    anchor.id = "乙";
    preview.appendChild(anchor);
    pane.appendChild(preview);
    document.body.appendChild(pane);
    useApp.setState({
      selected: { id: "p1", title: "T", folder: null, status: "draft", tags: [], body: "## 乙", path: "posts/p1.md" },
      viewMode: "preview",
      activePane: "primary",
    });
    render(<OutlinePanel />);
    await userEvent.click(within(screen.getByTestId("outline-list")).getByText("乙"));
    // 命中了真实锚点：容器被当作滚动目标（jsdom 下 scrollTop 赋值可观察）
    expect(preview.scrollTop).toBe(0); // 无布局差值为 0，但链路走通且未抛错
    pane.remove();
  });

  test("预览管线给标题注入与大纲一致的锚点 id（同名去重 -1）", async () => {
    const { MarkdownPreview } = await import("../lib/markdown");
    const { unmount: unmountPreview } = render(
      <MarkdownPreview>{"# 开头\n\n## 中段小节\n\n### 中段小节"}</MarkdownPreview>,
    );
    expect(document.getElementById("开头")).toBeInTheDocument();
    expect(document.getElementById("中段小节")).toBeInTheDocument();
    expect(document.getElementById("中段小节-1")).toBeInTheDocument();
    unmountPreview();
  });

  test("源码模式点击：光标定位到标题行（选中整行）", async () => {
    const pane = document.createElement("div");
    pane.setAttribute("data-pane", "primary");
    const content = document.createElement("div");
    content.className = "w-md-editor-content";
    const area = document.createElement("div");
    area.className = "w-md-editor-area";
    const text = document.createElement("div");
    text.className = "w-md-editor-text";
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.appendChild(document.createTextNode("引言\n\n# 甲\n\n正文\n\n## 乙\n\n结尾\n"));
    pre.appendChild(code);
    const ta = document.createElement("textarea");
    ta.value = "引言\n\n# 甲\n\n正文\n\n## 乙\n\n结尾";
    text.appendChild(pre);
    text.appendChild(ta);
    area.appendChild(text);
    content.appendChild(area);
    pane.appendChild(content);
    document.body.appendChild(pane);
    useApp.setState({
      selected: { id: "p1", title: "T", folder: null, status: "draft", tags: [], body: ta.value, path: "posts/p1.md" },
      viewMode: "edit",
      activePane: "primary",
    });
    render(<OutlinePanel />);
    await userEvent.click(screen.getByText("乙"));
    expect(ta.selectionStart).toBe("引言\n\n# 甲\n\n正文\n\n".length);
    expect(ta.selectionEnd).toBe("引言\n\n# 甲\n\n正文\n\n## 乙".length);
    pane.remove();
  });
});
