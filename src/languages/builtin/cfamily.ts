import { LanguageDef } from '../types';
import { C_COMPLETION, CPP_COMPLETION, CSHARP_COMPLETION } from './completions';

const C_KEYWORDS = [
  'auto','break','case','char','const','continue','default','do','double',
  'else','enum','extern','float','for','goto','if','inline','int','long',
  'register','restrict','return','short','signed','sizeof','static','struct',
  'switch','typedef','union','unsigned','void','volatile','while',
];
const CPP_KEYWORDS = [
  ...C_KEYWORDS,
  'alignas','alignof','and','asm','bitand','bitor','bool','catch','class',
  'concept','constexpr','const_cast','decltype','delete','dynamic_cast',
  'explicit','export','false','final','friend','mutable','namespace','new',
  'noexcept','not','nullptr','operator','or','override','private','protected',
  'public','reinterpret_cast','requires','static_assert','static_cast',
  'template','this','throw','true','try','typeid','typename','using','virtual',
  'wchar_t','xor',
];

export const cDef: LanguageDef = {
  id: 'c',
  name: 'C',
  extensions: ['c', 'h'],
  lineComments: ['//'],
  blockComments: [['/*', '*/']],
  strings: [{ open: '"', template: false }],
  charQuote: "'",
  keywords: C_KEYWORDS,
  builtins: [
    'printf','scanf','fprintf','sprintf','malloc','calloc','realloc','free',
    'fopen','fclose','fread','fwrite','fgets','fputs','puts','getchar',
    'putchar','strlen','strcpy','strcat','memcpy','memset','sizeof',
  ],
  types: ['int','char','float','double','long','short','unsigned','signed','void','size_t'],
  constants: ['true','false','NULL'],
  hexPrefixes: ['0x', '0X'],
  binaryPrefixes: ['0b', '0B'],
  macroVar: true,
  completion: C_COMPLETION,
};

export const cppDef: LanguageDef = {
  id: 'cpp',
  name: 'C++',
  extensions: ['cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx'],
  lineComments: ['//'],
  blockComments: [['/*', '*/']],
  strings: [{ open: '"', template: false }],
  charQuote: "'",
  keywords: CPP_KEYWORDS,
  builtins: ['std','cout','cin','cerr','clog','endl','printf','vector','map','string'],
  types: [
    'int','char','float','double','bool','long','short','unsigned','signed',
    'void','wchar_t','size_t','uint8_t','int8_t','uint16_t','int16_t',
    'uint32_t','int32_t','uint64_t','int64_t','string',
  ],
  constants: ['true','false','nullptr','NULL'],
  hexPrefixes: ['0x', '0X'],
  binaryPrefixes: ['0b', '0B'],
  macroVar: true,
  completion: CPP_COMPLETION,
};

export const csharpDef: LanguageDef = {
  id: 'csharp',
  name: 'C#',
  extensions: ['cs'],
  lineComments: ['//'],
  blockComments: [['/*', '*/']],
  strings: [
    { open: '"', template: false },
    { open: '$"', template: false },
    { open: '"""', template: false },
  ],
  charQuote: "'",
  keywords: [
    'abstract','as','base','bool','break','byte','case','catch','char',
    'checked','class','const','continue','decimal','default','delegate','do',
    'double','else','enum','event','explicit','extern','false','finally','fixed',
    'float','for','foreach','goto','if','implicit','in','int','interface',
    'internal','is','lock','long','namespace','new','null','object','operator',
    'out','override','params','private','protected','public','readonly','ref',
    'return','sbyte','sealed','short','sizeof','stackalloc','static','string',
    'struct','switch','this','throw','true','try','typeof','uint','ulong',
    'unchecked','unsafe','ushort','using','virtual','void','volatile','while',
    'async','await','var','record','init','required',
  ],
  builtins: ['Console','Math','String','List','Dictionary','Enumerable','Task'],
  types: [
    'int','long','short','byte','sbyte','uint','ulong','ushort','float',
    'double','decimal','bool','char','string','object','void',
  ],
  constants: ['true','false','null','this','base'],
  hexPrefixes: ['0x', '0X'],
  binaryPrefixes: ['0b', '0B'],
  numberSuffixes: ['f','F','m','M','d','D','l','L','u','U'],
  macroVar: false,
  completion: CSHARP_COMPLETION,
};