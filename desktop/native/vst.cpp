// VST3 hosting for the tabShare desktop engine (Node-API addon).
// The engine's JS audio callback calls process() per block (that thread is the "audio thread"); loading, editors and
// state run on a JUCE message thread. The plugin slots themselves live in plugins.cpp.
// - Windows: in process. The addon starts its own JUCE message thread.
// - macOS: JUCE's message loop and plugin windows need a process main thread, which an Electron utility process
//   doesn't have, so the slots run in tabshare_plugin_host (host.cpp). This addon starts it and talks to it over two
//   socketpairs (ipc.h); process() is a synchronous round trip inside the audio callback.
#include <napi.h>
#include <algorithm>
#include <functional>
#include <mutex>
#include <string>
#include <vector>

namespace {

Napi::ThreadSafeFunction jsQueue;  // runs std::function<void(Napi::Env)> on the JS thread
Napi::FunctionReference onEvent;   // (type, slot, payload)

void onJs(std::function<void(Napi::Env)> fn) {
  jsQueue.NonBlockingCall(new std::function<void(Napi::Env)>(std::move(fn)), [](Napi::Env env, Napi::Function, std::function<void(Napi::Env)>* f) {
    (*f)(env);
    delete f;
  });
}

void emit(std::string type, int slot, std::string payload) {
  onJs([type, slot, payload](Napi::Env env) {
    if (onEvent.IsEmpty()) return;
    napi_value args[] = {Napi::String::New(env, type), Napi::Number::New(env, slot), Napi::String::New(env, payload)}, result;
    // Raw call: during shutdown JS can't run any more, and that must not be fatal.
    napi_call_function(env, env.Undefined(), onEvent.Value(), 3, args, &result);
  });
}

using LoadDone = std::function<void(std::string name, int latency, std::string error)>;

}  // namespace

// ---------- backends: same operations, in process (Windows) or in the plugin host (macOS) ----------

#ifndef __APPLE__

#include "plugins.h"
#include <juce_events/juce_events.h>
#include <windows.h>
#include <avrt.h>
#include <future>
#include <thread>

namespace backend {

/** Runs fn on the JUCE message thread and waits for it (used from the JS thread for quick calls only). */
template <typename F>
auto onMessageThread(F fn) -> decltype(fn()) {
  std::packaged_task<decltype(fn())()> task(std::move(fn));
  auto fut = task.get_future();
  juce::MessageManager::callAsync([&task] { task(); });
  return fut.get();
}

void init(const std::string&) {
  plugins::onEditorClosed = [](int slot, const std::string& state) { emit("editorClosed", slot, state); };
  std::promise<void> ready;
  std::thread([&ready] {
    juce::initialiseJuce_GUI();
    juce::MessageManager::getInstance()->setCurrentThreadAsMessageThread();
    ready.set_value();
    juce::MessageManager::getInstance()->runDispatchLoop();
  }).detach();
  ready.get_future().wait();
}

std::vector<std::string> list() { return plugins::list(); }
void prepare(double rate, int block) {
  // prepare() runs on the engine's audio (JS) thread. Register it with MMCSS "Pro Audio" like a DAW's audio thread:
  // at normal priority any busy process delays it past the one-block deadline and the block plays as a click.
  thread_local HANDLE mmcss = [] {
    DWORD task = 0;
    HANDLE h = AvSetMmThreadCharacteristicsW(L"Pro Audio", &task);
    if (h) AvSetMmThreadPriority(h, AVRT_PRIORITY_HIGH);
    return h;
  }();
  (void)mmcss;
  onMessageThread([=] {
    plugins::prepare(rate, block);
    return 0;
  });
}
void load(int slot, std::string path, std::string state, LoadDone done) {
  juce::MessageManager::callAsync([=] {
    std::string name;
    auto error = plugins::load(slot, path, state, name);
    done(name, error.empty() ? plugins::latency(slot) : 0, error);
  });
}
void unload(int slot) { juce::MessageManager::callAsync([slot] { plugins::unload(slot); }); }
void openEditor(int slot) { juce::MessageManager::callAsync([slot] { plugins::openEditor(slot); }); }
std::string getState(int slot) { return onMessageThread([slot] { return plugins::getState(slot); }); }
int latency(int slot) { return plugins::latency(slot); }
void process(int slot, float* x, int n) { plugins::process(slot, x, n); }

}  // namespace backend

#else  // macOS: client of tabshare_plugin_host

#include "ipc.h"
#include <mach/mach.h>
#include <mach/mach_time.h>
#include <array>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <csignal>
#include <fcntl.h>
#include <map>
#include <spawn.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <thread>

extern char** environ;

