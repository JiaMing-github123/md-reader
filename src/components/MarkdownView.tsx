import { convertFileSrc } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ImageOff } from "lucide-react";
import {
  Children,
  isValidElement,
  memo,
  useEffect,
  useMemo,
  useState,
  type ComponentPropsWithoutRef,
  type ReactElement,
  type ReactNode,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";
import type { Element } from "hast";
import type { ResolvedTheme } from "../types";
import {
  isExternalUrl,
  isMarkdownPath,
  resolveLocalPath,
  sanitizeMarkdownUrl,
} from "../lib/markdown";
import { CodeBlock, codeHighlightStyles } from "./CodeBlock";

const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [
      ...(defaultSchema.attributes?.code ?? []),
      ["className", /^language-[\w-]+$/],
    ],
    input: [
      ...(defaultSchema.attributes?.input ?? []),
      ["type", "checkbox"],
      "checked",
      "disabled",
    ],
  },
};

interface MarkdownImageProps extends ComponentPropsWithoutRef<"img"> {
  documentPath: string;
}

function MarkdownImage({ src = "", alt = "", documentPath, ...props }: MarkdownImageProps) {
  const [failed, setFailed] = useState(false);
  const resolvedSource = useMemo(() => {
    if (!src) return "";
    if (/^(?:https?:|data:|asset:|blob:)/i.test(src)) return src;
    const localPath = resolveLocalPath(src, documentPath);
    return localPath ? convertFileSrc(localPath) : src;
  }, [documentPath, src]);

  useEffect(() => setFailed(false), [resolvedSource]);

  if (failed || !resolvedSource) {
    return (
      <span className="markdown-image-error" role="img" aria-label={alt || "Image unavailable"}>
        <ImageOff size={18} />
        <span>{alt ? `Image unavailable: ${alt}` : "Image unavailable"}</span>
      </span>
    );
  }

  return (
    <img
      {...props}
      src={resolvedSource}
      alt={alt}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

interface MarkdownViewProps {
  content: string;
  documentPath: string;
  theme: ResolvedTheme;
  articleRef: React.RefObject<HTMLElement>;
  scrollRef: React.RefObject<HTMLElement>;
  onOpenMarkdown: (path: string) => void;
}

// Keep scroll, search and editor state updates outside the Markdown parser.
export const MarkdownView = memo(function MarkdownView({
  content,
  documentPath,
  theme,
  articleRef,
  scrollRef,
  onOpenMarkdown,
}: MarkdownViewProps) {
  const components = useMemo<Components>(
    () => ({
      a({ href = "", children, ...props }) {
        const handleClick = async (event: React.MouseEvent<HTMLAnchorElement>) => {
          event.preventDefault();
          if (!href) return;

          if (href.startsWith("#")) {
            const target = document.getElementById(decodeURIComponent(href.slice(1)));
            target?.scrollIntoView({ behavior: "smooth", block: "start" });
            return;
          }

          if (isExternalUrl(href)) {
            try {
              await openUrl(href);
            } catch {
              // The URL stays visible and copyable if Windows cannot open it.
            }
            return;
          }

          const localPath = resolveLocalPath(href, documentPath);
          if (localPath && isMarkdownPath(localPath)) onOpenMarkdown(localPath);
        };

        return (
          <a {...props} href={href} onClick={handleClick}>
            {children}
          </a>
        );
      },
      img({ node: _node, ...props }) {
        return <MarkdownImage {...props} documentPath={documentPath} />;
      },
      table({ children, ...props }) {
        return (
          <div className="markdown-table-wrap">
            <table {...props}>{children}</table>
          </div>
        );
      },
      pre({ children }) {
        const child = Children.only(children) as ReactElement<{
          className?: string;
          children?: ReactNode;
        }>;

        if (!isValidElement(child)) return <pre>{children}</pre>;
        const language = child.props.className?.match(/language-([\w-]+)/)?.[1];
        const code = String(child.props.children ?? "").replace(/\n$/, "");
        return <CodeBlock code={code} language={language} scrollRef={scrollRef} />;
      },
    }),
    [documentPath, onOpenMarkdown, scrollRef],
  );

  return (
    <>
      <style>{codeHighlightStyles}</style>
      <article key={documentPath} ref={articleRef} className="markdown-body" data-code-theme={theme}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[[rehypeSanitize, sanitizeSchema], rehypeSlug]}
          components={components}
          urlTransform={(url, _key, node: Element) =>
            sanitizeMarkdownUrl(url, node.tagName === "img")
          }
        >
          {content}
        </ReactMarkdown>
      </article>
    </>
  );
});
