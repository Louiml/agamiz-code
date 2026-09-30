/**
 * A small, dependency-free Lua 5.1-style interpreter used to run LuaScript
 * extensions. Supports numbers, strings (incl. long brackets), tables, all
 * operators, closures (upvalues), local/global scoping, numeric & generic
 * `for`, `while`, `repeat`, `if`, `break`, `return`, methods, multiple
 * returns, and a compact standard library. Errors surface via LuaError.
 */

const KEYWORDS = new Set([
  'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function',
  'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true',
  'until', 'while',
]);

type Tok =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'name'; v: string }
  | { t: 'sym'; v: string }
  | { t: 'eof'; v: string };

/** Split on long-bracket delimiters first so `--[[ ]]` wins over `--`. */
function tokenize(src: string, fname = '?lua'): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const n = src.length;
  const here = (len: number) => src.slice(i, i + len);

  function longBrack(idx: number): { level: number; len: number } | null {
    if (src[idx] !== '[') return null;
    let j = idx + 1;
    while (j < n && src[j] === '=') j++;
    if (src[j] !== '[') return null;
    return { level: j - idx - 1, len: j - idx + 1 };
  }

  function readLongString(startIdx: number): { value: string; end: number } {
    const open = longBrack(startIdx)!;
    const close = ']' + '='.repeat(open.level) + ']';
    const end = src.indexOf(close, startIdx + open.len);
    if (end === -1) throw new LuaError('unfinished long string', fname);
    let raw = src.slice(startIdx + open.len, end);
    if (raw.charCodeAt(0) === 13 && raw.charCodeAt(1) === 10) raw = raw.slice(2);
    else if (raw.charCodeAt(0) === 10) raw = raw.slice(1);
    else if (raw.charCodeAt(0) === 13) raw = raw.slice(1);
    return { value: raw, end: end + close.length };
  }

  while (i < n) {
    const c = src[i];

    // line comment
    if (c === '-' && here(2) === '--') {
      const lb = longBrack(i + 2);
      if (lb) {
        i += 2;
        const res = readLongString(i);
        i = res.end;
        continue;
      }
      let j = i + 2;
      while (j < n && src[j] !== '\n') j++;
      i = j;
      continue;
    }

    // whitespace
    if (/\s/.test(c)) { i++; continue; }

    // long string
    if (c === '[' && longBrack(i)) {
      const res = readLongString(i);
      toks.push({ t: 'str', v: res.value });
      i = res.end;
      continue;
    }

    // comment re-check for `--` already handled; short string
    if (c === '"' || c === "'") {
      const q = c;
      let j = i + 1;
      let out = '';
      while (j < n) {
        const ch = src[j];
        if (ch === '\\') {
          const e = src[j + 1];
          const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', a: '\a', b: '\b', f: '\f', v: '\v', '\\': '\\', '"': '"', "'": "'" };
          if (e in map) { out += map[e]; j += 2; continue; }
          if (e === '\n') { j += 2; continue; } // escaped newline
          out += e; j += 2; continue;
        }
        if (ch === q) { j++; break; }
        out += ch; j++;
      }
      if (j > n || src[j - 1] !== q) throw new LuaError('unfinished string', fname);
      i = j;
      toks.push({ t: 'str', v: out });
      continue;
    }

    // number
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(here(2)[1] ?? ''))) {
      let j = i;
      if (here(2) === '0x' || here(2) === '0X') {
        j = i + 2;
        while (j < n && /[0-9A-Fa-f]/.test(src[j])) j++;
        toks.push({ t: 'num', v: parseInt(src.slice(i + 2, j), 16) });
        i = j;
        continue;
      }
      while (j < n && /[0-9]/.test(src[j])) j++;
      if (src[j] === '.' && /[0-9]/.test(src[j + 1] ?? '')) { j++; while (j < n && /[0-9]/.test(src[j])) j++; }
      if (src[j] === 'e' || src[j] === 'E') {
        let k = j + 1;
        if (src[k] === '+' || src[k] === '-') k++;
        if (/[0-9]/.test(src[k] ?? '')) { while (k < n && /[0-9]/.test(src[k])) k++; j = k; }
      }
      toks.push({ t: 'num', v: parseFloat(src.slice(i, j)) });
      i = j;
      continue;
    }

    // identifier / keyword
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
      const w = src.slice(i, j);
      toks.push(KEYWORDS.has(w) ? { t: 'sym', v: w } : { t: 'name', v: w });
      i = j;
      continue;
    }

    // multi-char operators
    const two = here(2);
    const three = here(3);
    if (['...'].includes(three)) { toks.push({ t: 'sym', v: three }); i += 3; continue; }
    if (['==', '~=', '<=', '>=', '..', '//', '<<', '>>'].includes(two)) { toks.push({ t: 'sym', v: two }); i += 2; continue; }
    if ('+-*/%^#<>=(){}[];:.,'.includes(c)) { toks.push({ t: 'sym', v: c }); i++; continue; }

    throw new LuaError(`unexpected symbol near '${c}'`, fname);
  }

  toks.push({ t: 'eof', v: '' });
  return toks;
}