namespace backend {

constexpr int kSlots = 16;

struct Pending {
  bool done = false;
  std::vector<std::string> result;  // "ok" | "err", values...; empty if the host died
  std::function<void(std::vector<std::string>)> async;
};

std::string hostPath;
std::mutex m;  // guards everything below except the audio-only fields
std::condition_variable cv;
std::map<uint32_t, Pending> pending;
uint32_t nextId = 1;
int ctl = -1;
pid_t pid = 0;
std::atomic<bool> alive{false};
std::array<std::atomic<int>, kSlots> latencies{};

// Audio side (JS thread only).
int aud = -1;
uint32_t seq = 0;
std::atomic<int> timeoutUs{5000};
std::vector<char> frame(sizeof(ipc::AudioHeader) + ipc::kMaxBlock * sizeof(float));

void readerLoop(int fd, pid_t child) {
  std::vector<std::string> f;
  while (ipc::recvFields(fd, f)) {
    if (f.size() < 2) continue;
    if (f[0] == "0") {
      if (f.size() >= 4) emit(f[1], std::atoi(f[2].c_str()), f[3]);
      continue;
    }
    std::function<void(std::vector<std::string>)> async;
    std::vector<std::string> result(f.begin() + 1, f.end());
    {
      std::lock_guard lk(m);
      auto it = pending.find((uint32_t)std::strtoul(f[0].c_str(), nullptr, 10));
      if (it == pending.end()) continue;
      if (it->second.async) {
        async = std::move(it->second.async);
        pending.erase(it);
      } else {
        it->second.result = std::move(result);
        it->second.done = true;
      }
    }
    if (async) async(std::move(result));
    cv.notify_all();
  }
  // Host gone (crashed plugin, or killed): fail whatever is waiting and tell the engine.
  std::vector<std::function<void(std::vector<std::string>)>> failed;
  {
    std::lock_guard lk(m);
    alive = false;
    for (auto& [id, p] : pending) {
      if (p.async) failed.push_back(std::move(p.async));
      else p.done = true;
    }
    pending.clear();
    ::close(fd);
    if (ctl == fd) ctl = -1;
  }
  cv.notify_all();
  for (auto& f : failed) f({});
  waitpid(child, nullptr, 0);
  emit("hostExited", -1, "");
}

/** Starts the host if it isn't running. Caller holds no lock. */
bool ensureHost() {
  std::lock_guard lk(m);
  if (alive) return true;
  int c[2], a[2];
  if (socketpair(AF_UNIX, SOCK_STREAM, 0, c) || socketpair(AF_UNIX, SOCK_STREAM, 0, a)) return false;
  int one = 1;
  for (int fd : {c[0], a[0]}) {
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof one);  // a dead host must not kill the engine
    fcntl(fd, F_SETFD, FD_CLOEXEC);
  }
  posix_spawn_file_actions_t fa;
  posix_spawn_file_actions_init(&fa);
  posix_spawn_file_actions_adddup2(&fa, c[1], ipc::kControlFd);
  posix_spawn_file_actions_adddup2(&fa, a[1], ipc::kAudioFd);
  posix_spawn_file_actions_addinherit_np(&fa, 1);  // host logs go to the engine's stdout/stderr
  posix_spawn_file_actions_addinherit_np(&fa, 2);
  posix_spawnattr_t attr;
  posix_spawnattr_init(&attr);
  posix_spawnattr_setflags(&attr, POSIX_SPAWN_CLOEXEC_DEFAULT);  // nothing else of the engine's leaks in
  char* argv[] = {const_cast<char*>(hostPath.c_str()), nullptr};
  int err = posix_spawn(&pid, hostPath.c_str(), &fa, &attr, argv, environ);
  posix_spawn_file_actions_destroy(&fa);
  posix_spawnattr_destroy(&attr);
  ::close(c[1]);
  ::close(a[1]);
  if (err) {
    ::close(c[0]);
    ::close(a[0]);
    pid = 0;
    return false;
  }
  if (aud >= 0) ::close(aud);
  ctl = c[0];
  aud = a[0];
  for (auto& l : latencies) l = 0;
  alive = true;
  std::thread(readerLoop, ctl, pid).detach();
  return true;
}

/** Sends a request. With `async`, returns at once and calls it from the reader thread; else waits for the reply. */
std::vector<std::string> request(std::vector<std::string> fields, int timeoutMs = 10000, std::function<void(std::vector<std::string>)> async = {}) {
  std::unique_lock lk(m);
  if (!alive) {
    lk.unlock();
    if (async) async({});
    return {};
  }
  uint32_t id = nextId++;
  fields.insert(fields.begin(), std::to_string(id));
  bool wantsReply = fields[1] != "unload" && fields[1] != "editor";
  if (wantsReply) pending[id].async = std::move(async);
  if (!ipc::sendFields(ctl, fields) || !wantsReply) {
    pending.erase(id);
    return {};
  }
  if (pending[id].async) return {};
  cv.wait_for(lk, std::chrono::milliseconds(timeoutMs), [&] { return pending.count(id) == 0 || pending[id].done; });
  auto it = pending.find(id);
  if (it == pending.end()) return {};
  auto result = std::move(it->second.result);
  pending.erase(it);
  return result;
}

