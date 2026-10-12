// See TabshareEngine.h. Audio: one RemoteIO unit (input bus 1 rendered inside the output callback of bus 0), so the
// round trip is the driver's input + output latency plus one IO buffer. NAM core (MIT) runs the amp model and the cab
// IR (its Linear model is a real-time-safe partitioned FFT convolver).
// Objective-C's YES/NO macros (already defined by the pod's prefix header) would break NAM's `Supported::YES`/`NO`.
#pragma push_macro("YES")
#pragma push_macro("NO")
#undef YES
#undef NO
#include "NAM/container.h"
#include "NAM/convnet.h"
#include "NAM/get_dsp.h"
#include "NAM/linear.h"
#include "NAM/lstm.h"
#include "NAM/sequential.h"
#include "NAM/wavenet/model.h"
#pragma pop_macro("NO")
#pragma pop_macro("YES")
#include <algorithm>
#include <atomic>
#include <cmath>
#include <memory>
#include <mutex>
#include <vector>

#import "TabshareEngine.h"
#import <AVFoundation/AVFoundation.h>
#import <AudioToolbox/AudioToolbox.h>

namespace {

constexpr int kMaxFrames = 4096;
constexpr int kFeedBlock = 1024;        // samples per message to the page (call audio + tuner)
constexpr double kMaxIrSeconds = 0.5;   // like desktop: cab IRs are well under this

/** Single-producer (audio thread) / single-consumer (drain timer) float FIFO. Drops input when full. */
struct Fifo {
  std::vector<float> buf = std::vector<float>(1 << 15);
  std::atomic<size_t> w{0}, r{0};
  void push(const float *x, int n) {
    size_t wi = w.load(std::memory_order_relaxed), ri = r.load(std::memory_order_acquire);
    if (wi - ri + n > buf.size()) return;
    for (int i = 0; i < n; i++) buf[(wi + i) & (buf.size() - 1)] = x[i];
    w.store(wi + n, std::memory_order_release);
  }
  bool pop(float *x, int n) {
    size_t ri = r.load(std::memory_order_relaxed), wi = w.load(std::memory_order_acquire);
    if (wi - ri < (size_t)n) return false;
    for (int i = 0; i < n; i++) x[i] = buf[(ri + i) & (buf.size() - 1)];
    r.store(ri + n, std::memory_order_release);
    return true;
  }
  void clear() { r.store(w.load()); }
};

/** Everything the audio callback touches. Parameters are atomics; models are swapped under `lock` (try_lock in audio). */
struct Dsp {
  std::atomic<int> channel{0}, voiceChannel{-1};
  std::atomic<float> inGain{1}, outGain{0.5f};
  std::atomic<bool> monitor{true}, bypass{false}, tapOn{false};
  std::atomic<float> peak{0};
  std::mutex lock;
  std::unique_ptr<nam::DSP> amp;
  std::unique_ptr<nam::Linear> cab;
  std::vector<float> x = std::vector<float>(kMaxFrames), y = std::vector<float>(kMaxFrames), z = std::vector<float>(kMaxFrames);
  Fifo feed, tap, voice;

