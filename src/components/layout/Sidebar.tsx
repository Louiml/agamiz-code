import { useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useEditorStore, useSidebarStore, useContextMenuStore, useProjectStore } from "../../store";
import type { FileNode } from "../../types";

function iconForFile(name: string, isDir: boolean): string {
  if (isDir) return "\uD83D\uDCC1";
  const ext = name.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "ts":
    case "tsx":
      return "\uD83D\uDCE6";
    case "js":
    case "jsx":
      return "\uD83D\uDFE8";
    case "json":
      return "\u2699\uFE0F";
    case "css":
    case "scss":
      return "\uD83C\uDFA8";
    case "html":
      return "\uD83C\uDF10";
    case "md":
      return "\uD83D\uDCDC";
    case "svg":
      return "\uD83D\uDDBC\uFE0F";
    default:
      return "\uD83D\uDCC4";
  }
}

function FileTreeItem({
  node,
  depth,
  onSelect,
}: {
  node: FileNode;
  depth: number;
  onSelect: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FileNode[] | null>(null);
  const [loading, setLoading] = useState(false);
  const showMenu = useContextMenuStore((s) => s.showMenu);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      showMenu(e.clientX, e.clientY, node.path, node.isDir);
    },
    [node.path, node.isDir, showMenu],
  );

  const handleToggle = useCallback(async () => {
    if (!node.isDir) {
      onSelect(node.path);
      return;
    }
    if (!expanded && children === null) {
      setLoading(true);
      try {
        const entries: FileNode[] = await invoke("get_file_tree", {
          path: node.path,
        });
        setChildren(entries);
      } catch {
        setChildren([]);
      }
      setLoading(false);
    }
    setExpanded(!expanded);
  }, [expanded, children, node, onSelect]);

  return (
    <div>
      <button
        onClick={handleToggle}
        onContextMenu={handleContextMenu}
        className="flex items-center w-full text-left py-[3px] px-[6px] rounded-[6px] text-[12px] hover:bg-[var(--color-bg-glass-hover)] transition-colors gap-1.5"
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
      >
        <span className="text-[10px] w-4 shrink-0">
          {loading ? "\u23F3" : expanded ? "\u25BC" : "\u25B6"}
        </span>
        <span className="text-[13px] w-4 shrink-0 text-center">
          {iconForFile(node.name, node.isDir)}
        </span>
        <span
          className="truncate text-[var(--color-text-primary)]"
          title={node.path}
        >
          {node.name}
        </span>
      </button>

      {expanded && children && (
        <div>
          {children.map((child) => (
            <FileTreeItem
              key={child.path}
              node={child}
              depth={depth + 1}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function Sidebar() {
  const visible = useSidebarStore((s) => s.visible);
  const width = useSidebarStore((s) => s.width);
  const selectFile = useSidebarStore((s) => s.selectFile);
  const openTab = useEditorStore((s) => s.openTab);
  const projectRoot = useProjectStore((s) => s.root);
  const [rootChildren, setRootChildren] = useState<FileNode[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const onChanged = () => setRefreshKey((k) => k + 1);
    const onProject = () => setRefreshKey((k) => k + 1);
    window.addEventListener("file:changed", onChanged);
    window.addEventListener("project:changed", onProject);
    return () => {
      window.removeEventListener("file:changed", onChanged);
      window.removeEventListener("project:changed", onProject);
    };
  }, []);

  useEffect(() => {
    if (!projectRoot) {
      setRootChildren([]);
      return;
    }
    invoke<FileNode[]>("get_file_tree", { path: projectRoot })
      .then(setRootChildren)
      .catch(console.warn);
  }, [refreshKey, projectRoot]);

  const handleSelect = useCallback(
    (path: string) => {
      selectFile(path);
      const name = path.replace(/\\/g, "/").split("/").pop() ?? path;
      const ext = name.split(".").pop()?.toLowerCase() ?? "";
      const langMap: Record<string, string> = {
        ts: "typescript",
        tsx: "typescript",
        js: "javascript",
        jsx: "javascript",
        json: "json",
        css: "css",
        scss: "css",
        html: "html",
        md: "markdown",
        rs: "rust",
      };
      openTab({
        id: path,
        path,
        name,
        isDirty: false,
        language: langMap[ext] ?? "plain",
      });
    },
    [selectFile, openTab]
  );

  if (!visible) return null;

  return (
    <aside
      className="flex flex-col shrink-0 border-r border-[var(--color-border-glass)] glass animate-slide-left scrollbar-apple overflow-y-auto"
      style={{ width }}
    >
      <div className="p-3">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-[var(--color-text-tertiary)] mb-2 px-1">
          Explorer
        </p>
        {!projectRoot ? (
          <p className="text-[12px] text-[var(--color-text-tertiary)] px-1 py-2">
            No folder open. Open a project to view its files.
          </p>
        ) : (
          rootChildren.map((child) => (
            <FileTreeItem
              key={child.path}
              node={child}
              depth={0}
              onSelect={handleSelect}
            />
          ))
        )}
      </div>
    </aside>
  );
}