export class LuaError extends Error {
  constructor(message: string, public file = '?lua', public line = 0) {
    super(message);
    this.name = 'LuaError';
  }
}
// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------
type Expr =
  | { k: 'nil' }
  | { k: 'bool'; v: boolean }
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'vararg' }
  | { k: 'name'; v: string }
  | { k: 'index'; base: Expr; key: Expr }
  | { k: 'call'; func: Expr; args: Expr[] }
  | { k: 'method'; base: Expr; name: string; args: Expr[] }
  | { k: 'table'; fields: { key: Expr | null; value: Expr }[] }
  | { k: 'binop'; op: string; l: Expr; r: Expr }
  | { k: 'unop'; op: string; e: Expr }
  | { k: 'func'; params: string[]; vararg: boolean; body: Stat[] };

type Stat =
  | { k: 'local'; names: string[]; exprs: Expr[] }
  | { k: 'assign'; targets: Expr[]; exprs: Expr[] }
  | { k: 'call'; expr: Expr }
  | { k: 'if'; cond: Expr; then: Stat[]; elseif: { cond: Expr; body: Stat[] }[]; els: Stat[] }
  | { k: 'while'; cond: Expr; body: Stat[] }
  | { k: 'repeat'; body: Stat[]; cond: Expr }
  | { k: 'block'; body: Stat[] }
  | { k: 'numfor'; v: string; init: Expr; limit: Expr; step: Expr | null; body: Stat[] }
  | { k: 'genfor'; names: string[]; exprs: Expr[]; body: Stat[] }
  | { k: 'return'; exprs: Expr[] }
  | { k: 'break' }
  | { k: 'func'; name: string; func: Expr };

const PREC: Record<string, number> = {
  or: 1, and: 2,
  '<': 3, '>': 3, '<=': 3, '>=': 3, '~=': 3, '==': 3,
  '|': 4, '~': 5, '&': 6,
  '<<': 7, '>>': 7,
  '..': 8,
  '+': 9, '-': 9,
  '*': 10, '/': 10, '//': 10, '%': 10,
  '^': 11,
};
class Parser {
  private pos = 0;
  constructor(private toks: Tok[], private fname: string) {}

  private cur(): Tok { return this.toks[this.pos]; }
  private peek(k: number): Tok { return this.toks[Math.min(this.pos + k, this.toks.length - 1)]; }
  private at(v: string): boolean { const t = this.cur(); return t.t === 'sym' && t.v === v; }
  private eat(v: string): void { if (!this.at(v)) this.fail(`expected '${v}'`); this.pos++; }
  private fail(msg: string): never {
    const t = this.toks[Math.min(this.pos, this.toks.length - 1)];
    throw new LuaError(`${msg} near '${t.t === 'eof' ? '<eof>' : t.v}'`, this.fname);
  }

  parse(): Stat[] {
    const block = this.block();
    if (this.cur().t !== 'eof') this.fail('unexpected token');
    return block;
  }

  private block(until: string[] = []): Stat[] {
    const stats: Stat[] = [];
    while (true) {
      if (this.cur().t === 'eof') break;
      const t = this.cur();
      if (t.t === 'sym' && until.includes(t.v)) break;
      if (t.t === 'sym' && t.v === 'return') {
        this.pos++;
        const tv = this.cur();
        const term = tv.t === 'sym' && ['end', 'else', 'elseif', 'until', 'eof'].includes(tv.v);
        stats.push({ k: 'return', exprs: term ? [] : this.exprList() });
        break;
      }
      if (t.t === 'sym' && t.v === 'break') { this.pos++; stats.push({ k: 'break' }); continue; }
      if (t.t === 'sym' && t.v === ';') { this.pos++; continue; }
      stats.push(this.statement());
    }
    return stats;
  }

  private statement(): Stat {
    const t = this.cur();
    if (t.t === 'sym' && t.v === 'if') return this.ifStmt();
    if (t.t === 'sym' && t.v === 'while') return this.whileStmt();
    if (t.t === 'sym' && t.v === 'repeat') return this.repeatStmt();
    if (t.t === 'sym' && t.v === 'for') return this.forStmt();
    if (t.t === 'sym' && t.v === 'do') {
      this.pos++;
      const body = this.block(['end']);
      this.eat('end');
      return { k: 'block', body };
    }
    if (t.t === 'sym' && t.v === 'local') return this.localStmt();
    if (t.t === 'sym' && t.v === 'function') return this.functionStmt();
    const first = this.suffixedExpr();
    const rest = this.cur();
    if (rest.t === 'sym' && (rest.v === ',' || rest.v === '=')) {
      const targets: Expr[] = [first];
      while (this.at(',')) { this.pos++; targets.push(this.suffixedExpr()); }
      this.eat('=');
      return { k: 'assign', targets, exprs: this.exprList() };
    }
    return { k: 'call', expr: first };
  }

  private exprList(): Expr[] {
    const out = [this.expr()];
    while (this.at(',')) { this.pos++; out.push(this.expr()); }
    return out;
  }

  private ifStmt(): Stat {
    this.eat('if');
    const cond = this.expr();
    this.eat('then');
    const then = this.block(['elseif', 'else', 'end']);
    const elseif: { cond: Expr; body: Stat[] }[] = [];
    let els: Stat[] = [];
    while (this.at('elseif')) {
      this.pos++;
      const c = this.expr();
      this.eat('then');
      elseif.push({ cond: c, body: this.block(['elseif', 'else', 'end']) });
    }
    if (this.at('else')) { this.pos++; els = this.block(['end']); }
    this.eat('end');
    return { k: 'if', cond, then, elseif, els };
  }

