import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { readFile } from "@tauri-apps/plugin-fs";
import { imageMimeType } from "../../utils/image";

interface ImageViewerProps {
  path: string;
  name: string;
}

export function ImageViewer({ path, name }: ImageViewerProps) {
  const [src, setSrc] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [dimensions, setDimensions] = useState<{
    width: number;
    height: number;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;

    async function load() {
      try {
        const bytes = await readFile(path);
        if (cancelled) return;
        const blob = new Blob([bytes], { type: imageMimeType(path) });
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
        setError(null);
      } catch (e) {
        // Fall back to the asset protocol which handles some formats more reliably
        setSrc(convertFileSrc(path));
        setError(null);
        void e;
      }
    }

    load();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setSrc("");
    };
  }, [path]);

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-auto scrollbar-apple">
      <div className="flex-1 flex items-center justify-center p-8">
        {error ? (
          <div className="text-[13px] text-[var(--color-accent-red)]">
            {error}
          </div>
        ) : (
          <div className="flex flex-col items-center gap-4">
            <img
              src={src}
              alt={name}
              onLoad={(e) => {
                const img = e.currentTarget;
                setDimensions({ width: img.naturalWidth, height: img.naturalHeight });
              }}
              className="max-w-full max-h-[70vh] object-contain rounded-xl shadow-[var(--shadow-glass-md)] select-none"
              draggable={false}
            />
            {dimensions && (
              <div className="text-[11px] text-[var(--color-text-tertiary)] font-mono">
                {dimensions.width} &times; {dimensions.height}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}