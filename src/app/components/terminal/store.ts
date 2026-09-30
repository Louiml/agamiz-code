/**
 * Terminal panel state.
 *
 * A `useReducer` over one object holds sessions, the split layout and the
 * active id. The split tree is manipulated with pure helpers below so the
 * reducer stays a thin action switch and the tricky part (finding a leaf,
 * replacing it, collapsing an empty parent) is unit-testable in isolation.
 *
 * Invariants maintained by every action:
 *   - every leaf references a live instance,
 *   - `activeId` always points at a leaf that exists,
 *   - a split node never has a single child (it collapses instead).
 */

import type { SessionIcon, SplitDirection, SplitNode, TerminalInstance } from './types';

export interface TerminalState {
  instances: TerminalInstance[];
  root: SplitNode | null;
  activeId: string | null;
  /** Monotonic counter feeding the `1:`, `2:` prefixes. */
  nextOrdinal: number;
  sidebarOpen: boolean;
  maximized: boolean;
}

export const initialTerminalState: TerminalState = {
  instances: [],
  root: null,
  activeId: null,
  nextOrdinal: 1,
  sidebarOpen: true,
  maximized: false,
};

export type TerminalAction =
  | { type: 'add'; instance: TerminalInstance }
  | { type: 'remove'; id: string }
  | { type: 'focus'; id: string }
  | { type: 'pty-ready'; id: string; ptyId: number }
  | { type: 'spawn-failed'; id: string; error: string }
  | { type: 'exited'; id: string; code: number }
  | { type: 'rename'; id: string; name: string }
  | { type: 'set-color'; id: string; color: string | null }
  | { type: 'set-icon'; id: string; icon: SessionIcon | null }
  | { type: 'set-cwd'; id: string; cwd: string }
  | { type: 'split'; id: string; direction: SplitDirection; instance: TerminalInstance }
  | { type: 'focus-sibling'; delta: 1 | -1 }
  | { type: 'set-sizes'; path: string; sizes: number[] }
  | { type: 'toggle-sidebar' }
  | { type: 'toggle-maximized' }
  | { type: 'set-maximized'; value: boolean }
  | { type: 'hydrate-sidebar'; open: boolean; maximized: boolean }
  | { type: 'reset' };

// ---------------------------------------------------------------------------
// Split tree helpers (pure)
// ---------------------------------------------------------------------------

/** Every instance id referenced by the tree, in visual order. */
export function leafIds(node: SplitNode | null): string[] {
  if (!node) return [];
  if (node.kind === 'leaf') return [node.instanceId];
  return node.children.flatMap(leafIds);
}

/** Drop the leaf and any parent that ends up with a single child, so closing
 *  the last pane of a split promotes its sibling to the whole area. */
function removeLeaf(node: SplitNode, instanceId: string): SplitNode | null {
  if (node.kind === 'leaf') return node.instanceId === instanceId ? null : node;
  const children = node.children
    .map((c) => removeLeaf(c, instanceId))
    .filter((c): c is SplitNode => c !== null);
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  return { ...node, children, sizes: resizeSizes(node.sizes, children.length) };
}

/**
 * Insert `instance` as a sibling of the leaf holding `id`, splitting the
 * containing group. VS Code splits the group the pane lives in, not the whole
 * panel, so a 4-pane arrangement stays predictable.
 */
function splitLeaf(
  node: SplitNode,
  id: string,
  direction: SplitDirection,
  instance: TerminalInstance,
): SplitNode {
  if (node.kind === 'leaf') {
    if (node.instanceId !== id) return node;
    return {
      kind: 'split',
      direction,
      sizes: [0.5, 0.5],
      children: [node, { kind: 'leaf', instanceId: instance.id }],
    };
  }
  // Descend into every child: an id is unique, so at most one branch matches.
  const next = node.children.map((c) => splitLeaf(c, id, direction, instance));
  if (next.some((c, i) => c !== node.children[i])) return { ...node, children: next };
  return node;
}

/** Keep the size vector in step with the child count after a removal. */
function resizeSizes(sizes: number[], count: number): number[] {
  if (sizes.length === count) return sizes;
  const next = sizes.slice(0, count);
  while (next.length < count) next.push(1 / count);
  const total = next.reduce((a, b) => a + b, 0) || 1;
  return next.map((s) => s / total);
}

/**
 * Replace the ratios of the split group addressed by `path`.
 *
 * `path` is the chain of child indices from the root, e.g. `"0/1"` for the
 * second child of the first child. The renderer builds it while the pointer
 * moves and commits it on release, so the store only ever sees a settled
 * layout.
 */
export function setSizesAt(node: SplitNode, path: string, sizes: number[]): SplitNode {
  if (path === '') {
    if (node.kind !== 'split' || node.children.length !== sizes.length) return node;
    return { ...node, sizes };
  }
  if (node.kind !== 'split') return node;
  const slash = path.indexOf('/');
  const head = slash === -1 ? path : path.slice(0, slash);
  const index = Number(head);
  if (!Number.isInteger(index) || index < 0 || index >= node.children.length) return node;
  const children = [...node.children];
  children[index] = setSizesAt(children[index], slash === -1 ? '' : path.slice(slash + 1), sizes);
  return { ...node, children };
}

