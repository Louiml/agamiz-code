import { LanguageDef } from '../../languages/types';
import { RAK_COMPLETION } from './completion';

/**
 * The Rak programming language, contributed to Agamiz Code by the bundled
 * "Rak" extension. Keeping all Rak-specific lexical data here (instead of in
 * the editor core) lets Agamiz Code stay language-agnostic: enabling the Rak
 * extension registers `.rak` files, syntax highlighting, autocomplete
 * suggestions, examples, and the `rakc`/`rakpkg` run integration.
 */

/** Keywords that the generic registry should highlight. */
export const RAK_KEYWORDS = [
  'scan', 'fetch', 'dump', 'trace', 'loop', 'if', 'else', 'fn', 'let', 'mut',
  'return', 'use', 'mod', 'pub', 'struct', 'enum', 'impl', 'match', 'for',
  'while', 'break', 'continue', 'true', 'false', 'nil', 'in',
  'try', 'catch', 'raise', 'throw', 'trait', 'async', 'await', 'spawn', 'as', 'type',
  'import', 'from', 'export', 'macro', 'macro_rules', 'const', 'extern',
  'binstruct', 'evidence', 'tunnel', 'defer', 'test', 'assert',
];

/** Rak primitive + structured type names. */
export const RAK_TYPES = [
  'hex8', 'hex16', 'hex32', 'hex64', 'int', 'string', 'char', 'bytes', 'bool',
  'i8', 'i16', 'i32', 'i64', 'u8', 'u16', 'u32', 'u64', 'f32', 'f64',
  'Option', 'Result', 'void',
];

/** Rak standard-library function names. */
export const RAK_BUILTINS = [
  'fmt', 'md5', 'sha1', 'sha256', 'xor', 'rot13', 'hex_encode', 'hex_decode',
  'base64_encode', 'base64_decode', 'url_encode', 'url_decode', 'dns_lookup',
  'subdomain_enum', 'reverse_dns', 'len', 'split', 'join', 'contains',
  'to_hex', 'from_hex', 'int', 'string', 'bytes', 'float', 'upper', 'lower', 'trim',
  'push', 'read', 'write', 'array', 'map', 'keys', 'values', 'has', 'get', 'sort',
  'file_read', 'file_write', 'file_append', 'file_exists', 'file_size',
  'file_list', 'file_delete', 'file_mkdir', 'file_copy', 'file_rename',
  'file_ext', 'file_basename', 'file_dirname',
  'html_title', 'html_select', 'html_select_all', 'html_attr', 'html_links',
  'html_images', 'html_scripts', 'html_forms', 'html_inputs', 'html_meta',
  'html_count', 'html_headers',
  'json_parse', 'json_get', 'json_path', 'json_keys', 'json_len', 'json_find_all',
  'scan_ports', 'scan_subdomains',
  'regex_new', 'regex_match', 'regex_is_match', 'regex_find', 'regex_find_all', 'regex_replace',
  'net_listen', 'net_accept', 'net_connect', 'net_local_addr',
  'tcp_read', 'tcp_write', 'tcp_read_line', 'tcp_close',
  'spawn', 'thread_join', 'channel', 'chan_send', 'chan_recv',
  'sleep', 'now_ms', 'args', 'env_get', 'ord', 'chr', 'substr', 'print', 'dbg', 'exit',
  'Some', 'None', 'Ok', 'Err',
  // FFI
  'ffi_load', 'ffi_ptr', 'ffi_alloc', 'ffi_free', 'ffi_write', 'ffi_read',
  'ffi_read_i32', 'ffi_cstr_to_string', 'ffi_string_to_cstr', 'ffi_call',
  // Memory-mapped files
  'mmap_open', 'mmap_slice', 'mmap_size', 'mmap_close', 'mmap_find',
  'mmap_lines', 'mmap_lines_off',
  // Raw sockets
  'net_raw_csum', 'net_raw_ipv4', 'net_raw_tcp', 'net_raw_udp',
  'net_raw_tcp_syn', 'net_raw_send', 'net_raw_recv',
  // Protocol parsers
  'dns_query', 'dns_build', 'dns_parse',
  'tls_parse_client_hello', 'tls_parse_cert_chain',
  'pcap_open', 'pcap_next',
  // Async I/O
  'http_get_async', 'tcp_probe', 'tcp_connect_async',
  // VPN / encrypted tunneling
  'x25519_keypair', 'x25519_shared',
  'chacha20_encrypt', 'chacha20_decrypt',
  'tunnel_preshared_key', 'kdf_next',
  'tunnel_frame', 'tunnel_unframe', 'tunnel_nonce',
  'udp_bind', 'udp_send', 'udp_recv', 'udp_local_addr',
  // Structured errors (v0.7)
  'error', 'err_message', 'err_kind', 'err_line', 'err_col', 'err_file',
  'err_cause', 'err_context', 'err_with_context',
  // Async concurrency (v0.7)
  'await_all', 'select', 'timeout', 'task_group', 'async_sleep', 'async_yield',
  // Streaming (v0.7)
  'stream_from_array', 'stream_map', 'stream_next', 'filter', 'take', 'collect',
  'read_lines', 'tcp_stream', 'stream_csv', 'stream_jsonl', 'parse_csv_line',
  // CLI (v0.7)
  'argv', 'stdin_read_line', 'stdin_read_all', 'eprint', 'parse_args',
  // Data processing (v0.7)
  'gzip', 'gunzip', 'deflate', 'inflate', 'zip_archive', 'zip_list', 'zip_extract',
  // Stdlib batteries (v0.7.2)
  'time_now', 'time_now_millis', 'time_fmt', 'time_parse', 'time_parts',
  'time_add', 'time_diff', 'date_today',
  'rand_seed', 'rand_int', 'rand_float', 'rand_bytes', 'rand_hex',
  'rand_choice', 'rand_shuffle',
  'csv_parse', 'csv_stringify', 'yaml_parse',
  'gzip_compress', 'gzip_decompress', 'zip_read', 'zip_write',
  // OSINT pack (v0.7.2)
  'whois_lookup', 'whois_parse', 'ct_subdomains', 'yara_scan', 'report_markdown',
];

/** Literal-ish constants the registry should highlight distinctly. */
export const RAK_CONSTANTS = ['true', 'false', 'nil', 'Some', 'None', 'Ok', 'Err', 'self', 'this'];

/**
 * Data-driven definition the generic registry uses for `.rak` files. This is
 * what gets registered when the Rak extension is activated.
 */
export const RAK_LANGUAGE: LanguageDef = {
  id: 'rak',
  name: 'Rak',
  extensions: ['rak'],
  lineComments: ['//'],
  blockComments: [],
  strings: [{ open: '"' }, { open: '"', prefix: 'f', template: true }, { open: '"', prefix: 'b' }],
  charQuote: "'",
  regexLiteral: true,
  macroVar: true,
  hexPrefixes: ['0x', '0X'],
  binaryPrefixes: ['0b', '0B'],
  octalPrefixes: ['0o', '0O'],
  numberSuffixes: ['i8', 'i16', 'i32', 'i64', 'u8', 'u16', 'u32', 'u64', 'f32', 'f64'],
  keywords: RAK_KEYWORDS,
  types: RAK_TYPES,
  builtins: RAK_BUILTINS,
  constants: RAK_CONSTANTS,
  completion: RAK_COMPLETION,
};