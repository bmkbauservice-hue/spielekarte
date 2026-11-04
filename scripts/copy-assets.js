// Kopiert Schriften (aus @fontsource, nur lateinischer Zeichensatz) und das MKDIR-Logo nach src/public/static/.
// Einmal ausführen, Ergebnis wird committet – so braucht das Docker-Image keine Font-Pakete
// und der Browser lädt nichts von Google (Datenschutz).
//
//   npm run assets                               (Logo aus ../mkdir-digital/public/logo-mkdir.webp)
//   node scripts/copy-assets.js /pfad/zum/logo.webp

import { copyFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const fontsOut = join(root, 'src/public/static/fonts');
const imgOut = join(root, 'src/public/static/img');
mkdirSync(fontsOut, { recursive: true });
mkdirSync(imgOut, { recursive: true });

const FONTS = [
  { pkg: 'cormorant-garamond', family: 'Cormorant Garamond', weights: [600, 700] },
  { pkg: 'hanken-grotesk', family: 'Hanken Grotesk', weights: [400, 600, 700, 800] },
  { pkg: 'parisienne', family: 'Parisienne', weights: [400] },
];

let css = '/* Selbst gehostete Schriften (SIL Open Font License 1.1, siehe fonts/LICENSE-*.txt). Erzeugt von scripts/copy-assets.js */\n';
for (const { pkg, family, weights } of FONTS) {
  const dir = join(root, 'node_modules/@fontsource', pkg);
  for (const w of weights) {
    const file = `${pkg}-latin-${w}-normal.woff2`;
    copyFileSync(join(dir, 'files', file), join(fontsOut, file));
    css += `@font-face{font-family:'${family}';font-style:normal;font-weight:${w};font-display:swap;src:url('fonts/${file}') format('woff2')}\n`;
  }
  const license = join(dir, 'LICENSE');
  if (existsSync(license)) copyFileSync(license, join(fontsOut, `LICENSE-${pkg}.txt`));
}
writeFileSync(join(root, 'src/public/static/fonts.css'), css);

const logo = process.argv[2] ?? join(root, '../mkdir-digital/public/logo-mkdir.webp');
copyFileSync(logo, join(imgOut, 'logo-mkdir.webp'));
console.log('Schriften und Logo kopiert.');
