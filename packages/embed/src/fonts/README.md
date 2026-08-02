# Bundled typefaces

Typeface-JSON fonts for the 3D text feature, generated from the three.js
example fonts (r185) and trimmed to printable ASCII (32–126) — roughly a
fifth of their original size. Each is a TS module so every consumer
(esbuild, Vite, node --experimental-strip-types) loads it the same way.

| id              | family          | licence            |
|-----------------|-----------------|--------------------|
| sans            | Helvetiker      | three.js examples  |
| sans-bold       | Helvetiker Bold | three.js examples  |
| droid-sans-bold | Droid Sans Bold | Apache License 2.0 |
| serif           | Gentilis        | SIL OFL 1.1        |
| serif-bold      | Gentilis Bold   | SIL OFL 1.1        |

The runtime registry (`src/runtime/fonts.ts`) lazy-imports these per font id
— Vite splits them into chunks the Studio only fetches when a manifest uses
text; the single-file embed build inlines them.
