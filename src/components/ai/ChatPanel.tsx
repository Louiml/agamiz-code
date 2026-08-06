import { useState, useEffect, useCallback, useRef } from "react";
import { ai } from "../../utils/ai";
import { useAiStore, useEditorStore } from "../../store";

export function ChatPanel() {
  const visible = useAiStore((s) => s.chatVisible);
  const messages = useAiStore((s) => s.chatMessages);
  const addMessage = useAiStore((s) => s.addChatMessage);
  const clearChat = useAiStore((s) => s.clearChat);

  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const activeTab = useEditorStore((s) =>
    s.tabs.length > 0 ? s.tabs.find((t) => t.id === s.activeTabId) ?? null : null,
  );

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text) return;
    addMessage({ role: "user", content: text });
    setInput("");
    setLoading(true);
    try {
      let prompt = text;
      if (activeTab) {
        prompt = `@file:${activeTab.path}\n${text}`;
      }
      const result = await ai.complete(prompt);
      addMessage({
        role: "assistant",
        content: result ?? "No suggestion available.",
      });
    } catch {
      addMessage({ role: "assistant", content: "Chat error." });
    } finally {
      setLoading(false);
    }
  }, [input, activeTab, addMessage]);

  if (!visible) return null;

  return (
    <div
      className="flex flex-col shrink-0 border-t border-[var(--color-border-glass)] glass"
      style={{ height: 240 }}
    >
      <div className="flex items-center gap-2 px-3 h-[30px] shrink-0 border-b border-[var(--color-border-glass)]">
        <span className="text-[10px] uppercase font-semibold tracking-widest text-[var(--color-text-tertiary)]">
          AI Chat
        </span>
        <div className="flex-1" />
        <button
          onClick={clearChat}
          className="text-[10px] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]"
        >
          Clear
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-apple px-3 py-2 space-y-2">
        {messages.length === 0 && (
          <p className="text-[11px] text-[var(--color-text-tertiary)]">
            Ask anything about your code. Powered by local analysis.
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={m.role === "user" ? "flex justify-end" : ""}>
            <div
              className={`max-w-[85%] rounded-md px-2.5 py-1.5 text-[12px] whitespace-pre-wrap ${
                m.role === "user"
                  ? "bg-[var(--color-bg-glass-strong)]"
                  : ""
              }`}
            >
              {m.content}
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex items-center gap-2 text-[11px] text-[var(--color-text-tertiary)]">
            <span className="inline-flex h-2 w-2 rounded-full bg-[var(--color-accent-teal)] animate-pulse" />
            Thinking…
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="px-3 pb-3">
        <div className="flex items-center gap-1.5">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void handleSend();
              }
            }}
            placeholder="Ask about your code…"
            disabled={loading}
            className="flex-1 bg-[var(--color-bg-glass-strong)] border border-[var(--color-border-glass)] rounded px-2.5 py-1.5 text-[12px] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] outline-none focus:border-[var(--color-accent-blue)] disabled:opacity-50"
          />
          <button
            onClick={() => void handleSend()}
            disabled={loading || !input.trim()}
            className="px-3 py-1.5 rounded text-[12px] font-medium bg-[var(--color-accent-blue)] text-white disabled:opacity-40 hover:brightness-110"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}