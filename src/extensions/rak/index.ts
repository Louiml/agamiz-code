import { ExtensionManifest } from '../types';
import { RAK_LANGUAGE } from './language';
import { RAK_REGISTRY_SNIPPETS } from './snippets';

/**
 * The bundled "Rak" extension for Agamiz Code.
 *
 * Activating this extension registers the Rak language definition (so `.rak`
 * files get a language id and tokenization hints), its autocomplete snippets,
 * a status-bar indicator, and (via `src/extensions/rak/examples.ts` and
 * `docs.ts`) the example gallery and reference documentation. The editor and
 * the rest of Agamiz Code remain language-agnostic.
 */
export const rakExtension: ExtensionManifest = {
  id: 'rak',
  name: 'Rak',
  version: '0.7.2',
  description:
    'Rak programming language support: syntax highlighting data, snippets, examples, docs, and the rakc/rakpkg toolchain integration.',
  languages: [RAK_LANGUAGE],
  activate: (ctx) => {
    ctx.registerSnippets('rak', RAK_REGISTRY_SNIPPETS);
    ctx.registerStatusBarItem({
      id: 'rak.status',
      text: () => 'Rak',
      alignment: 'left',
      priority: 10,
    });
  },
};