import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PublishDialog } from "./PublishDialog";

const apiMocks = vi.hoisted(() => ({
  listPublishVersions: vi.fn(),
  listPublishTargets: vi.fn(),
  listSnapshots: vi.fn(),
  createPublishVersion: vi.fn(),
  addPublishTarget: vi.fn(),
  readPublishVersion: vi.fn(),
  readPost: vi.fn(),
}));

vi.mock("../lib/api", () => ({ api: apiMocks }));

import { useApp } from "../stores/app";

const version = (target: string, published = false) => ({
  id: `id-${target}`,
  base: "p1",
  target,
  title: "T",
  publishedUrl: published ? "https://x" : null,
  publishedAt: published ? "2026-08-20" : null,
  updatedAt: "2026-08-19T10:00:00",
  path: `.versions/p1/publish/${target}.md`,
});

describe("PublishDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.listPublishTargets.mockResolvedValue([{ id: "wechat", display: "微信公众号", note: "" }]);
    apiMocks.listSnapshots.mockResolvedValue([]);
    apiMocks.addPublishTarget.mockResolvedValue(undefined);
    useApp.setState({ view: { kind: "post" }, selectedId: null, selected: null, version: null, flushFn: null });
  });

  test("渲染已有版本列表与已发布 chip；点击打开版本", async () => {
    apiMocks.listPublishVersions.mockResolvedValue([version("wechat", true), version("blog")]);
    apiMocks.readPublishVersion.mockResolvedValue({
      id: "id-wechat", base: "p1", target: "wechat", title: "T", body: "内容", publishedUrl: "https://x", publishedAt: null, path: ".versions/p1/publish/wechat.md",
    });
    render(<PublishDialog open baseId="p1" onClose={vi.fn()} />);
    expect(await screen.findByTestId("version-list")).toBeInTheDocument();
    expect(screen.getByText("wechat")).toBeInTheDocument();
    expect(screen.getByText("已发布")).toBeInTheDocument();
    // 打开已有版本（真实 store 链路：selectVersion → readPublishVersion）
    fireEvent.click(screen.getAllByTestId("open-version")[0]);
    await waitFor(() => expect(apiMocks.readPublishVersion).toHaveBeenCalledWith("p1", "wechat"));
    await waitFor(() =>
      expect(useApp.getState().view).toEqual({ kind: "version", baseId: "p1", target: "wechat" }),
    );
  });

  test("新建版本：输入目标名 → createPublishVersion 并切换版本态；新名入注册表", async () => {
    apiMocks.listPublishVersions.mockResolvedValue([]);
    apiMocks.createPublishVersion.mockResolvedValue({
      id: "v-new", base: "p1", target: "weibo", title: "T", body: "", publishedUrl: null, publishedAt: null, path: ".versions/p1/publish/weibo.md",
    });
    render(<PublishDialog open baseId="p1" onClose={vi.fn()} />);
    await screen.findByTestId("publish-dialog");
    await userEvent.type(screen.getByTestId("new-target-name"), "weibo");
    fireEvent.click(screen.getByTestId("create-version-btn"));
    await waitFor(() => expect(apiMocks.createPublishVersion).toHaveBeenCalledWith("p1", "weibo", null));
    expect(apiMocks.addPublishTarget).toHaveBeenCalledWith("weibo", "weibo", "");
    await waitFor(() => expect(useApp.getState().view).toEqual({ kind: "version", baseId: "p1", target: "weibo" }));
  });

  test("同目标已存在时报错展示（TargetExists）", async () => {
    apiMocks.listPublishVersions.mockResolvedValue([version("wechat")]);
    apiMocks.createPublishVersion.mockRejectedValue("该文稿已有「wechat」版本的发布版本");
    render(<PublishDialog open baseId="p1" onClose={vi.fn()} />);
    await screen.findByTestId("publish-dialog");
    await userEvent.type(screen.getByTestId("new-target-name"), "wechat");
    fireEvent.click(screen.getByTestId("create-version-btn"));
    await waitFor(() => expect(screen.getByTestId("publish-error")).toBeInTheDocument());
  });

  test("从指定历史版本分叉：fromSnapshot 传快照文件名", async () => {
    apiMocks.listPublishVersions.mockResolvedValue([]);
    apiMocks.listSnapshots.mockResolvedValue([
      { fileName: "20260818-090503-8d1f0a1c.md", ts: "2026-08-18T09:05:03", tsUtc: "", hash8: "8d1f0a1c", milestone: null },
    ]);
    apiMocks.createPublishVersion.mockResolvedValue({
      id: "v", base: "p1", target: "blog", title: "T", body: "", publishedUrl: null, publishedAt: null, path: ".versions/p1/publish/blog.md",
    });
    render(<PublishDialog open baseId="p1" onClose={vi.fn()} />);
    await screen.findByTestId("publish-dialog");
    await userEvent.type(screen.getByTestId("new-target-name"), "blog");
    await userEvent.selectOptions(screen.getByTestId("fork-snapshot"), "20260818-090503-8d1f0a1c.md");
    fireEvent.click(screen.getByTestId("create-version-btn"));
    await waitFor(() =>
      expect(apiMocks.createPublishVersion).toHaveBeenCalledWith("p1", "blog", "20260818-090503-8d1f0a1c.md"),
    );
  });

  test("创建前先强制保存母版（flush 先于 createPublishVersion）", async () => {
    apiMocks.listPublishVersions.mockResolvedValue([]);
    apiMocks.createPublishVersion.mockResolvedValue({
      id: "v", base: "p1", target: "weibo", title: "T", body: "x", publishedUrl: null, publishedAt: null, path: ".versions/p1/publish/weibo.md",
    });
    const flush = vi.fn().mockResolvedValue(undefined);
    useApp.setState({ flushFn: flush, selectedId: "p1" });
    render(<PublishDialog open baseId="p1" onClose={vi.fn()} />);
    await screen.findByTestId("publish-dialog");
    await userEvent.type(screen.getByTestId("new-target-name"), "weibo");
    fireEvent.click(screen.getByTestId("create-version-btn"));
    await waitFor(() => expect(apiMocks.createPublishVersion).toHaveBeenCalled());
    expect(flush).toHaveBeenCalled();
    expect(flush.mock.invocationCallOrder[0]).toBeLessThan(
      apiMocks.createPublishVersion.mock.invocationCallOrder[0],
    );
  });
});