  private whileStmt(): Stat {
    this.eat('while');
    const cond = this.expr();
    this.eat('do');
    const body = this.block(['end']);
    this.eat('end');
    return { k: 'while', cond, body };
  }

  private repeatStmt(): Stat {
    this.eat('repeat');
    const body = this.block(['until']);
    this.eat('until');
    const cond = this.expr();
    return { k: 'repeat', body, cond };
  }

  private forStmt(): Stat {
    this.eat('for');
    const name = this.cur();
    if (name.t !== 'name') this.fail('expected name');
    this.pos++;
    if (this.at('=')) {
      this.pos++;
      const init = this.expr();
      this.eat(',');
      const limit = this.expr();
      let step: Expr | null = null;
      if (this.at(',')) { this.pos++; step = this.expr(); }
      this.eat('do');
      const body = this.block(['end']);
      this.eat('end');
      return { k: 'numfor', v: name.v, init, limit, step, body };
    }
    const names = [name.v];
    while (this.at(',')) { this.pos++; const nx = this.cur(); if (nx.t !== 'name') this.fail('expected name'); names.push(nx.v); this.pos++; }
    this.eat('in');
    const exprs = this.exprList();
    this.eat('do');
    const body = this.block(['end']);
    this.eat('end');
    return { k: 'genfor', names, exprs, body };
  }

  private localStmt(): Stat {
    this.eat('local');
    if (this.at('function')) {
      this.pos++;
      const name = this.cur();
      if (name.t !== 'name') this.fail('expected function name');
      this.pos++;
      return { k: 'func', name: name.v, func: this.funcValue() };
    }
    const names: string[] = [];
    const n = this.cur();
    if (n.t !== 'name') this.fail('expected name');
    names.push(n.v); this.pos++;
    while (this.at(',')) { this.pos++; const nx = this.cur(); if (nx.t !== 'name') this.fail('expected name'); names.push(nx.v); this.pos++; }
    const exprs = this.at('=') ? (this.pos++, this.exprList()) : [];
    return { k: 'local', names, exprs };
  }

  private functionStmt(): Stat {
    this.eat('function');
    const name = this.cur();
    if (name.t !== 'name') this.fail('expected function name');
    this.pos++;
    const nameParts = [name.v];
    while (this.at('.')) { this.pos++; const nx = this.cur(); if (nx.t !== 'name') this.fail('expected name'); nameParts.push('.' + nx.v); this.pos++; }
    const f = this.funcValue();
    if (nameParts.length > 1) {
      const chain: Expr[] = [];
      let base: Expr = { k: 'name', v: nameParts[0] };
      for (let i = 1; i < nameParts.length; i++) {
        base = { k: 'index', base, key: { k: 'str', v: nameParts[i].slice(1) } };
        chain.push(base);
      }
      return { k: 'assign', targets: chain, exprs: [f] };
    }
    return { k: 'func', name: name.v, func: f };
  }

  private funcExpr(): Expr {
    this.eat('function');
    return this.funcValue();
  }

  private funcValue(): Expr {
    this.eat('(');
    const params: string[] = [];
    let vararg = false;
    if (!this.at(')')) {
      while (true) {
        const t = this.cur();
        if (t.t === 'name') { params.push(t.v); this.pos++; }
        else if (t.t === 'sym' && t.v === '...') { vararg = true; this.pos++; }
        else this.fail('expected parameter name');
        if (this.at(',')) { this.pos++; continue; }
        break;
      }
    }
    this.eat(')');
    const body = this.block(['end']);
    this.eat('end');
    return { k: 'func', params, vararg, body };
  }

  private expr(minPrec = 0): Expr {
    let lhs = this.unary();
    while (true) {
      const t = this.cur();
      if (t.t !== 'sym') break;
      const prec = PREC[t.v];
      if (prec === undefined || prec < minPrec) break;
      const op = t.v;
      this.pos++;
      const rightAssoc = op === '^' || op === '..';
      lhs = { k: 'binop', op, l: lhs, r: this.expr(rightAssoc ? prec : prec + 1) };
    }
    return lhs;
  }

  private unary(): Expr {
    const t = this.cur();
    if (t.t === 'sym' && ['not', '#', '-'].includes(t.v)) {
      this.pos++;
      return { k: 'unop', op: t.v, e: this.unary() };
    }
    return this.suffixedExpr();
  }

  private simpleExpr(): Expr {
    const t = this.cur();
    if (t.t === 'num') { this.pos++; return { k: 'num', v: t.v }; }
    if (t.t === 'str') { this.pos++; return { k: 'str', v: t.v }; }
    if (t.t === 'name') {
      this.pos++;
      return { k: 'name', v: t.v };
    }
    if (t.t === 'sym') {
      if (t.v === 'nil' || t.v === 'true' || t.v === 'false') {
        this.pos++;
        return t.v === 'nil' ? { k: 'nil' } : { k: 'bool', v: t.v === 'true' };
      }
      if (t.v === 'function') return this.funcExpr();
      if (t.v === '{') return this.tableExpr();
      if (t.v === '(') { this.pos++; const e = this.expr(); this.eat(')'); return e; }
      if (t.v === '...') { this.pos++; return { k: 'vararg' }; }
    }
    this.fail('unexpected token');
  }

