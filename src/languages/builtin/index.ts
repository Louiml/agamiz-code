import { registerLanguage } from '../registry';
import { plainSpecials } from './specials';
import { jsDefs } from './script';
import { pythonDef, luaDef } from './pythonlua';
import { rustDef, goDef, javaDef } from './systemlangs';
import { cDef, cppDef, csharpDef } from './cfamily';
import { htmlDef, cssDef } from './web';

const BUILTIN_LANGUAGES = [
  ...plainSpecials,
  ...jsDefs,
  pythonDef,
  luaDef,
  rustDef,
  goDef,
  javaDef,
  cDef,
  cppDef,
  csharpDef,
  htmlDef,
  cssDef,
];

/**
 * Register all bundled (non-Rak) languages. The Rak language itself is
 * contributed at runtime by the bundled "Rak" extension (see
 * `src/extensions/rak/`), so that the core IDE stays language-agnostic.
 */
export function registerBuiltinLanguages() {
  for (const def of BUILTIN_LANGUAGES) registerLanguage(def);
}