  /** Audio thread. `in` = per-channel input pointers. Writes mono into outL/outR. */
  void process(float *const *in, int nIn, float *outL, float *outR, int n) {
    const int ch = std::min(channel.load(), nIn - 1);
    const float g = inGain.load();
    float pk = 0;
    for (int i = 0; i < n; i++) {
      pk = std::max(pk, std::fabs(in[ch][i]));
      x[i] = in[ch][i] * g;
    }
    if (pk * g > peak.load(std::memory_order_relaxed)) peak.store(pk * g, std::memory_order_relaxed);
    if (tapOn.load(std::memory_order_relaxed)) tap.push(in[ch], n);

    float *out = x.data();
    std::unique_lock lk(lock, std::try_to_lock);  // a model being swapped in: play this block dry
    if (lk.owns_lock()) {
      if (amp && !bypass.load()) {
        float *xi[] = {x.data()}, *yi[] = {y.data()};
        amp->process(xi, yi, n);
        out = y.data();
      }
      if (cab) {
        float *ci[] = {out}, *zi[] = {z.data()};
        cab->process(ci, zi, n);
        out = z.data();
      }
    }
    const float og = outGain.load();
    const bool mon = monitor.load();
    for (int i = 0; i < n; i++) {
      out[i] *= og;
      outL[i] = mon ? out[i] : 0;
      if (outR) outR[i] = outL[i];
    }
    feed.push(out, n);  // the processed instrument, for the call
    // iOS has one input device: with an interface plugged in, the call's voice comes from one of its inputs too.
    const int vc = voiceChannel.load();
    if (vc >= 0 && vc < nIn && vc != ch) voice.push(in[vc], n);
  }
};

// NAM registers each architecture from a static object in its own .cpp. In a static library the linker drops object
// files nothing references, so those registrations vanished ("No config parser registered for architecture:
// SlimmableContainer"). Referencing each file's create_config keeps them all linked.
__attribute__((used)) const void *kKeepNamArchitectures[] = {  // `used`: survive -O3 dead-code removal
  (const void *)&nam::container::create_config, (const void *)&nam::convnet::create_config, (const void *)&nam::linear::create_config,
  (const void *)&nam::lstm::create_config,      (const void *)&nam::sequential::create_config, (const void *)&nam::wavenet::create_config,
};

NSString *base64(const float *x, int n) {
  return [[NSData dataWithBytes:x length:n * sizeof(float)] base64EncodedStringWithOptions:0];
}

}  // namespace

@implementation TabshareEngine {
  void (^_emit)(NSString *);
  Dsp _dsp;
  AudioUnit _unit;
  AudioBufferList *_inList;
  std::vector<std::vector<float>> _inBufs;
  std::vector<float *> _inPtrs;
  int _nIn;
  double _rate;
  BOOL _running;
  dispatch_queue_t _queue;  // messages, model loading and the drain timer, in order
  dispatch_source_t _timer;
  int _levelTick;
  int _silentLevels;  // consecutive level reports of exact digital silence (a dead input, not a quiet one)
  NSDictionary *_lastStart;  // the page's start message, to restart by ourselves after an interruption
}

- (instancetype)initWithEmitter:(void (^)(NSString *))emit {
  if ((self = [super init])) {
    _emit = [emit copy];
    _queue = dispatch_queue_create("tabshare.engine", DISPATCH_QUEUE_SERIAL);
    _rate = 48000;
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(routeChanged:) name:AVAudioSessionRouteChangeNotification object:nil];
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(interrupted:) name:AVAudioSessionInterruptionNotification object:nil];
  }
  return self;
}

