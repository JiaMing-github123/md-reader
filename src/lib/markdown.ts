import GithubSlugger from "github-slugger";
import { toString } from "mdast-util-to-string";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import type { Heading } from "mdast";
import type { TocItem } from "../types";

export function extractTableOfContents(markdown: string): TocItem[] {
  try {
    const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown);
    const slugger = new GithubSlugger();
    const headings: TocItem[] = [];

    visit(tree, "heading", (node: Heading) => {
      if (node.depth > 3) return;
      const text = toString(node).trim();
      if (!text) return;

      headings.push({
        id: slugger.slug(text),
        text,
        level: node.depth as 1 | 2 | 3,
      });
    });

    return headings;
  } catch {
    return [];
  }
}

export function isMarkdownPath(path: string): boolean {
  return /\.(?:md|markdown)$/i.test(path.trim());
}

export function directoryOf(path: string): string {
  const lastSeparator = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return lastSeparator >= 0 ? path.slice(0, lastSeparator) : "";
}

function normalizeWindowsPath(path: string): string {
  const normalized = path.replace(/\//g, "\\");
  const driveMatch = normalized.match(/^([a-zA-Z]:)\\/);
  const prefix = driveMatch?.[1] ?? "";
  const remainder = prefix ? normalized.slice(prefix.length + 1) : normalized;
  const parts: string[] = [];

  for (const part of remainder.split("\\")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
    } else {
      parts.push(part);
    }
  }

  return prefix ? `${prefix}\\${parts.join("\\")}` : parts.join("\\");
}

export function resolveLocalPath(source: string, documentPath: string): string | null {
  let value = source.trim();
  if (!value) return null;

  try {
    value = decodeURIComponent(value);
  } catch {
    // Keep the original value if it contains malformed URL escapes.
  }

  value = value.split("#", 1)[0].split("?", 1)[0];

  if (/^file:\/\//i.test(value)) {
    value = value.replace(/^file:\/\/\/?/i, "");
  }

  if (/^[a-zA-Z]:[\\/]/.test(value)) {
    return normalizeWindowsPath(value);
  }

  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value) || value.startsWith("//")) {
    return null;
  }

  const baseDirectory = directoryOf(documentPath);
  return baseDirectory ? normalizeWindowsPath(`${baseDirectory}\\${value}`) : null;
}

export function isExternalUrl(url: string): boolean {
  return /^(?:https?:|mailto:)/i.test(url.trim());
}

export function sanitizeMarkdownUrl(url: string, isImage: boolean): string {
  const value = url.trim();
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) return "";

  if (isImage && /^data:image\/(?:png|jpe?g|gif|webp|avif);base64,/i.test(value)) {
    return value;
  }

  if (/^(?:javascript|vbscript|data):/i.test(value)) return "";
  if (isImage && /^mailto:/i.test(value)) return "";

  return value;
}
