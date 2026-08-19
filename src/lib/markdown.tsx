import { useState, useEffect, useRef } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import rehypeRaw from "rehype-raw";
import remarkEmoji from "remark-emoji";
import { visit } from "unist-util-visit";
import "katex/dist/katex.min.css";
import "highlight.js/styles/github.css";

// ═══════ 自写 remark 插件：==高亮== / ~下标~ / ^上标^（事实标准扩展语法） ═══════

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

interface MdNode {
  type: string;
  value?: string;
}

/** `==text==` → <mark> */
export function remarkMark(): (tree: MdNode) => void {
  return (tree) => {
    visit(tree, "text" as never, ((node: MdNode, index: number | null, parent: { children: MdNode[] }) => {
      if (index === null || !parent || typeof node.value !== "string" || !node.value.includes("==")) return;
      const parts = node.value.split(/(==[^=\n]+==)/g).filter((p) => p !== "");
      if (parts.length === 1) return;
      const children: MdNode[] = parts.map((p) => {
        const m = p.match(/^==([^=]+)==$/);
        return m ? { type: "html", value: `<mark>${escapeHtml(m[1])}</mark>` } : { type: "text", value: p };
      });
      parent.children.splice(index, 1, ...children);
    }) as never);
  };
}

/** `~x~` → <sub>，`^x^` → <sup>（避开 GFM 删除线 `~~x~~`） */
export function remarkSubSuper(): (tree: MdNode) => void {
  return (tree) => {
    visit(tree, "text" as never, ((node: MdNode, index: number | null, parent: { children: MdNode[] }) => {
      if (index === null || !parent || typeof node.value !== "string") return;
      const value: string = node.value;
      if (!/[~^][^~^\s][^~^\n]*[~^]/.test(value)) return;
      const parts = value.split(/(~[^~\s][^~\n]*~|\^[^\^\s][^\^\n]*\^)/g).filter((p) => p !== "");
      if (parts.length === 1) return;
      const children: MdNode[] = parts.map((p) => {
        const sub = p.match(/^~([^~\s][^~\n]*)~$/);
        const sup = p.match(/^\^([^\^\s][^\^\n]*)\^$/);
        if (sub) return { type: "html", value: `<sub>${escapeHtml(sub[1])}</sub>` };
        if (sup) return { type: "html", value: `<sup>${escapeHtml(sup[1])}</sup>` };
        return { type: "text", value: p };
      });
      parent.children.splice(index, 1, ...children);
    }) as never);
  };
}

// ═══════ 预览配置（编辑器与测试共用同一管线） ═══════

import type { PluggableList } from "unified";

// GFM 关闭单波浪线删除线（保留 ~~ 双波浪线），把 ~x~ 留给下标语法
export const previewRemarkPlugins: PluggableList = [
  remarkSubSuper,
  remarkMark,
  [remarkGfm, { singleTilde: false }],
  remarkMath,
  remarkEmoji,
];
export const previewRehypePlugins: PluggableList = [
  rehypeRaw,
  rehypeKatex,
  [rehypeHighlight, { detect: false }],
];

/** mermaid 代码块：懒加载渲染。
 *  live 模式下每次按键都会重挂/重渲染，mermaid.render 的 id 必须每次唯一，
 *  否则与上一次渲染冲突报错（表现为图不出现）。 */
function MermaidBlock({ code }: { code: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const idBase = useRef(`mmd-${Math.random().toString(36).slice(2)}`);
  const seq = useRef(0);

  useEffect(() => {
    const mySeq = ++seq.current;
    const id = `${idBase.current}-${mySeq}`;
    let cancelled = false;
    setSvg(null);
    setError(null);
    import("mermaid")
      .then(async (mod) => {
        const mermaid = mod.default;
        mermaid.initialize({ startOnLoad: false, theme: "neutral" });
        const { svg } = await mermaid.render(id, code);
        if (!cancelled && mySeq === seq.current) setSvg(svg);
      })
      .catch((e: unknown) => {
        if (!cancelled && mySeq === seq.current) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [code]);

  if (error) return <pre className="text-xs text-[var(--red)]">{code}</pre>;
  if (!svg) return <pre className="text-xs text-[var(--muted)]">⏳ mermaid 渲染中…</pre>;
  return <div className="my-2 overflow-auto" dangerouslySetInnerHTML={{ __html: svg }} />;
}

/** 代码块容器：语言标签 + 复制按钮（测试环境 navigator.clipboard 可能缺失，降级 execCommand） */
function CodeBlock({ className, children }: { className?: string; children?: React.ReactNode }) {
  const lang = /language-(\w+)/.exec(className ?? "")?.[1];
  const codeText = extractText(children);
  const [copied, setCopied] = useState(false);

  if (lang === "mermaid") return <MermaidBlock code={codeText} />;

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(codeText);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = codeText;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="group relative">
      <div className="flex justify-between rounded-t-lg border border-b-0 border-[var(--line)] bg-[var(--cream)] px-3 py-1 text-[10px] text-[var(--muted)]">
        <span>{lang ?? ""}</span>
        <button onClick={onCopy} className="opacity-60 hover:opacity-100" data-testid="code-copy">
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <pre className="!mt-0 !rounded-t-none">
        <code className={className}>{children}</code>
      </pre>
    </div>
  );
}

function extractText(node: React.ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (node && typeof node === "object" && "props" in (node as { props?: { children?: React.ReactNode } })) {
    return extractText((node as { props: { children?: React.ReactNode } }).props.children);
  }
  return "";
}

export const previewComponents = {
  pre: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  code: (props: React.HTMLAttributes<HTMLElement> & { children?: React.ReactNode }) => {
    const { className, children } = props;
    // 行内代码（无 language- 前缀）直接渲染
    if (!className || !/language-/.test(className)) {
      return <code className="rounded bg-[var(--cream)] px-1 py-0.5 text-[13px]">{children}</code>;
    }
    return <CodeBlock className={className}>{children}</CodeBlock>;
  },
};

/** 测试与预览共享的渲染入口 */
export function MarkdownPreview({ children }: { children: string }) {
  return (
    <Markdown remarkPlugins={previewRemarkPlugins} rehypePlugins={previewRehypePlugins} components={previewComponents}>
      {children}
    </Markdown>
  );
}

/**
 * 编辑器（@uiw/react-md-editor）的 previewOptions。
 * 它内部的 react-markdown-preview 会在我的插件之后**再追加一个裸的 remark-gfm**
 * （singleTilde 默认开启，会把 ~x~ 下标吃成删除线），并自行添加 rehypeRaw。
 * 用 pluginsFilter 把裸 gfm 函数剔除——我们自己的 gfm 以 [fn, {singleTilde:false}] 元组传入，不受影响。
 */
export const editorPreviewOptions = {
  remarkPlugins: previewRemarkPlugins,
  rehypePlugins: previewRehypePlugins,
  components: previewComponents,
  pluginsFilter: (type: "rehype" | "remark", plugins: PluggableList): PluggableList => {
    if (type !== "remark") return plugins;
    return plugins.filter((p) => p !== remarkGfm);
  },
};
