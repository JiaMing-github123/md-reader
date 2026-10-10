import { Check, Copy } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { PrismLight as SyntaxHighlighter } from "react-syntax-highlighter";
import bash from "react-syntax-highlighter/dist/esm/languages/prism/bash";
import c from "react-syntax-highlighter/dist/esm/languages/prism/c";
import cpp from "react-syntax-highlighter/dist/esm/languages/prism/cpp";
import css from "react-syntax-highlighter/dist/esm/languages/prism/css";
import java from "react-syntax-highlighter/dist/esm/languages/prism/java";
import javascript from "react-syntax-highlighter/dist/esm/languages/prism/javascript";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json";
import jsx from "react-syntax-highlighter/dist/esm/languages/prism/jsx";
import markdown from "react-syntax-highlighter/dist/esm/languages/prism/markdown";
import markup from "react-syntax-highlighter/dist/esm/languages/prism/markup";
import powershell from "react-syntax-highlighter/dist/esm/languages/prism/powershell";
import python from "react-syntax-highlighter/dist/esm/languages/prism/python";
import rust from "react-syntax-highlighter/dist/esm/languages/prism/rust";
import sql from "react-syntax-highlighter/dist/esm/languages/prism/sql";
import tsx from "react-syntax-highlighter/dist/esm/languages/prism/tsx";
import typescript from "react-syntax-highlighter/dist/esm/languages/prism/typescript";
import yaml from "react-syntax-highlighter/dist/esm/languages/prism/yaml";
import { oneDark, oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import { canHighlightCode, enqueueCodeHighlight, observeCodeVisibility } from "../lib/codeHighlighting";

const languages = {
  bash,
  c,
  cpp,
  css,
  java,
  javascript,
  json,
  jsx,
  markdown,
  markup,
  powershell,
  python,
  rust,
  sql,
  tsx,
  typescript,
  yaml,
};

Object.entries(languages).forEach(([name, grammar]) => {
  SyntaxHighlighter.registerLanguage(name, grammar);
});

const languageAliases: Record<string, keyof typeof languages> = {
  sh: "bash",
  shell: "bash",
  js: "javascript",
  mjs: "javascript",
  ts: "typescript",
  py: "python",
  rs: "rust",
  html: "markup",
  xml: "markup",
  md: "markdown",
  yml: "yaml",
  ps1: "powershell",
  cxx: "cpp",
};

// Reuse the existing palettes through CSS. Token colors can change without rerunning
// Prism or repeatedly computing inline styles for every token on every render.
export const codeHighlightStyles = (["light", "dark"] as const).map((theme) => {
  const palette = theme === "dark" ? oneDark : oneLight;
  const scope = `.markdown-body[data-code-theme="${theme}"] .code-block__content`;
  return `${scope}{color:${palette['pre[class*="language-"]'].color}}\n` + Object.entries(palette)
    .filter(([selector]) => !selector.includes("["))
    .map(([selector, rules]) => {
      const declarations = Object.entries(rules)
        .map(([property, value]) => `${property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}:${value}`)
        .join(";");
      return `${scope} .token.${selector}{${declarations}}`;
    }).join("\n");
}).join("\n");

const HighlightedCode = memo(function HighlightedCode({
  code, language,
}: { code: string; language: string }) {
  return (
    <SyntaxHighlighter
      language={language}
      useInlineStyles={false}
      PreTag="pre"
      className="code-block__content"
    >
      {code}
    </SyntaxHighlighter>
  );
});

// Copy feedback and unrelated Markdown updates stay outside this expensive subtree.
const CodeContent = memo(function CodeContent({ code, language, scrollRef }: {
  code: string;
  language?: string;
  scrollRef: React.RefObject<HTMLElement>;
}) {
  const blockRef = useRef<HTMLDivElement>(null);
  const [highlighted, setHighlighted] = useState<{ code: string; language: string } | null>(null);
  const ready = highlighted?.code === code && highlighted?.language === language;
  const eligible = Boolean(language) && canHighlightCode(code);

  useEffect(() => {
    if (ready || !eligible || !language) return;
    const block = blockRef.current;
    const root = scrollRef.current;
    if (!block || !root) return;
    let cancelHighlight: (() => void) | undefined;
    const stopObserving = observeCodeVisibility(root, block, (visible) => {
      cancelHighlight?.();
      cancelHighlight = visible
        ? enqueueCodeHighlight(() => setHighlighted({ code, language }))
        : undefined;
    });
    return () => {
      cancelHighlight?.();
      stopObserving();
    };
  }, [code, eligible, language, ready, scrollRef]);

  return (
    <div ref={blockRef} data-code-content>
      {ready && language ? <HighlightedCode code={code} language={language} /> : (
        <pre className="code-block__content"><code>{code}</code></pre>
      )}
    </div>
  );
});

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }
}

interface CodeBlockProps {
  code: string;
  language?: string;
  scrollRef: React.RefObject<HTMLElement>;
}

export const CodeBlock = memo(function CodeBlock({ code, language, scrollRef }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const normalizedLanguage = language?.toLocaleLowerCase();
  const registeredLanguage = normalizedLanguage
    ? (Object.prototype.hasOwnProperty.call(languageAliases, normalizedLanguage)
        ? languageAliases[normalizedLanguage] : undefined) ??
      (Object.prototype.hasOwnProperty.call(languages, normalizedLanguage)
        ? (normalizedLanguage as keyof typeof languages)
        : undefined)
    : undefined;

  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  useEffect(() => setCopied(false), [code, language]);

  const handleCopy = async () => {
    await copyText(code);
    setCopied(true);
  };

  return (
    <div className="code-block not-prose">
      <div className="code-block__toolbar" data-search-exclude>
        <span className="code-block__language">{language || "Plain text"}</span>
        <button
          className="code-block__copy"
          type="button"
          onClick={handleCopy}
          aria-label={copied ? "Code copied" : "Copy code"}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <CodeContent code={code} language={registeredLanguage} scrollRef={scrollRef} />
    </div>
  );
});
