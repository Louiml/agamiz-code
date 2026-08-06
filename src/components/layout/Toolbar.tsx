import {
  useSidebarStore,
  useInspectorStore,
  useTerminalStore,
  useThemeStore,
} from "../../store";

interface ToolButton {
  id: string;
  label: string;
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
}

function SvgIcon({ path }: { path: string }) {
  return (
    <svg
      className="size-[18px]"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={path} />
    </svg>
  );
}

export function Toolbar() {
  const sidebarVisible = useSidebarStore((s) => s.visible);
  const toggleSidebar = useSidebarStore((s) => s.toggle);
  const inspectorVisible = useInspectorStore((s) => s.visible);
  const toggleInspector = useInspectorStore((s) => s.toggle);
  const terminalVisible = useTerminalStore((s) => s.visible);
  const toggleTerminal = useTerminalStore((s) => s.toggle);
  const variant = useThemeStore((s) => s.variant);
  const toggleTheme = useThemeStore((s) => s.toggleTheme);

  const buttons: ToolButton[] = [
    {
      id: "explorer",
      label: "Toggle Explorer",
      active: sidebarVisible,
      onClick: toggleSidebar,
      icon: (
        <SvgIcon path="M3 5a2 2 0 012-2h4l2 2h8a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V5z" />
      ),
    },
{
      id: "search",
      label: "Search Symbols",
      active: false,
      onClick: () => {},
      icon: <SvgIcon path="M21 21l-4.35-4.35M17 7a10 7 0 11-20 0a10 7 0 0120 0z" />,
    },
    {
      id: "terminal",
      label: "Toggle Terminal",
      active: terminalVisible,
      onClick: toggleTerminal,
      icon: (
        <SvgIcon path="M4 17l6-5-6-5M12 19h8" />
      ),
    },
    {
      id: "inspector",
      label: "Toggle Inspector",
      active: inspectorVisible,
      onClick: toggleInspector,
      icon: (
        <SvgIcon path="M12 3a9 9 0 100 18 9 9 0 000-18zM12 3v18M9 3.5A9 9 0 003 12M15 3.5A9 9 0 0121 12" />
      ),
    },
    {
      id: "theme",
      label: `Theme: ${variant}`,
      active: false,
      onClick: toggleTheme,
      icon: (
        <SvgIcon path="M12 3v1.5M12 19.5V21M3 12h1.5M19.5 12H21M5.6 5.6l1.06 1.06M17.34 17.34l1.06 1.06M18.4 5.6l-1.06 1.06M6.66 17.34l-1.06 1.06M12 8a4 4 0 100 8 4 4 0 000-8z" />
      ),
    },
  ];

  return (
    <nav className="flex flex-col items-center gap-1 py-2 w-[46px] shrink-0 glass border-r border-[var(--color-border-glass)]">
      {buttons.map((btn) => (
        <button
          key={btn.id}
          onClick={btn.onClick}
          title={btn.label}
          aria-label={btn.label}
          className={`w-9 h-9 rounded-lg flex items-center justify-center transition-all duration-150 ${
            btn.active
              ? "bg-[var(--color-bg-glass-active)] text-[var(--color-text-primary)]"
              : "text-[var(--color-text-tertiary)] hover:bg-[var(--color-bg-glass-hover)] hover:text-[var(--color-text-secondary)]"
          }`}
        >
          {btn.icon}
        </button>
      ))}

      <div className="flex-1" />

      <button
        onClick={() => {}}
        title="Settings"
        aria-label="Settings"
        className="w-9 h-9 rounded-lg flex items-center justify-center text-[var(--color-text-tertiary)] hover:bg-[var(--color-bg-glass-hover)] hover:text-[var(--color-text-secondary)] transition-all"
      >
        <svg
          className="size-[18px]"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        >
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33 1.65 1.65 0 0 0 1-1.51V13a2 2 0 0 1 4 0" />
        </svg>
      </button>
    </nav>
  );
}