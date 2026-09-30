/**
 * AI assistant panel. Provider abstraction for four chat APIs (Ollama local,
 * OpenAI, Anthropic Claude, Google Gemini) plus a light tool-use loop: the
 * assistant may emit ```tool { ... } ``` fenced blocks that the IDE executes
 * (commands / file reads) and feeds results back for follow-up.
 *
 * Every tool call goes through the host's approval callback. That is not
 * optional: without it the model can run a command or read a file with no
 * prompt, and the system prompt below advertises the syntax.
 */

import { resolveWithin } from './paths';

export type AiProviderId = 'ollama' | 'openai' | 'anthropic' | 'gemini' | 'custom';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
}

export interface AiProviderConfig {
  provider: AiProviderId;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  maxTokens?: number;
}

export interface AiToolResult {
  name: string;
  output: string;
}

export interface AiResult {
  text: string;
  toolUses: string[];
}

/** Token counts reported by the provider for one request (0 when unknown). */
export interface TokenUsage {
  input: number;
  output: number;
  cached: number;
}

export type UsageSink = (usage: TokenUsage) => void;

/**
 * Extract token usage from any of the four provider response shapes:
 * OpenAI (prompt/completion tokens + prompt_tokens_details.cached_tokens),
 * Ollama (prompt_eval_count / eval_count), Anthropic (input/output/cache_read)
 * and Gemini (usageMetadata).
 */
export function extractUsage(provider: AiProviderId, data: unknown): TokenUsage {
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const root = (data ?? {}) as {
    usage?: Record<string, unknown>;
    prompt_eval_count?: unknown;
    eval_count?: unknown;
    prompt_tokens_details?: { cached_tokens?: unknown };
  };
  const u = root.usage ?? {};
  if (provider === 'ollama') {
    return {
      input: num(root.prompt_eval_count ?? u.prompt_eval_count),
      output: num(root.eval_count ?? u.eval_count),
      cached: 0, // Ollama does not report prompt-cache hits
    };
  }
  if (provider === 'anthropic') {
    return {
      input: num(u.input_tokens) + num(u.cache_creation_input_tokens),
      output: num(u.output_tokens),
      cached: num(u.cache_read_input_tokens),
    };
  }
  if (provider === 'gemini') {
    return {
      input: num(u.promptTokenCount),
      output: num(u.candidatesTokenCount),
      cached: num(u.cachedContentTokenCount),
    };
  }
  // OpenAI-compatible (openai + custom providers); cached prompt tokens live in
  // usage.prompt_tokens_details.cached_tokens (also accepted at the root).
  const oaiCached = (u.prompt_tokens_details ?? root.prompt_tokens_details) as
    | { cached_tokens?: unknown }
    | undefined;
  return {
    input: num(u.prompt_tokens),
    output: num(u.completion_tokens),
    cached: num(oaiCached?.cached_tokens ?? u.cached_tokens),
  };
}

const DEFAULT_BASE: Record<AiProviderId, string> = {
  ollama: 'http://localhost:11434',
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com',
  custom: '',
};

export function buildSystemPrompt(base?: string): string {
  return (
    (base ?? 'You are an expert programming assistant embedded in an IDE.') +
    '\n\nWhen you need to inspect or run something, output a fenced block like:\n' +
    '```tool { "cmd": ["git", "status"] } ```\nor\n```tool { "file": "src/lib.ts" } ```\n' +
    'The IDE will run it and return the output. Keep replies concise.'
  );
}

/** Strip ```tool ... ``` fenced blocks from a reply, returning them separately. */
export function parseToolUses(text: string): { text: string; tools: string[] } {
  const tools: string[] = [];
  const cleaned = text.replace(/```tool\s+([\s\S]*?)```/g, (_m, body: string) => {
    tools.push(body.trim());
    return '';
  });
  return { text: cleaned.trim(), tools };
}

