// Windows: rebuild audify's RtAudio so it only loads the ASIO driver you picked.
// Why: RtAudio lists devices by loading every installed ASIO driver. Wrapper drivers (ASIO4ALL, FL Studio ASIO, …) take
// over the Windows audio devices when loaded, and a USB call mic (Corey's Razer) stopped delivering audio for good, even
// to a fresh getUserMedia (.playwright-mcp/asio4all-mic.mjs, 2026-10-13). With TABSHARE_ASIO_ONLY set (the engine
// sets it), RtAudio probes just that driver; driver names for the picker come from the registry without loading any.
// Idempotent; run by `npm run build:native` (npm install restores the prebuilt audify, so it re-runs every build).
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

if (process.platform !== 'win32') process.exit(0); // ASIO is Windows-only; macOS keeps the prebuilt audify

const dir = path.dirname(createRequire(import.meta.url).resolve('audify/package.json'));
const src = path.join(dir, 'vendor/rtaudio/RtAudio.cpp');
const stamp = path.join(dir, 'build/Release/.tabshare-asio-only');
const MARK = '// tabShare patch v2: TABSHARE_ASIO_ONLY';

let code = readFileSync(src, 'utf8').replace(/\r\n/g, '\n'); // the vendored source has CRLF line endings
if (code.includes('// tabShare patch') && !code.includes(MARK)) throw new Error('RtAudio.cpp has an older tabShare patch: reinstall audify (npm i audify --force) and run again');
if (!code.includes(MARK)) {
  const anchorFn = 'void RtApiAsio :: probeDevices( void )';
  const anchorNew = `    if ( m == deviceList_.size() ) { // new device
      RtAudio::DeviceInfo info;
      info.name = driverNames.back();`;
  for (const a of [anchorFn, anchorNew]) if (!code.includes(a)) throw new Error(`RtAudio.cpp changed; anchor not found: ${a.slice(0, 50)}`);
  code = code.replace(
    anchorFn,
    `${MARK} (see desktop/scripts/patch-audify.mjs)
static bool tabshareSkipAsio( const std::string &name )
{
  char only[256];
  DWORD n = GetEnvironmentVariableA( "TABSHARE_ASIO_ONLY", only, sizeof only );
  return n > 0 && n < sizeof only && name != std::string( only, n );
}

${anchorFn}`,
  );
  code = code.replace(
    anchorNew,
    `    if ( m == deviceList_.size() ) { // new device
      if ( tabshareSkipAsio( driverNames.back() ) ) continue; // never load drivers other than the chosen one
      RtAudio::DeviceInfo info;
      info.name = driverNames.back();`,
  );
  writeFileSync(src, code);
  console.log('patched', src);
}

if (!existsSync(stamp) || readFileSync(stamp, 'utf8') !== MARK) {
  console.log('rebuilding audify (RtAudio) from source…');
  execSync('npx cmake-js compile', { cwd: dir, stdio: 'inherit' });
  writeFileSync(stamp, MARK);
}
