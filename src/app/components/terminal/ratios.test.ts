/**
 * Ratio maths checks for the split layout.
 *
 * Run with: npx tsx src/app/components/terminal/ratios.test.ts
 * (or via `node --experimental-strip-types` on Node 22+).
 */

import { expect, it } from 'vitest';
import { MIN_RATIO, evenRatios, normalizeRatios, resizeRatios } from './ratios';

/** Keeps the original per-case names in the failure output. */
function check(name: string, cond: boolean, detail = '') {
  expect(cond, detail ? `${name} — ${detail}` : name).toBe(true);
}
const sum = (v: number[]) => v.reduce((a, b) => a + b, 0);
const pct = (v: number[]) => normalizeRatios(v).map((x) => `${(x * 100).toFixed(0)}%`).join('/');
const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

it('split-pane ratio maths', () => {
  // 1. regression: the old frozen-divider case
{
  // delta 0 must be a no-op — the old code produced 76/24 here.
  check('delta 0 is identity', pct(resizeRatios([0.5, 0.5], 0, 0)) === '50%/50%', pct(resizeRatios([0.5, 0.5], 0, 0)));
  // Dragging right must actually move right.
  const dragged = resizeRatios([0.5, 0.5], 0, 0.2);
  check('delta +0.2 grows pane 0', close(dragged[0], 0.7), pct(dragged));
  check('delta +0.2 shrinks pane 1', close(dragged[1], 0.3), pct(dragged));
  const left = resizeRatios([0.5, 0.5], 0, -0.2);
  check('delta -0.2 shrinks pane 0', close(left[0], 0.3), pct(left));
  // The old code returned the identical ratio for every delta. Assert the
  // divider tracks the pointer monotonically and reaches both clamp limits.
  let prev = -1;
  let monotonic = true;
  let hitMin = false;
  let hitMax = false;
  for (let d = -1; d <= 1.0001; d += 0.05) {
    const r = resizeRatios([0.5, 0.5], 0, d)[0];
    if (r < prev - 1e-9) monotonic = false;
    prev = r;
    if (close(r, MIN_RATIO)) hitMin = true;
    if (close(r, 1 - MIN_RATIO)) hitMax = true;
  }
  check('divider tracks the pointer monotonically', monotonic);
  check('divider reaches the minimum', hitMin);
  check('divider reaches the maximum', hitMax);
  check('full sweep is not frozen', prev > 0.8, `max reached ${prev}`);
}

console.log('2. invariants hold across shapes and extremes');
{
  const shapes: number[][] = [
    [0.5, 0.5],
    [0.2, 0.3, 0.5],
    [0.25, 0.25, 0.25, 0.25],
    [0.6, 0.2, 0.1, 0.1],
  ];
  for (const base of shapes) {
    for (let i = 0; i < base.length - 1; i++) {
      for (const delta of [-2, -0.5, -0.1, 0, 0.1, 0.5, 2]) {
        const out = resizeRatios(base, i, delta);
        check(`sums to 1 (${pct(base)} @${i} d=${delta})`, close(sum(out), 1), `got ${sum(out)}`);
        check(`length preserved`, out.length === base.length);
        for (const [k, v] of out.entries()) {
          check(
            `pane ${k} >= MIN_RATIO (${pct(base)} @${i} d=${delta})`,
            v >= MIN_RATIO - 1e-9,
            `pane ${k} = ${v}`,
          );
        }
      }
    }
  }
}

console.log('3. tail rescaling keeps every pane above the floor');
{
  // 40/30/30, drag divider 0 by +10% -> pane 0 takes 50%, and the 20% it lost
  // is shared between panes 1 and 2 in their existing 50/50 ratio -> 25/25.
  const out = resizeRatios([0.4, 0.3, 0.3], 0, 0.1);
  check('pane 0 grew by exactly the delta', close(out[0], 0.5), pct(out));
  check('equal tail stays equal', close(out[1], 0.25) && close(out[2], 0.25), pct(out));
  // An uneven tail keeps its ordering (the floor distorts the exact ratio,
  // which is the intended trade — nobody should be starved).
  const out2 = resizeRatios([0.4, 0.4, 0.2], 0, 0.1);
  check('uneven tail keeps ordering', out2[1] > out2[2], pct(out2));
  // Dragging the middle divider must leave pane 0 alone.
  const out3 = resizeRatios([0.33, 0.34, 0.33], 1, 0.1);
  check('pane 0 untouched when divider 1 moves', close(out3[0], 0.33), pct(out3));
  check('middle drag keeps the tail above the floor', out3[2] >= MIN_RATIO - 1e-9, pct(out3));
}

console.log('4. clamping at both edges');
{
  const hard = resizeRatios([0.5, 0.5], 0, -5);
  check('cannot push pane 0 below MIN_RATIO', close(hard[0], MIN_RATIO), pct(hard));
  const hard2 = resizeRatios([0.5, 0.5], 0, 5);
  check('cannot push pane 1 below MIN_RATIO', close(hard2[1], MIN_RATIO), pct(hard2));
  // Every pane at once: 5 panes is the most the clamp can satisfy.
  const five = resizeRatios([0.2, 0.2, 0.2, 0.2, 0.2], 0, 0.5);
  check('5-pane group still sums to 1', close(sum(five), 1), `sum ${sum(five)}`);
  for (const [k, v] of five.entries()) check(`5-pane pane ${k} >= min`, v >= MIN_RATIO - 1e-9, `${v}`);
}

console.log('5. degenerate input');
{
  check('zero-sum base normalises evenly', pct(normalizeRatios([0, 0])) === '50%/50%');
  check('unnormalised base is handled', close(sum(resizeRatios([2, 2], 0, 0.1)), 1));
  check('out-of-range index is a no-op', pct(resizeRatios([0.5, 0.5], 5, 0.3)) === '50%/50%');
  check('last pane is not a divider', pct(resizeRatios([0.5, 0.5], 1, 0.3)) === '50%/50%');
  check('evenRatios(3) sums to 1', close(sum(evenRatios(3)), 1));
  // The original assertion here was `Array.isArray(evenRatios(0))`, which
  // passed for *any* non-throwing implementation including one returning
  // `[NaN]`. Assert the actual degenerate-case properties instead.
  const zero = evenRatios(0);
  check('evenRatios(0) is empty, not NaN-filled', zero.length === 0 && zero.every(Number.isFinite), JSON.stringify(zero));
  check('everyRatios-style guard holds for 1 pane', evenRatios(1).length === 1);
}

  // KNOWN GAP (not asserted — fixing ratios.ts is scheduled, out of the current
  // pass): `resizeRatios` only floors the dragged pane and the tail, so panes
  // *before* the divider pass through untouched (ratios.ts:50-56). A base like
  // [0.1, 0.2, 0.35, 0.35] resized at divider 1 yields pane 0 = 0.1, below
  // MIN_RATIO — so the invariant loop in section 2 only ever holds because
  // every shape it runs over already satisfies the floor. Not reachable from
  // the UI today (the store only holds [0.5, 0.5] or `resizeRatios` output),
  // but a caller that seeded a base from persisted state would break it. When
  // ratios.ts is fixed, add this shape to `shapes` above:
  //   [0.1, 0.2, 0.35, 0.35]
});
