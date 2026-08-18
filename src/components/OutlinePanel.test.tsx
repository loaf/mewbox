import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OutlinePanel } from "./OutlinePanel";

import { useApp } from "../stores/app";

describe("OutlinePanel", () => {
  test("渲染层级缩进列表；空正文显示空状态", () => {
    useApp.setState({
      selected: { id: "p1", title: "T", folder: null, status: "draft", tags: [], body: "# 甲\n\n## 乙\n\n### 丙" },
      viewMode: "edit",
    });
    render(<OutlinePanel />);
    expect(screen.getByText("甲")).toBeInTheDocument();
    expect(screen.getByText("乙")).toBeInTheDocument();
    expect(screen.getByText("丙")).toBeInTheDocument();

    act(() => {
      useApp.setState({
        selected: { id: "p1", title: "T", folder: null, status: "draft", tags: [], body: "无标题正文" },
      });
    });
    expect(screen.getByText(/暂无标题结构/)).toBeInTheDocument();
  });

  test("点击项触发跳转（预览模式下滚动到锚点）", async () => {
    const el = document.createElement("h2");
    el.id = "user-content-乙";
    el.scrollIntoView = vi.fn();
    document.body.appendChild(el);
    useApp.setState({
      selected: { id: "p1", title: "T", folder: null, status: "draft", tags: [], body: "## 乙" },
      viewMode: "preview",
    });
    render(<OutlinePanel />);
    await userEvent.click(screen.getByText("乙"));
    expect(el.scrollIntoView).toHaveBeenCalled();
    el.remove();
  });
});
