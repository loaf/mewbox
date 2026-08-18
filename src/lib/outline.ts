export interface Heading {
  level: number; // 1-6
  text: string;
  slug: string;
}

function slugify(text: string): string {
  return (
    text
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .replace(/\s+/g, "-") || "h"
  );
}

/** 抽取标题（跳过代码围栏内的 # 行）；slug 用于预览模式 scrollIntoView */
export function extractHeadings(markdown: string): Heading[] {
  const headings: Heading[] = [];
  const seen = new Map<string, number>();
  let inFence = false;
  let fenceMark = "";
  for (const line of markdown.split("\n")) {
    const fence = line.trimStart().match(/^(`{3,}|~{3,})/);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceMark = fence[1][0];
      } else if (fence[1][0] === fenceMark) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;
    const m = line.match(/^(#{1,6})\s+(.*)$/);
    if (m) {
      const text = m[2].trim();
      let slug = slugify(text);
      const n = seen.get(slug) ?? 0;
      seen.set(slug, n + 1);
      if (n > 0) slug = `${slug}-${n}`;
      headings.push({ level: m[1].length, text, slug });
    }
  }
  return headings;
}
