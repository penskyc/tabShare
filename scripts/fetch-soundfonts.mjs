// Downloads the full-size sound banks into public/soundfont/ (gitignored; ~72 MB, so not in the repo).
// Runs in the Docker build; on a dev machine run `npm run soundfonts` once. Each file is pinned by sha256.
// Usage: node scripts/fetch-soundfonts.mjs [--hashes]   (--hashes prints the sha256 of what's downloaded)
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const GU = 'https://raw.githubusercontent.com/mrbumpy409/GeneralUser-GS/684543d5e5efaef08d02be50dcda8d552478fa60';
const MS = 'https://ftp.osuosl.org/pub/musescore/soundfont/MuseScore_General';
const FILES = [
  // GeneralUser GS v2.0.3 by S. Christian Collins: free to use, including in software (see its license).
  { name: 'GeneralUser-GS.sf2', url: `${GU}/GeneralUser-GS.sf2`, sha256: '9575028c7a1f589f5770fccc8cff2734566af40cd26ed836944e9a5152688cfe' },
  { name: 'GeneralUser-GS-LICENSE.txt', url: `${GU}/documentation/LICENSE.txt`, sha256: '7b32efefdf95ce38a043799f0659853ddc00fbaa14d8c50f0aca16b9b8b405be' },
  // MuseScore General 0.2 (FluidR3-based): MIT; its notices must ship with it.
  { name: 'MuseScore_General.sf3', url: `${MS}/MuseScore_General.sf3`, sha256: '5b85b6c2c61d10b2b91cddd41efcce7b25cd31c8271d511c73afafbef20b6fa3' },
  { name: 'MuseScore_General_License.md', url: `${MS}/MuseScore_General_License.md`, sha256: '5ad8d737e13c7f01f5b9674872a82a92b4ba253603e8ed14b9db12293550b4b9' },
];

const dest = path.resolve('public/soundfont');
fs.mkdirSync(dest, { recursive: true });
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const printHashes = process.argv.includes('--hashes');

for (const f of FILES) {
  const file = path.join(dest, f.name);
  if (!printHashes && fs.existsSync(file) && sha(fs.readFileSync(file)) === f.sha256) continue;
  const res = await fetch(f.url);
  if (!res.ok) throw new Error(`${f.url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (printHashes) console.log(f.name, sha(buf));
  else if (sha(buf) !== f.sha256) throw new Error(`${f.name}: sha256 mismatch (upstream changed?)`);
  fs.writeFileSync(file, buf);
  console.log(`downloaded ${f.name} (${(buf.length / 1e6).toFixed(1)} MB)`);
}
