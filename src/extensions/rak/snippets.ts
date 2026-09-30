import { Snippet } from '../types';

/**
 * Rak editor snippets (autocomplete fragments). Moved out of the core editor
 * into the Rak extension so the editor stays language-agnostic.
 */
export interface RakSnippet {
  trigger: string;
  label: string;
  body: string;
}

/** Snippets in the editor's compact `trigger/label/body` shape. */
export const RAK_SNIPPETS: RakSnippet[] = [
  { trigger: 'fn', label: 'function', body: 'fn name(params) {\n    \n}' },
  { trigger: 'if', label: 'if', body: 'if cond {\n    \n}' },
  { trigger: 'for', label: 'for', body: 'for item in iterable {\n    \n}' },
  { trigger: 'while', label: 'while', body: 'while cond {\n    \n}' },
  { trigger: 'match', label: 'match', body: 'match value {\n    pattern => {\n        \n    },\n    _ => {}\n}' },
  { trigger: 'matchb', label: 'match bytes', body: 'match data {\n    [0x89, ..] => {\n        \n    },\n    _ => {}\n}' },
  { trigger: 'struct', label: 'struct', body: 'struct Name {\n    field: type\n}' },
  { trigger: 'enum', label: 'enum', body: 'enum Name {\n    Variant\n}' },
  { trigger: 'let', label: 'let', body: 'let name = value' },
  { trigger: 'pipe', label: 'pipeline', body: 'value |> fn' },
  { trigger: 'regex', label: 'regex literal', body: '/\\d+/g' },
  { trigger: 'impld', label: 'impl Display', body: 'impl Display for Name {\n    fn fmt(self) {\n        return fmt("{}", self)\n    }\n}' },
  { trigger: 'impli', label: 'impl Iterable', body: 'impl Iterable for Name {\n    fn iter(self) {\n        return []\n    }\n}' },
  { trigger: 'implx', label: 'impl Index', body: 'impl Index for Name {\n    fn index(self, key) {\n        return self.data[key]\n    }\n}' },
  { trigger: 'import', label: 'import module', body: 'import module' },
  { trigger: 'from', label: 'from import', body: 'from module import name' },
  { trigger: 'export', label: 'export fn', body: 'export fn name(params) {\n    \n}' },
  { trigger: 'macro', label: 'macro', body: 'macro name(x: expr) {\n    $x\n}' },
  { trigger: 'extern', label: 'extern C', body: 'extern "C" {\n    fn name(args) -> i32\n}' },
  { trigger: 'const', label: 'const', body: 'const NAME = value' },
  { trigger: 'async', label: 'async fn', body: 'async fn name(args) {\n    let r = await expr\n    return r\n}' },
  { trigger: 'mmap', label: 'mmap open', body: 'let m = mmap_open("file", "r")\ndump mmap_size(m)' },
  { trigger: 'netraw', label: 'net_raw SYN', body: 'let pkt = net_raw_tcp_syn("10.0.0.1", "10.0.0.2", 12345, 80)\ndump len(pkt)' },
  { trigger: 'ffi', label: 'ffi_load', body: 'let lib = ffi_load("libc.so.6")\ndump lib.call("abs", [-9])' },
  { trigger: 'dns', label: 'dns_query', body: 'dump dns_query("example.com", "A")' },
  { trigger: 'tunnel', label: 'tunnel block', body: 'tunnel link "passphrase" {\n    \n}' },
  { trigger: 'x25519', label: 'x25519 keypair', body: 'let keys = x25519_keypair(seed)\ndump hex_encode(keys.0)' },
  { trigger: 'chacha', label: 'chacha20 encrypt', body: 'let ct = chacha20_encrypt(key, tunnel_nonce(1), b"aad", b"data")' },
  { trigger: 'udp', label: 'udp bind', body: 'let t = udp_bind("127.0.0.1:8001")\nlet sock = t.0\nlet addr = t.1' },
  { trigger: 'main', label: 'fn main entry', body: 'fn main(argv) -> int {\n    dump argv\n    return 0\n}' },
  { trigger: 'awaitall', label: 'await_all futures', body: 'let results = await_all([f1, f2, f3])\ndump results' },
  { trigger: 'taskgroup', label: 'task_group (bounded)', body: 'let results = task_group([fn1, fn2, fn3], 4)\ndump results' },
  { trigger: 'timeout', label: 'timeout future', body: 'let r = timeout(future, 500)  // Ok(value) | Err(...)\ndump r' },
  { trigger: 'stream', label: 'stream pipeline', body: 'let s = stream_from_array([1, 2, 3])\nlet s2 = stream_map(s, fn(x) { return x * 2 })\ndump collect(take(s2, 2))' },
  { trigger: 'readlines', label: 'read_lines', body: 'for line in read_lines("file.txt") {\n    dump line\n}' },
  { trigger: 'csv', label: 'stream_csv', body: 'for row in stream_csv("data.csv", {}) {\n    dump row\n}' },
  { trigger: 'errh', label: 'structured error', body: 'try {\n    raise "boom"\n} catch e {\n    dump err_kind(e)\n    dump err_message(e)\n    dump err_line(e)\n}' },
  { trigger: 'parseargs', label: 'parse_args', body: 'let args = parse_args({ verbose: "bool", out: "string" }, argv())\ndump args' },
  { trigger: 'gzip', label: 'gzip / zip', body: 'let z = gzip(b"data")\ndump gunzip(z)\ndump zip_list(zip_archive({ "a.txt": b"hello" }))' },
];

/** Rak snippets in the extension-registry `label/prefix/body` shape. */
export const RAK_REGISTRY_SNIPPETS: Snippet[] = RAK_SNIPPETS.map((s) => ({
  label: s.label,
  prefix: s.trigger,
  body: s.body,
  description: `Rak snippet: ${s.trigger}`,
}));