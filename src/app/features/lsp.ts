/**
 * Language-features layer. Exposes a provider interface used by the editor for
 * completion, hover and document symbols. A built-in provider derives these
 * from the language registry; an external LSP server (when configured) is
 * spoken to over the bundled LSP tunnel using the LSP (JSON-RPC) protocol and
 * supersedes the built-in results.
 */

import { getLanguage, listLanguages } from '../../languages/registry';
import type { Position } from './diag';

export type CompletionKind =
  | 'keyword' | 'type' | 'builtin' | 'function' | 'class' | 'variable' | 'property' | 'snippet';

export interface Completion {
  label: string;
  kind: CompletionKind;
  detail?: string;
  insertText?: string;
}

export interface Hover {
  contents: string;
}

export interface DocumentSymbol {
  name: string;
  kind: 'function' | 'class' | 'method' | 'variable' | 'struct' | 'enum' | 'interface';
  line: number;
  container?: string;
}

export interface LanguageProvider {
  complete?(path: string, text: string, languageId: string, pos: Position): Completion[];
  hover?(path: string, text: string, languageId: string, pos: Position): Hover | null;
  symbols?(path: string, text: string, languageId: string): DocumentSymbol[];
}

const KIND_BY_WORD: Record<string, CompletionKind> = {
  fn: 'function', function: 'function', def: 'function',
  class: 'class', struct: 'class', enum: 'class', interface: 'class',
  let: 'variable', const: 'variable', var: 'variable', mut: 'variable',
};

/** Extract user-defined identifiers/declarations for completion/hover/symbols. */
export function extractSymbols(
  text: string,
  languageId: string,
): { name: string; kind: string; line: number }[] {
  const out: { name: string; kind: string; line: number }[] = [];
  const seen = new Set<string>();
  const lines = text.split('\n');
  const add = (name: string, kind: string, line: number) => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    out.push({ name, kind, line });
  };

  const patterns: [RegExp, string][] =
    languageId === 'python'
      ? [
          [/^def\s+([a-zA-Z_]\w*)/m, 'function'],
          [/^class\s+([a-zA-Z_]\w*)/m, 'class'],
        ]
      : languageId === 'lua'
        ? [
            [/^function\s*([a-zA-Z_]\w*)/gm, 'function'],
            [/^local\s+([a-zA-Z_]\w*)/gm, 'variable'],
          ]
        : [[/(\bfn|function)\s+([a-zA-Z_]\w*)/g, 'function']];

  for (const [re, kind] of patterns) {
    for (const m of text.matchAll(re)) {
      add(m[2] ?? m[1], kind, lineOf(lines, m.index ?? 0));
    }
  }
  const varRe = /\b(?:let|const|var|mut)\s+([a-zA-Z_]\w*)\b/g;
  for (const m of text.matchAll(varRe)) add(m[1], 'variable', lineOf(lines, m.index ?? 0));
  const clsRe = /\b(?:class|struct|enum|interface)\s+([a-zA-Z_]\w*)\b/g;
  for (const m of text.matchAll(clsRe)) add(m[1], 'class', lineOf(lines, m.index ?? 0));
  return out;
}

function lineOf(lines: string[], index: number): number {
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    count += lines[i].length + 1;
    if (count > index) return i + 1;
  }
  return lines.length;
}

const validKind = (k: string): CompletionKind =>
  (['keyword', 'type', 'builtin', 'function', 'class', 'variable', 'property'] as CompletionKind[]).includes(
    k as ('keyword' | 'type' | 'builtin' | 'function' | 'class' | 'variable' | 'property'),
  )
    ? (k as CompletionKind)
    : 'variable';

export const builtinProvider: LanguageProvider = {
  complete(path, text, languageId, pos) {
    const def = getLanguage(languageId);
    const items: Completion[] = [];
    if (def?.keywords) for (const k of def.keywords) items.push({ label: k, kind: 'keyword' });
    if (def?.types) for (const t of def.types) items.push({ label: t, kind: 'type' });
    if (def?.builtins) for (const b of def.builtins) items.push({ label: b, kind: 'builtin' });
    for (const s of extractSymbols(text, languageId)) {
      items.push({ label: s.name, kind: validKind(s.kind) });
    }
    const currentLine = text.split('\n')[pos.line] ?? '';
    const before = currentLine.slice(0, pos.character);
    const m = before.match(/([a-zA-Z_]\w*)$/);
    if (m) {
      const word = m[1].toLowerCase();
      return items.filter((c) => c.label.toLowerCase().includes(word));
    }
    return items;
  },

  hover(path, text, languageId, pos) {
    const currentLine = text.split('\n')[pos.line] ?? '';
    const before = currentLine.slice(0, pos.character);
    const after = currentLine.slice(pos.character);
    const m = before.match(/[a-zA-Z_]\w*$/);
    if (!m) return null;
    const full = m[0] + (after.match(/^\w*/)?.[0] ?? '');
    const def = getLanguage(languageId);
    if (def?.keywords?.includes(full)) return { contents: `keyword \`${full}\`` };
    if (def?.types?.includes(full)) return { contents: `type \`${full}\`` };
    if (def?.builtins?.includes(full)) return { contents: `builtin \`${full}\` — ${languageId} standard library` };
    const sym = extractSymbols(text, languageId).find((s) => s.name === full);
    if (sym) return { contents: `${sym.kind} \`${full}\` (declared on line ${sym.line})` };
    return null;
  },

  symbols(path, text, languageId) {
    return extractSymbols(text, languageId).map((s): DocumentSymbol => ({
      name: s.name,
      kind: s.kind as DocumentSymbol['kind'],
      line: s.line,
      container: undefined,
    }));
  },
};

