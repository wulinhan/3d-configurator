// The bundled typeface registry for 3D text (see ../fonts/README.md).
//
// Font data is heavy (26–63 KB per face), so each face lives behind a
// dynamic import: Vite splits them into chunks the Studio only fetches when
// a manifest actually uses text; the single-file embed build inlines them.
// Parsed fonts are cached — a font is parsed once per page, ever.

import { FontLoader, Font } from 'three/examples/jsm/loaders/FontLoader.js';
import type { TextFont } from '../manifest/types.ts';

export const FONT_CHOICES: Array<{ id: TextFont; label: string }> = [
  { id: 'sans-bold', label: 'Sans bold' },
  { id: 'sans', label: 'Sans' },
  { id: 'droid-sans-bold', label: 'Soft sans bold' },
  { id: 'serif', label: 'Serif' },
  { id: 'serif-bold', label: 'Serif bold' },
];

/** Bold survives extrusion and printing best — thin strokes snap off. */
export const DEFAULT_FONT: TextFont = 'sans-bold';

const LOADERS: Record<TextFont, () => Promise<{ default: unknown }>> = {
  'sans': () => import('../fonts/sans.ts'),
  'sans-bold': () => import('../fonts/sans-bold.ts'),
  'droid-sans-bold': () => import('../fonts/droid-sans-bold.ts'),
  'serif': () => import('../fonts/serif.ts'),
  'serif-bold': () => import('../fonts/serif-bold.ts'),
};

const cache = new Map<TextFont, Promise<Font>>();

export function loadFont(id: TextFont): Promise<Font> {
  let font = cache.get(id);
  if (!font) {
    const load = LOADERS[id] ?? LOADERS[DEFAULT_FONT];
    font = load().then((mod) => new FontLoader().parse(mod.default as Parameters<FontLoader['parse']>[0]));
    cache.set(id, font);
  }
  return font;
}
