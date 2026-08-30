import { ChevronLeft, ChevronRight, ListTree } from "lucide-react";
import { useCallback } from "react";
import type { TocItem } from "../types";

interface SidebarProps {
  items: TocItem[];
  width: number;
  collapsed: boolean;
  activeId: string;
  onToggle: () => void;
  onWidthChange: (width: number) => void;
  onNavigate: (id: string) => void;
}

export function Sidebar({
  items,
  width,
  collapsed,
  activeId,
  onToggle,
  onWidthChange,
  onNavigate,
}: SidebarProps) {
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
        <button type="button" onClick={onToggle} title="Show table of contents">
          <ChevronRight size={17} />
          <span className="sr-only">Show table of contents</span>
        </button>
      </div>
    );
  }

  return (
    <aside className="sidebar" style={{ width }} aria-label="Table of contents">
      <div className="sidebar__header">
        <div>
          <ListTree size={16} />
          <span>Contents</span>
        </div>
        <button type="button" onClick={onToggle} title="Hide table of contents">
          <ChevronLeft size={17} />
          <span className="sr-only">Hide table of contents</span>
        </button>
      </div>
      <nav className="sidebar__nav">
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
      <div
        className="sidebar__resize-handle"
        onPointerDown={startResize}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize table of contents"
      />
    </aside>
  );
}

