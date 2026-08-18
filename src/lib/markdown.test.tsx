import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownPreview } from "./markdown";

const render = (md: string) => renderToStaticMarkup(<MarkdownPreview>{md}</MarkdownPreview>);

describe("markdown 渲染扩展", () => {
  test("==高亮== 渲染为 <mark>", () => {
    const html = render("普通 ==重点内容== 普通");
    expect(html).toContain("<mark>重点内容</mark>");
  });

  test("~下标~ 与 ^上标^ 渲染", () => {
    const html = render("H~2~O 与 x^2^");
    expect(html).toContain("<sub>2</sub>");
    expect(html).toContain("<sup>2</sup>");
    // GFM 删除线不受影响
    const del = render("~~删除~~");
    expect(del).toContain("<del>删除</del>");
  });

  test("表格/任务列表/删除线/脚注 走 remark-gfm", () => {
    const table = render("| a | b |\n| --- | --- |\n| 1 | 2 |");
    expect(table).toContain("<table>");
    const task = render("- [x] 完成\n- [ ] 待办");
    expect(task).toContain('type="checkbox"');
    const footnote = render("正文[^1]\n\n[^1]: 注释内容");
    expect(footnote.toLowerCase()).toContain("footnote");
  });

  test("$..$ 与 $$..$$ 走 KaTeX", () => {
    const inline = render("公式 $E=mc^2$ 结束");
    expect(inline).toContain("katex");
    const block = render("$$\n\\int_0^1 x dx\n$$");
    expect(block).toContain("katex-display");
  });

  test("emoji 扩展", () => {
    const html = render("好棒 :+1:");
    expect(html).toContain("👍");
  });
});
