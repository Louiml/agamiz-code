/**
 * Per-project AI session store + project memory.
 *
 * A session record is created as soon as the user starts chatting in a
 * workspace (title, mode, token usage, full transcript) and is persisted to
 * localStorage keyed by the project directory. The stored sessions power the
 * "previous sessions" list in the AI panel and are condensed into a PROJECT
 * MEMORY block that is injected into the agent's system prompt, so new
 * sessions inherit the context of older ones — bounded so it always fits the
 * model's context window.
 */

import type { ChatMessage } from './ai';
import type { AgentMode, ToolCall, ToolDiff } from './agent';

export interface SessionUsage {
  input: number;
  output: number;
  cached: number;
}

/** Timeline shape shared with the AI panel (serialized into the store). */
export type StoredTimelineItem =
  | { kind: 'msg'; id: string; role: ChatMessage['role']; content: string }
  | {
      kind: 'tool';
      id: string;
      call: ToolCall;
      status: 'pending' | 'running' | 'ok' | 'error' | 'denied';
      output: string;
      /** Human action line from the agent, e.g. "Created file src/a.ts (+12/-0)". */
      label?: string;
      /** Line-level +/- diff for file writes. */
      diff?: ToolDiff;
      /** ask_user payload (set at tool-start; cleared when it completes). */
      question?: string;
      options?: string[];
    };

export interface StoredSession {
  id: string;
  projectId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Agent mode last used in this session (plan | build). */
  mode: AgentMode;
  usage: SessionUsage;
  /** Conversation transcript (system messages stripped). */
  thread: ChatMessage[];
  items: StoredTimelineItem[];
}

const MAX_SESSIONS = 40;
const MAX_THREAD_MSGS = 80;
const MAX_THREAD_CHARS = 6000;
const MAX_ITEMS = 160;
const MAX_ITEM_OUTPUT = 1500;
const MEMORY_SESSIONS = 8;
const MEMORY_SESSION_CHARS = 340;
const MEMORY_BLOCK_CHARS = 3600;

const storageKey = (projectId: string): string =>
  `agamiz.code.ai.sessions.${(projectId || '(no project)').replace(/[^a-zA-Z0-9._-]+/g, '_')}`;

export function newSessionId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `s${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Derive a session title from the first user message. */
export function titleFromText(text: string): string {
  const line = (text.trim().split('\n')[0] || '').replace(/^[#>`\s]+/, '').trim();
  if (!line) return 'New chat';
  return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}

export function emptyUsage(): SessionUsage {
  return { input: 0, output: 0, cached: 0 };
}

/** "1234" -> "1.2k" style formatting for token counters. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(Math.round(n));
  return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/** Load all stored sessions of a project, most recent first. */
export function loadSessions(projectId: string): StoredSession[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(storageKey(projectId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed?.sessions) ? (parsed.sessions as StoredSession[]) : [];
    return list.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

function storeSessions(projectId: string, list: StoredSession[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(storageKey(projectId), JSON.stringify({ sessions: list.slice(0, MAX_SESSIONS) }));
  } catch {
    // Quota exceeded — retry keeping only the newest quarter of the sessions.
    try {
      window.localStorage.setItem(
        storageKey(projectId),
        JSON.stringify({ sessions: list.slice(0, Math.max(1, MAX_SESSIONS >> 2)) }),
      );
    } catch {
      /* give up silently — sessions are a cache, not a source of truth */
    }
  }
}

function trimThread(thread: ChatMessage[]): ChatMessage[] {
  return thread
    .filter((m) => m.role !== 'system')
    .slice(-MAX_THREAD_MSGS)
    .map((m) => ({
      ...m,
      content: m.content.length > MAX_THREAD_CHARS ? m.content.slice(0, MAX_THREAD_CHARS) : m.content,
    }));
}

function trimItems(items: StoredTimelineItem[]): StoredTimelineItem[] {
  return items.slice(-MAX_ITEMS).map((it) => {
    if (it.kind === 'tool') {
      const stuck = it.status === 'running' || it.status === 'pending';
      const next: Extract<StoredTimelineItem, { kind: 'tool' }> = {
        ...it,
        status: stuck ? 'error' : it.status,
        output: (it.output || '').slice(0, MAX_ITEM_OUTPUT),
      };
      if (stuck && !next.output) next.output = 'Interrupted (session saved mid-run).';
      return next;
    }
    return { ...it, content: it.content.slice(0, MAX_THREAD_CHARS) };
  });
}

/** Upsert a session into its project's store (trimmed to the budgets above). */
export function saveSession(projectId: string, session: StoredSession): void {
  const list = loadSessions(projectId).filter((s) => s.id !== session.id);
  list.unshift({
    ...session,
    thread: trimThread(session.thread),
    items: trimItems(session.items),
  });
  list.sort((a, b) => b.updatedAt - a.updatedAt);
  storeSessions(projectId, list);
}

export function deleteSession(projectId: string, id: string): void {
  storeSessions(projectId, loadSessions(projectId).filter((s) => s.id !== id));
}

/** Delete every stored session (= the project memory) of a workspace. */
export function forgetSessions(projectId: string): number {
  const count = loadSessions(projectId).length;
  storeSessions(projectId, []);
  return count;
}

// ---------------------------------------------------------------------------
// Project memory
// ---------------------------------------------------------------------------

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/**
 * Condense the stored sessions of a project into a memory block for the agent
 * system prompt: title, date, mode, tool actions and the final outcome of the
 * last few sessions. Empty string when there is nothing to remember.
 */
export function buildProjectMemory(projectId: string, excludeSessionId?: string): string {
  const sessions = loadSessions(projectId)
    .filter((s) => s.id !== excludeSessionId)
    .filter((s) => s.items.some((it) => it.kind === 'msg'))
    .slice(0, MEMORY_SESSIONS);
  if (sessions.length === 0) return '';

  const lines: string[] = [];
  for (const s of sessions) {
    const msgs = s.items.filter((it): it is Extract<StoredTimelineItem, { kind: 'msg' }> => it.kind === 'msg');
    const lastReply = [...msgs].reverse().find((m) => m.role === 'assistant')?.content ?? '';
    const actions = [
      ...new Set(
        s.items
          .filter(
            (it): it is Extract<StoredTimelineItem, { kind: 'tool' }> =>
              it.kind === 'tool' && typeof it.label === 'string' && it.label.length > 0,
          )
          .map((it) => it.label as string),
      ),
    ].slice(0, 5);
    const d = new Date(s.updatedAt);
    const when = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    let line = `[${when}, ${s.mode}] "${oneLine(s.title).slice(0, 70)}"`;
    const detail = [actions.length ? `actions: ${actions.join(' | ')}` : '', lastReply ? `outcome: ${oneLine(lastReply)}` : '']
      .filter(Boolean)
      .join('; ');
    if (detail) line += ` — ${detail}`;
    lines.push(line.slice(0, MEMORY_SESSION_CHARS));
    if (lines.join('\n').length >= MEMORY_BLOCK_CHARS) break;
  }
  return lines.join('\n').slice(0, MEMORY_BLOCK_CHARS);
}