  private tableExpr(): Expr {
    this.eat('{');
    const fields: { key: Expr | null; value: Expr }[] = [];
    while (!this.at('}')) {
      if (this.cur().t === 'eof') this.fail('unexpected end');
      const t = this.cur();
      if (t.t === 'name' && this.peek(1).t === 'sym' && this.peek(1).v === '=') {
        this.pos++; this.pos++;
        fields.push({ key: { k: 'str', v: t.v }, value: this.expr() });
      } else if (t.t === 'sym' && t.v === '[') {
        this.pos++;
        const key = this.expr();
        this.eat(']');
        this.eat('=');
        fields.push({ key, value: this.expr() });
      } else {
        fields.push({ key: null, value: this.expr() });
      }
      if (this.at(',') || this.at(';')) this.pos++;
      else break;
    }
    this.eat('}');
    return { k: 'table', fields };
  }

  private suffixedExpr(): Expr {
    let e = this.simpleExpr();
    while (true) {
      const t = this.cur();
      if (t.t === 'sym' && t.v === '[') {
        this.pos++;
        const key = this.expr();
        this.eat(']');
        e = { k: 'index', base: e, key };
      } else if (t.t === 'sym' && t.v === '.') {
        this.pos++;
        const n = this.cur();
        if (n.t !== 'name') this.fail('expected field name');
        this.pos++;
        e = { k: 'index', base: e, key: { k: 'str', v: n.v } };
      } else if (t.t === 'sym' && t.v === ':') {
        this.pos++;
        const n = this.cur();
        if (n.t !== 'name') this.fail('expected method name');
        this.pos++;
        e = { k: 'method', base: e, name: n.v, args: this.callArgs() };
      } else if (t.t === 'sym' && (t.v === '(' || t.v === '{')) {
        e = { k: 'call', func: e, args: this.callArgs() };
      } else if (t.t === 'str') {
        e = { k: 'call', func: e, args: this.callArgs() };
      } else {
        break;
      }
    }
    return e;
  }

  private callArgs(): Expr[] {
    const t = this.cur();
    if (t.t === 'sym' && t.v === '(') {
      this.pos++;
      if (this.at(')')) { this.pos++; return []; }
      const args = this.exprList();
      this.eat(')');
      return args;
    }
    if (t.t === 'sym' && t.v === '{') return [this.tableExpr()];
    if (t.t === 'str') { this.pos++; return [{ k: 'str', v: t.v }]; }
    this.fail('unexpected token');
  }
}

function parse(src: string, fname = '?lua'): Stat[] {
  return new Parser(tokenize(src, fname), fname).parse();
}
// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------
type LuaTable = { t: 'table'; map: Map<Value, Value>; arr: Value[] };
type LuaClosure = { t: 'closure'; params: string[]; vararg: boolean; body: Stat[]; env: Env; name?: string };
type NativeFn = { t: 'native'; name: string; fn: (args: Value[]) => Value[] };
type Callable = LuaClosure | NativeFn;
type Value = number | string | boolean | null | LuaTable | Callable;

/** JS function autismomatic conversion to/from Lua values. */
export type LazyJsApiArg = unknown;
export type JsApi = Record<string, (...args: LazyJsApiArg[]) => LazyJsApiArg>;

export function isTruthy(v: Value): boolean { return v !== null && v !== false; }

export function toJs(v: Value): LazyJsApiArg {
  if (v === null) return null;
  if (v && (v as LuaTable).t === 'table') {
    if ((v as LuaTable).arr.length > 0 || (v as LuaTable).map.size === 0) {
      return (v as LuaTable).arr.map(toJs);
    }
    const o: Record<string, LazyJsApiArg> = {};
    (v as LuaTable).map.forEach((val, key) => {
      const k = toJs(key);
      if (typeof k === 'string' || typeof k === 'number') o[String(k)] = toJs(val);
    });
    return o;
  }
  if (v && (v as Callable).t === 'closure') return { __luaFunction: true } as unknown;
  if (v) return v;
  return v;
}

export function fromJs(x: LazyJsApiArg): Value {
  if (x === null || x === undefined) return null;
  if (typeof x === 'number' || typeof x === 'string' || typeof x === 'boolean') return x;
  if (typeof x === 'function') return { t: 'native', name: x.name || 'fn', fn: (args) => [fromJs(x(...args.map(toJs)))] };
  if (Array.isArray(x)) {
    const arr: Value[] = x.map(fromJs);
    return { t: 'table', map: new Map(), arr };
  }
  if (typeof x === 'object') {
    const map = new Map<Value, Value>();
    for (const k of Object.keys(x)) map.set(k, fromJs((x as any)[k]));
    return { t: 'table', map, arr: [] };
  }
  return null;
}

class Ret extends Error { constructor(public values: Value[]) { super('ret'); } }
class Brk extends Error { constructor() { super('brk'); } }

