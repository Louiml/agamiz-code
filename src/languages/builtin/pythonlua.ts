import { LanguageDef } from '../types';
import { LUA_COMPLETION, PYTHON_COMPLETION } from './completions';

export const pythonDef: LanguageDef = {
  id: 'python',
  name: 'Python',
  extensions: ['py', 'pyw'],
  lineComments: ['#'],
  blockComments: [],
  strings: [
    { open: '"', template: false },
    { open: "'", template: false },
  ],
  charQuote: "'",
  keywords: [
    'and','as','assert','async','await','break','class','continue','def','del',
    'elif','else','except','finally','for','from','global','if','import','in',
    'is','lambda','nonlocal','not','or','pass','raise','return','try','while',
    'with','yield','match','case',
  ],
  builtins: [
    'print','len','range','str','int','float','bool','list','dict','set',
    'tuple','enumerate','zip','map','filter','sorted','sum','min','max','abs',
    'type','repr','input','open','super','isinstance','hasattr','getattr',
    'setattr','round','format','reversed','all','any','next','iter','vars',
  ],
  types: ['Self','Type','Any','Optional','List','Dict','Set','Tuple'],
  constants: ['True','False','None','self','cls'],
  hexPrefixes: ['0x', '0X'],
  binaryPrefixes: ['0b', '0B'],
  octalPrefixes: ['0o', '0O'],
  tripleQuotes: ['"""', "'''"],
  propertyColon: false,
  completion: PYTHON_COMPLETION,
};

export const luaDef: LanguageDef = {
  id: 'lua',
  name: 'Lua',
  extensions: ['lua', 'luau'],
  lineComments: ['--'],
  blockComments: [['--[[', ']]']],
  strings: [
    { open: '"', template: false },
    { open: "'", template: false },
  ],
  charQuote: "'",
  keywords: [
    'and','break','do','else','elseif','end','false','for','function','goto',
    'if','in','local','nil','not','or','repeat','return','then','true','until',
    'while',
  ],
  builtins: [
    'print','type','tostring','tonumber','pairs','ipairs','next','error',
    'assert','select','rawget','rawset','setmetatable','getmetatable','pcall',
    'xpcall','require','load','collectgarbage','dofile',
  ],
  types: [],
  constants: ['true', 'false', 'nil', 'self'],
  hexPrefixes: ['0x', '0X'],
  tripleQuotes: ['[==[', ']]'],
  macroVar: false,
  completion: LUA_COMPLETION,
};