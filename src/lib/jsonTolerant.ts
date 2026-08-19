// 润色建议/查错的容错 JSON 解析（与后端 prompts.rs 同口径：
// 剥 BOM/``` 围栏/前置闲话/尾逗号；中英字段名兼容；坏条目跳过）。

export interface Suggestion {
  original: string;
  revised: string;
  reason: string;
}

export interface Issue {
  kind: string;
  location: string;
  advice: string;
}

function stripFence(raw: string): string {
  let s = raw.replace(/^\uFEFF/, "").trim();
  if (!s.startsWith("```")) return s;
  const nl = s.indexOf("\n");
  if (nl >= 0) s = s.slice(nl + 1).trimStart();
  const end = s.lastIndexOf("```");
  return (end >= 0 ? s.slice(0, end) : s).trim();
}

/** 去掉 ]/} 前的尾逗号（含中间空白）——与 Rust 版逐字符同逻辑 */
function removeTrailingCommas(s: string): string {
  let out = "";
  let ws = "";
  let pending = false;
  for (const c of s) {
    if (pending) {
      if (/\s/.test(c)) {
        ws += c;
        continue;
      }
      if (c !== "]" && c !== "}") {
        out += ",";
        out += ws;
      }
      ws = "";
      pending = false;
    }
    if (c === ",") pending = true;
    else out += c;
  }
  if (pending) {
    out += ",";
    out += ws;
  }
  return out;
}

/** 从模型输出中提取 JSON 数组文本（首个 [ 到最后一个 ]） */
function extractJsonText(raw: string): string | null {
  const t = stripFence(raw);
  const start = t.indexOf("[");
  const end = t.lastIndexOf("]");
  if (start < 0 || end <= start) return null;
  return removeTrailingCommas(t.slice(start, end + 1));
}

function valueArray(raw: string): unknown[] {
  const text = extractJsonText(raw);
  if (text === null) return [];
  try {
    const v: unknown = JSON.parse(text);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function field(obj: unknown, keys: string[]): string {
  if (typeof obj !== "object" || obj === null) return "";
  for (const k of keys) {
    const v = (obj as Record<string, unknown>)[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

/** 润色建议：`[{"原段","改段","理由"}]`；原段/改段缺一或相同即跳过 */
export function parseSuggestions(raw: string): Suggestion[] {
  return valueArray(raw).flatMap((v) => {
    const original = field(v, ["原段", "original"]);
    const revised = field(v, ["改段", "revised"]);
    if (!original || !revised || original === revised) return [];
    return [{ original, revised, reason: field(v, ["理由", "reason"]) }];
  });
}

/** 查错条目：`[{"类型","定位","建议"}]`；三字段全空即跳过 */
export function parseIssues(raw: string): Issue[] {
  return valueArray(raw).flatMap((v) => {
    const kind = field(v, ["类型", "kind"]);
    const location = field(v, ["定位", "location"]);
    const advice = field(v, ["建议", "advice"]);
    if (!kind && !location && !advice) return [];
    return [{ kind, location, advice }];
  });
}