class Env {
  constructor(private parent: Env | null, private vars = new Map<string, Value>()) {}
  child(): Env { return new Env(this); }
  define(name: string, v: Value): void { this.vars.set(name, v); }
  get(name: string): Value {
    if (this.vars.has(name)) return this.vars.get(name)!;
    if (this.parent) return this.parent.get(name);
    return null;
  }
  find(name: string): Env {
    if (this.vars.has(name)) return this;
    if (this.parent) return this.parent.find(name);
    return this;
  }
  set(name: string, v: Value): void { this.find(name).vars.set(name, v); }
}

export interface LuaOutput {
  log(msg: string): void;
  dump(v: LazyJsApiArg, o: LazyJsApiArg): void;
}
class Interpreter {
  private global: Env;
  private stepLimit = 2_000_000;
  private steps = 0;

  constructor(private api: JsApi, private out: LuaOutput) {
    this.global = new Env(null);
    this.installStdlib();
    this.global.define('ide', fromJs(api as unknown));
    this.global.define('print', this.native('print', (a) => {
      this.out.log(a.map((v) => luaToString(v)).join('\t'));
      return [];
    }));
  }

  private native(name: string, fn: (args: Value[]) => Value[]): NativeFn {
    return { t: 'native', name, fn };
  }

  private numfn(name: string, fn: (...xs: number[]) => Value[]) {
    return this.native(name, (a: Value[]) => fn(...a.map((x) => (typeof x === 'number' ? x : 0))));
  }

  private installStdlib(): void {
    const g = this.global;
    g.define('type', this.native('type', (a) => {
      const v = a[0] ?? null;
      if (v === null) return ['nil'];
      if ((v as any).t === 'table') return ['table'];
      if ((v as any).t === 'closure' || (v as any).t === 'native') return ['function'];
      return [typeof v];
    }));
    g.define('tostring', this.native('tostring', (a) => [luaToString(a[0] ?? null)]));
    g.define('tonumber', this.native('tonumber', (a) => {
      const x = a[0];
      const n = typeof x === 'number' ? x : typeof x === 'string' ? Number(x) : NaN;
      return isNaN(n) ? [null] : [n];
    }));
    g.define('error', this.native('error', (a) => { throw new LuaError(luaToString(a[0] ?? 'error')); }));
    g.define('assert', this.native('assert', (a) => { if (!isTruthy(a[0] ?? null)) throw new LuaError(luaToString(a[1] ?? 'assertion failed!')); return a; }));
    g.define('ipairs', this.native('ipairs', (a) => makeIpairs(a[0])));
    g.define('pairs', this.native('pairs', (a) => makePairs(a[0])));
    g.define('next', this.native('next', (a) => nextImpl(a[0] as LuaTable, a[1] ?? null)));
    g.define('select', this.native('select', (a) => {
      const n = a[0];
      if (n === '#') return [a.length - 1];
      const idx = typeof n === 'number' ? n : 1;
      return a.slice(idx);
    }));
    g.define('rawget', this.native('rawget', (a) => [rawGet(a[0] as LuaTable, a[1])]));
    g.define('rawset', this.native('rawset', (a) => { rawSet(a[0] as LuaTable, a[1], a[2] ?? null); return [a[0]]; }));

    // table
    const table = fromJs({}) as LuaTable;
    rawSet(table, 'insert', this.native('table.insert', (a) => {
      const t = a[0] as LuaTable;
      if (a.length >= 3) t.arr.splice(typeof a[1] === 'number' ? a[1] - 1 : t.arr.length, 0, a[2]);
      else t.arr.push(a[1]);
      return [];
    }));
    rawSet(table, 'remove', this.native('table.remove', (a) => {
      const t = a[0] as LuaTable;
      const i = (typeof a[1] === 'number' ? a[1] : t.arr.length) - 1;
      const v = t.arr[i] ?? null;
      t.arr.splice(i, 1);
      return [v];
    }));
    rawSet(table, 'concat', this.native('table.concat', (a) => [(a[0] as LuaTable).arr.map((x) => luaToString(x)).join((a[1] as string) ?? '')]));
    rawSet(table, 'unpack', this.native('table.unpack', (a) => (a[0] as LuaTable).arr.slice(0, typeof a[2] === 'number' ? a[2] : undefined)));
    rawSet(table, 'getn', this.native('table.getn', (a) => [(a[0] as LuaTable).arr.length]));
    g.define('table', table);
// string
    const str = fromJs({}) as LuaTable;
    rawSet(str, 'len', this.native('string.len', (a) => [String(a[0] ?? '').length]));
    rawSet(str, 'upper', this.native('string.upper', (a) => [String(a[0] ?? '').toUpperCase()]));
    rawSet(str, 'lower', this.native('string.lower', (a) => [String(a[0] ?? '').toLowerCase()]));
    rawSet(str, 'sub', this.native('string.sub', (a) => {
      const s = String(a[0] ?? '');
      let i = typeof a[1] === 'number' ? Math.floor(a[1]) : 1;
      let j = typeof a[2] === 'number' ? Math.floor(a[2]) : s.length;
      if (i < 0) i = s.length + i + 1;
      if (j < 0) j = s.length + j + 1;
      if (i < 1) i = 1;
      if (j > s.length) j = s.length;
      return i > j ? [''] : [s.slice(i - 1, j)];
    }));
    rawSet(str, 'rep', this.native('string.rep', (a) => [String(a[0] ?? '').repeat(typeof a[1] === 'number' ? a[1] : 0)]));
    rawSet(str, 'byte', this.native('string.byte', (a) => [String(a[0] ?? '').charCodeAt(0)]));
    rawSet(str, 'char', this.native('string.char', (a) => [String.fromCharCode(...a.map((x) => (typeof x === 'number' ? x : 0)))]));
    rawSet(str, 'find', this.native('string.find', (a) => {
      const s = String(a[0] ?? '');
      const p = String(a[1] ?? '');
      const i = s.indexOf(p);
      return i === -1 ? [null] : [i + 1, i + p.length];
    }));
    rawSet(str, 'format', this.native('string.format', (a) => {
      const f = String(a[0] ?? '');
      const xs = a.slice(1);
      let out = '';
      let k = 0;
      for (let j = 0; j < f.length; j++) {
        if (f[j] === '%' && f[j + 1]) {
          const spec = f[j + 1];
          if (spec === '%') out += '%';
          else if (spec === 's') out += luaToString(xs[k++] ?? null);
          else if (spec === 'd' || spec === 'i') out += String(Math.trunc(typeof xs[k] === 'number' ? (xs[k++] as number) : 0));
          else if (spec === 'f') out += String(Number(xs[k++] ?? 0));
          else out += '%' + spec;
          j++;
        } else out += f[j];
      }
      return [out];
    }));
    g.define('string', str);

    // math
    const math = fromJs({}) as LuaTable;
    for (const m of ['floor', 'ceil', 'abs', 'log', 'exp', 'sqrt', 'sin', 'cos', 'tan', 'acos', 'asin', 'atan']) {
      rawSet(math, m, this.numfn(m, (...xs) => [(Math as any)[m](...xs)]));
    }
    rawSet(math, 'max', this.numfn('max', (...xs) => [Math.max(...xs)]));
    rawSet(math, 'min', this.numfn('min', (...xs) => [Math.min(...xs)]));
    rawSet(math, 'random', this.native('math.random', (a) => {
      const lo = typeof a[0] === 'number' ? a[0] : 1;
      const hi = typeof a[1] === 'number' ? a[1] : 1;
      return [lo + Math.floor(Math.random() * (hi - lo + 1))];
    }));
    rawSet(math, 'huge', Number.MAX_VALUE);
    rawSet(math, 'pi', Math.PI);
    g.define('math', math);

    // os
    const os = fromJs({}) as LuaTable;
    rawSet(os, 'time', this.native('os.time', () => [Date.now() / 1000]));
    rawSet(os, 'clock', this.native('os.clock', () => [performance.now() / 1000]));
    rawSet(os, 'date', this.native('os.date', () => [new Date().toISOString()]));
    g.define('os', os);
  }

