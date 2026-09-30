import { LanguageDef } from '../types';
import { GO_COMPLETION, JAVA_COMPLETION, RUST_COMPLETION } from './completions';

export const rustDef: LanguageDef = {
  id: 'rust',
  name: 'Rust',
  extensions: ['rs'],
  lineComments: ['//'],
  blockComments: [['/*', '*/']],
  strings: [
    { open: '"', template: false },
    { open: 'b"', template: false },
    // Raw strings. `close` is mandatory here: with no `close`, the tokenizer
    // used the *opener* as the terminator and searched for another `r#"`, so
    // every raw string ran to end-of-line and turned the rest of the file into
    // a string. `r##"` needs a hash count to match, which a static table cannot
    // express, so only the single-hash form is covered.
    { open: 'r#"', close: '"#', template: false },
  ],
  charQuote: "'",
  keywords: [
    'as','async','await','break','const','continue','crate','dyn','else','enum',
    'extern','false','fn','for','if','impl','in','let','loop','match','mod',
    'move','mut','pub','ref','return','self','Self','static','struct','super',
    'trait','true','type','unsafe','use','where','while',
  ],
  builtins: ['println','print','eprintln','eprint','format','vec','dbg','Some','None','Ok','Err'],
  types: [
    'i8','i16','i32','i64','i128','u8','u16','u32','u64','u128','f32','f64',
    'isize','usize','bool','char','str','String','Vec','Option','Result','Box',
  ],
  constants: ['true','false','None','Some','Ok','Err'],
  hexPrefixes: ['0x', '0X'],
  binaryPrefixes: ['0b', '0B'],
  octalPrefixes: ['0o', '0O'],
  numberSuffixes: ['u8','u16','u32','u64','i8','i16','i32','i64','f32','f64','usize','isize'],
  macroVar: true,
  completion: RUST_COMPLETION,
};

export const goDef: LanguageDef = {
  id: 'go',
  name: 'Go',
  extensions: ['go'],
  lineComments: ['//'],
  blockComments: [['/*', '*/']],
  strings: [
    { open: '"', template: false },
    { open: '`', template: true },
    { open: 'r"', template: false },
  ],
  charQuote: "'",
  keywords: [
    'break','case','chan','const','continue','default','defer','else',
    'fallthrough','for','func','go','goto','if','import','interface','map',
    'package','range','return','select','struct','switch','type','var',
  ],
  builtins: ['make','new','len','cap','append','copy','delete','panic','recover','print','println','printf'],
  types: [
    'int','int8','int16','int32','int64','uint','uint8','uint16','uint32',
    'uint64','uintptr','float32','float64','complex64','complex128','bool',
    'byte','rune','string','error','any',
  ],
  constants: ['true','false','nil','iota'],
  hexPrefixes: ['0x', '0X'],
  binaryPrefixes: ['0b', '0B'],
  octalPrefixes: ['0o', '0O'],
  macroVar: false,
  completion: GO_COMPLETION,
};

export const javaDef: LanguageDef = {
  id: 'java',
  name: 'Java',
  extensions: ['java'],
  lineComments: ['//'],
  blockComments: [['/*', '*/']],
  strings: [{ open: '"', template: false }],
  charQuote: "'",
  keywords: [
    'abstract','assert','break','case','catch','class','const','continue',
    'default','do','else','enum','extends','final','finally','for','if',
    'implements','import','instanceof','interface','native','new','package',
    'private','protected','public','return','static','strictfp','super',
    'switch','synchronized','this','throw','throws','transient','try','void',
    'volatile','while','var','record','sealed','permits','yield',
  ],
  builtins: ['System','Math','String','Integer','Double','Boolean','List','ArrayList','Map','HashMap','Set','HashSet','Objects'],
  types: ['int','long','short','byte','float','double','boolean','char','String','Object','Void'],
  constants: ['true','false','null','this','super'],
  hexPrefixes: ['0x', '0X'],
  binaryPrefixes: ['0b', '0B'],
  numberSuffixes: ['L','l','f','F','d','D'],
  macroVar: false,
  completion: JAVA_COMPLETION,
};