/**
 * Reorder siblings within the split group holding `id` (Ctrl+PageUp /
 * Ctrl+PageDown swaps the pane with its neighbour).
 */
export function moveLeaf(node: SplitNode, id: string, delta: 1 | -1): SplitNode {
  if (node.kind === 'leaf') return node;
  const children = node.children.map((c) => moveLeaf(c, id, delta));
  const index = children.findIndex((c) => c.kind === 'leaf' && c.instanceId === id);
  if (index === -1) return { ...node, children };
  const target = index + delta;
  if (target < 0 || target >= children.length) return { ...node, children };
  const swapped = [...children];
  [swapped[index], swapped[target]] = [swapped[target], swapped[index]];
  return { ...node, children: swapped };
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

function withInstance(
  state: TerminalState,
  id: string,
  patch: Partial<TerminalInstance>,
): TerminalState {
  return {
    ...state,
    instances: state.instances.map((i) => (i.id === id ? { ...i, ...patch } : i)),
  };
}

/** Pick the instance that should take focus after `id` disappears. */
function pickNeighbour(state: TerminalState, id: string): string | null {
  const order = leafIds(state.root).filter((leaf) => leaf !== id);
  if (order.length === 0) return null;
  const before = leafIds(state.root);
  const index = before.indexOf(id);
  // Prefer the pane to the right, matching editor tab-close behaviour.
  const next = before[index + 1] ?? before[index - 1];
  return order.includes(next) ? next : order[0];
}

export function terminalReducer(state: TerminalState, action: TerminalAction): TerminalState {
  switch (action.type) {
    case 'add': {
      const root: SplitNode = state.root
        ? {
            kind: 'split',
            direction: 'row',
            sizes: [0.5, 0.5],
            children: [state.root, { kind: 'leaf', instanceId: action.instance.id }],
          }
        : { kind: 'leaf', instanceId: action.instance.id };
      return {
        ...state,
        instances: [...state.instances, action.instance],
        root,
        activeId: action.instance.id,
        nextOrdinal: state.nextOrdinal + 1,
      };
    }

    case 'remove': {
      const root = state.root ? removeLeaf(state.root, action.id) : null;
      const instances = state.instances.filter((i) => i.id !== action.id);
      return {
        ...state,
        instances,
        root,
        activeId: state.activeId === action.id ? pickNeighbour(state, action.id) : state.activeId,
      };
    }

    case 'focus':
      return state.activeId === action.id ? state : { ...state, activeId: action.id };

    case 'pty-ready':
      return withInstance(state, action.id, { ptyId: action.ptyId, error: null });

    case 'spawn-failed':
      return withInstance(state, action.id, { error: action.error, alive: false });

    case 'exited':
      return withInstance(state, action.id, { alive: false, exitCode: action.code });

    case 'rename': {
      const name = action.name.trim();
      if (!name) return state;
      return withInstance(state, action.id, { name });
    }

    case 'set-color':
      return withInstance(state, action.id, { color: action.color });

    case 'set-icon':
      return withInstance(state, action.id, { icon: action.icon });

    case 'set-cwd':
      return withInstance(state, action.id, { cwd: action.cwd });

    case 'split': {
      if (!state.root) {
        return {
          ...state,
          instances: [...state.instances, action.instance],
          root: { kind: 'leaf', instanceId: action.instance.id },
          activeId: action.instance.id,
          nextOrdinal: state.nextOrdinal + 1,
        };
      }
      return {
        ...state,
        instances: [...state.instances, action.instance],
        root: splitLeaf(state.root, action.id, action.direction, action.instance),
        activeId: action.instance.id,
        nextOrdinal: state.nextOrdinal + 1,
      };
    }

    case 'focus-sibling': {
      if (!state.root || !state.activeId) return state;
      const order = leafIds(state.root);
      const index = order.indexOf(state.activeId);
      if (index === -1) return state;
      const next = (index + action.delta + order.length) % order.length;
      // Also reorder the layout so the tab strip and the panes agree.
      return { ...state, activeId: order[next], root: moveLeaf(state.root, state.activeId, action.delta) };
    }

    case 'set-sizes':
      return state.root
        ? { ...state, root: setSizesAt(state.root, action.path, action.sizes) }
        : state;

    case 'toggle-sidebar':
      return { ...state, sidebarOpen: !state.sidebarOpen };

    case 'toggle-maximized':
      return { ...state, maximized: !state.maximized };

    case 'set-maximized':
      return { ...state, maximized: action.value };

    case 'hydrate-sidebar':
      return { ...state, sidebarOpen: action.open, maximized: action.maximized };

    case 'reset':
      return { ...initialTerminalState, sidebarOpen: state.sidebarOpen, maximized: state.maximized };

    default:
      return state;
  }
}