- (void)send:(NSDictionary *)msg {
  NSData *data = [NSJSONSerialization dataWithJSONObject:msg options:0 error:nil];
  if (data) _emit([[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding]);
}

- (void)error:(NSString *)message {
  [self send:@{@"type" : @"error", @"message" : message}];
}

- (void)handle:(NSString *)json {
  dispatch_async(_queue, ^{
    NSDictionary *m = [NSJSONSerialization JSONObjectWithData:[json dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
    if (![m isKindOfClass:NSDictionary.class]) return;
    NSString *type = m[@"type"];
    @try {
      if ([type isEqual:@"devices"]) [self sendDevices];
      else if ([type isEqual:@"start"]) [self start:m];
      else if ([type isEqual:@"stop"]) {
        self->_lastStart = nil;
        [self stop];
      }
      else if ([type isEqual:@"params"]) [self params:m[@"params"]];
      else if ([type isEqual:@"loadModel"]) [self loadModel:m[@"json"]];
      else if ([type isEqual:@"unloadModel"]) [self swapAmp:nullptr];
      else if ([type isEqual:@"ir"]) [self setIr:m[@"samples"]];
      else if ([type isEqual:@"tap"]) {
        self->_dsp.tap.clear();
        self->_dsp.tapOn = [m[@"on"] boolValue];
      } else if ([type isEqual:@"vstList"]) [self send:@{@"type" : @"vstList", @"available" : @NO, @"plugins" : @[]}];
      // vst* messages: no plugin hosting on iOS (no VST3 there); the page hides the section.
    } @catch (NSException *e) {
      if ([type isEqual:@"start"]) [self stop];
      [self error:e.reason ?: @"Audio engine error"];
    }
  });
}

#pragma mark - devices

/** For error messages: what the shared audio session looks like right now (WebKit uses it too). */
static NSString *sessionInfo() {
  AVAudioSession *s = AVAudioSession.sharedInstance;
  return [NSString stringWithFormat:@"session %@/%@, input %@", [s.category stringByReplacingOccurrencesOfString:@"AVAudioSessionCategory" withString:@""],
                                    [s.mode stringByReplacingOccurrencesOfString:@"AVAudioSessionMode" withString:@""],
                                    s.currentRoute.inputs.firstObject.portName ?: @"none"];
}

/** Measurement mode: no automatic gain, echo cancellation or EQ on the instrument. */
- (BOOL)setRecordCategory:(NSError **)err {
  return [AVAudioSession.sharedInstance setCategory:AVAudioSessionCategoryPlayAndRecord mode:AVAudioSessionModeMeasurement
                                            options:AVAudioSessionCategoryOptionDefaultToSpeaker | AVAudioSessionCategoryOptionMixWithOthers
                                              error:err];
}

- (void)sendDevices {
  AVAudioSession *s = AVAudioSession.sharedInstance;
  // iOS lists external inputs only under a record category, and the page's own session is playback (silent switch).
  if (!_running) [self setRecordCategory:nil];
  NSMutableArray *devices = [NSMutableArray array];
  for (AVAudioSessionPortDescription *p in s.availableInputs) {
    NSUInteger channels = p.channels.count;
    for (AVAudioSessionPortDescription *r in s.currentRoute.inputs)
      if ([r.UID isEqual:p.UID]) channels = MAX(channels, r.channels.count);
    // shortcut: an interface iOS hasn't opened yet reports no channels; assume 2 (start opens what it really has).
    if (!channels) channels = [p.portType isEqual:AVAudioSessionPortUSBAudio] ? 2 : 1;
    [devices addObject:@{@"name" : p.portName, @"inputs" : @(channels), @"outputs" : @2}];
  }
  [self send:@{@"type" : @"devices", @"devices" : devices}];
}

#pragma mark - start / stop

static OSStatus renderCallback(void *ref, AudioUnitRenderActionFlags *flags, const AudioTimeStamp *ts, UInt32, UInt32 n,
                               AudioBufferList *out) {
  TabshareEngine *e = (__bridge TabshareEngine *)ref;
  return [e render:flags time:ts frames:n out:out];
}

- (OSStatus)render:(AudioUnitRenderActionFlags *)flags time:(const AudioTimeStamp *)ts frames:(UInt32)n out:(AudioBufferList *)out {
  float *L = (float *)out->mBuffers[0].mData;
  float *R = out->mNumberBuffers > 1 ? (float *)out->mBuffers[1].mData : nullptr;
  if (n > kMaxFrames) n = kMaxFrames;
  for (int c = 0; c < _nIn; c++) {
    _inList->mBuffers[c].mData = _inPtrs[c];
    _inList->mBuffers[c].mDataByteSize = n * sizeof(float);
  }
  if (AudioUnitRender(_unit, flags, ts, 1, n, _inList) != noErr) {
    memset(L, 0, n * sizeof(float));
    if (R) memset(R, 0, n * sizeof(float));
    return noErr;
  }
  _dsp.process(_inPtrs.data(), _nIn, L, R, (int)n);
  return noErr;
}

- (void)start:(NSDictionary *)m {
  [self stop];
  _lastStart = m;
  AVAudioSession *s = AVAudioSession.sharedInstance;
  NSError *err = nil;
  if (![self setRecordCategory:&err])
    @throw [NSException exceptionWithName:@"audio" reason:err.localizedDescription ?: @"Couldn't set up audio" userInfo:nil];
  int bufferSize = MAX(32, MIN([m[@"bufferSize"] intValue] ?: 128, 1024));
  [s setPreferredSampleRate:48000 error:nil];
  [s setPreferredIOBufferDuration:bufferSize / 48000.0 error:nil];
  NSString *device = m[@"device"];
  for (AVAudioSessionPortDescription *p in s.availableInputs)
    if ([p.portName isEqual:device]) [s setPreferredInput:p error:nil];
  if (![s setActive:YES error:&err])
    @throw [NSException exceptionWithName:@"audio" reason:err.localizedDescription ?: @"Couldn't start audio" userInfo:nil];
  if (s.maximumInputNumberOfChannels > 1) [s setPreferredInputNumberOfChannels:s.maximumInputNumberOfChannels error:nil];

  _rate = s.sampleRate;
  _nIn = (int)MAX((NSInteger)1, s.inputNumberOfChannels);
  _inBufs.assign(_nIn, std::vector<float>(kMaxFrames));
  _inPtrs.resize(_nIn);
  for (int c = 0; c < _nIn; c++) _inPtrs[c] = _inBufs[c].data();
  _inList = (AudioBufferList *)calloc(1, offsetof(AudioBufferList, mBuffers) + sizeof(AudioBuffer) * _nIn);
  _inList->mNumberBuffers = _nIn;
  for (int c = 0; c < _nIn; c++) _inList->mBuffers[c].mNumberChannels = 1;

  AudioComponentDescription d = {kAudioUnitType_Output, kAudioUnitSubType_RemoteIO, kAudioUnitManufacturer_Apple, 0, 0};
  AudioComponentInstanceNew(AudioComponentFindNext(nullptr, &d), &_unit);
  UInt32 one = 1;
  AudioUnitSetProperty(_unit, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Input, 1, &one, sizeof one);
  auto format = [&](UInt32 ch) {
    AudioStreamBasicDescription f = {};
    f.mSampleRate = _rate;
    f.mFormatID = kAudioFormatLinearPCM;
    f.mFormatFlags = kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked | kAudioFormatFlagIsNonInterleaved;
    f.mBytesPerPacket = f.mBytesPerFrame = sizeof(float);
    f.mFramesPerPacket = 1;
    f.mChannelsPerFrame = ch;
    f.mBitsPerChannel = 32;
    return f;
  };
  AudioStreamBasicDescription inFmt = format(_nIn), outFmt = format(2);
  AudioUnitSetProperty(_unit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Output, 1, &inFmt, sizeof inFmt);
  AudioUnitSetProperty(_unit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Input, 0, &outFmt, sizeof outFmt);
  UInt32 maxFrames = kMaxFrames;
  AudioUnitSetProperty(_unit, kAudioUnitProperty_MaximumFramesPerSlice, kAudioUnitScope_Global, 0, &maxFrames, sizeof maxFrames);
  AURenderCallbackStruct cb = {renderCallback, (__bridge void *)self};
  AudioUnitSetProperty(_unit, kAudioUnitProperty_SetRenderCallback, kAudioUnitScope_Input, 0, &cb, sizeof cb);
  {
    std::lock_guard lk(_dsp.lock);  // models are prepared at the stream's rate
    if (_dsp.amp) _dsp.amp->Reset(_rate, kMaxFrames);
    if (_dsp.cab) _dsp.cab->Reset(_rate, kMaxFrames);
  }
  OSStatus st = AudioUnitInitialize(_unit);
  if (st == noErr) st = AudioOutputUnitStart(_unit);
  if (st != noErr) @throw [NSException exceptionWithName:@"audio" reason:[NSString stringWithFormat:@"Audio unit failed to start (%d)", (int)st] userInfo:nil];
  _running = YES;
  _dsp.feed.clear();
  _dsp.voice.clear();
  [self startTimer];

  double io = s.IOBufferDuration;
  double latencyMs = (s.inputLatency + s.outputLatency + 2 * io) * 1000;
  NSString *name = s.currentRoute.inputs.firstObject.portName ?: @"Audio input";
  [self send:@{
    @"type" : @"started", @"device" : name, @"sampleRate" : @(_rate), @"bufferSize" : @((int)lround(io * _rate)),
    @"latencyMs" : @(latencyMs), @"inputs" : @(_nIn), @"outputs" : @((int)s.outputNumberOfChannels)
  }];
}

- (void)stop {
  if (![self halt]) return;
  [self send:@{@"type" : @"stopped"}];
}

/** Tears the audio unit down without telling the page. Returns NO if nothing was running. */
- (BOOL)halt {
  if (_timer) {
    dispatch_source_cancel(_timer);
    _timer = nil;
  }
  if (!_unit) return NO;
  AudioOutputUnitStop(_unit);
  AudioUnitUninitialize(_unit);
  AudioComponentInstanceDispose(_unit);
  _unit = nullptr;
  free(_inList);
  _inList = nullptr;
  _running = NO;
  // Hand the session back to the page (WebKit plays the synth and the call through it): default mode, no measurement.
  [AVAudioSession.sharedInstance setMode:AVAudioSessionModeDefault error:nil];
  return YES;
}

/**
 * The session was taken from under the rig (starting a call in the web view does this once). Starting again works, so
 * do it ourselves — a few tries, and only on the same interface (never fall back to the built-in mic: feedback).
 * The page keeps its state; a successful start sends `started` again, which rebuilds its call feed.
 */
- (void)resumeAfter:(NSString *)why attempt:(int)attempt {
  const double delays[] = {0.6, 1.5, 3.0};
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(delays[attempt] * NSEC_PER_SEC)), _queue, ^{
    NSDictionary *m = self->_lastStart;
    if (self->_running || !m) return;  // the page started or stopped the rig in the meantime
    BOOL present = NO;
    for (AVAudioSessionPortDescription *p in AVAudioSession.sharedInstance.availableInputs) present |= [p.portName isEqual:m[@"device"]];
    if (present) {
      @try {
        [self start:m];
        return;
      } @catch (NSException *e) {
        [self halt];
        if (attempt < 2) return [self resumeAfter:why attempt:attempt + 1];
      }
    }
    self->_lastStart = nil;
    [self send:@{@"type" : @"stopped"}];
    [self error:[NSString stringWithFormat:@"%@ Turn the rig back on.", present ? why : @"The audio interface was disconnected."]];
  });
}

- (void)shutdown {
  dispatch_sync(_queue, ^{ [self stop]; });
  [NSNotificationCenter.defaultCenter removeObserver:self];
}

- (void)routeChanged:(NSNotification *)n {
  NSUInteger reason = [n.userInfo[AVAudioSessionRouteChangeReasonKey] unsignedIntegerValue];
  // An interface plugged in or out: refresh the page's device list.
  if (reason == AVAudioSessionRouteChangeReasonNewDeviceAvailable || reason == AVAudioSessionRouteChangeReasonOldDeviceUnavailable)
    dispatch_async(_queue, ^{ [self sendDevices]; });
  // Something else in the app (WebKit) reconfigured the session under the running rig: report it.
  if (reason == AVAudioSessionRouteChangeReasonCategoryChange || reason == AVAudioSessionRouteChangeReasonOverride)
    dispatch_async(_queue, ^{
      AVAudioSession *s = AVAudioSession.sharedInstance;
      if (self->_running && (![s.category isEqual:AVAudioSessionCategoryPlayAndRecord] || ![s.mode isEqual:AVAudioSessionModeMeasurement]))
        [self error:[NSString stringWithFormat:@"The audio session was changed under the rig (%@).", sessionInfo()]];
    });
  if (reason != AVAudioSessionRouteChangeReasonOldDeviceUnavailable) return;
  dispatch_async(_queue, ^{
    if (!self->_running) return;
    [self halt];
    [self resumeAfter:[NSString stringWithFormat:@"The audio input went away (%@).", sessionInfo()] attempt:0];
  });
}

- (void)interrupted:(NSNotification *)n {
  if ([n.userInfo[AVAudioSessionInterruptionTypeKey] unsignedIntegerValue] != AVAudioSessionInterruptionTypeBegan) return;
  NSUInteger reason = [n.userInfo[AVAudioSessionInterruptionReasonKey] unsignedIntegerValue];
  dispatch_async(_queue, ^{
    if (!self->_running) return;
    NSString *info = sessionInfo();
    [self halt];
    [self resumeAfter:[NSString stringWithFormat:@"Audio was interrupted (reason %lu; %@).", (unsigned long)reason, info] attempt:0];
  });
}

#pragma mark - page feed

/** Every 20 ms: call audio and tuner samples in 1024-sample blocks, input level every 60 ms. */
- (void)startTimer {
  _silentLevels = 0;
  _timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, _queue);
  dispatch_source_set_timer(_timer, dispatch_time(DISPATCH_TIME_NOW, 0), 20 * NSEC_PER_MSEC, 5 * NSEC_PER_MSEC);
  dispatch_source_set_event_handler(_timer, ^{ [self drain]; });
  dispatch_resume(_timer);
}