  private tick(): void {
    this.steps++;
    if (this.steps > this.stepLimit) throw new LuaError('program too complex (infinite loop?)');
  }

  run(code: string, fname?: string): Value[] {
    const ast = parse(code, fname ?? '?lua');
    try {
      this.executeBlock(ast, this.global);
      return [];
    } catch (e) {
      if (e instanceof Ret) return e.values;
      if (e instanceof Brk) throw new LuaError("'break' outside loop");
      throw e;
    }
  }

  private executeBlock(stats: Stat[], env: Env): void {
    for (const s of stats) this.execStat(s, env);
  }

  private execStat(s: Stat, env: Env): void {
    switch (s.k) {
      case 'local': {
        if (s.exprs.length === 0) { for (const n of s.names) env.define(n, null); return; }
        const vals = this.evalList(s.exprs, env);
        s.names.forEach((n, i) => env.define(n, vals[i] ?? null));
        return;
      }
      case 'assign': {
        const vals = this.evalList(s.exprs, env);
        s.targets.forEach((t, i) => this.assignTarget(t, vals[i] ?? null, env));
        return;
      }
      case 'call': {
        this.eval(s.expr, env);
        return;
      }
      case 'block': {
        this.executeBlock(s.body, env.child());
        return;
      }
      case 'func': {
        const f = this.eval(s.func, env) as LuaClosure;
        env.define(s.name, f);
        return;
      }
      case 'return': {
        const vals = this.evalList(s.exprs, env);
        throw new Ret(vals);
      }
      case 'break': { throw new Brk(); }
      case 'if': {
        if (isTruthy(this.eval(s.cond, env))) return this.executeBlock(s.then, env.child());
        for (const e of s.elseif) if (isTruthy(this.eval(e.cond, env))) return this.executeBlock(e.body, env.child());
        return this.executeBlock(s.els, env.child());
      }
      case 'while': {
        const inner = env.child();
        while (isTruthy(this.eval(s.cond, env))) {
          this.tick();
          try { this.executeBlock(s.body, inner); } catch (e) { if (e instanceof Brk) break; throw e; }
        }
        return;
      }
      case 'repeat': {
        const inner = env.child();
        while (true) {
          this.tick();
          try { this.executeBlock(s.body, inner); } catch (e) { if (e instanceof Brk) break; throw e; }
          if (isTruthy(this.eval(s.cond, env))) return;
        }
        break;
      }
      case 'numfor': {
        const start = this.eval(s.init, env);
        const limit = this.eval(s.limit, env);
        const step0 = s.step ? this.eval(s.step, env) : 1;
        const st = typeof step0 === 'number' ? step0 : 1;
        let i = typeof start === 'number' ? start : 0;
        const lim = typeof limit === 'number' ? limit : 0;
        const inner = env.child();
        inner.define(s.v, i);
        for (; st > 0 ? i <= lim : i >= lim; i += st) {
          this.tick();
          inner.define(s.v, i);
          try { this.executeBlock(s.body, inner); } catch (e) { if (e instanceof Brk) break; throw e; }
        }
        return;
      }
      case 'genfor': {
        const iters = this.evalList(s.exprs, env);
        const inner = env.child();
        for (let idx = 0; idx + 1 < iters.length; idx += 2) {
          const gen = iters[idx] as Callable;
          const state = iters[idx + 1];
          let control: Value = null;
          while (true) {
            this.tick();
            const vals: Value[] = gen.t === 'native' ? gen.fn([state, control]) : [];
            if (vals.length === 0 || (vals[0] ?? null) === null) break;
            control = vals[0];
            s.names.forEach((n, i) => inner.define(n, vals[i] ?? null));
            try { this.executeBlock(s.body, inner); } catch (e) { if (e instanceof Brk) break; throw e; }
          }
        }
        return;
      }
    }
  }
private evalList(exprs: Expr[], env: Env): Value[] {
    const out: Value[] = [];
    for (const e of exprs) out.push(...this.evalFlat(e, env));
    return out;
  }