void init(const std::string& path) {
  hostPath = path;
  ensureHost();
}

std::vector<std::string> list() {
  ensureHost();
  auto r = request({"list", "0"});
  if (r.empty() || r[0] != "ok") return {};
  return {r.begin() + 1, r.end()};
}

void prepare(double rate, int block) {
  // prepare() runs on the engine's audio (JS) thread. Real-time priority, like Core Audio's IO threads: otherwise the
  // scheduler pauses it for milliseconds under load while it waits for the plugin host, and the block plays dry.
  mach_timebase_info_data_t tb;
  mach_timebase_info(&tb);
  auto ticks = [&](double us) { return (uint32_t)(us * 1e3 * tb.denom / tb.numer); };
  double periodUs = 1e6 * block / rate;
  thread_time_constraint_policy_data_t policy{ticks(periodUs), ticks(periodUs * 0.5), ticks(periodUs), 1};
  thread_policy_set(pthread_mach_thread_np(pthread_self()), THREAD_TIME_CONSTRAINT_POLICY, (thread_policy_t)&policy,
                    THREAD_TIME_CONSTRAINT_POLICY_COUNT);
  timeoutUs = (int)(0.5e6 * block / rate);  // shortcut: each plugin call may take up to half a block; past that it passes through
  if (ensureHost()) request({"prepare", "0", std::to_string(rate), std::to_string(block)});
}

void load(int slot, std::string path, std::string state, LoadDone done) {
  if (!ensureHost()) return done("", 0, "The plugin host couldn't start (" + hostPath + ")");
  request({"load", std::to_string(slot), path, state}, 0, [slot, done](std::vector<std::string> r) {
    if (r.size() >= 3 && r[0] == "ok") {
      int latency = std::atoi(r[2].c_str());
      if (slot >= 0 && slot < kSlots) latencies[slot] = latency;
      done(r[1], latency, "");
    } else {
      done("", 0, r.size() >= 2 ? r[1] : "The plugin host stopped while loading (the plugin may have crashed it)");
    }
  });
}

void unload(int slot) {
  if (slot >= 0 && slot < kSlots) latencies[slot] = 0;
  request({"unload", std::to_string(slot)});
}
void openEditor(int slot) { request({"editor", std::to_string(slot)}); }

std::string getState(int slot) {
  auto r = request({"state", std::to_string(slot)}, 5000);
  return r.size() >= 2 && r[0] == "ok" ? r[1] : std::string();
}

int latency(int slot) { return slot >= 0 && slot < kSlots ? latencies[slot].load() : 0; }

void process(int slot, float* x, int n) {
  if (!alive || aud < 0 || n <= 0 || (uint32_t)n > ipc::kMaxBlock) return;
  auto* h = reinterpret_cast<ipc::AudioHeader*>(frame.data());
  auto* y = reinterpret_cast<float*>(frame.data() + sizeof(ipc::AudioHeader));
  *h = {++seq, slot, (uint32_t)n};
  std::copy_n(x, n, y);
  size_t bytes = sizeof *h + n * sizeof(float);
  if (!ipc::writeAll(aud, frame.data(), bytes)) return;
  auto deadline = std::chrono::steady_clock::now() + std::chrono::microseconds(timeoutUs.load());
  for (;;) {
    auto left = std::chrono::duration_cast<std::chrono::microseconds>(deadline - std::chrono::steady_clock::now()).count();
    if (left <= 0) return;  // too slow this block: dry signal; the late reply is skipped by its seq next time
    fd_set rd;
    FD_ZERO(&rd);
    FD_SET(aud, &rd);
    timeval tv{(long)(left / 1000000), (int)(left % 1000000)};
    int ready = select(aud + 1, &rd, nullptr, nullptr, &tv);
    if (ready < 0 && errno == EINTR) continue;
    if (ready <= 0) return;
    if (!ipc::readAll(aud, h, sizeof *h) || h->n > ipc::kMaxBlock || !ipc::readAll(aud, y, h->n * sizeof(float))) return;
    if (h->seq == seq && (int)h->n == n) {
      std::copy_n(y, n, x);
      return;
    }
  }
}

}  // namespace backend

#endif

// ---------- exports (same on both platforms) ----------

