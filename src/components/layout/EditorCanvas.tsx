import { useEffect, useState, useMemo, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import CodeMirror from "@uiw/react-codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { rust } from "@codemirror/lang-rust";
import { keymap } from "@codemirror/view";
import { EditorView } from "@codemirror/view";
import type { ReactCodeMirrorProps } from "@uiw/react-codemirror";
import { useEditorStore, useSidebarStore, useLspDiagnosticsStore } from "../../store";
import { ImageViewer } from "./ImageViewer";
import { MarkdownPreview } from "./MarkdownPreview";
import { isImageFile } from "../../utils/image";
import { openProject } from "../../utils/project";
import type { Extension } from "@codemirror/state";
import { lspExtensions, pathToLanguage } from "../../utils/codemirrorLsp";
import { breakpointGutter } from "../../utils/breakpointGutter";
import { gitGutter, setGitGutterLines } from "../../utils/gitGutter";
import { ghostTextExtension } from "../../utils/ghostText";
import { lsp, initLspDiagnostics, fromUri } from "../../utils/lsp";
import type { GitFileDiff } from "../../types";

const langExtensions: Record<string, () => Extension> = {
  typescript: () => javascript({ typescript: true, jsx: true }),
  javascript: () => javascript({ jsx: true }),
  html: html,
  css: css,
  scss: css,
  less: css,
  json: json,
  markdown: markdown,
  rust: rust,
};

const agamizTheme = EditorView.theme(
  {
    "&": {
      backgroundColor: "var(--color-bg-base)",
      color: "var(--color-text-primary)",
      fontSize: "13px",
      fontFamily: "var(--font-mono)",
      fontFeatureSettings: '"ss01","ss02","ss03","cv01","cv02","calr","liga"',
    },
    ".cm-content": {
      padding: "24px",
      caretColor: "var(--color-accent-teal)",
    },
    ".cm-cursor": {
      borderLeftColor: "var(--color-accent-teal)",
    },
    "&.cm-focused .cm-cursor": {
      borderLeftColor: "var(--color-accent-teal)",
    },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
      background: "var(--color-accent-blue) !important",
      opacity: 0.2,
    },
    ".cm-gutters": {
      background: "var(--color-bg-base)",
      borderRight: "1px solid var(--color-border-glass)",
      color: "var(--color-text-tertiary)",
      fontSet: "var(--font-mono)",
      fontSize: "11px",
      padding: "0 6px 0 4px",
    },
    ".cm-activeLineGutter": {
      background: "var(--color-bg-glass)",
      color: "var(--color-text-secondary)",
    },
    ".cm-activeLine": {
      background: "var(--color-bg-glass) !important",
      borderRadius: "4px",
    },
    ".cm-foldPlaceholder": {
      background: "var(--color-bg-glass-strong)",
      border: "1px solid var(--color-border-glass)",
      color: "var(--color-accent-teal)",
      borderRadius: "4px",
      padding: "0 6px",
      fontSize: "11px",
    },
    ".cm-matchingBracket": {
      background: "var(--color-bg-glass-strong)",
      outline: "1px solid var(--color-border-strong)",
      borderRadius: "2px",
    },
    ".cm-nonmatchingBracket": {
      background: "rgba(255, 69, 58, 0.15)",
      outline: "1px solid var(--color-accent-red)",
    },
    ".cm-tooltip": {
      background: "var(--color-bg-overlay)",
      border: "1px solid var(--color-border-glass)",
      borderRadius: "8px",
      boxShadow: "var(--shadow-glass-md)",
      color: "var(--color-text-primary)",
    },
    ".cm-tooltip-autocomplete > ul > li": {
      padding: "2px 8px",
      fontSize: "12px",
    },
    ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
      background: "var(--color-bg-glass-hover)",
      color: "var(--color-text-primary)",
    },
    ".cm-panel": {
      background: "var(--color-bg-overlay)",
      borderBottom: "1px solid var(--color-border-glass)",
    },
    ".cm-searchMatch": {
      background: "var(--color-accent-orange)",
      opacity: 0.25,
    },
    ".cm-searchMatch-selected": {
      background: "var(--color-accent-orange)",
      opacity: 0.4,
    },
    ".cm-lightColor": { color: "var(--color-text-tertiary)" },
    ".cm-keyword": { color: "#fc6a8c" },
    ".cm-atom": { color: "#d2a8ff" },
    ".cm-number": { color: "#79c0ff" },
    ".cm-def": { color: "#d2a8ff" },
    ".cm-variable": { color: "#ffa657" },
    ".cm-variable-2": { color: "#79c0ff" },
    ".cm-type": { color: "#ffa657" },
    ".cm-property": { color: "#79c0ff" },
    ".cm-operator": { color: "#d2a8ff" },
    ".cm-comment": { color: "#5c6370", fontStyle: "italic" },
    ".cm-string": { color: "#a5d6ff" },
    ".cm-string-2": { color: "#a5d6ff" },
    ".cm-meta": { color: "#d2a8ff" },
    ".cm-qualifier": { color: "#ffa657" },
    ".cm-tag": { color: "#7ee787" },
    ".cm-attribute": { color: "#79c0ff" },
    ".cm-bracket": { opacity: 0.5 },
    ".cm-link": { color: "#79c0ff", textDecoration: "underline" },
    ".cm-heading": { color: "#d2a8ff", fontWeight: "600" },
    ".cm-hr": { color: "var(--color-text-tertiary)" },
    ".cm-emphasis": { fontStyle: "italic" },
    ".cm-strong": { fontWeight: "600" },
    ".cm-quote": { color: "var(--color-text-secondary)", fontStyle: "italic" },
    ".cm-list": { color: "var(--color-accent-orange)" },
    ".cm-builtin": { color: "var(--color-accent-purple)" },
    ".cm-tagName": { color: "var(--color-accent-green)" },
    ".cm-attributeName": { color: "var(--color-accent-orange)" },
    ".cm-attributeValue": { color: "var(--color-accent-teal)" },
    ".cm-deleted": { color: "var(--color-accent-red)", textDecoration: "line-through" },
    ".cm-inserted": { color: "var(--color-accent-green)" },
    ".cm-changed": { color: "var(--color-accent-orange)" },
  },
  { dark: true },
);

