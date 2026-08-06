import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useContextMenuStore } from "../../store";

interface MenuItem {
  id: string;
  label: string;
  icon?: string;
  shortcut?: string;
  danger?: boolean;
  action: (path: string) => void;
}

export function FileContextMenu() {
  const { open, x, y, path, isDir, hideMenu } = useContextMenuStore();
  const [error, setError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        hideMenu();
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") hideMenu();
    };
    const onBlur = () => hideMenu();
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", onBlur);
    };
  }, [open, hideMenu]);

  useEffect(() => {
    setError(null);
  }, [open]);

  const runAction = (fn: () => Promise<unknown> | void) => {
    Promise.resolve(fn())
      .then(() => {
        hideMenu();
        window.dispatchEvent(new CustomEvent("file:changed"));
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
      });
  };

  const parentPath = useMemo(() => {
    if (!path) return "";
    const parts = path.replace(/\\/g, "/").split("/");
    parts.pop();
    return parts.join("/");
  }, [path]);

  const baseName = useMemo(() => {
    if (!path) return "";
    const parts = path.replace(/\\/g, "/").split("/");
    return parts[parts.length - 1] ?? "";
  }, [path]);

  const items: MenuItem[] = useMemo(() => {
    if (!path) return [];
    const common: MenuItem[] = [
      {
        id: "reveal",
        label: "Reveal in Explorer",
        icon: "\uD83D\uDCC2",
        shortcut: "Alt+R",
        action: (p) => runAction(() => invoke("reveal_in_explorer", { path: p })),
      },
      {
        id: "copy-path",
        label: "Copy Path",
        icon: "\uD83D\uDCCB",
        action: (p) => runAction(() => navigator.clipboard.writeText(p)),
      },
      {
        id: "copy-name",
        label: "Copy Name",
        icon: "\u270F\uFE0F",
        action: () => runAction(() => navigator.clipboard.writeText(baseName)),
      },
    ];

    if (isDir) {
      return [
        {
          id: "new-file",
          label: "New File",
          icon: "\uD83D\uDCC4",
          shortcut: "Alt+N",
          action: (p) =>
            runAction(async () => {
              const name = window.prompt("New file name", "untitled.ts");
              if (!name) return;
              await invoke("create_file", { path: `${p.replace(/[\\/]+$/, "")}/${name}` });
            }),
        },
        {
          id: "new-folder",
          label: "New Folder",
          icon: "\uD83D\uDCC1",
          shortcut: "Alt+F",
          action: (p) =>
            runAction(async () => {
              const name = window.prompt("New folder name", "new-folder");
              if (!name) return;
              await invoke("create_folder", { path: `${p.replace(/[\\/]+$/, "")}/${name}` });
            }),
        },
        { id: "sep-1", label: "", icon: "", action: () => {} },
        ...common,
        { id: "sep-2", label: "", icon: "", action: () => {} },
        {
          id: "rename",
          label: "Rename",
          icon: "\uD83D\uDD19",
          shortcut: "F2",
          action: (p) =>
            runAction(async () => {
              const parts = p.replace(/\\/g, "/").split("/");
              const current = parts[parts.length - 1] ?? "";
              const name = window.prompt("Rename to", current);
              if (!name || name === current) return;
              parts[parts.length - 1] = name;
              await invoke("rename_path", { oldPath: p, newPath: parts.join("/") });
            }),
        },
        {
          id: "duplicate",
          label: "Duplicate",
          icon: "\uD83D\uDCCE",
          action: (p) => runAction(() => invoke("duplicate_path", { path: p })),
        },
        {
          id: "delete",
          label: "Delete",
          icon: "\uD83D\uDDD1\uFE0F",
          danger: true,
          shortcut: "Del",
          action: (p) =>
            runAction(async () => {
              if (!window.confirm(`Permanently delete ${baseName}?`)) return;
              await invoke("delete_path", { path: p, recursive: true });
            }),
        },
      ];
    }

    return [
      {
        id: "open",
        label: "Open",
        icon: "\u2192",
        shortcut: "Enter",
        action: () => Promise.resolve(undefined),
      },
      { id: "sep-1", label: "", icon: "", action: () => {} },
      ...common,
      { id: "sep-2", label: "", icon: "", action: () => {} },
      {
        id: "rename",
        label: "Rename",
        icon: "\uD83D\uDD19",
        shortcut: "F2",
        action: (p) =>
          runAction(async () => {
            const parts = p.replace(/\\/g, "/").split("/");
            const current = parts[parts.length - 1] ?? "";
            const name = window.prompt("Rename to", current);
            if (!name || name === current) return;
            parts[parts.length - 1] = name;
            await invoke("rename_path", { oldPath: p, newPath: parts.join("/") });
          }),
      },
      {
        id: "duplicate",
        label: "Duplicate",
        icon: "\uD83D\uDCCE",
        action: (p) => runAction(() => invoke("duplicate_path", { path: p })),
      },
      {
        id: "delete",
        label: "Delete",
        icon: "\uD83D\uDDD1\uFE0F",
        danger: true,
        shortcut: "Del",
        action: (p) =>
          runAction(async () => {
            if (!window.confirm(`Permanently delete ${baseName}?`)) return;
            await invoke("delete_path", { path: p, recursive: false });
          }),
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, isDir, parentPath, baseName]);

  if (!open || !path) return null;

  const maxHeight = window.innerHeight - y - 16;
  const style: React.CSSProperties = {
    position: "fixed",
    top: Math.min(y, window.innerHeight - 400),
    left: Math.min(x, window.innerWidth - 260),
    zIndex: 60,
  };

  return (
    <div
      ref={menuRef}
      className="glass-modal min-w-[220px] py-1 animate-scale-in"
      style={style}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="px-3 pt-1 pb-1.5">
        <div className="text-[10px] font-semibold uppercase tracking-widest text-[var(--color-text-tertiary)] truncate">
          {baseName}
        </div>
        <div className="text-[10px] text-[var(--color-text-tertiary)] font-mono truncate opacity-60">
          {parentPath || "/"}
        </div>
      </div>

      <div className="border-t border-[var(--color-border-glass)] my-1" />

      {error && (
        <div className="px-3 py-1.5 text-[11px] text-[var(--color-accent-red)]">
          {error}
        </div>
      )}

      <div className="overflow-y-auto scrollbar-apple" style={{ maxHeight }}>
        {items.map((item, idx) =>
          item.label === "" ? (
            <div
              key={`sep-${idx}`}
              className="border-t border-[var(--color-border-glass)] my-1"
            />
          ) : (
            <button
              key={item.id}
              onClick={() => item.action(path)}
              className={`flex items-center gap-2.5 w-full text-left px-3 py-[6px] text-[12px] hover:bg-[var(--color-bg-glass-hover)] transition-colors ${
                item.danger ? "text-[var(--color-accent-red)]" : "text-[var(--color-text-primary)]"
              }`}
            >
              <span className="w-4 text-center text-[13px]">{item.icon}</span>
              <span className="flex-1">{item.label}</span>
              {item.shortcut && (
                <span className="text-[10px] text-[var(--color-text-tertiary)]">
                  {item.shortcut}
                </span>
              )}
            </button>
          ),
        )}
      </div>
    </div>
  );
}