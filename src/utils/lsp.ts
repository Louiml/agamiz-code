import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Diagnostic } from "../types";

const LANGUAGE_IDS: Record<string, string> = {
  typescript: "typescript",
  javascript: "javascript",
  rust: "rust",
  python: "python",
  go: "go",
};

const SUPPORTED = new Set(Object.values(LANGUAGE_IDS));

export function supportedLanguage(language: string): boolean {
  return SUPPORTED.has(language);
}

export function languageId(language: string): string {
  return LANGUAGE_IDS[language] ?? language;
}

export function toUri(path: string): string {
  const norm = path.replace(/\\/g, "/");
  const winDrive = /^[A-Za-z]:/.test(norm);
  if (winDrive) {
    return `file:///${norm}`;
  }
  return norm.startsWith("/") ? `file://${norm}` : `file:///${norm}`;
}

export function fromUri(uri: string): string {
  return uri.replace(/^file:\/\//, "").replace(/\//g, "\\");
}

export interface CompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  insertText?: string;
}

export interface LspDiagnosticsPayload {
  file: string;
  diagnostics: Diagnostic[];
}

let diagnosticsListener: UnlistenFn | undefined;

export async function initLspDiagnostics(
  onDiagnostics: (payload: LspDiagnosticsPayload) => void,
): Promise<UnlistenFn> {
  if (!diagnosticsListener) {
    diagnosticsListener = await listen<LspDiagnosticsPayload>("lsp:diagnostics", (event) => {
      onDiagnostics(event.payload);
    });
  }
  return () => {
    diagnosticsListener?.();
    diagnosticsListener = undefined;
  };
}

export function filePathKey(path: string): string {
  const norm = path.replace(/\\/g, "/").toLowerCase();
  return norm.replace(/^\/+/, "");
}

export const lsp = {
  open: (path: string, language: string, text: string) =>
    invoke<void>("lsp_open", {
      uri: toUri(path),
      language: languageId(language),
      text,
    }),
  change: (path: string, text: string) =>
    invoke<void>("lsp_change", { uri: toUri(path), text }),
  close: (path: string) =>
    invoke<void>("lsp_close", { uri: toUri(path) }),
  completion: (path: string, line: number, character: number) =>
    invoke<CompletionItem[]>("lsp_completion", {
      uri: toUri(path),
      line,
      character,
    }),
  hover: (path: string, line: number, character: number) =>
    invoke<{ contents?: { value?: string } } | null>("lsp_hover", {
      uri: toUri(path),
      line,
      character,
    }),
  definition: (path: string, line: number, character: number) =>
    invoke<{ uri: string; range: { start: { line: number; character: number } } }[]>(
      "lsp_definition",
      { uri: toUri(path), line, character },
    ),
};