/**
 * Split-pane ratio maths.
 *
 * Kept separate from `TerminalLayout` because it is pure, branch-heavy, and
 * the easiest thing in the panel to get subtly wrong. A split group's sizes
 * must always sum to 1, no pane may be squeezed out of existence, and dragging
 * one divider must not disturb siblings beyond the group being resized.
 */

/** Smallest share of a group a single pane may occupy. */
export const MIN_RATIO = 0.12;

/** Normalise a size vector to sum to 1. Returns an even split for a zero sum. */
export function normalizeRatios(sizes: number[]): number[] {
  const total = sizes.reduce((a, b) => a + b, 0);
  if (total <= 0) return sizes.map(() => 1 / Math.max(1, sizes.length));
  return sizes.map((v) => v / total);
}

/**
 * Move the divider at `index` by `delta` (a fraction of the group) and return
 * the new ratios.
 *
 * The clamp is computed against *both* sides of the divider:
 *   - the panes to its left keep their combined share plus a minimum each, so
 *     the dragged pane cannot swallow them,
 *   - the panes to its right each keep a minimum, bounding the dragged pane
 *     from above.
 *
 * The tail is then given every minimum it is owed, and only the leftover is
 * shared in proportion to the sizes it had before. That ordering matters: a
 * proportional split of the *whole* space would let a narrow pane fall under
 * the minimum while a wide one hoards the slack.
 */
export function resizeRatios(
  base: number[],
  index: number,
  delta: number,
  min: number = MIN_RATIO,
): number[] {
  const next = normalizeRatios(base);
  if (index < 0 || index >= next.length - 1) return next;

  const before = next.slice(0, index).reduce((a, b) => a + b, 0);
  const tail = next.slice(index + 1);
  // The dragged pane is floored at `min`. Its ceiling comes from the tail: it
  // may not claim so much that the panes to its right cannot each keep theirs.
  // (Flooring it at `before + min` instead would double-count the left-hand
  // panes and hand the group more than 100%.)
  const lower = min;
  const upper = 1 - before - tail.length * min;
  // A group too small to satisfy the minimum on both sides is degenerate;
  // splitting it evenly is the only sane answer.
  if (upper < lower) return evenRatios(next.length);

  next[index] = Math.max(lower, Math.min(upper, next[index] + delta));

  // Space left for the tail. The panes to the left already hold `before`.
  const space = 1 - before - next[index];
  const surplus = space - tail.length * min;
  const tailTotal = tail.reduce((a, b) => a + b, 0);
  for (let k = 0; k < tail.length; k++) {
    const share = tailTotal > 0 ? (tail[k] / tailTotal) * surplus : surplus / tail.length;
    next[index + 1 + k] = min + share;
  }
  return next;
}

/** An even split, used by the "double-click the divider to reset" affordance. */
export function evenRatios(count: number): number[] {
  return Array.from({ length: count }, () => 1 / Math.max(1, count));
}
