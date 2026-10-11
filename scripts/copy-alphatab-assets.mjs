// Copies alphaTab's music font and soundfont into public/ so Vite serves them at /font and /soundfont.
import fs from 'node:fs';
import path from 'node:path';

const src = path.resolve('node_modules/@coderline/alphatab/dist');
const dest = path.resolve('public');

for (const dir of ['font', 'soundfont']) {
  const from = path.join(src, dir);
  if (!fs.existsSync(from)) continue;
  fs.cpSync(from, path.join(dest, dir), { recursive: true });
}
console.log('alphaTab assets copied to public/');