const pendingChanges = new Map<string, number>();

function scheduleLspChange(path: string, text: string) {
  const existing = pendingChanges.get(path);
  if (existing) window.clearTimeout(existing);
  const t = window.setTimeout(() => {
    pendingChanges.delete(path);
    void lsp.change(path, text).catch((e) => console.warn("[lsp] change", path, e));
  }, 350);
  pendingChanges.set(path, t);
}

export function EditorCanvas() {
  const tabs = useEditorStore((s) => s.tabs);
  const activeTabId = useEditorStore((s) => s.activeTabId);
  const setActiveTab = useEditorStore((s) => s.setActiveTab);
  const closeTab = useEditorStore((s) => s.closeTab);
  const markDirty = useEditorStore((s) => s.markDirty);

  const [content, setContent] = useState("");
  const [showPreview, setShowPreview] = useState<boolean | "split">(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  const pendingCursorRef = useRef<{ line: number; character: number } | null>(null);
  const [viewReadyTick, setViewReadyTick] = useState(0);

  const activeTab = useMemo(
    () => tabs.find((t) => t.id === activeTabId),
    [tabs, activeTabId],
  );

  const isImage = useMemo(
    () => (activeTab ? isImageFile(activeTab.path) : false),
    [activeTab],
  );

  const isMarkdown = useMemo(
    () => activeTab?.language === "markdown",
    [activeTab],
  );

  useEffect(() => {
    setShowPreview(false);
  }, [activeTabId]);

  useEffect(() => {
    if (!activeTab || isImage) return;
    const path = activeTab.path;
    useSidebarStore.getState().selectFile(path);
    let cancelled = false;
    invoke<string>("read_file_content", { path })
      .then((text) => {
        if (cancelled) return;
        setContent(text);
        void lsp
          .open(path, pathToLanguage(path), text)
          .catch((e) => console.warn("[lsp] open", path, e));
      })
      .catch(console.warn);
    return () => {
      cancelled = true;
      void lsp.close(path);
    };
  }, [activeTab, isImage]);

  // Load git diff indicators for the active file into the editor gutter.
  useEffect(() => {
    if (!activeTab || isImage) return;
    const path = activeTab.path;
    let cancelled = false;
    void invoke<GitFileDiff>("git_diff", { path })
      .then((diff) => {
        if (cancelled || !editorViewRef.current) return;
        setGitGutterLines(
          editorViewRef.current,
          diff.lines.map((l) => ({
            line: l.line,
            kind: l.kind,
            status: l.status,
          })),
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activeTab, isImage, viewReadyTick]);

  const handleChange = useCallback(
    (value: string) => {
      setContent(value);
      if (activeTab) {
        markDirty(activeTab.id, true);
        if (activeTab.path) {
          scheduleLspChange(activeTab.path, value);
        }
      }
    },
    [activeTab, markDirty],
  );

  const saveExtension = useMemo(() => {
    return keymap.of([
      {
        key: "Mod-s",
        run: () => {
          if (!activeTab) return false;
          invoke("write_file_content", {
            path: activeTab.path,
            content,
          }).then(() => markDirty(activeTab.id, false));
          return true;
        },
      },
    ]);
  }, [activeTab, content, markDirty]);

  const handleOpenLocation = useCallback(
    (uri: string, line: number, character: number) => {
      const path = fromUri(uri);
      const target =
        tabs.find((t) => t.path.replace(/\\/g, "/") === path.replace(/\\/g, "/")) ??
        tabs[0];
      if (!target) return;
      setActiveTab(target.id);
      pendingCursorRef.current = { line, character };
      invoke<string>("read_file_content", { path: target.path })
        .then(setContent)
        .catch(console.warn);
    },
    [tabs, setActiveTab],
  );

  useEffect(() => {
    if (!activeTab || !pendingCursorRef.current) return;
    const view = editorViewRef.current;
    const { line, character } = pendingCursorRef.current;
    pendingCursorRef.current = null;
    if (view && content) {
      const lineNum = Math.max(1, line + 1);
      const docLine = view.state.doc.line(Math.min(lineNum, view.state.doc.lines));
      const pos = docLine.from + Math.min(character, docLine.length);
      view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
      view.focus();
    }
  }, [activeTab, content]);

  useEffect(() => {
    let un: (() => void) | undefined;
    void initLspDiagnostics((payload) => {
      const { file, diagnostics } = payload;
      if (diagnostics.length === 0) {
        useLspDiagnosticsStore.getState().clearFile(file);
      } else {
        useLspDiagnosticsStore.getState().setFile(file, diagnostics);
      }
    }).then((fn) => (un = fn));
    return () => un?.();
  }, []);

  const extensions = useMemo(() => {
    const lang = activeTab?.language ?? "plain";
    const ext = langExtensions[lang];
    const base = ext ? [ext(), saveExtension] : [saveExtension];
    if (!activeTab) return base;
    return [
      ...base,
      ...lspExtensions(activeTab.path, handleOpenLocation),
      breakpointGutter(activeTab.path),
      gitGutter(),
      ghostTextExtension(activeTab.path),
    ];
  }, [activeTab?.language, saveExtension, activeTab?.path]);

  const onEditorReady: ReactCodeMirrorProps["onCreateEditor"] = (view) => {
    editorViewRef.current = view;
    setViewReadyTick((t) => t + 1);
  };

  if (tabs.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center glass">
        <div className="text-center space-y-5">
          <div className="text-6xl opacity-20 select-none">{"\u2728"}</div>
          <h2 className="text-lg font-medium text-[var(--color-text-secondary)]">
            Agamiz Code
          </h2>
          <p className="text-[13px] text-[var(--color-text-tertiary)] max-w-xs leading-relaxed">
            Open a project to begin. Use{" "}
            <kbd className="glass-strong px-1.5 py-0.5 text-[11px] rounded font-mono">
              Ctrl+K
            </kbd>{" "}
            to search symbols, files, and actions.
          </p>
          <button
            onClick={() => void openProject()}
            className="glass-strong glass-hover px-4 py-2 rounded-lg text-[13px] font-medium text-[var(--color-text-primary)] transition-all"
          >
            {"\uD83D\uDCC2"} Open Project…
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-w-0">
      <div className="flex items-center h-[34px] shrink-0 glass-strong border-b border-[var(--color-border-glass)] overflow-x-auto scrollbar-apple">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-1.5 h-full px-3 text-[12px] whitespace-nowrap border-r border-[var(--color-border-glass)] transition-colors ${
              tab.id === activeTabId
                ? "bg-[var(--color-bg-glass-strong)] text-[var(--color-text-primary)]"
                : "text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-glass)]"
            }`}
          >
            {tab.name}
            {tab.isDirty && (
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-accent-blue)]" />
            )}
            <span
              onClick={(e) => {
                e.stopPropagation();
                closeTab(tab.id);
              }}
              className="ml-1 text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] text-[10px] leading-none"
            >
              {"\u2715"}
            </span>
          </button>
        ))}
      </div>

      {activeTab && (
        <div className="flex items-center h-[26px] shrink-0 px-3 bg-[var(--color-bg-elevated)] border-b border-[var(--color-border-glass)]">
          <span className="text-[11px] text-[var(--color-text-tertiary)] font-mono tracking-wide">
            {activeTab.path}
          </span>
          {isMarkdown && (
            <div className="flex items-center gap-1 ml-auto">
              <button
                onClick={() => setShowPreview(false)}
                className={`px-2 py-0.5 rounded text-[11px] transition-colors ${
                  !showPreview
                    ? "bg-[var(--color-bg-glass-strong)] text-[var(--color-text-primary)]"
                    : "text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-glass)]"
                }`}
              >
                {"\u270E"} Edit
              </button>
              <button
                onClick={() => setShowPreview("split")}
                className={`px-2 py-0.5 rounded text-[11px] transition-colors flex items-center gap-1 ${
                  showPreview === "split"
                    ? "bg-[var(--color-bg-glass-strong)] text-[var(--color-text-primary)]"
                    : "text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-glass)]"
                }`}
              >
                {"\u25A0"} Split
              </button>
              <button
                onClick={() => setShowPreview(true)}
                className={`px-2 py-0.5 rounded text-[11px] transition-colors ${
                  showPreview === true
                    ? "bg-[var(--color-bg-glass-strong)] text-[var(--color-text-primary)]"
                    : "text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-glass)]"
                }`}
              >
                {"\u25B6"} Preview
              </button>
            </div>
          )}
        </div>
      )}

      <div ref={containerRef} className="flex-1 min-h-0 overflow-hidden">
        {activeTab && isImage ? (
          <ImageViewer path={activeTab.path} name={activeTab.name} />
        ) : isMarkdown && showPreview ? (
          <div className={`flex h-full ${showPreview === "split" ? "border-t border-[var(--color-border-glass)]" : ""}`}>
            {showPreview === "split" && (
              <>
                <div className="flex-1 min-w-0">
                  <CodeMirror
value={content}
                    onChange={handleChange}
                    extensions={extensions}
                    theme={agamizTheme}
                    onCreateEditor={onEditorReady}
                    basicSetup={{
                      lineNumbers: true,
                      highlightActiveLineGutter: true,
                      highlightActiveLine: true,
                      highlightSpecialChars: true,
                      foldGutter: true,
                      bracketMatching: true,
                      closeBrackets: true,
                      indentOnInput: true,
                      autocompletion: true,
                      crosshairCursor: true,
                      allowMultipleSelections: true,
                      tabSize: 2,
                    }}
                    style={{ height: "100%" }}
                  />
                </div>
                <div className="w-px bg-[var(--color-border-glass)] shrink-0" />
                <div className="w-1/2 min-w-0 bg-[var(--color-bg-base)]">
                  <MarkdownPreview markdown={content} />
                </div>
              </>
            )}
            {showPreview === true && (
              <MarkdownPreview markdown={content} />
            )}
          </div>
        ) : (
          <CodeMirror
            value={content}
            onChange={handleChange}
            extensions={extensions}
            theme={agamizTheme}
            basicSetup={{
              lineNumbers: true,
              highlightActiveLineGutter: true,
              highlightActiveLine: true,
              highlightSpecialChars: true,
              foldGutter: true,
              bracketMatching: true,
              closeBrackets: true,
              indentOnInput: true,
              autocompletion: true,
              crosshairCursor: true,
              allowMultipleSelections: true,
              tabSize: 2,
            }}
            style={{ height: "100%" }}
          />
        )}
      </div>
    </div>
  );
}