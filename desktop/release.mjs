// Uploads this platform's build (from `electron-builder`) to the GitHub release vX.Y.Z, creating the release if needed.
// Run after building: `npm run publish` (Windows) / `npm run publish:mac`. Needs the GitHub CLI (`gh`) signed in.
// (electron-builder's own --publish raced itself here: two uploads, and an installer that didn't match latest.yml.)
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const { version, build } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const { owner, repo } = build.publish[0];
const tag = `v${version}`;
const mac = process.platform === 'darwin';
// Named by OS + architecture (no version), so .../releases/latest/download/<name> links never change.
const WIN_EXE = 'tabShare-Windows-x64-Setup.exe';
const MAC_DMG = 'tabShare-macOS-arm64.dmg';
const feed = mac ? 'latest-mac.yml' : 'latest.yml';
const files = mac
  ? [`${MAC_DMG}`, `tabShare-${version}-macOS-arm64.zip`, `tabShare-${version}-macOS-arm64.zip.blockmap`, feed]
  : [WIN_EXE, `${WIN_EXE}.blockmap`, feed];

for (const f of files) if (!existsSync(`dist/${f}`)) throw new Error(`missing dist/${f}: build first`);
// The updater refuses a download whose sha512 doesn't match the feed, so check before anything goes public.
const yml = readFileSync(`dist/${feed}`, 'utf8');
if (!yml.includes(`version: ${version}`)) throw new Error(`dist/${feed} is not for ${version}`);
const target = yml.match(/^path: (.+)$/m)[1].trim();
const sha = createHash('sha512').update(readFileSync(`dist/${target}`)).digest('base64');
if (sha !== yml.match(/^sha512: (.+)$/m)[1].trim()) throw new Error(`dist/${target} doesn't match its sha512 in ${feed}`);

const gh = (...args) => execFileSync('gh', [...args, '--repo', `${owner}/${repo}`], { stdio: 'inherit' });
try {
  execFileSync('gh', ['release', 'view', tag, '--repo', `${owner}/${repo}`], { stdio: 'ignore' });
} catch {
  gh('release', 'create', tag, '--target', 'main', '--title', `tabShare ${version}`, '--notes', `Desktop app ${version}.`);
}
gh('release', 'upload', tag, ...files.map((f) => `dist/${f}`), '--clobber');
console.log(`uploaded ${files.join(', ')} to ${owner}/${repo} ${tag}`);
