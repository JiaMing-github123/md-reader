import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileText,
  Files,
  Folder,
  FolderOpen,
  ListTree,
  RefreshCw,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { FileTreeNode, SidebarTab, TocItem } from "../types";

interface SidebarProps {
  fileTree: FileTreeNode | null;
  items: TocItem[];
  width: number;
  collapsed: boolean;
  activeId: string;
  activeFilePath: string;
  activeTab: SidebarTab;
  refreshing: boolean;
  onToggle: () => void;
  onWidthChange: (width: number) => void;
  onTabChange: (tab: SidebarTab) => void;
  onOpenFile: (path: string) => void;
  onRefresh: () => void;
  onNavigate: (id: string) => void;
}

function comparablePath(path: string): string {
  return path.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

function collectActiveAncestors(
  nodes: FileTreeNode[],
  activePath: string,
  ancestors: Set<string>,
): boolean {
  for (const node of nodes) {
    if (node.kind === "file") {
      if (comparablePath(node.path) === activePath) return true;
      continue;
    }

    if (collectActiveAncestors(node.children, activePath, ancestors)) {
      ancestors.add(node.path);
      return true;
    }
  }
  return false;
}

interface FileTreeItemProps {
  node: FileTreeNode;
  depth: number;
  activePath: string;
  expandedFolders: Set<string>;
  onToggleFolder: (path: string) => void;
  onOpenFile: (path: string) => void;
}

function FileTreeItem({
  node,
  depth,
  activePath,
  expandedFolders,
  onToggleFolder,
  onOpenFile,
}: FileTreeItemProps) {
  const isFolder = node.kind === "folder";
  const expanded = isFolder && expandedFolders.has(node.path);
  const active = !isFolder && comparablePath(node.path) === activePath;

  return (
    <li role="treeitem" aria-expanded={isFolder ? expanded : undefined}>
      <button
        type="button"
        className={`file-tree__row${active ? " is-active" : ""}`}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        onClick={() => (isFolder ? onToggleFolder(node.path) : onOpenFile(node.path))}
        title={node.path}
        aria-current={active ? "page" : undefined}
      >
        {isFolder ? (
          <>
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            {expanded ? <FolderOpen size={15} /> : <Folder size={15} />}
          </>
        ) : (
          <>
            <span className="file-tree__spacer" />
            <FileText size={15} />
          </>
        )}
        <span>{node.name}</span>
      </button>
      {expanded && (
        <ul role="group">
          {node.children.map((child) => (
            <FileTreeItem
              key={child.path}
              node={child}
              depth={depth + 1}
              activePath={activePath}
              expandedFolders={expandedFolders}
              onToggleFolder={onToggleFolder}
              onOpenFile={onOpenFile}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export function Sidebar({
  fileTree,
  items,
  width,
  collapsed,
  activeId,
  activeFilePath,
  activeTab,
  refreshing,
  onToggle,
  onWidthChange,
  onTabChange,
  onOpenFile,
  onRefresh,
  onNavigate,
}: SidebarProps) {
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const activePath = useMemo(() => comparablePath(activeFilePath), [activeFilePath]);

  useEffect(() => {
    setExpandedFolders(new Set());
  }, [fileTree?.path]);

  useEffect(() => {
    if (!fileTree || !activePath) return;
    const activeAncestors = new Set<string>();
    collectActiveAncestors(fileTree.children, activePath, activeAncestors);
    if (activeAncestors.size === 0) return;

    setExpandedFolders((current) => new Set([...current, ...activeAncestors]));
  }, [activePath, fileTree]);

  const toggleFolder = useCallback((path: string) => {
    setExpandedFolders((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const startResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = width;
      document.body.classList.add("is-resizing-sidebar");

      const handleMove = (moveEvent: PointerEvent) => {
        const nextWidth = Math.min(Math.max(startWidth + moveEvent.clientX - startX, 200), 420);
        onWidthChange(nextWidth);
      };

      const handleUp = () => {
        document.body.classList.remove("is-resizing-sidebar");
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleUp);
      };

      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handleUp, { once: true });
    },
    [onWidthChange, width],
  );

  if (collapsed) {
    return (
      <div className="sidebar-collapsed">
        <button type="button" onClick={onToggle} title="Show navigation">
          <ChevronRight size={17} />
          <span className="sr-only">Show navigation</span>
        </button>
      </div>
    );
  }

  return (
    <aside className="sidebar" style={{ width }} aria-label="Document navigation">
      <div className="sidebar__header">
        <div className="sidebar__tabs" role="tablist" aria-label="Navigation view">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "files"}
            className={activeTab === "files" ? "is-active" : undefined}
            disabled={!fileTree}
            onClick={() => onTabChange("files")}
          >
            <Files size={14} />
            Files
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "contents"}
            className={activeTab === "contents" ? "is-active" : undefined}
            disabled={!activeFilePath}
            onClick={() => onTabChange("contents")}
          >
            <ListTree size={14} />
            Contents
          </button>
        </div>
        <button className="sidebar__collapse" type="button" onClick={onToggle} title="Hide navigation">
          <ChevronLeft size={17} />
          <span className="sr-only">Hide navigation</span>
        </button>
      </div>

      {activeTab === "files" && fileTree ? (
        <div className="sidebar__panel" role="tabpanel">
          <div className="sidebar__root">
            <span title={fileTree.path}>{fileTree.name}</span>
            <button
              type="button"
              onClick={onRefresh}
              disabled={refreshing}
              title="Refresh file tree"
              aria-label="Refresh file tree"
            >
              <RefreshCw className={refreshing ? "is-spinning" : undefined} size={14} />
            </button>
          </div>
          {fileTree.children.length > 0 ? (
            <ul className="file-tree" role="tree" aria-label={`${fileTree.name} Markdown files`}>
              {fileTree.children.map((node) => (
                <FileTreeItem
                  key={node.path}
                  node={node}
                  depth={0}
                  activePath={activePath}
                  expandedFolders={expandedFolders}
                  onToggleFolder={toggleFolder}
                  onOpenFile={onOpenFile}
                />
              ))}
            </ul>
          ) : (
            <p className="sidebar__empty">No Markdown files in this folder.</p>
          )}
        </div>
      ) : (
        <nav className="sidebar__nav" aria-label="Table of contents">
          {items.length > 0 ? (
            items.map((item) => (
              <button
                type="button"
                key={item.id}
                className={activeId === item.id ? "is-active" : undefined}
                style={{ paddingLeft: `${12 + (item.level - 1) * 14}px` }}
                onClick={() => onNavigate(item.id)}
                title={item.text}
              >
                {item.text}
              </button>
            ))
          ) : (
            <p>No H1–H3 headings in this document.</p>
          )}
        </nav>
      )}

      <div
        className="sidebar__resize-handle"
        onPointerDown={startResize}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize navigation"
      />
    </aside>
  );
}
