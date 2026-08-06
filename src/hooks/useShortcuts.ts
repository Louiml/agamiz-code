import { useEffect } from "react";
import { usePaletteStore, useTerminalStore } from "../store";

export function useShortcuts() {
  const togglePalette = usePaletteStore((s) => s.toggle);
  const toggleTerminal = useTerminalStore((s) => s.toggle);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;

      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        togglePalette();
      } else if (mod && e.key === "`") {
        e.preventDefault();
        toggleTerminal();
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [togglePalette, toggleTerminal]);
}