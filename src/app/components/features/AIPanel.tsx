'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AiProviderConfig, ChatMessage, ChatToolRequest, chat, buildSystemPrompt, AiProviderId, fetchOllamaModels, OllamaModelInfo, TokenUsage } from '../../features/ai';
import type { AgentEvent, AgentMode, ToolCall } from '../../features/agent';
import { buildAgentContext, buildAgentSystemPrompt, runAgent } from '../../features/agent';
import type { SessionUsage, StoredSession, StoredTimelineItem } from '../../features/sessions';
import { buildProjectMemory, deleteSession, forgetSessions, formatTokens, loadSessions, newSessionId, saveSession, titleFromText } from '../../features/sessions';
import Markdown from './Markdown';

interface AIPanelProps {
  cwd: string;
  activeFile: string | null;
  activeFileContent: string;
  onToast: (msg: string, type?: 'success' | 'error' | 'info') => void;
  /** Open a file in an editor tab (agent `open_file` tool). */
  onOpenFile?: (path: string) => void;
  /** Called after the agent modified a file on disk so open tabs can reload. */
  onFileChanged?: (path: string) => void;
}

const PROVIDERS: { id: AiProviderId; label: string }[] = [
  { id: 'ollama', label: 'Ollama (local)' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'anthropic', label: 'Anthropic Claude' },
  { id: 'gemini', label: 'Google Gemini' },
];

const DEFAULT_MODEL: Record<AiProviderId, string> = {
  ollama: 'llama3.2',
  openai: 'gpt-4o-mini',
  anthropic: 'claude-3-5-haiku-20241022',
  gemini: 'gemini-1.5-flash',
  custom: '',
};

/** Timeline shape shared with the per-project session store (features/sessions.ts). */
type TimelineItem = StoredTimelineItem;

type ToolItem = Extract<TimelineItem, { kind: 'tool' }>;

const QUICK_ACTIONS: { label: string; prompt: string }[] = [
  { label: 'Explain file', prompt: 'Explain what the active file does, then check its diagnostics.' },
  { label: 'Fix problems', prompt: 'Read the IDE diagnostics, fix every error/warning in the active file, and verify.' },
  { label: 'Run & debug', prompt: 'Run the active file with Node, inspect the output, and fix any errors you find.' },
  { label: 'Project tour', prompt: 'Explore the workspace: list the top-level directories, read the key entry files, and summarize the architecture.' },
  { label: 'Build check', prompt: 'Run the build for this workspace. If it fails, find the root cause, fix it, and run the build again until it passes.' },
];

let uiSeq = 1;
const uid = () => `ui${uiSeq++}`;

/** Small arg helpers for ask_user payloads. */
const strArg = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const listArg = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);