export async function requestText(
  cfg: AiProviderConfig,
  messages: ChatMessage[],
  signal?: AbortSignal,
  onUsage?: UsageSink,
): Promise<string> {
  if (cfg.provider === 'ollama') {
    const url = `${cfg.baseUrl || DEFAULT_BASE.ollama}/api/chat`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: cfg.model, messages, stream: false }),
      signal,
    });
    if (!res.ok) throw new Error(`Ollama ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as { message?: { content?: string }; prompt_eval_count?: unknown; eval_count?: unknown };
    onUsage?.(extractUsage('ollama', data));
    return data?.message?.content ?? '';
  }
  if (cfg.provider === 'openai' || cfg.provider === 'custom') {
    const base = cfg.baseUrl || 'https://api.openai.com/v1';
    const url = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: cfg.model, messages, max_tokens: cfg.maxTokens ?? 1024 }),
      signal,
    });
    if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: Record<string, unknown>;
    };
    onUsage?.(extractUsage(cfg.provider, data));
    return data?.choices?.[0]?.message?.content ?? '';
  }
  if (cfg.provider === 'anthropic') {
    const url = `${cfg.baseUrl || DEFAULT_BASE.anthropic}/v1/messages`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': cfg.apiKey ?? '', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: cfg.maxTokens ?? 1024,
        messages: messages
          .filter((m) => m.role !== 'system')
          .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
        system: messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n'),
      }),
      signal,
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as { content?: Array<{ text?: string }>; usage?: Record<string, unknown> };
    onUsage?.(extractUsage('anthropic', data));
    return (data?.content ?? []).map((p) => p.text ?? '').join('');
  }
  // gemini
  const base = cfg.baseUrl || DEFAULT_BASE.gemini;
  const url = `${base}/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent?key=${encodeURIComponent(cfg.apiKey ?? '')}`;
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents, generationConfig: { maxOutputTokens: cfg.maxTokens ?? 1024 } }),
    signal,
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    usage?: Record<string, unknown>;
  };
  onUsage?.(extractUsage('gemini', data));
  return (data?.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
}

export interface OllamaModelInfo {
  /** Model tag as Ollama reports it, e.g. "llama3.2:latest". */
  name: string;
  /** On-disk size in bytes, when reported. */
  size?: number;
  /** Model family, e.g. "llama". */
  family?: string;
  /** Human-readable parameter size, e.g. "7B". */
  parameterSize?: string;
}

interface OllamaTagModel {
  model?: string;
  name?: string;
  size?: number;
  modified_at?: string;
  details?: { family?: string; parameter_size?: string; quantization_level?: string };
}

/**
 * List the models installed on an Ollama server via `GET /api/tags`.
 * Works against any Ollama host (defaults to http://localhost:11434) and
 * honours `signal`; also times out after 8s so a hung server can't block
 * the panel UI. Older Ollama versions name the field `name`, newer ones
 * `model` — both are accepted.
 */
export async function fetchOllamaModels(
  baseUrl?: string,
  signal?: AbortSignal,
): Promise<OllamaModelInfo[]> {
  const base = (baseUrl || DEFAULT_BASE.ollama).replace(/\/+$/, '');
  const timeout = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(8000) : undefined;
  const res = await fetch(`${base}/api/tags`, { signal: signal ?? timeout });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { models?: OllamaTagModel[] };
  return (Array.isArray(data.models) ? data.models : [])
    .map((m) => ({
      name: (m.model ?? m.name ?? '').trim(),
      size: typeof m.size === 'number' ? m.size : undefined,
      family: m.details?.family,
      parameterSize: m.details?.parameter_size,
    }))
    .filter((m) => m.name)
    .sort((a, b) => a.name.localeCompare(b.name));
}

interface ParsedToolSpec {
  cmd?: unknown;
  cwd?: unknown;
  file?: unknown;
}

const parseToolSpec = (spec: string): ParsedToolSpec | null => {
  try {
    return JSON.parse(spec) as ParsedToolSpec;
  } catch {
    return null;
  }
};

/**
 * Turn a raw tool spec into a one-line summary for the approval card.
 *
 * Returns null for a spec nothing can run, so the caller reports "unsupported"
 * instead of prompting the user to approve nothing.
 */
export function describeToolSpec(spec: string): ChatToolRequest | null {
  const parsed = parseToolSpec(spec);
  if (!parsed) return null;
  if (Array.isArray(parsed.cmd) && parsed.cmd.every((c) => typeof c === 'string')) {
    return { summary: `Run: ${parsed.cmd.join(' ')}`, spec };
  }
  if (typeof parsed.file === 'string') {
    return { summary: `Read file: ${parsed.file}`, spec };
  }
  return null;
}

async function executeToolSpec(spec: string, root = ''): Promise<AiToolResult> {
  const parsed = parseToolSpec(spec);
  if (!parsed) return { name: 'tool', output: `Could not parse tool JSON: ${spec}` };
  if (Array.isArray(parsed.cmd)) {
    const { execResult } = await import('./runner');
    const [program, ...args] = parsed.cmd as string[];
    const cwd = typeof parsed.cwd === 'string' ? parsed.cwd : '';
    const r = await execResult(program, args ?? [], cwd);
    return { name: program, output: `exit=${r.code}\n${(r.stdout + '\n' + r.stderr).trim()}` };
  }
  if (typeof parsed.file === 'string') {
    const { invoke } = await import('@tauri-apps/api/core');
    // The model's path is confined to the workspace like every other
    // model-supplied path, rather than being handed to `read_file` verbatim.
    let path = parsed.file;
    try {
      path = resolveWithin(root, parsed.file);
    } catch (e) {
      return { name: 'read_file', output: `error: ${e instanceof Error ? e.message : String(e)}` };
    }
    try {
      const content = (await invoke('read_file', { path })) as string;
      return { name: 'read_file', output: content.slice(0, 20000) };
    } catch (e) {
      return { name: 'read_file', output: `error: ${String(e)}` };
    }
  }
  return { name: 'tool', output: 'Unsupported tool spec.' };
}

/** A tool call the chat loop wants to run, described for the user to approve. */
export interface ChatToolRequest {
  /** A short human summary, e.g. `Run: powershell -Command Remove-Item …`. */
  summary: string;
  /** The raw JSON the model emitted, for the approval card to show. */
  spec: string;
}

/**
 * Ask the user whether a tool call may run.
 *
 * Chat mode used to have no gate at all: `executeToolSpec` ran any
 * `{"cmd": […]}` block immediately and read any `{"file": …}` path verbatim,
 * while the agent's `WRITE_TOOLS` approval set, plan mode and auto-approve were
 * all bypassed. The system prompt even advertises the syntax, so a model asked
 * "what does this project do" could reply with a fenced tool block and have it
 * executed with no prompt — silently, and recursively.
 *
 * The host supplies this; without it (tests, or a caller that does not want
 * tools) nothing runs, because a silently-capable shell is exactly the failure
 * mode being closed.
 */
export type ChatToolApproval = (request: ChatToolRequest) => Promise<boolean>;

/** Run a chat with tool-use support (bounded rounds). */
export async function chat(
  cfg: AiProviderConfig,
  initialMessages: ChatMessage[],
  onDelta?: (text: string) => void,
  signal?: AbortSignal,
  maxRounds = 4,
  onUsage?: UsageSink,
  approve?: ChatToolApproval,
  root = '',
): Promise<AiResult> {
  const messages: ChatMessage[] = [...initialMessages];
  const toolUses: string[] = [];
  let cumulative = '';

  for (let round = 0; round < maxRounds; round++) {
    const full = await requestText(cfg, messages, signal, onUsage);
    const { text, tools } = parseToolUses(full);
    cumulative += text;
    onDelta?.(text);
    toolUses.push(...tools);
    messages.push({ role: 'assistant', content: text || '(assistant) ' + full.trim() });

    if (tools.length === 0) break;

    for (const spec of tools) {
      const request = describeToolSpec(spec);
      if (!request) {
        messages.push({ role: 'user', name: 'tool', content: 'Tool output: unsupported tool spec.' });
        continue;
      }
      // Fail closed: with no approval hook, no tool runs.
      const allowed = approve ? await approve(request) : false;
      if (!allowed) {
        messages.push({
          role: 'user',
          name: request.summary.split(':')[0] || 'tool',
          content: `Tool denied: ${request.summary}. The user did not approve it. Do not retry it; answer without running it or ask what to do instead.`,
        });
        continue;
      }
      const result = await executeToolSpec(spec, root);
      messages.push({ role: 'user', name: result.name, content: `Tool output from ${result.name}:\n${result.output}` });
    }
  }
  return { text: cumulative.trim(), toolUses };
}