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
// RtAudio's preferredSampleRate for ASIO is the highest supported rate ≤ 48 kHz, not the rate the interface runs at,
// so starting the rig could flip the interface's clock under other apps. Prefer the current rate.
const MARK3 = '// tabShare patch v3: current ASIO rate';
if (!code.includes(MARK3)) {
  const anchor = '  // Determine supported data types ... just check first channel and assume rest are the same.';
  if (!code.includes(anchor)) throw new Error('RtAudio.cpp changed; sample-rate anchor not found');
  code = code.replace(
    anchor,
    `  ${MARK3}
  {
    ASIOSampleRate current;
    if ( ASIOGetSampleRate( &current ) == ASE_OK && ASIOCanSampleRate( current ) == ASE_OK && current > 0 )
      info.preferredSampleRate = (unsigned int) current;
  }

${anchor}`,
  );
  writeFileSync(src, code);
  console.log('patched', src, '(current rate)');
}

// Second patch, audify's own wrapper (src/rt_audio.*): same-callback output + dropout counters.
// Why: stock audify plays the block JS wrote for the *previous* callback (one buffer of extra latency), and the
// handoff can fall out of step with the driver. Mike's Focusrite 4i4 crackled on everything the app played out while
// what it sent was clean (2026-10-14). With setSyncWait(us) > 0 the audio thread hands JS this block's input and waits
// up to `us` for its output, playing it in the same callback; a late answer plays silence and counts as `late`.
// The engine falls back to the stock behavior (setSyncWait(0)) when late blocks keep coming. getStats() reports
// late / empty (stock mode, nothing queued) / skipped (driver block of another size) / xruns (driver over/underflow).
const MARK2 = '// tabShare patch v3: sync output';
const wrapCpp = path.join(dir, 'src/rt_audio.cpp');
const wrapH = path.join(dir, 'src/rt_audio.h');
let cpp = readFileSync(wrapCpp, 'utf8').replace(/\r\n/g, '\n');
let h = readFileSync(wrapH, 'utf8').replace(/\r\n/g, '\n');
if (!cpp.includes(MARK2)) {
  const fn = /int rt_callback\([\s\S]*?\n}\n(?=\nNapi::Object RtAudioWrap::Init)/;
  const anchors = [
    [cpp, 'InstanceMethod("clearOutputQueue", &RtAudioWrap::clearOutputQueue),'],
    [cpp, '    _outputData.push(data);'],
    [h, '    double _outputMultiplier;\n};'],
    [h, '    void clearOutputQueue(const Napi::CallbackInfo& info);'],
    [h, '#include <queue>'],
  ];
  for (const [text, a] of anchors) if (!text.includes(a)) throw new Error(`audify wrapper changed; anchor not found: ${a}`);
  if (!fn.test(cpp)) throw new Error('audify wrapper changed; rt_callback not found');
  cpp = cpp.replace(
    fn,
    `${MARK2} (see desktop/scripts/patch-audify.mjs)
int rt_callback(void* outputBuffer,
                void* inputBuffer,
                unsigned int nFrames,
                double streamTime,
                RtAudioStreamStatus status,
                void* userData)
{
    const auto wrap = static_cast<RtAudioWrap*>(userData);
    const size_t outBytes = static_cast<size_t>(nFrames) * wrap->_outputChannels * wrap->_sampleSize;

    // A block of another size than we opened with: play silence (stock audify left the driver's buffer as it was).
    if (nFrames != wrap->_frameSize)
    {
        wrap->_skipped++;
        if (wrap->_outputChannels) memset(outputBuffer, 0, outBytes);
        return 0;
    }
    if (status) wrap->_xruns++;

    std::unique_lock outputLock(wrap->_outputDataMutex, std::defer_lock);
    std::unique_lock tsfnLock(wrap->_tsfnMutex, std::defer_lock);

    // Callers hold outputLock.
    auto playFront = [&]() {
        if (wrap->_outputData.empty())
        {
            memset(outputBuffer, 0, outBytes);
            return false;
        }
        wrap->applyVolume(wrap->_outputData.front().get(), outputBuffer, wrap->_frameSize * wrap->_outputChannels);
        wrap->_outputData.pop();
        return true;
    };
    // Callers hold tsfnLock.
    auto frameOutput = [&]() {
        if (wrap->_frameOutputTsfn != nullptr)
            wrap->_frameOutputTsfn.NonBlockingCall([](Napi::Env, Napi::Function callback) { callback.Call({}); });
    };
    auto sendInput = [&]() {
        if (wrap->_inputTsfn == nullptr) return;
        const size_t inBytes = static_cast<size_t>(wrap->_frameSize) * wrap->_inputChannels * wrap->_sampleSize;
        std::shared_ptr<int8_t> inputData(new int8_t[inBytes]);
        memcpy(inputData.get(), inputBuffer, inBytes);
        wrap->_inputTsfn.NonBlockingCall(
            [inputData, inBytes](Napi::Env env, Napi::Function callback)
            { callback.Call({Napi::Buffer<int8_t>::Copy(env, inputData.get(), inBytes)}); });
    };

    const unsigned int waitUs = wrap->_syncWaitUs;
    if (waitUs > 0 && wrap->_outputChannels && wrap->_inputChannels)
    {
        // Anything still queued answered an earlier block too late (already counted); drop it to stay in step.
        outputLock.lock();
        std::queue<std::shared_ptr<int8_t>> stale;
        std::swap(wrap->_outputData, stale);
        outputLock.unlock();

        tsfnLock.lock();
        sendInput();
        tsfnLock.unlock();

        outputLock.lock();
        const bool got = wrap->_outputCv.wait_for(outputLock, std::chrono::microseconds(waitUs), [&] { return !wrap->_outputData.empty(); });
        if (got) playFront();
        else
        {
            memset(outputBuffer, 0, outBytes);
            wrap->_late++;
        }
        outputLock.unlock();
        if (got)
        {
            tsfnLock.lock();
            frameOutput();
        }
        return 0;
    }

    // Stock behavior: play what JS wrote after the previous callback, then send this block's input.
    if (wrap->_outputChannels)
    {
        std::lock(outputLock, tsfnLock);
        if (playFront()) frameOutput();
        else wrap->_empty++;
        outputLock.unlock();
    }
    if (wrap->_inputChannels)
    {
        if (!tsfnLock.owns_lock()) tsfnLock.lock();
        sendInput();
    }
    return 0;
}
`,
  );
  cpp = cpp.replace(
    'InstanceMethod("clearOutputQueue", &RtAudioWrap::clearOutputQueue),',
    `InstanceMethod("clearOutputQueue", &RtAudioWrap::clearOutputQueue),
            InstanceMethod("setSyncWait", &RtAudioWrap::setSyncWait),
            InstanceMethod("getStats", &RtAudioWrap::getStats),`,
  );
  cpp = cpp.replace('    _outputData.push(data);', '    _outputData.push(data);\n    _outputCv.notify_one();');
  cpp += `
${MARK2}
void RtAudioWrap::setSyncWait(const Napi::CallbackInfo& info)
{
    _syncWaitUs = info[0].As<Napi::Number>().Uint32Value();
}

Napi::Value RtAudioWrap::getStats(const Napi::CallbackInfo& info)
{
    Napi::Object o = Napi::Object::New(info.Env());
    o.Set("late", Napi::Number::New(info.Env(), _late.load()));
    o.Set("empty", Napi::Number::New(info.Env(), _empty.load()));
    o.Set("skipped", Napi::Number::New(info.Env(), _skipped.load()));
    o.Set("xruns", Napi::Number::New(info.Env(), _xruns.load()));
    return o;
}
`;
  h = h.replace('#include <queue>', '#include <queue>\n#include <atomic>\n#include <chrono>\n#include <condition_variable>');
  h = h.replace(
    '    void clearOutputQueue(const Napi::CallbackInfo& info);',
    '    void clearOutputQueue(const Napi::CallbackInfo& info);\n    void setSyncWait(const Napi::CallbackInfo& info);\n    Napi::Value getStats(const Napi::CallbackInfo& info);',
  );
  h = h.replace(
    '    double _outputMultiplier;\n};',
    `    double _outputMultiplier;

    ${MARK2}
    std::condition_variable _outputCv;
    std::atomic<unsigned int> _syncWaitUs{0};
    std::atomic<uint32_t> _late{0}, _empty{0}, _skipped{0}, _xruns{0};
};`,
  );
  writeFileSync(wrapCpp, cpp);
  writeFileSync(wrapH, h);
  console.log('patched', wrapCpp);
}

const stampText = `${MARK}\n${MARK2}\n${MARK3}`;
if (!existsSync(stamp) || readFileSync(stamp, 'utf8') !== stampText) {
  console.log('rebuilding audify (RtAudio) from source…');
  execSync('npx cmake-js compile', { cwd: dir, stdio: 'inherit' });
  writeFileSync(stamp, stampText);
}
