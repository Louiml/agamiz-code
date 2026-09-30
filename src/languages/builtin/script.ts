import { LanguageDef } from '../types';
import { JS_COMPLETION, TS_COMPLETION } from './completions';

const JS_KEYWORDS = [
  'break','case','catch','class','const','continue','debugger','default','delete',
  'do','else','export','extends','finally','for','function','if','import','in',
  'instanceof','let','new','of','return','static','super','switch','throw','try',
  'typeof','var','void','while','with','yield','async','await','interface','type',
  'enum','implements','private','protected','public','readonly','namespace',
  'module','declare','abstract','as','keyof','infer','is','satisfies',
];
const JS_TYPES = [
  'string','number','boolean','object','Array','Record','Promise','Function',
  'Symbol','bigint','void','any','unknown','never','object',
];
const JS_BUILTINS = [
  'console','JSON','Math','Date','String','Number','Boolean','Object','Array',
  'Symbol','BigInt','parseInt','parseFloat','setTimeout','setInterval',
  'clearTimeout','clearInterval','fetch','queueMicrotask','alert','print',
];
const JS_CONSTANTS = ['true','false','null','undefined','NaN','Infinity','this','globalThis'];
const JS_STRINGS = [
  { open: '"', template: false },
  { open: "'", template: false },
  { open: '`', template: true },
];
// Symmetric open/close pairs, built with `repeat` rather than written as
// literals so the delimiters cannot be misread or miscounted. The old
// `string[]` shape forced one text to serve as both the open and the close,
// which is what let a bare quote anywhere open a string that never terminated
// and swallow the rest of the file.
const DQ3 = '"'.repeat(3);
const SQ3 = "'".repeat(3);
const JS_TRIPLE = [
  { open: DQ3, close: DQ3 },
  { open: SQ3, close: SQ3 },
];

export const jsDefs: LanguageDef[] = [
  {
    id: 'javascript',
    name: 'JavaScript',
    extensions: ['js', 'mjs', 'cjs', 'jsx'],
    lineComments: ['//'],
    blockComments: [['/*', '*/']],
    strings: JS_STRINGS,
    charQuote: "'",
    keywords: JS_KEYWORDS,
    builtins: JS_BUILTINS,
    types: JS_TYPES,
    constants: JS_CONSTANTS,
    hexPrefixes: ['0x', '0X'],
    binaryPrefixes: ['0b', '0B'],
    octalPrefixes: ['0o', '0O'],
    regexLiteral: true,
    tripleQuotes: JS_TRIPLE,
    completion: JS_COMPLETION,
  },
  {
    id: 'typescript',
    name: 'TypeScript',
    extensions: ['ts', 'mts', 'cts', 'tsx'],
    lineComments: ['//'],
    blockComments: [['/*', '*/']],
    strings: JS_STRINGS,
    charQuote: "'",
    keywords: JS_KEYWORDS,
    builtins: JS_BUILTINS,
    types: [...JS_TYPES, 'void', 'never', 'unknown'],
    constants: JS_CONSTANTS,
    hexPrefixes: ['0x', '0X'],
    binaryPrefixes: ['0b', '0B'],
    octalPrefixes: ['0o', '0O'],
    regexLiteral: true,
    tripleQuotes: JS_TRIPLE,
    completion: TS_COMPLETION,
  },
];
