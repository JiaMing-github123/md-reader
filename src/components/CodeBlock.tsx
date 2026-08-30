import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
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
import type { ResolvedTheme } from "../types";

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
  theme: ResolvedTheme;
}

export function CodeBlock({ code, language, theme }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const normalizedLanguage = language?.toLocaleLowerCase();
  const registeredLanguage = normalizedLanguage
    ? languageAliases[normalizedLanguage] ??
      (normalizedLanguage in languages
        ? (normalizedLanguage as keyof typeof languages)
        : undefined)
    : undefined;

  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timeout);
  }, [copied]);

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
      {registeredLanguage ? (
        <SyntaxHighlighter
          language={registeredLanguage}
          style={theme === "dark" ? oneDark : oneLight}
          PreTag="div"
          customStyle={{
            margin: 0,
            padding: "1rem 1.1rem 1.15rem",
            background: "transparent",
            fontSize: "0.84em",
            lineHeight: 1.65,
          }}
          codeTagProps={{
            style: {
              fontFamily:
                '"Cascadia Code", "SFMono-Regular", Consolas, "Liberation Mono", monospace',
            },
          }}
        >
          {code}
        </SyntaxHighlighter>
      ) : (
        <pre className="code-block__plain">
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}