- (void)drain {
  float block[kFeedBlock];
  while (_dsp.feed.pop(block, kFeedBlock)) [self send:@{@"type" : @"pcm", @"samples" : base64(block, kFeedBlock)}];
  while (_dsp.voice.pop(block, kFeedBlock)) [self send:@{@"type" : @"voice", @"samples" : base64(block, kFeedBlock)}];
  while (_dsp.tap.pop(block, kFeedBlock))
    [self send:@{@"type" : @"tap", @"samples" : base64(block, kFeedBlock), @"sampleRate" : @(_rate)}];
  if (++_levelTick % 3 == 0) {
    float peak = _dsp.peak.exchange(0);
    [self send:@{@"type" : @"level", @"peak" : @(peak)}];
    // ~3 s of exact zeros: the input is dead (another audio unit took it?). Say so once, with the session state.
    _silentLevels = peak > 0 ? 0 : _silentLevels + 1;
    if (_silentLevels == 50) [self error:[NSString stringWithFormat:@"No signal from the input (%@).", sessionInfo()]];
  }
}

#pragma mark - params and models

- (void)params:(NSDictionary *)p {
  if (![p isKindOfClass:NSDictionary.class]) return;
  if (p[@"channel"]) _dsp.channel = MAX(0, [p[@"channel"] intValue]);
  if (p[@"inGain"]) _dsp.inGain = [p[@"inGain"] floatValue];
  if (p[@"outGain"]) _dsp.outGain = [p[@"outGain"] floatValue];
  if (p[@"monitor"]) _dsp.monitor = [p[@"monitor"] boolValue];
  if (p[@"bypass"]) _dsp.bypass = [p[@"bypass"] boolValue];
  if (p[@"voiceChannel"]) {
    _dsp.voiceChannel = [p[@"voiceChannel"] intValue];
    _dsp.voice.clear();
  }
}

