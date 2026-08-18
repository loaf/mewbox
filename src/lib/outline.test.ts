import { extractHeadings } from "./outline";

describe("extractHeadings", () => {
  test("抽取 #/##/### 标题，跳过代码围栏内的 # 行", () => {
    const md = [
      "# 一级",
      "正文",
      "```",
      "# 围栏里的假标题",
      "```",
      "## 二级",
      "```python",
      "# 注释也不是标题",
      "```",
      "### 三级",
    ].join("\n");
    const hs = extractHeadings(md);
    expect(hs.map((h) => h.text)).toEqual(["一级", "二级", "三级"]);
    expect(hs.map((h) => h.level)).toEqual([1, 2, 3]);
  });

  test("重名标题生成不同锚点 slug", () => {
    const hs = extractHeadings("# 相同\n## 相同\n# 相同");
    const slugs = hs.map((h) => h.slug);
    expect(new Set(slugs).size).toBe(3);
  });
});
