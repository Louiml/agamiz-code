import { useEffect, useMemo } from "react";
import { marked } from "marked";

interface MarkdownPreviewProps {
  markdown: string;
}

marked.setOptions({
  gfm: true,
  breaks: true,
});

export function MarkdownPreview({ markdown }: MarkdownPreviewProps) {
  const html = useMemo(() => {
    try {
      return marked.parse(markdown) as string;
    } catch (e) {
      console.warn("markdown parse failed", e);
      return `<pre>${markdown}</pre>`;
    }
  }, [markdown]);

  useEffect(() => {
    const links = document.querySelectorAll<HTMLAnchorElement>(".md-preview a");
    const handler = (e: MouseEvent) => {
      const href = (e.target as HTMLAnchorElement).getAttribute("href") ?? "";
      if (href.startsWith("http")) {
        // let it navigate normally
        return;
      }
      e.preventDefault();
    };
    links.forEach((l) => l.addEventListener("click", handler));
    return () => {
      links.forEach((l) => l.removeEventListener("click", handler));
    };
  }, [html]);

  return (
    <div
      className="md-preview flex-1 min-h-0 overflow-auto scrollbar-apple px-10 py-8"
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}