- (void)swapAmp:(std::unique_ptr<nam::DSP>)amp {
  std::unique_ptr<nam::DSP> old;
  {
    std::lock_guard lk(_dsp.lock);
    old = std::move(_dsp.amp);
    _dsp.amp = std::move(amp);
  }
}  // the old model is freed here, outside the lock and off the audio thread

- (void)loadModel:(NSString *)json {
  bool ok = false;
  try {
    // The page is remote content: a malformed or hostile model must fail here, not crash the app.
    auto amp = nam::get_dsp(nlohmann::json::parse(json.UTF8String));
    if (amp) {
      amp->Reset(_rate, kMaxFrames);
      [self swapAmp:std::move(amp)];
      ok = true;
    }
  } catch (const std::exception &e) {
    [self error:[NSString stringWithFormat:@"Couldn't load the model: %s", e.what()]];
  }
  [self send:@{@"type" : @"modelLoaded", @"ok" : @(ok)}];
}

/** `samples`: base64 Float32, already at the stream's rate and normalized by the page (normalizeIr), or null. */
- (void)setIr:(id)samples {
  std::unique_ptr<nam::Linear> cab;
  if ([samples isKindOfClass:NSString.class]) {
    NSData *data = [[NSData alloc] initWithBase64EncodedString:samples options:0];
    size_t n = std::min(data.length / sizeof(float), (size_t)(kMaxIrSeconds * _rate));
    if (n > 0) {
      std::vector<float> ir((const float *)data.bytes, (const float *)data.bytes + n);
      cab = std::make_unique<nam::Linear>(1, 1, (int)n, false, ir, _rate);
      cab->Reset(_rate, kMaxFrames);
    }
  }
  std::unique_ptr<nam::Linear> old;
  {
    std::lock_guard lk(_dsp.lock);
    old = std::move(_dsp.cab);
    _dsp.cab = std::move(cab);
  }
}

@end