namespace {

int pendingLoads = 0;  // JS thread only

int slotOf(const Napi::CallbackInfo& info) { return info[0].As<Napi::Number>().Int32Value(); }

/** init(onEvent, hostPath?): onEvent(type, slot, payload); hostPath is the plugin host executable (macOS only). */
Napi::Value Init(const Napi::CallbackInfo& info) {
  static std::once_flag once;
  std::call_once(once, [&] {
    auto env = info.Env();
    jsQueue = Napi::ThreadSafeFunction::New(env, Napi::Function::New(env, [](const Napi::CallbackInfo&) {}), "vst-js", 0, 1);
    jsQueue.Unref(env);
    onEvent = Napi::Persistent(info[0].As<Napi::Function>());
    backend::init(info.Length() > 1 && info[1].IsString() ? info[1].As<Napi::String>().Utf8Value() : std::string());
  });
  return info.Env().Undefined();
}

/** list() → [{path, name}]: installed .vst3 bundles. */
Napi::Value List(const Napi::CallbackInfo& info) {
  auto env = info.Env();
  auto out = Napi::Array::New(env);
  uint32_t n = 0;
  for (auto& path : backend::list()) {
    auto file = path.substr(path.find_last_of("/\\") + 1);
    auto o = Napi::Object::New(env);
    o.Set("path", path);
    o.Set("name", file.substr(0, file.rfind('.')));
    out.Set(n++, o);
  }
  return out;
}

/** prepare(sampleRate, blockSize): sets the stream format and re-prepares loaded plugins. */
Napi::Value Prepare(const Napi::CallbackInfo& info) {
  backend::prepare(info[0].As<Napi::Number>().DoubleValue(), info[1].As<Napi::Number>().Int32Value());
  return info.Env().Undefined();
}

/** load(slot, path, stateBase64?) → Promise<name>. Loads off the audio path; audio keeps running meanwhile. */
Napi::Value Load(const Napi::CallbackInfo& info) {
  auto deferred = std::make_shared<Napi::Promise::Deferred>(Napi::Promise::Deferred::New(info.Env()));
  auto promise = deferred->Promise();
  std::string state = info.Length() > 2 && info[2].IsString() ? info[2].As<Napi::String>().Utf8Value() : std::string();
  if (pendingLoads++ == 0) jsQueue.Ref(info.Env());  // a pending load keeps the process alive, like any promise
  backend::load(slotOf(info), info[1].As<Napi::String>().Utf8Value(), state, [deferred](std::string name, int, std::string error) {
    onJs([deferred, name, error](Napi::Env env) {
      if (--pendingLoads == 0) jsQueue.Unref(env);
      if (error.empty()) deferred->Resolve(Napi::String::New(env, name));
      else deferred->Reject(Napi::Error::New(env, error).Value());
    });
  });
  return promise;
}

Napi::Value Unload(const Napi::CallbackInfo& info) {
  backend::unload(slotOf(info));
  return info.Env().Undefined();
}

/** process(slot, Float32Array): mono, in place. Passes audio through untouched if the slot is empty or busy. */
Napi::Value Process(const Napi::CallbackInfo& info) {
  auto arr = info[1].As<Napi::Float32Array>();
  backend::process(slotOf(info), arr.Data(), (int)arr.ElementLength());
  return info.Env().Undefined();
}

/** openEditor(slot): the plugin's own window (or a generic one if it has none). */
Napi::Value OpenEditor(const Napi::CallbackInfo& info) {
  backend::openEditor(slotOf(info));
  return info.Env().Undefined();
}

/** getState(slot) → base64 string ('' when empty). */
Napi::Value GetState(const Napi::CallbackInfo& info) { return Napi::String::New(info.Env(), backend::getState(slotOf(info))); }

/** latency(slot) → samples the plugin reports it delays the signal by. */
Napi::Value Latency(const Napi::CallbackInfo& info) { return Napi::Number::New(info.Env(), backend::latency(slotOf(info))); }

}  // namespace

Napi::Object InitModule(Napi::Env env, Napi::Object exports) {
  exports.Set("init", Napi::Function::New(env, Init));
  exports.Set("list", Napi::Function::New(env, List));
  exports.Set("prepare", Napi::Function::New(env, Prepare));
  exports.Set("load", Napi::Function::New(env, Load));
  exports.Set("unload", Napi::Function::New(env, Unload));
  exports.Set("process", Napi::Function::New(env, Process));
  exports.Set("openEditor", Napi::Function::New(env, OpenEditor));
  exports.Set("getState", Napi::Function::New(env, GetState));
  exports.Set("latency", Napi::Function::New(env, Latency));
  return exports;
}

NODE_API_MODULE(tabshare_vst, InitModule)
