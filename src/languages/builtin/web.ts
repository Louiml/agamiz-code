import { LanguageDef } from '../types';
import { CSS_COMPLETION, HTML_COMPLETION } from './completions';

export const htmlDef: LanguageDef = {
  id: 'html',
  name: 'HTML',
  extensions: ['html', 'htm'],
  lineComments: ['<!--'],
  blockComments: [['<!--', '-->']],
  strings: [
    { open: '"', template: false },
    { open: "'", template: false },
  ],
  keywords: [
    'html','head','body','script','style','div','span','p','a','ul','ol','li',
    'table','tr','td','th','form','input','button','select','option','img',
    'br','hr','h1','h2','h3','h4','h5','h6','header','footer','nav','section',
    'article','aside','main','meta','link','title','svg','path','canvas',
    'video','audio','iframe','pre','code','strong','em','label','textarea',
    'template','dialog','details','summary','doctype',
  ],
  builtins: [],
  types: [],
  constants: [],
  markup: true,
  completion: HTML_COMPLETION,
};

export const cssDef: LanguageDef = {
  id: 'css',
  name: 'CSS',
  extensions: ['css', 'scss', 'less'],
  lineComments: ['//'],
  blockComments: [['/*', '*/']],
  strings: [
    { open: '"', template: false },
    { open: "'", template: false },
  ],
  keywords: [],
  builtins: [
    'import','url','var','calc','rgb','rgba','hsl','hsla','min','max','clamp',
    'repeat','attr','counter','env','minmax','fit-content',
  ],
  types: [],
  constants: ['inherit','initial','unset','revert','auto','none','transparent','currentColor'],
  propertyColon: true,
  completion: CSS_COMPLETION,
};