export const listBuiltinLanguages = () => listLanguages();

/* ------------------------------------------------------------------ */
/* External LSP client (JSON-RPC over the bundled tunnel)              */
/* ------------------------------------------------------------------ */

export interface ServerSpec {
  languageId: string;
  program: string;
  args: string[];
}

export class LSPClient {
  private requestSeq = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  ready = false;
  onNotification: (method: string, params: unknown) => void = () => {};
  onRequest: ((method: string, params: unknown) => Promise<unknown>) | null = null;

  async start(spec: ServerSpec, cwd: string) {
    const { invoke } = await import('@tauri-apps/api/core');
    const { listen } = await import('@tauri-apps/api/event');
    await invoke('lsp_start', { program: spec.program, args: spec.args, cwd });
    await listen<string>('lsp-message', (e) => this.handleMessage(e.payload));
    await this.request('initialize', {
      processId: null,
      rootUri: `file://${cwd.replace(/\\/g, '/')}`,
      capabilities: {
        textDocument: { hover: {}, completion: { completionItem: { snippetSupport: true } }, documentSymbol: {} },
      },
    });
    await this.notify('initialized', {});
    this.ready = true;
    return this;
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.requestSeq++;
    const msg = { jsonrpc: '2.0', id, method, params: params ?? {} };
    const p = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    import('@tauri-apps/api/core').then(({ invoke }) => invoke('lsp_send', { json: JSON.stringify(msg) }));
    return p;
  }

  private notify(method: string, params: unknown) {
    const msg = { jsonrpc: '2.0', method, params: params ?? {} };
    import('@tauri-apps/api/core').then(({ invoke }) => invoke('lsp_send', { json: JSON.stringify(msg) }));
  }

  handleMessage(json: string) {
    let msg: any;
    try {
      msg = JSON.parse(json);
    } catch {
      return;
    }
    if (msg && msg.id != null && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? 'LSP error'));
      else p.resolve(msg.result);
      return;
    }
    if (msg && msg.method) {
      const method: string = msg.method;
      if (method.startsWith('$/') || method === 'window/showMessageRequest') {
        void this.onRequest?.(method, msg.params);
        void this.notifyReply(msg.id, null);
      } else {
        this.onNotification(method, msg.params);
      }
    }
  }

  private notifyReply(id: unknown, result: unknown) {
    const msg = { jsonrpc: '2.0', id, result: result ?? null };
    import('@tauri-apps/api/core').then(({ invoke }) => invoke('lsp_send', { json: JSON.stringify(msg) }));
  }

  didOpen(path: string, text: string) {
    this.notify('textDocument/didOpen', {
      textDocument: { uri: this.uri(path), languageId: 'plaintext', version: 1, text },
    });
  }

  didChange(path: string, text: string, version: number) {
    this.notify('textDocument/didChange', {
      textDocument: { uri: this.uri(path), version },
      contentChanges: [{ text }],
    });
  }

  async complete(path: string, text: string, offset: number): Promise<Completion[]> {
    const result = (await this.request('textDocument/completion', {
      textDocument: { uri: this.uri(path) },
      position: this.offsetToPosition(text, offset),
      context: { triggerKind: 1 },
    })) as any;
    const list = Array.isArray(result) ? result : Array.isArray(result?.items) ? result.items : [];
    return (list as any[]).map((it) => ({
      label: it.label ?? it.insertText ?? '',
      kind: (it.kind as CompletionKind) ?? 'variable',
      detail: it.detail,
      insertText: it.insertText ?? it.label,
    }));
  }

  async hover(path: string, text: string, offset: number): Promise<Hover | null> {
    const result = (await this.request('textDocument/hover', {
      textDocument: { uri: this.uri(path) },
      position: this.offsetToPosition(text, offset),
    })) as any;
    if (!result) return null;
    const contents =
      typeof result.contents === 'string'
        ? result.contents
        : Array.isArray(result.contents)
          ? result.contents.map((s: any) => (typeof s === 'string' ? s : s.value ?? '')).join('\n')
          : result.contents?.value ?? '';
    return { contents };
  }

  private uri(path: string) {
    return `file://${path.replace(/\\/g, '/')}`;
  }

  private offsetToPosition(text: string, offset: number): Position {
    let line = 0;
    for (let i = 0; i < offset && i < text.length; i++) if (text[i] === '\n') line++;
    const lastNl = text.lastIndexOf('\n', Math.min(offset, text.length));
    return { line, character: Math.max(0, offset - lastNl - 1) };
  }

  dispose() {
    this.ready = false;
    import('@tauri-apps/api/core').then(({ invoke }) => invoke('lsp_stop').catch(() => {}));
  }
}