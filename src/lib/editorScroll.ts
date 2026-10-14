/** 编辑器滚动定位工具（右栏大纲跳转）。
 *
 *  @uiw/react-md-editor 的滚动容器随模式变化且不在文档里写明：
 *  - 源码（edit）：textarea 是绝对定位的透明输入层、内容不溢出；真正滚动的是
 *    `.w-md-editor-area`（overflow:auto），外层 `.w-md-editor-content` 也是 auto 兜底；
 *  - 预览（preview）：滚动的是 `.w-md-editor-preview`（绝对定位 + overflow:auto）；
 *  - 分栏（live）：两侧各自滚动。
 *  所以不硬编码选择器，改为「从目标元素上溯，取最内层真正溢出的祖先」。
 */

/** 从 target 上溯到 root，返回最内层真正溢出的滚动容器；
 *  没有溢出时退回第一个 overflow:auto|scroll 的祖先（内容短时滚动无副作用） */
export function findScroller(target: Element, root: Element | null): HTMLElement | null {
  let n: Element | null = target.parentElement;
  let candidate: HTMLElement | null = null;
  const stop = root?.parentElement ?? null;
  while (n && n !== stop) {
    const el = n as HTMLElement;
    const oy = typeof getComputedStyle === "function" ? getComputedStyle(n).overflowY : "";
    const scrollable = oy === "auto" || oy === "scroll";
    const overflowing = el.scrollHeight > el.clientHeight + 1;
    if (overflowing && (scrollable || el.scrollHeight > 0)) return el;
    if (scrollable && !candidate) candidate = el;
    if (n === root) break;
    n = n.parentElement;
  }
  return candidate;
}

/** 目标矩形滚到容器视口约 1/3 处（标题上方留一点上文）。用 rect 差值，不做行高/内边距算术。 */
export function scrollRectWithin(rect: { top: number }, box: HTMLElement): void {
  const boxRect = box.getBoundingClientRect();
  const delta = rect.top - boxRect.top - box.clientHeight / 3;
  box.scrollTop = Math.max(0, box.scrollTop + delta);
}

/** 把某个真实元素滚入其所属滚动容器 */
export function scrollElementWithin(el: Element, root: Element | null): boolean {
  const box = findScroller(el, root);
  if (!box) return false;
  scrollRectWithin(el.getBoundingClientRect(), box);
  return true;
}

/** 在镜像层（pre > code，文本 === textarea 值 + "\n"）里取第 offset 个字符处的零宽 Range，
 *  用它的真实 rect 定位——分栏限宽、字号缩放、软换行都能自适应 */
export function rangeAtOffset(code: Element, offset: number): Range | null {
  if (typeof document.createTreeWalker !== "function") return null;
  const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
  let acc = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const len = node.textContent?.length ?? 0;
    if (acc + len >= offset) {
      const range = document.createRange();
      const pos = Math.max(0, Math.min(len, offset - acc));
      range.setStart(node, pos);
      range.setEnd(node, pos);
      return range;
    }
    acc += len;
  }
  return null;
}

/** 源码层：把镜像层第 offset 个字符的位置滚入容器（容器由 code 上溯判定）。
 *  Range 没有 parentElement，滚动容器的查找必须从宿主元素出发。 */
export function scrollOffsetWithin(code: Element, offset: number, root: Element | null): boolean {
  const box = findScroller(code, root);
  if (!box) return false;
  const range = rangeAtOffset(code, offset);
  if (!range) return false;
  scrollRectWithin(range.getBoundingClientRect(), box);
  return true;
}