  private evalArgs(args: Expr[], env: Env): Value[] {
    const out: Value[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (i === args.length - 1) out.push(...this.evalFlat(a, env));
      else out.push(this.eval(a, env));
    }
    return out;
  }

  /** Evaluate an expression, returning all values (only call/method can yield >1). */
  private evalFlat(e: Expr, env: Env): Value[] {
    if (e.k === 'call') return this.executeCall(this.eval(e.func, env), this.evalArgs(e.args, env));
    if (e.k === 'method') {
      const base = this.eval(e.base, env);
      const fn = rawGet(base as LuaTable, e.name);
      return this.executeCall(fn, [base, ...this.evalArgs(e.args, env)]);
    }
    return [this.eval(e, env)];
  }

  private eval(e: Expr, env: Env): Value {
    switch (e.k) {
      case 'nil': return null;
      case 'bool': return e.v;
      case 'num': return e.v;
      case 'str': return e.v;
      case 'vararg': return null;
      case 'name': return env.get(e.v);
      case 'table': {
        const t: LuaTable = { t: 'table', map: new Map(), arr: [] };
        for (const f of e.fields) {
          if (f.key) rawSet(t, this.eval(f.key, env), this.eval(f.value, env));
          else t.arr.push(this.eval(f.value, env));
        }
        return t;
      }
      case 'func': return { t: 'closure', params: e.params, vararg: e.vararg, body: e.body, env };
      case 'index': return rawGet(this.eval(e.base, env) as LuaTable, this.eval(e.key, env));
      case 'unop': return this.evalUnop(e.op, e.e, env);
      case 'binop': return this.evalBinop(e.op, e.l, e.r, env);
      case 'call': return this.executeCall(this.eval(e.func, env), this.evalArgs(e.args, env))[0] ?? null;
      case 'method': {
        const base = this.eval(e.base, env);
        const fn = rawGet(base as LuaTable, e.name);
        return this.executeCall(fn, [base, ...this.evalArgs(e.args, env)])[0] ?? null;
      }
    }
  }

  private evalUnop(op: string, expr: Expr, env: Env): Value {
    const v = this.eval(expr, env);
    if (op === '-') return -this.num(v);
    if (op === '#') return this.lenOf(v as LuaTable);
    if (op === 'not') return !isTruthy(v);
    return null;
  }

  private num(v: Value): number { return typeof v === 'number' ? v : 0; }

  private lenOf(t: LuaTable): number {
    return t && t.t === 'table' ? t.arr.length : tableLenStr(t);
  }

  private evalBinop(op: string, l: Expr, r: Expr, env: Env): Value {
    const a = this.eval(l, env);
    if (op === 'and') return isTruthy(a) ? this.eval(r, env) : a;
    if (op === 'or') return isTruthy(a) ? a : this.eval(r, env);
    const b = this.eval(r, env);
    switch (op) {
      case '+': return this.num(a) + this.num(b);
      case '-': return this.num(a) - this.num(b);
      case '*': return this.num(a) * this.num(b);
      case '/': return this.num(a) / this.num(b);
      case '//': return Math.floor(this.num(a) / this.num(b));
      case '%': return this.num(a) % this.num(b);
      case '^': return Math.pow(this.num(a), this.num(b));
      case '..': return luaToString(a) + luaToString(b);
      case '&': return this.num(a) & this.num(b);
      case '|': return this.num(a) | this.num(b);
      case '~': return this.num(a) ^ this.num(b);
      case '<<': return this.num(a) << this.num(b);
      case '>>': return this.num(a) >> this.num(b);
      case '==': return isTruthy(this.eq(a, b));
      case '~=': return isTruthy(this.eq(a, b)) ? false : true;
      case '<': return (a as any) < (b as any) || this.num(a) < this.num(b);
      case '>': return (a as any) > (b as any) || this.num(a) > this.num(b);
      case '<=': return (a as any) <= (b as any) || this.num(a) <= this.num(b);
      case '>=': return (a as any) >= (b as any) || this.num(a) >= this.num(b);
    }
    return null;
  }

