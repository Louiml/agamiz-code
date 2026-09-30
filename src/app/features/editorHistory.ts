/**
 * Undo/redo history for the editor.
 *
 * The editor is a fully controlled `<textarea>`: React assigns `value` on
 * every state change, and per the HTML spec that clears the browser's native
 * undo stack. So the browser's Ctrl+Z, which would otherwise work, stops
 * working after the first keystroke — and every programmatic edit (Tab,
 * auto-close, duplicate line, find-replace, accepting a completion) is
 * indistinguishable from a manual one. There is no undo at all today.
 *
 * This is a pure model, separate from the React plumbing, for two reasons: the
 * coalescing rules are the fiddly part and deserve direct tests, and the
 * component should not be the place that decides what counts as one undo step.
 *
 * ## Coalescing
 *
 * A naive "push every change" stack makes undo useless — it steps back one
 * character at a time. Two rules keep a burst of typing to one entry:
 *
 *  - **Time.** Consecutive changes within `coalesceMs` merge into the previous
 *    entry, so a sentence is one undo rather than forty.
 *  - **Contiguity.** The new selection must touch the end of the previous
 *    one. Typing at the end of a word coalesces; jumping to the top of the
 *    file and typing starts a new entry, which is what the user means.
 *
 * Newline-delimited changes never coalesce — a line break is a natural
 * boundary, and merging across it produces steps that undo in a confusing order.
 */

export interface HistoryEntry {
  content: string;
  selectionStart: number;
  selectionEnd: number;
}

export interface HistoryOptions {
  /** How long after a change a further change still joins the same entry. */
  coalesceMs?: number;
  /** Entries kept. Older ones are dropped from the bottom of the undo stack. */
  limit?: number;
}

const DEFAULTS: Required<HistoryOptions> = {
  coalesceMs: 400,
  limit: 500,
};

/** The state a caret is in when a change was made, for contiguity checks. */
interface ChangeContext {
  at: number;
  /** Caret *after* the change, so the next edit's anchor can be compared to it. */
  caret: number;
}

export class EditorHistory {
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private last: ChangeContext | null = null;

  private readonly coalesceMs: number;
  private readonly limit: number;

  constructor(options: HistoryOptions = {}) {
    this.coalesceMs = options.coalesceMs ?? DEFAULTS.coalesceMs;
    this.limit = options.limit ?? DEFAULTS.limit;
  }

  /**
   * Seed the history with the state the editor is in when a file is opened.
   *
   * Called on mount and whenever the buffer is replaced wholesale (file switch,
   * external reload, agent write). A fresh document must not be undoable back
   * into a different file.
   */
  reset(content: string, selectionStart = 0, selectionEnd = selectionStart): void {
    this.undoStack = [{ content, selectionStart, selectionEnd }];
    this.redoStack = [];
    this.last = null;
  }

  /**
   * Record a new buffer state.
   *
   * `anchor` is where the edit began — **the caret position before the change**
   * — and that is what contiguity is judged against. Only the caller knows
   * which operation ran, so it cannot be inferred here.
   *
   * The before/after distinction matters most for deletion. Deleting a character
   * moves the caret *backwards*, so the edit after a backspace begins exactly
   * where the previous one left off even though both carets differ from the
   * edit position. Passing the post-edit caret instead would make every
   * backspace look non-contiguous and each keystroke its own undo step.
   */
  push(entry: HistoryEntry, anchor: number, now: number): void {
    const previous = this.undoStack[this.undoStack.length - 1];
    if (previous && this.shouldCoalesce(previous, entry, anchor, now)) {
      // Replace the top entry rather than adding one. Its `selectionStart` is
      // kept so undoing returns the caret to where the burst began.
      this.undoStack[this.undoStack.length - 1] = {
        content: entry.content,
        selectionStart: previous.selectionStart,
        selectionEnd: previous.selectionEnd,
      };
    } else {
      this.undoStack.push(entry);
      if (this.undoStack.length > this.limit) this.undoStack.shift();
    }

    this.last = { at: now, caret: entry.selectionEnd };
    // Any new edit invalidates the redo branch, which is what every editor
    // does and what makes redo-after-a-typo behave predictably.
    this.redoStack = [];
  }

  /**
   * Whether `next` should join the previous entry instead of starting a new one.
   *
   * All four conditions must hold. Each exists for a specific case that would
   * otherwise produce a confusing undo:
   *
   * 1. **Time** — a pause ends the burst.
   * 2. **No new line break** — undoing should not straddle a paragraph.
   * 3. **At most one character of length delta** — a paste, a multi-character
   *    delete, or a block edit is its own step. Without this, pasting right
   *    after typing would merge into the typing and one undo would remove both.
   * 4. **Contiguous** — the new edit begins exactly where the last one ended.
   *    This is what separates "finished the word" from "jumped to the top of
   *    the file and started typing", which is why it is compared against the
   *    previous caret rather than a distance threshold.
   */
  private shouldCoalesce(
    previous: HistoryEntry,
    next: HistoryEntry,
    anchor: number,
    now: number,
  ): boolean {
    if (!this.last) return false;
    if (now - this.last.at > this.coalesceMs) return false;
    if (countChar(next.content, '\n') > countChar(previous.content, '\n')) return false;
    if (Math.abs(next.content.length - previous.content.length) > 1) return false;
    return this.last.caret - anchor === 0;
  }

  /** The state to restore on undo, or null when there is nothing to undo. */
  undo(current: HistoryEntry): HistoryEntry | null {
    if (this.undoStack.length <= 1) return null;
    this.undoStack.pop();
    const target = this.undoStack[this.undoStack.length - 1];
    this.redoStack.push(current);
    this.last = null;
    return target;
  }

  /** The state to restore on redo, or null when there is nothing to redo. */
  redo(current: HistoryEntry): HistoryEntry | null {
    const target = this.redoStack.pop();
    if (!target) return null;
    this.undoStack.push(current);
    this.last = null;
    return target;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 1;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Depth of each stack, for tests and a future undo/redo UI affordance. */
  get depth(): { undo: number; redo: number } {
    return { undo: this.undoStack.length, redo: this.redoStack.length };
  }
}

function countChar(s: string, ch: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === ch) n++;
  return n;
}
