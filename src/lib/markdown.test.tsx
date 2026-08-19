import { renderToStaticMarkup } from "react-dom/server";
import { render, screen, waitFor } from "@testing-library/react";
import remarkGfm from "remark-gfm";
import { MarkdownPreview, editorPreviewOptions, remarkSubSuper, resolveAssetSrc, assetContext, withWikiLinks, wikiTitleFromAnchor } from "./markdown";

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async (id: string, code: string) => ({ svg: `<svg data-id="${id}">${code}</svg>` })),
  },
}));

const renderStatic = (md: string) => renderToStaticMarkup(<MarkdownPreview>{md}</MarkdownPreview>);

describe("markdown 渲染扩展", () => {
  test("==高亮== 渲染为 <mark>", () => {
    const html = renderStatic("普通 ==重点内容== 普通");
    expect(html).toContain("<mark>重点内容</mark>");
  });

  test("~下标~ 与 ^上标^ 渲染", () => {
    const html = renderStatic("H~2~O 与 x^2^");
    expect(html).toContain("<sub>2</sub>");
    expect(html).toContain("<sup>2</sup>");
    // GFM 删除线不受影响
    const del = renderStatic("~~删除~~");
    expect(del).toContain("<del>删除</del>");
  });

  test("表格/任务列表/删除线/脚注 走 remark-gfm", () => {
    const table = renderStatic("| a | b |\n| --- | --- |\n| 1 | 2 |");
    expect(table).toContain("<table>");
    const task = renderStatic("- [x] 完成\n- [ ] 待办");
    expect(task).toContain('type="checkbox"');
    const footnote = renderStatic("正文[^1]\n\n[^1]: 注释内容");
    expect(footnote.toLowerCase()).toContain("footnote");
  });

  test("$..$ 与 $$..$$ 走 KaTeX", () => {
    const inline = renderStatic("公式 $E=mc^2$ 结束");
    expect(inline).toContain("katex");
    const block = renderStatic("$$\n\\int_0^1 x dx\n$$");
    expect(block).toContain("katex-display");
  });

  test("emoji 扩展", () => {
    const html = renderStatic("好棒 :+1:");
    expect(html).toContain("👍");
  });

  test("mermaid 块渲染 svg，重复渲染 id 唯一（live 模式不冲突）", async () => {
    const { rerender } = render(<MarkdownPreview>{"```mermaid\ngraph TD\nA-->B\n```"}</MarkdownPreview>);
    await waitFor(() => expect(screen.getByText(/A-->B/)).toBeInTheDocument());
    rerender(<MarkdownPreview>{"```mermaid\ngraph TD\nB-->C\n```"}</MarkdownPreview>);
    await waitFor(() => expect(screen.getByText(/B-->C/)).toBeInTheDocument());
    const mermaid = (await import("mermaid")).default;
    expect(mermaid.render).toHaveBeenCalledTimes(2);
    const ids = vi.mocked(mermaid.render).mock.calls.map((c) => c[0]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("resolveAssetSrc：相对引用映射为 asset URL；外链/锚点/越根原样", () => {
    const backup = { ...assetContext };
    assetContext.root = "X:/ws";
    assetContext.baseDir = ".versions/p1/publish";
    // 版本里的贴图引用（Tauri 环境 asset.localhost；jsdom 退化 file:///）
    const url = resolveAssetSrc("../../../_assets/abc.png");
    expect(url).toMatch(/asset\.localhost|file:\/\/\//);
    expect(url).toContain("_assets");
    // 文稿目录
    assetContext.baseDir = "posts";
    expect(resolveAssetSrc("../_assets/a.png")).toMatch(/asset\.localhost|file:\/\/\//);
    // 外链/锚点/data 原样
    expect(resolveAssetSrc("https://x.com/a.png")).toBe("https://x.com/a.png");
    expect(resolveAssetSrc("#sec")).toBe("#sec");
    expect(resolveAssetSrc("data:image/png;base64,xxx")).toBe("data:image/png;base64,xxx");
    // 根未就绪 → 原样（测试/降级路径）
    assetContext.root = "";
    expect(resolveAssetSrc("../_assets/a.png")).toBe("../_assets/a.png");
    Object.assign(assetContext, backup);
  });

  test("pluginsFilter 剔除 @uiw 追加的裸 remark-gfm，保留带配置的元组", () => {
    const remarkAlert = vi.fn() as never;
    const tuple = [remarkGfm, { singleTilde: false }] as never;
    const plugins = [remarkAlert, remarkSubSuper as never, tuple, remarkGfm] as never[];
    const filtered = editorPreviewOptions.pluginsFilter("remark", plugins);
    expect(filtered).toHaveLength(3);
    expect(filtered).not.toContain(remarkGfm);
    expect(filtered).toContain(tuple);
    // rehype 插件不动
    const rehype = [1, 2] as never[];
    expect(editorPreviewOptions.pluginsFilter("rehype", rehype)).toBe(rehype);
  });

  // ───── wiki 链接预处理（M3） ─────

  test("withWikiLinks：[[标题]] → data-wiki 锚点；一行多个全替换", () => {
    expect(withWikiLinks("参考 [[深度工作]] 一书")).toBe(
      '参考 <a data-wiki="%E6%B7%B1%E5%BA%A6%E5%B7%A5%E4%BD%9C">深度工作</a> 一书',
    );
    const multi = withWikiLinks("[[甲]] 和 [[乙]]");
    expect(multi).toContain('data-wiki="%E7%94%B2"');
    expect(multi).toContain('data-wiki="%E4%B9%99"');
    // wikiTitleFromAnchor 还原标题
    const el = document.createElement("a");
    el.setAttribute("data-wiki", "%E7%94%B2");
    expect(wikiTitleFromAnchor(el)).toBe("甲");
  });

  test("withWikiLinks：代码围栏内不替换（``` 与 ~~~ 均跳过）", () => {
    const md = "正文 [[外]]\n```ts\nconst x = \"[[内]]\";\n```\n后续 [[外2]]\n~~~\n[[内2]]\n~~~";
    const out = withWikiLinks(md);
    expect(out).toContain('<a data-wiki=');
    expect(out).not.toContain('[[外');
    expect(out).toContain("[[内]]");
    expect(out).not.toContain("[内](#wiki:");
    expect(out).not.toContain("[内2](#wiki:");
    expect(out).toContain('const x = "[[内]]";');
  });

  test("withWikiLinks：非 wiki 文本原样；wikiTitleFromAnchor 只认 data-wiki", () => {
    expect(withWikiLinks("[普通链接](a.md) 和 [x](#anchor)")).toBe("[普通链接](a.md) 和 [x](#anchor)");
    const plain = document.createElement("a");
    expect(wikiTitleFromAnchor(plain)).toBeNull();
  });
});
