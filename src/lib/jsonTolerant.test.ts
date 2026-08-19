import { parseSuggestions, parseIssues } from "./jsonTolerant";

describe("jsonTolerant", () => {
  test("基本润色建议（中文字段）", () => {
    const raw = `[{"原段":"今天的天气好","改段":"今天天气很好","理由":"语病"},{"原段":"从新开始","改段":"重新开始","理由":"错别字"}]`;
    expect(parseSuggestions(raw)).toEqual([
      { original: "今天的天气好", revised: "今天天气很好", reason: "语病" },
      { original: "从新开始", revised: "重新开始", reason: "错别字" },
    ]);
  });

  test("剥 ```json 围栏与前置闲话", () => {
    const raw = `好的，以下是建议：\n\`\`\`json\n[{"原段":"a","改段":"b","理由":"r"}]\n\`\`\``;
    expect(parseSuggestions(raw)).toEqual([{ original: "a", revised: "b", reason: "r" }]);
  });

  test("去尾逗号（含 ]/} 前空白）", () => {
    const raw = `[{"原段":"a","改段":"b","reason":"r",},{"原段":"c","改段":"d",},]`;
    expect(parseSuggestions(raw)).toEqual([
      { original: "a", revised: "b", reason: "r" },
      { original: "c", revised: "d", reason: "" },
    ]);
  });

  test("原段=改段或缺字段 → 跳过；英文字段名兼容", () => {
    const raw = `[{"original":"x","revised":"x"},{"original":"y"},{"原段":"中","revised":"文","reason":"ok"}]`;
    expect(parseSuggestions(raw)).toEqual([{ original: "中", revised: "文", reason: "ok" }]);
  });

  test("完全不是 JSON → 空数组（不抛错）", () => {
    expect(parseSuggestions("抱歉，我无法处理。")).toEqual([]);
    expect(parseSuggestions("")).toEqual([]);
    expect(parseSuggestions("[坏掉的")).toEqual([]);
  });

  test("查错条目解析；三字段全空跳过", () => {
    const raw = `[{"类型":"错别字","定位":"从新开始","建议":"重新开始"},{"类型":"","定位":"","建议":""}]`;
    expect(parseIssues(raw)).toEqual([
      { kind: "错别字", location: "从新开始", advice: "重新开始" },
    ]);
  });

  test("查错：中英混排字段", () => {
    const raw = `[{"kind":"标点","location":"你好,世界","advice":"你好，世界"}]`;
    expect(parseIssues(raw)).toEqual([
      { kind: "标点", location: "你好,世界", advice: "你好，世界" },
    ]);
  });

  test("BOM 前缀容错", () => {
    const raw = "﻿" + `[{"原段":"a","改段":"b","理由":""}]`;
    expect(parseSuggestions(raw)).toEqual([{ original: "a", revised: "b", reason: "" }]);
  });
});