export default function AIPanel({ cwd, activeFile, activeFileContent, onToast, onOpenFile, onFileChanged }: AIPanelProps) {
  const [provider, setProvider] = useState<AiProviderId>('ollama');
  const [model, setModel] = useState(DEFAULT_MODEL.ollama);
  const [baseUrl, setBaseUrl] = useState('http://localhost:11434');
  const [apiKey, setApiKey] = useState('');
  const [ollamaModels, setOllamaModels] = useState<OllamaModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState('');
  const [customModel, setCustomModel] = useState(false);
  const [mode, setMode] = useState<'agent' | 'chat'>('agent');
  const [autoApprove, setAutoApprove] = useState(false);
  const [maxSteps, setMaxSteps] = useState(10);
  const [alwaysAllow, setAlwaysAllow] = useState<string[]>([]);
  const [answerDraft, setAnswerDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [stepInfo, setStepInfo] = useState('');
  const [input, setInput] = useState('');
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [configOpen, setConfigOpen] = useState(true);
  // --- plan/build mode, sessions (per project) and token usage ---
  const [agentMode, setAgentMode] = useState<AgentMode>('build');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<StoredSession[]>([]);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [usage, setUsage] = useState<SessionUsage>({ input: 0, output: 0, cached: 0 });
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const threadRef = useRef<ChatMessage[]>([]);
  const abortRef = useRef<AbortController | null>(null);
/**
 * Synchronous mirror of `busy`.
 *
 * `busy` is render state, so two fast Enters both read `false` and started two
 * concurrent loops. Set before the first `await`, so the second is refused.
 */
const busyRef = useRef(false);
  const approvalsRef = useRef<Map<string, (ok: boolean) => void>>(new Map());
  const autoApproveRef = useRef(autoApprove);
  autoApproveRef.current = autoApprove;
  const alwaysAllowRef = useRef(alwaysAllow);
  alwaysAllowRef.current = alwaysAllow;
  const userInputsRef = useRef<Map<string, (answer: string) => void>>(new Map());
  const sessionIdRef = useRef<string | null>(null);
  sessionIdRef.current = sessionId;
  const sessionMetaRef = useRef<{ id: string; title: string; createdAt: number } | null>(null);
  const usageRef = useRef<SessionUsage>({ input: 0, output: 0, cached: 0 });
  const loadedProjectRef = useRef<string | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Per-project sessions: each workspace keeps its own history and memory.
  // Switching projects resets the live view; stored sessions of the previous
  // project stay saved under their own key.
  useEffect(() => {
    if (loadedProjectRef.current === cwd) return;
    loadedProjectRef.current = cwd;
    setSessions(loadSessions(cwd));
    setSessionsOpen(false);
    setSessionId(null);
    sessionMetaRef.current = null;
    usageRef.current = { input: 0, output: 0, cached: 0 };
    setUsage({ input: 0, output: 0, cached: 0 });
    threadRef.current = [];
    setItems([]);
  }, [cwd]);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('agamiz.code.ai') || '{}');
      if (saved.provider) setProvider(saved.provider);
      if (saved.model) setModel(saved.model);
      if (saved.baseUrl) setBaseUrl(saved.baseUrl);
      if (saved.apiKey) setApiKey(saved.apiKey);
      if (saved.mode === 'agent' || saved.mode === 'chat') setMode(saved.mode);
      if (saved.agentMode === 'plan' || saved.agentMode === 'build') setAgentMode(saved.agentMode);
      if (typeof saved.autoApprove === 'boolean') setAutoApprove(saved.autoApprove);
      if (typeof saved.maxSteps === 'number') setMaxSteps(Math.max(1, Math.min(30, saved.maxSteps)));
      if (Array.isArray(saved.permissions)) {
        setAlwaysAllow((saved.permissions as unknown[]).filter((t): t is string => typeof t === 'string'));
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem('agamiz.code.ai', JSON.stringify({ provider, model, baseUrl, apiKey, mode, agentMode, autoApprove, maxSteps, permissions: alwaysAllow }));
    } catch { /* ignore */ }
  }, [provider, model, baseUrl, apiKey, mode, agentMode, autoApprove, maxSteps, alwaysAllow]);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [items, busy]);

  // Persist the active session (debounced) whenever its content changes.
  useEffect(() => {
    const meta = sessionMetaRef.current;
    if (!sessionId || !meta || meta.id !== sessionId) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveSession(cwd, {
        id: sessionId,
        projectId: cwd,
        title: meta.title,
        createdAt: meta.createdAt,
        updatedAt: Date.now(),
        mode: agentMode,
        usage: usageRef.current,
        thread: threadRef.current,
        items,
      });
      setSessions(loadSessions(cwd));
    }, 600);
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [items, usage, sessionId, agentMode, cwd]);

  // --- Ollama model discovery -------------------------------------------------
  const modelsAbortRef = useRef<AbortController | null>(null);

  /** Fetch the installed-model list from the Ollama server at `base`. */
  const refreshModels = useCallback(async (base?: string) => {
    const target = (base ?? baseUrl).trim();
    if (!target) return;
    modelsAbortRef.current?.abort();
    const ctrl = new AbortController();
    modelsAbortRef.current = ctrl;
    setModelsLoading(true);
    setModelsError('');
    try {
      const list = await fetchOllamaModels(target || undefined, ctrl.signal);
      if (modelsAbortRef.current !== ctrl) return;
      setOllamaModels(list);
      if (list.length === 0) {
        setModelsError('Ollama is running but no models are installed. Pull one first, e.g. `ollama pull qwen2.5-coder:7b`.');
      }
    } catch (e) {
      if (modelsAbortRef.current !== ctrl) return;
      if (!String(e).toLowerCase().includes('abort')) {
        setOllamaModels([]);
        setModelsError(String(e).replace(/^Error:\s*/, ''));
      }
    } finally {
      if (modelsAbortRef.current === ctrl) {
        modelsAbortRef.current = null;
        setModelsLoading(false);
      }
    }
  }, [baseUrl]);

  // Query the model list whenever the Ollama provider/base URL is active
  // (debounced so typing in the Base URL field doesn't spam the server).
  useEffect(() => {
    if (provider !== 'ollama') return;
    const timer = setTimeout(() => { refreshModels(); }, 300);
    return () => {
      clearTimeout(timer);
      modelsAbortRef.current?.abort();
    };
  }, [provider, baseUrl, refreshModels]);

  // If the saved/default model is not installed, fall back to the first one.
  useEffect(() => {
    if (provider !== 'ollama' || customModel || modelsLoading || ollamaModels.length === 0) return;
    if (ollamaModels.some((m) => m.name === model)) return;
    setModel(ollamaModels[0].name);
  }, [provider, customModel, modelsLoading, ollamaModels, model]);

  /** Convert agent runtime events into timeline updates. */
  const handleEvent = useCallback((e: AgentEvent) => {
    switch (e.type) {
      case 'assistant-text':
        setItems((prev) => [...prev, { kind: 'msg', id: uid(), role: 'assistant', content: e.text }]);
        break;
      case 'step':
        setStepInfo(`${e.step}/${e.maxSteps}`);
        break;
      case 'tool-start': {
        const isAsk = e.call.tool === 'ask_user';
        const question = isAsk ? strArg(e.call.args.question) : undefined;
        const options = isAsk ? listArg(e.call.args.options) : undefined;
        setItems((prev) => {
          const idx = prev.findIndex((it) => it.kind === 'tool' && it.id === e.id);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = { ...next[idx], status: 'running' } as ToolItem;
            return next;
          }
          return [...prev, { kind: 'tool', id: e.id, call: e.call, status: 'running' as const, output: '', question, options }];
        });
        break;
      }
      case 'tool-end':
        setItems((prev) =>
          prev.map((it) =>
            it.kind === 'tool' && it.id === e.id
              ? {
                  ...it,
                  status: e.denied ? ('denied' as const) : e.ok ? ('ok' as const) : ('error' as const),
                  output: e.output,
                  label: e.label ?? it.label,
                  diff: e.diff ?? it.diff,
                }
              : it,
          ),
        );
        break;
    }
  }, []);

  /**
   * Ask the user before a mutating tool runs (unless a permission covers it).
   *
   * The promise races the run's abort signal. Without that, pressing Stop while
   * an approval card was open left the agent loop parked on a promise only
   * `decide()` resolves: the button flipped to Send but the loop never
   * returned, so the IDE looked hung until the user clicked Approve/Deny,
   * opened New chat, or reloaded. `ask_user` already wires this listener; the
   * approval path did not.
   */
  const requestApproval = useCallback((call: ToolCall, id: string): Promise<boolean> => {
    if (autoApproveRef.current || alwaysAllowRef.current.includes(call.tool)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const settle = (ok: boolean) => {
        approvalsRef.current.delete(id);
        resolve(ok);
      };
      const signal = abortRef.current?.signal;
      if (signal?.aborted) {
        setItems((prev) => prev.map((it) => (it.kind === 'tool' && it.id === id ? { ...it, status: 'denied' as const, output: 'Cancelled.' } : it)));
        resolve(false);
        return;
      }
      signal?.addEventListener('abort', () => {
        setItems((prev) => prev.map((it) => (it.kind === 'tool' && it.id === id ? { ...it, status: 'denied' as const, output: 'Cancelled.' } : it)));
        settle(false);
      }, { once: true });
      approvalsRef.current.set(id, settle);
      setItems((prev) =>
        prev.some((it) => it.kind === 'tool' && it.id === id)
          ? prev
          : [...prev, { kind: 'tool', id, call, status: 'pending' as const, output: '' }],
      );
    });
  }, []);

  /**
   * Approval for a chat-mode tool call.
   *
   * Chat mode had no gate at all, so the model's `{"cmd": […]}` block ran
   * immediately — bypassing auto-approve, always-allow and plan mode alike. It
   * reuses the same card and the same `approvalsRef`, so a chat-mode tool looks
   * and behaves exactly like an agent-mode one.
   */
  const requestChatApproval = useCallback((request: ChatToolRequest): Promise<boolean> => {
    if (autoApproveRef.current) return Promise.resolve(true);
    const id = `chat_${uid()}`;
    // Shape the spec into a ToolCall so ToolCard can render it unchanged.
    const call: ToolCall = {
      id,
      tool: request.summary.split(':')[0] || 'tool',
      args: { detail: request.summary },
    };
    return requestApproval(call, id);
  }, [requestApproval]);

  const decide = (id: string, ok: boolean, alwaysTool?: string) => {
    const resolve = approvalsRef.current.get(id);
    approvalsRef.current.delete(id);
    resolve?.(ok);
    if (ok && alwaysTool) {
      setAlwaysAllow((prev) => (prev.includes(alwaysTool) ? prev : [...prev, alwaysTool]));
      onToast(`"${alwaysTool}" will be auto-approved from now on (manage in settings).`, 'info');
    }
    setItems((prev) =>
      prev.map((it) =>
        it.kind === 'tool' && it.id === id
          ? ok
            ? { ...it, status: 'running' as const, output: '' }
            : { ...it, status: 'denied' as const, output: 'Denied by user.' }
          : it,
      ),
    );
  };

  /** Resolve a pending ask_user question with the user's answer. */
  const answerAsk = (id: string, answer: string) => {
    const resolve = userInputsRef.current.get(id);
    userInputsRef.current.delete(id);
    setAnswerDraft('');
    resolve?.(answer);
  };

  // --- Session lifecycle (a session is created as soon as the user chats) -----

  /** Accumulate provider-reported token usage into the active session. */
  const addUsage = useCallback((u: TokenUsage) => {
    usageRef.current = {
      input: usageRef.current.input + u.input,
      output: usageRef.current.output + u.output,
      cached: usageRef.current.cached + u.cached,
    };
    setUsage({ ...usageRef.current });
  }, []);

  /** Create + store the session record for this workspace on the first message. */
  const ensureSession = (firstMessage: string) => {
    if (sessionIdRef.current) return;
    const now = Date.now();
    const id = newSessionId();
    const meta = { id, title: titleFromText(firstMessage), createdAt: now };
    sessionMetaRef.current = meta;
    usageRef.current = { input: 0, output: 0, cached: 0 };
    setUsage({ ...usageRef.current });
    setSessionId(id);
    saveSession(cwd, {
      id, projectId: cwd, title: meta.title, createdAt: now, updatedAt: now,
      mode: agentMode, usage: usageRef.current, thread: [], items: [],
    });
    setSessions(loadSessions(cwd));
  };

  /** Abandon the live view and start fresh (the old session stays in history). */
  const newChat = () => {
    approvalsRef.current.forEach((resolve) => resolve(false));
    approvalsRef.current.clear();
    userInputsRef.current.forEach((resolve) => resolve(''));
    userInputsRef.current.clear();
    setSessionId(null);
    sessionMetaRef.current = null;
    usageRef.current = { input: 0, output: 0, cached: 0 };
    setUsage({ input: 0, output: 0, cached: 0 });
    threadRef.current = [];
    setItems([]);
    setStepInfo('');
    setSessionsOpen(false);
  };

  /** Restore a previous session of this project into the live view. */
  const loadSession = (s: StoredSession) => {
    approvalsRef.current.forEach((resolve) => resolve(false));
    approvalsRef.current.clear();
    userInputsRef.current.forEach((resolve) => resolve(''));
    userInputsRef.current.clear();
    setSessionId(s.id);
    sessionMetaRef.current = { id: s.id, title: s.title, createdAt: s.createdAt };
    usageRef.current = { ...s.usage };
    setUsage({ ...s.usage });
    setAgentMode(s.mode === 'plan' ? 'plan' : 'build');
    threadRef.current = [...s.thread];
    setItems(
      s.items.map((it) =>
        it.kind === 'tool' && (it.status === 'running' || it.status === 'pending')
          ? { ...it, status: 'error' as const, output: it.output || 'Interrupted (session saved mid-run).' }
          : it,
      ),
    );
    setSessionsOpen(false);
  };

  const makeConfig = useCallback(
    (maxTokens = 1024): AiProviderConfig => ({ provider, model, baseUrl, apiKey, maxTokens }),
    [provider, model, baseUrl, apiKey],
  );

  /** Classic Q&A: single streamed reply; the model may still run safe tools. */
  const sendChat = async (text: string, ctrl: AbortController) => {
    const history: ChatMessage[] = [
      { role: 'system', content: buildSystemPrompt() },
      { role: 'system', content: `Working directory: ${cwd || '(none)'}${activeFile ? `\nActive file: ${activeFile}` : ''}` },
      ...items
        .filter((it) => it.kind === 'msg')
        .map((it) => ({ role: it.role, content: it.content }) as ChatMessage)
        .slice(-20),
      { role: 'user', content: text },
    ];
    const streamed = { text: '' };
    setItems((prev) => [...prev, { kind: 'msg', id: uid(), role: 'assistant', content: '' }]);
    await chat(
      makeConfig(),
      history,
      (delta) => {
        streamed.text += delta;
        setItems((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last && last.kind === 'msg' && last.role === 'assistant') {
            next[next.length - 1] = { ...last, content: streamed.text };
          }
          return next;
        });
      },
      // Passing the signal is what makes Stop work in chat mode; it used to be
      // `undefined`, so the button was a no-op for the whole request.
      ctrl.signal,
      undefined,
      addUsage,
      requestChatApproval,
      cwd,
    );
  };

  /** Autonomous loop: plan → tool blocks → results → … until done. */
  const sendAgent = async (text: string, ctrl: AbortController) => {
    const contextStr = await buildAgentContext(cwd, activeFile, activeFileContent);
    // Project memory: condensed summaries of this workspace's previous sessions.
    const memoryBlock = buildProjectMemory(cwd, sessionIdRef.current ?? undefined);
    threadRef.current = [
      { role: 'system', content: buildAgentSystemPrompt(contextStr, memoryBlock, agentMode) },
      ...threadRef.current.filter((m) => m.role !== 'system'),
      { role: 'user', content: text },
    ];
    const result = await runAgent(
      makeConfig(2048),
      threadRef.current,
      { cwd, activeFile, activeFileContent },
      {
        onEvent: handleEvent,
        requestApproval,
        onOpenFile,
        onFileChanged,
        onUsage: addUsage,
        requestUserInput: (_call, id) =>
          new Promise<string>((resolve) => {
            userInputsRef.current.set(id, resolve);
            // If the run is aborted while a question is open, unblock the loop.
            const onAbort = () => {
              userInputsRef.current.delete(id);
              resolve('');
            };
            if (ctrl.signal.aborted) onAbort();
            else ctrl.signal.addEventListener('abort', onAbort, { once: true });
          }),
      },
      { maxSteps, signal: ctrl.signal, mode: agentMode },
    );
    threadRef.current = result.messages;
  };

  const send = async () => {
    const text = input.trim();
    if (!text) return;
    // `busy` is render state, so two Enters pressed before the next paint both
    // saw `false` and started two loops — both writing files, with Stop only
    // reaching the second because `abortRef` had been overwritten. A ref flips
    // synchronously, before the first await, so the second send is refused.
    if (busyRef.current) return;
    busyRef.current = true;
    setItems((prev) => [...prev, { kind: 'msg', id: uid(), role: 'user', content: text }]);
    setInput('');
    ensureSession(text); // the session is created as soon as the user starts chatting
    setBusy(true);
    setStepInfo('');
    // One controller for the whole run, owned here rather than inside
    // `sendAgent`, so chat mode is stoppable too.
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      if (mode === 'agent') await sendAgent(text, ctrl);
      else await sendChat(text, ctrl);
    } catch (e) {
      const aborted = String(e).toLowerCase().includes('abort');
      setItems((prev) => [
        ...prev,
        { kind: 'msg', id: uid(), role: 'assistant', content: aborted ? '(stopped)' : `Error: ${String(e)}` },
      ]);
      if (!aborted) onToast(String(e), 'error');
    } finally {
      busyRef.current = false;
      setBusy(false);
      setStepInfo('');
      abortRef.current = null;
    }
  };

  const stop = () => abortRef.current?.abort();
  /** Clear conversation = abandon the active session (it stays in the session list). */
  const clear = () => newChat();

  const switchProvider = (p: AiProviderId) => {
    setProvider(p);
    setModel(DEFAULT_MODEL[p]);
    setCustomModel(false);
    setOllamaModels([]);
    setModelsError('');
    if (p === 'ollama') setBaseUrl('http://localhost:11434');
    else setBaseUrl('');
  };

  return (
    <div className="flex flex-col h-full min-h-0 text-xs">
      <div className="px-3 py-1.5 flex items-center gap-2 border-b border-zinc-800">
        <button onClick={() => setConfigOpen((o) => !o)} className="text-zinc-300 font-semibold">✧ AI Agent</button>
        <select value={mode} onChange={(e) => setMode(e.target.value as 'agent' | 'chat')} disabled={busy}
          className="bg-zinc-800 border border-zinc-700 rounded px-1 py-0.5 text-[10px] text-zinc-200">
          <option value="agent">Agent</option>
          <option value="chat">Chat</option>
        </select>
        {mode === 'agent' && (
          <select value={agentMode} onChange={(e) => setAgentMode(e.target.value as AgentMode)} disabled={busy}
            title="Plan: read-only investigation & implementation plan · Build: execute changes"
            className="bg-zinc-800 border border-zinc-700 rounded px-1 py-0.5 text-[10px] text-zinc-200">
            <option value="plan">Plan</option>
            <option value="build">Build</option>
          </select>
        )}
        <select value={provider} onChange={(e) => switchProvider(e.target.value as AiProviderId)}
          className="ml-auto bg-zinc-800 border border-zinc-700 rounded px-1 py-0.5 text-[10px] text-zinc-200">
          {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
        <button
          onClick={() => setSessionsOpen((o) => !o)}
          title="Previous sessions & project memory (stored per workspace)"
          className={`px-1.5 py-0.5 rounded text-[10px] border whitespace-nowrap ${sessionsOpen ? 'bg-emerald-600/20 border-emerald-700 text-emerald-300' : 'bg-zinc-800 border-zinc-700 text-zinc-300 hover:bg-zinc-700'}`}
        >
          ⧉ Sessions{sessions.length ? ` (${sessions.length})` : ''}
        </button>
      </div>

      <div className="px-3 py-0.5 border-b border-zinc-800 flex items-center gap-3 text-[10px] text-zinc-500">
        <span title="Provider-reported tokens for this session">↑ {formatTokens(usage.input)} in · ↓ {formatTokens(usage.output)} out · ⚡ {formatTokens(usage.cached)} cached</span>
        <span className={`ml-auto ${mode === 'agent' && agentMode === 'plan' ? 'text-sky-400' : ''}`}>
          {mode === 'agent' ? (agentMode === 'plan' ? 'Plan mode — read-only' : 'Build mode') : 'Chat mode'}
        </span>
      </div>

      {sessionsOpen && (
        <div className="border-b border-zinc-800 bg-zinc-900/80 max-h-72 overflow-y-auto ide-scrollbar">
          <div className="px-3 py-1.5 flex items-center gap-2 sticky top-0 bg-zinc-900/95 z-10">
            <span className="text-[10px] font-semibold text-zinc-400">Sessions — {cwd ? cwd.split(/[\\/]/).pop() : 'no project'}</span>
            <button onClick={newChat} className="ml-auto px-1.5 py-0.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-[10px] whitespace-nowrap">＋ New chat</button>
            {sessions.length > 0 && (
              <button
                onClick={() => {
                  const n = forgetSessions(cwd);
                  setSessions([]);
                  newChat();
                  onToast(`Forgot ${n} session(s) and the project memory.`, 'success');
                }}
                title="Delete all stored sessions (this also erases the project memory)"
                className="px-1.5 py-0.5 rounded bg-zinc-800 border border-zinc-700 text-[10px] text-zinc-400 hover:bg-red-600 hover:text-white whitespace-nowrap"
              >
                Forget all
              </button>
            )}
          </div>
          {sessions.length === 0 && (
            <div className="px-3 pb-2 text-[10px] text-zinc-600">
              No previous sessions for this project yet — one is created as soon as you start chatting, and its summary is remembered for future chats.
            </div>
          )}
          {sessions.map((s) => (
            <div
              key={s.id}
              onClick={() => loadSession(s)}
              className={`px-3 py-1 flex items-center gap-2 cursor-pointer border-t border-zinc-800/60 hover:bg-zinc-800/60 ${s.id === sessionId ? 'bg-emerald-600/10' : ''}`}
              title={s.title}
            >
              <span className="truncate flex-1 text-[11px] text-zinc-300">{s.title}</span>
              <span className={`px-1 rounded text-[9px] ${s.mode === 'plan' ? 'bg-sky-600/30 text-sky-300' : 'bg-emerald-600/20 text-emerald-300'}`}>{s.mode}</span>
              <span className="text-[9px] text-zinc-500 whitespace-nowrap" title="Tokens: input / output / cached">
                ↑{formatTokens(s.usage.input)} ↓{formatTokens(s.usage.output)} ⚡{formatTokens(s.usage.cached)}
              </span>
              <span className="text-[9px] text-zinc-500 whitespace-nowrap">{fmtDate(s.updatedAt)}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  deleteSession(cwd, s.id);
                  if (s.id === sessionId) newChat();
                  setSessions(loadSessions(cwd));
                }}
                className="text-zinc-600 hover:text-red-400 text-[11px] px-0.5"
                title="Delete this session"
              >
                ×
              </button>
            </div>
          ))}
          {sessions.length > 1 && (
            <div className="px-3 py-1 text-[9px] text-zinc-600 border-t border-zinc-800/60">
              Project memory: summaries of recent sessions are injected into the agent context window for new chats.
            </div>
          )}
        </div>
      )}

      {configOpen && (
        <div className="px-3 py-2 border-b border-zinc-800 space-y-1.5 bg-zinc-900/50">
          {provider === 'ollama' && !customModel && ollamaModels.length > 0 ? (
            <div className="flex items-center gap-1">
              <select value={model} onChange={(e) => (e.target.value === '__custom__' ? setCustomModel(true) : setModel(e.target.value))}
                title="Installed Ollama models"
                className="flex-1 min-w-0 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200">
                {ollamaModels.map((m) => (
                  <option key={m.name} value={m.name}>
                    {m.name}{m.size ? ` (${formatModelSize(m.size)})` : ''}{m.parameterSize ? ` · ${m.parameterSize}` : ''}
                  </option>
                ))}
                <option value="__custom__">Custom model…</option>
              </select>
              <button onClick={() => refreshModels()} title="Refresh installed models"
                className="px-1.5 py-1 rounded bg-zinc-800 border border-zinc-700 text-[10px] text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200">⟳</button>
            </div>
          ) : provider === 'ollama' && !customModel && modelsLoading ? (
            <div className="flex items-center gap-1">
              <div className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-500 italic">
                Loading installed models…
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-1">
              <input value={model} onChange={(e) => setModel(e.target.value)}
                placeholder={provider === 'ollama' ? 'Model tag, e.g. llama3.2' : 'Model'}
                className="flex-1 min-w-0 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200" />
              {provider === 'ollama' && (
                <button onClick={() => { setCustomModel(false); refreshModels(); }} title="Retry / back to model list"
                  className="px-1.5 py-1 rounded bg-zinc-800 border border-zinc-700 text-[10px] text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200">⟳</button>
              )}
            </div>
          )}
          {provider === 'ollama' && modelsError && (
            <div className="text-[10px] text-amber-500 break-words">{modelsError}</div>
          )}
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="Base URL"
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200" />
          {provider !== 'ollama' && (
            <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="API Key (optional)"
              type="password" className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200" />
          )}
          <div className="flex items-center justify-between text-[10px] text-zinc-400">
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={autoApprove} onChange={(e) => setAutoApprove(e.target.checked)} />
              Auto-approve edits &amp; commands
            </label>
            <label className="flex items-center gap-1">
              Steps
              <input type="number" min={1} max={30} value={maxSteps}
                onChange={(e) => setMaxSteps(Math.max(1, Math.min(30, Number(e.target.value) || 10)))}
                className="w-12 bg-zinc-800 border border-zinc-700 rounded px-1 py-0.5 text-[10px] text-zinc-200" />
            </label>
          </div>
          {alwaysAllow.length > 0 && (
            <div className="flex flex-wrap items-center gap-1 text-[10px] text-zinc-500">
              <span>Always allowed:</span>
              {alwaysAllow.map((t) => (
                <span key={t} className="inline-flex items-center gap-1 rounded-full bg-emerald-600/15 px-1.5 py-0.5 text-emerald-300">
                  {t}
                  <button
                    onClick={() => setAlwaysAllow((prev) => prev.filter((x) => x !== t))}
                    title="Revoke this permission"
                    className="hover:text-red-400"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      <div ref={listRef} className="flex-1 overflow-y-auto p-2 space-y-2 ide-scrollbar">
        {items.length === 0 && (
          <div className="text-zinc-600">
            {mode === 'agent'
              ? agentMode === 'plan'
                ? 'Plan mode: I will investigate the workspace read-only and propose an implementation plan — nothing is modified until you switch to Build mode.'
                : 'Agent mode (Build): I can read, edit, create and run code in this workspace. File edits and commands ask for your approval unless auto-approve is on. Use Plan mode for a read-only plan first.'
              : 'Ask the assistant to explain code, write snippets, or inspect your project. Switch to Agent mode to let it edit files.'}
          </div>
        )}
        {items.map((it) =>
          it.kind === 'msg' ? (
            <div key={it.id} className={it.role === 'user' ? 'text-right text-zinc-200' : 'text-zinc-300'}>
              {it.role === 'user' ? (
                <span className="inline-block max-w-full whitespace-pre-wrap text-left rounded-lg px-2 py-1 bg-emerald-600/20">
                  {it.content || '…'}
                </span>
              ) : (
                <span className="inline-block max-w-full text-left rounded-lg px-2 py-1 bg-zinc-800/60">
                  <Markdown text={it.content || '…'} />
                </span>
              )}
            </div>
          ) : (
            <ToolCard
              key={it.id}
              item={it}
              onApprove={() => decide(it.id, true)}
              onDeny={() => decide(it.id, false)}
              onAlways={() => decide(it.id, true, it.call.tool)}
              onAnswer={(answer) => answerAsk(it.id, answer)}
              answerDraft={answerDraft}
              setAnswerDraft={setAnswerDraft}
            />
          ),
        )}
        {busy && (
          <div className="text-zinc-500 italic">
            {mode === 'agent' && stepInfo ? `Working… step ${stepInfo}` : 'Thinking…'}
          </div>
        )}
      </div>

      {mode === 'agent' && items.length === 0 && (
        <div className="px-2 pb-1 flex flex-wrap gap-1">
          {QUICK_ACTIONS.map((q) => (
            <button key={q.label} onClick={() => { setInput(q.prompt); inputRef.current?.focus(); }}
              className="px-2 py-0.5 rounded-full border border-zinc-700 text-[10px] text-zinc-300 hover:bg-zinc-800">
              {q.label}
            </button>
          ))}
        </div>
      )}

      <div className="px-2 py-1.5 border-t border-zinc-800 flex items-end gap-1">
        <textarea
          ref={inputRef}
          value={input} onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
          }}
          rows={2}
          placeholder={
            mode === 'agent'
              ? 'Describe a task — e.g. "add input validation to src/lib.ts and run the tests"'
              : activeFile ? `Ask about ${activeFile.split(/[\\/]/).pop()}` : 'Ask anything…'
          }
          className="flex-1 resize-none bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-200"
        />
        {busy ? (
          <button onClick={stop} title="Stop the agent"
            className="px-3 py-2 rounded bg-red-600/80 hover:bg-red-500 text-white whitespace-nowrap">Stop</button>
        ) : (
          <button onClick={send} disabled={!input.trim()}
            className="px-3 py-2 rounded bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-40 whitespace-nowrap">Send</button>
        )}
        <button onClick={clear} title="Clear conversation"
          className="px-2 py-2 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 whitespace-nowrap">✕</button>
      </div>
    </div>
  );
}

/** Short timestamp for session rows: "14:05" today, "3/2 14:05" otherwise. */
function fmtDate(ts: number): string {
  const d = new Date(ts);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === new Date().toDateString()) return hm;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

/** Human-readable byte size for model list labels, e.g. "4.4 GB". */
function formatModelSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return '';
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;
}

const TOOL_LABELS: Record<string, string> = {
  list_dir: 'List directory',
  read_file: 'Read file',
  search_workspace: 'Search workspace',
  git_status: 'Git status',
  read_diagnostics: 'Read diagnostics',
  open_file: 'Open file',
  ask_user: 'Ask user',
  write_file: 'Write file',
  create_file: 'Create file',
  create_dir: 'Create directory',
  rename_file: 'Rename',
  delete_file: 'Delete file',
  run_command: 'Run command',
  run_program: 'Run program',
  stop_processes: 'Stop processes',
};

function describeCall(call: ToolCall): string {
  const a = call.args;
  switch (call.tool) {
    case 'write_file':
    case 'create_file': {
      const p = typeof a.path === 'string' ? a.path : '?';
      const size = typeof a.content === 'string' ? `${a.content.length} chars` : 'empty';
      return `${p} (${size})`;
    }
    case 'ask_user':
      return typeof a.question === 'string' ? a.question.slice(0, 80) : '';
    case 'rename_file':
      return `${typeof a.from === 'string' ? a.from : '?'} → ${typeof a.to === 'string' ? a.to : '?'}`;
    case 'run_command':
      return Array.isArray(a.args) ? a.args.map(String).join(' ') : '?';
    case 'run_program':
      return `${typeof a.program === 'string' ? a.program : '?'} ${Array.isArray(a.args) ? a.args.join(' ') : ''}`.trim();
    default:
      return typeof a.path === 'string' ? a.path : '';
  }
}

function ToolCard({
  item, onApprove, onDeny, onAlways, onAnswer, answerDraft, setAnswerDraft,
}: {
  item: ToolItem;
  onApprove: () => void;
  onDeny: () => void;
  onAlways: () => void;
  onAnswer: (answer: string) => void;
  answerDraft: string;
  setAnswerDraft: (value: string) => void;
}) {
  const isAsk = item.call.tool === 'ask_user';
  const desc = describeCall(item.call);
  const fallback = `${TOOL_LABELS[item.call.tool] || item.call.tool}${desc ? ` — ${desc}` : ''}`;
  const heading = isAsk ? (item.label ?? 'Asked you a question') : (item.label ?? fallback);
  const statusIcon =
    item.status === 'ok' ? '✓'
      : item.status === 'error' ? '✗'
        : item.status === 'denied' ? '⊘'
          : item.status === 'pending' ? '⏸' : '⟳';
  const statusColor =
    item.status === 'ok' ? 'text-emerald-400'
      : item.status === 'error' ? 'text-red-400'
        : item.status === 'denied' ? 'text-amber-400'
          : 'text-zinc-400';
  const shownRemoved = item.diff?.removed.slice(0, 14) ?? [];
  const shownAdded = item.diff?.added.slice(0, 14) ?? [];
  const hiddenCount =
    Math.max(0, (item.diff?.removedCount ?? 0) - shownRemoved.length) +
    Math.max(0, (item.diff?.addedCount ?? 0) - shownAdded.length);
  const canAnswer = isAsk && item.status === 'running' && Boolean(item.question);
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/70 overflow-hidden">
      <div className="px-2 py-1 flex items-center gap-2">
        <span className={`${statusColor} text-[11px]`}>{statusIcon}</span>
        <span className="font-medium text-zinc-300 text-left truncate">{heading}</span>
        {item.status === 'running' && !canAnswer && <span className="ml-auto text-zinc-500 text-[10px] animate-pulse">running…</span>}
        {item.status === 'pending' && <span className="ml-auto text-amber-400 text-[10px]">approval needed</span>}
      </div>
      {canAnswer && item.question && (
        <div className="px-2 pb-1.5 space-y-1">
          <div className="text-zinc-200 whitespace-pre-wrap">{item.question}</div>
          {item.options && item.options.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {item.options.map((o) => (
                <button
                  key={o}
                  onClick={() => onAnswer(o)}
                  className="px-2 py-0.5 rounded bg-zinc-800 border border-zinc-700 hover:bg-zinc-700 text-zinc-200 text-[10px]"
                >
                  {o}
                </button>
              ))}
            </div>
          )}
          <div className="flex gap-1">
            <input
              value={answerDraft}
              onChange={(e) => setAnswerDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && answerDraft.trim()) onAnswer(answerDraft.trim()); }}
              placeholder="Type your answer…"
              autoFocus
              className="flex-1 min-w-0 bg-zinc-800 border border-zinc-700 rounded px-2 py-0.5 text-[11px] text-zinc-200"
            />
            <button
              onClick={() => answerDraft.trim() && onAnswer(answerDraft.trim())}
              className="px-2 py-0.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-[10px]"
            >
              Answer
            </button>
          </div>
        </div>
      )}
      {item.status === 'pending' && (
        <div className="px-2 pb-1.5 flex gap-1">
          <button onClick={onApprove} className="px-2 py-0.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white">Approve</button>
          <button onClick={onDeny} className="px-2 py-0.5 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-200">Deny</button>
          <button
            onClick={onAlways}
            title={`Always allow "${TOOL_LABELS[item.call.tool] || item.call.tool}" without asking`}
            className="px-2 py-0.5 rounded bg-zinc-800 border border-zinc-700 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200"
          >
            Always allow
          </button>
        </div>
      )}
      {item.diff && (shownRemoved.length > 0 || shownAdded.length > 0) && (
        <div className="mx-2 mb-1.5 max-h-44 overflow-auto ide-scrollbar bg-zinc-950/70 border border-zinc-800 rounded p-1.5 font-mono text-[10px]">
          {shownRemoved.map((l, idx) => (
            <div key={`r${idx}`} className="whitespace-pre-wrap text-red-400/80">- {l}</div>
          ))}
          {shownAdded.map((l, idx) => (
            <div key={`a${idx}`} className="whitespace-pre-wrap text-emerald-400/80">+ {l}</div>
          ))}
          {hiddenCount > 0 && <div className="text-zinc-600">… {hiddenCount} more changed line(s)</div>}
        </div>
      )}
      {item.output && item.status !== 'running' && item.status !== 'pending' && (
        <pre className="mx-2 mb-1.5 max-h-40 overflow-auto ide-scrollbar whitespace-pre-wrap bg-zinc-950/70 border border-zinc-800 rounded p-1.5 text-[10px] text-zinc-400">
          {item.output}
        </pre>
      )}
    </div>
  );
}