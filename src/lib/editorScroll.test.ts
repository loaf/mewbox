import { findScroller, rangeAtOffset, scrollRectWithin } from "./editorScroll";

/** jsdom 无布局：所有 rect 为 0，此处只验证「容器判定」与「滚动量换算」两段纯逻辑，
 *  真实像素定位靠 range 的真实 rect（浏览器里由上述两段驱动）。 */

function box(opts: { overflow?: string; scrollHeight?: number; clientHeight?: number; top?: number }): HTMLElement {
  const el = document.createElement("div");
  const oy = opts.overflow ?? "visible";
  Object.defineProperty(el, "scrollHeight", { value: opts.scrollHeight ?? 0, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: opts.clientHeight ?? 0, configurable: true });
  el.getBoundingClientRect = () => ({ top: opts.top ?? 0 } as DOMRect);
  // jsdom 的 getComputedStyle 走内联样式/默认表；用内联样式表达 overflow 最稳
  el.style.overflowY = oy;
  return el;
}

describe("findScroller：从目标上溯找真正的滚动容器", () => {
  test("取最内层溢出容器（模拟源码模式 area 与 content 都是 auto，只有 area 溢出）", () => {
    const root = document.createElement("div");
    root.setAttribute("data-pane", "primary");
    const content = box({ overflow: "auto", scrollHeight: 1000, clientHeight: 1000 }); // 不溢出
    const area = box({ overflow: "auto", scrollHeight: 3000, clientHeight: 500 }); // 溢出
    const text = document.createElement("div");
    const code = document.createElement("code");
    root.appendChild(content);
    content.appendChild(area);
    area.appendChild(text);
    text.appendChild(code);
    document.body.appendChild(root);

    expect(findScroller(code, root)).toBe(area);
    root.remove();
  });

  test("预览模式：preview 容器溢出时即它（不被外层 content 抢走）", () => {
    const root = document.createElement("div");
    const content = box({ overflow: "auto", scrollHeight: 3000, clientHeight: 500 });
    const preview = box({ overflow: "auto", scrollHeight: 2000, clientHeight: 400 });
    const h2 = document.createElement("h2");
    root.appendChild(content);
    content.appendChild(preview);
    preview.appendChild(h2);
    document.body.appendChild(root);

    expect(findScroller(h2, root)).toBe(preview);
    root.remove();
  });

  test("都不溢出时退回第一个 overflow:auto 的祖先；无祖先则 null", () => {
    const root = document.createElement("div");
    const area = box({ overflow: "auto", scrollHeight: 0, clientHeight: 0 });
    const code = document.createElement("code");
    root.appendChild(area);
    area.appendChild(code);
    document.body.appendChild(root);
    expect(findScroller(code, root)).toBe(area);

    const lone = document.createElement("code");
    document.body.appendChild(lone);
    expect(findScroller(lone, null)).toBeNull();
    root.remove();
    lone.remove();
  });
});

describe("scrollRectWithin：目标落位约 1/3 处", () => {
  test("按 rect 差值滚动，不会为负", () => {
    const container = box({ overflow: "auto", scrollHeight: 2000, clientHeight: 300, top: 100 });
    (container as HTMLElement).scrollTop = 50;
    // 目标距容器顶 250px → 250 - 100(1/3) = 150 → 50 + 150 = 200
    scrollRectWithin({ top: 350 }, container);
    expect(container.scrollTop).toBe(200);

    // 目标在容器上方 → 收敛到 0
    container.scrollTop = 10;
    scrollRectWithin({ top: 20 }, container);
    expect(container.scrollTop).toBe(0);
  });
});

describe("rangeAtOffset：在镜像层按字符偏移取位置", () => {
  test("跨多个文本节点累加偏移；越界返回末节点", () => {
    const code = document.createElement("code");
    code.appendChild(document.createTextNode("abc"));
    code.appendChild(document.createTextNode("def"));
    const r = rangeAtOffset(code, 4);
    expect(r).not.toBeNull();
    expect(r!.startContainer.textContent).toBe("def");
    expect(r!.startOffset).toBe(1);
    expect(r!.collapsed).toBe(true);
  });
});
