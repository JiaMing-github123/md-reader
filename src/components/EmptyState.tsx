import { Clock3, FileText, FolderOpen } from "lucide-react";
import type { RecentFile } from "../types";

interface EmptyStateProps {
  recentFiles: RecentFile[];
  onOpen: () => void;
  onSelectRecent: (path: string) => void;
}

export function EmptyState({ recentFiles, onOpen, onSelectRecent }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <div className="empty-state__intro">
        <div className="empty-state__icon">
          <FileText size={30} />
        </div>
        <h1>Read Markdown without the clutter</h1>
        <p>Open a local .md or .markdown file, or drop one anywhere in this window.</p>
        <button type="button" onClick={onOpen}>
          <FolderOpen size={17} />
          Open Markdown File
        </button>
      </div>

      {recentFiles.length > 0 && (
        <section className="recent-files" aria-labelledby="recent-files-title">
          <div className="recent-files__title" id="recent-files-title">
            <Clock3 size={15} />
            Recent files
          </div>
          <div className="recent-files__list">
            {recentFiles.map((file) => (
              <button key={file.path} type="button" onClick={() => onSelectRecent(file.path)}>
                <FileText size={17} />
                <span>
                  <strong>{file.name}</strong>
                  <small>{file.path}</small>
                </span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