  private eq(a: Value, b: Value): Value {
    if (a === null || b === null) return a === b;
    if ((a as any).t === 'table' && (a as any).t === (b as any).t) return a === b;
    return a === b;
  }

  private assignTarget(t: Expr, value: Value, env: Env): void {
    if (t.k === 'name') { env.set(t.v, value); return; }
    if (t.k === 'index') {
      const base = this.eval(t.base, env) as LuaTable;
      rawSet(base, this.eval(t.key, env), value);
    }
  }

  private executeCall(fn: Value, args: Value[]): Value[] {
    if (fn === null) throw new LuaError('attempt to call a nil value');
    if ((fn as Callable).t !== 'native' && (fn as Callable).t !== 'closure') {
      // allow calling a table that has __call? skip: error
      throw new LuaError('attempt to call a non-function value');
    }
    if ((fn as Callable).t === 'native') return (fn as NativeFn).fn(args) ?? [];
    const c = fn as LuaClosure;
    const callEnv = c.env.child();
    c.params.forEach((p, i) => callEnv.define(p, args[i] ?? null));
    if (c.vararg) callEnv.define('...', { t: 'table', map: new Map(), arr: args.slice(c.params.length) });
    try {
      this.executeBlock(c.body, callEnv);
    } catch (e) {
      if (e instanceof Brk) throw new LuaError("'break' outside loop");
      if (e instanceof Ret) return e.values;
      throw e;
    }
    return [];
  }
}

function tableLenStr(x: Value): number {
  if (typeof x === 'string') return x.length;
  return 0;
}

export function luaToString(v: Value): string {
  if (v === null) return 'nil';
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'number') return Number.isInteger(v) && Math.abs(v) < 1e15 ? String(v) : String(v);
  if (typeof v === 'string') return v;
  if ((v as any).t === 'table') {
    const t = v as LuaTable;
    const parts: string[] = t.arr.map((x) => luaToString(x));
    t.map.forEach((val, key) => {
      parts.push(`[${luaToString(key)}]=${luaToString(val)}`);
    });
    return `{${parts.join(',')}}`;
  }
  if ((v as any).t === 'closure') return `function(${((v as LuaClosure).params).join(',')})`;
  return `function:${(v as NativeFn).name}`;
}

function rawSet(t: LuaTable, k: Value, val: Value): void {
  if (typeof k === 'number' && Number.isInteger(k) && k >= 1) {
    const i = k;
    while (t.arr.length < i) t.arr.push(null);
    t.arr[i - 1] = val;
    return;
  }
  t.map.set(k, val);
}

function rawGet(t: LuaTable, k: Value): Value {
  if (!t || t.t !== 'table') return null;
  if (typeof k === 'number' && Number.isInteger(k) && k >= 1) return t.arr[k - 1] ?? null;
  if (t.map.has(k)) return t.map.get(k)!;
  return null;
}

function nextImpl(t: LuaTable, control: Value): Value[] {
  if (t === null) return [];
  if (control === null) {
    // first: array elements
    if (t.arr.length > 0) return [1, t.arr[0]];
    if (t.map.size > 0) {
      const first = t.map.entries().next().value;
      if (first) return [first[0], first[1]];
      return [];
    }
    return [];
  }
  if (typeof control === 'number' && Number.isInteger(control) && control >= 1 && control < t.arr.length) {
    return [control + 1, t.arr[control]];
  }
  // map exaustion
  const keys = [...t.map.keys()];
  const idx = keys.findIndex((kk) => kk === control);
  if (idx !== -1 && idx + 1 < keys.length) {
    const nk = keys[idx + 1]!;
    return [nk, t.map.get(nk)!];
  }
  // past array then into map
  return [];
}

function makeIpairs(array: Value): Value[] {
  const arr = (array as LuaTable)?.t === 'table' ? (array as LuaTable).arr : [];
  const iter: NativeFn = {
    t: 'native', name: 'ipairs-iter', fn: (args) => {
      const i = typeof args[1] === 'number' ? args[1] : 0;
      const next = i + 1;
      if (next > arr.length) return [null];
      return [next, arr[next - 1]];
    },
  };
  return [iter, array, 0];
}

function makePairs(tbl: Value): Value[] {
  const t: LuaTable = (tbl as LuaTable)?.t === 'table' ? tbl as LuaTable : { t: 'table', map: new Map(), arr: [] };
  const iter: NativeFn = {
    t: 'native', name: 'pairs-iter', fn: (args) => nextImpl(t, args[1] ?? null),
  };
  return [iter, t];
}

/**
 * Execute a LuaScript source string. `api` is exposed to the script as the
 * global `ide` table; `out` collects console/log output. Returns a structured
 * result for callers.
 */
export function executeLua(source: string, api: JsApi, out: LuaOutput): { ok: boolean; error?: string } {
  try {
    const interp = new Interpreter(api, out);
    interp.run(source, 'extension.lua');
    return { ok: true };
  } catch (e) {
    const msg = e instanceof LuaError ? e.message : String((e as Error).message ?? e);
    return { ok: false, error: msg };
  }
}