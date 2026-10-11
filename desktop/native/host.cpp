// tabShare plugin host (macOS): runs the VST3 slots (plugins.cpp) for the desktop engine in a process of its own,
// because JUCE's Mac message loop and plugin windows need a process main thread, which the engine (an Electron
// utility process) doesn't have. Started by the addon (vst.cpp) with the control socket on fd 3 and the audio socket on
// fd 4 (protocol in ipc.h). Exits when the control socket closes, i.e. the engine went away.
#include "ipc.h"
#include "plugins.h"
#include <juce_gui_basics/juce_gui_basics.h>
#include <csignal>
#include <mach/mach.h>
#include <mach/mach_time.h>
#include <pthread.h>
#include <thread>

namespace juce {
void initialiseNSApplication();  // juce_MessageManager_mac.mm; normally only JUCE's own app main() calls it
}

namespace {

/** Real-time scheduling for the audio thread, like Core Audio's own IO threads. Without it the thread sleeps between
 *  blocks at normal priority and sometimes wakes too late (measured: ~1 dry block every 3 s, worst 22 ms). */
void makeRealtime(double periodMs) {
  mach_timebase_info_data_t tb;
  mach_timebase_info(&tb);
  auto ticks = [&](double ms) { return (uint32_t)(ms * 1e6 * tb.denom / tb.numer); };
  thread_time_constraint_policy_data_t policy{ticks(periodMs), ticks(periodMs * 0.5), ticks(periodMs), 1};
  if (thread_policy_set(pthread_mach_thread_np(pthread_self()), THREAD_TIME_CONSTRAINT_POLICY, (thread_policy_t)&policy,
                        THREAD_TIME_CONSTRAINT_POLICY_COUNT) != KERN_SUCCESS)
    makeRealtime(128 / 48.0);  // shortcut: sized for 128 @ 48 kHz; fine for other sizes since it only sets priority hints
}

void reply(const std::vector<std::string>& fields) { ipc::sendFields(ipc::kControlFd, fields); }

/** Message thread: one control request. */
void handle(const std::vector<std::string>& f) {
  if (f.size() < 3) return;
  const auto& id = f[0];
  const auto& op = f[1];
  int slot = std::atoi(f[2].c_str());
  auto arg = [&](size_t i) { return i < f.size() ? f[i] : std::string(); };
  if (op == "list") {
    auto paths = plugins::list();
    paths.insert(paths.begin(), {id, "ok"});
    reply(paths);
  } else if (op == "prepare") {
    plugins::prepare(std::atof(arg(3).c_str()), std::atoi(arg(4).c_str()));
    reply({id, "ok"});
  } else if (op == "load") {
    std::string name;
    auto error = plugins::load(slot, arg(3), arg(4), name);
    if (error.empty()) reply({id, "ok", name, std::to_string(plugins::latency(slot))});
    else reply({id, "err", error});
  } else if (op == "unload") {
    plugins::unload(slot);
  } else if (op == "editor") {
    plugins::openEditor(slot);
  } else if (op == "state") {
    reply({id, "ok", plugins::getState(slot)});
  } else {
    reply({id, "err", "unknown op " + op});
  }
}

}  // namespace

int main() {
  std::signal(SIGPIPE, SIG_IGN);  // a closed socket shows up as a failed write instead
  juce::initialiseNSApplication();  // without NSApp, runDispatchLoop() ([NSApp run]) returns at once
  juce::ScopedJuceInitialiser_GUI gui;
  juce::Process::setDockIconVisible(false);  // plugin windows still show; no second Dock icon next to tabShare
  plugins::onEditorClosed = [](int slot, const std::string& state) { reply({"0", "editorClosed", std::to_string(slot), state}); };

  std::thread([] {
    std::vector<std::string> f;
    while (ipc::recvFields(ipc::kControlFd, f)) juce::MessageManager::callAsync([f] { handle(f); });
    // shortcut: no orderly plugin teardown; the engine is gone, and some plugins crash in their destructors anyway.
    std::_Exit(0);
  }).detach();

  std::thread([] {
    makeRealtime(128 / 48.0);  // shortcut: sized for 128 @ 48 kHz; fine for other sizes since it only sets priority hints
    std::vector<char> frame(sizeof(ipc::AudioHeader) + ipc::kMaxBlock * sizeof(float));
    auto* h = reinterpret_cast<ipc::AudioHeader*>(frame.data());
    auto* x = reinterpret_cast<float*>(frame.data() + sizeof(ipc::AudioHeader));
    while (ipc::readAll(ipc::kAudioFd, h, sizeof *h) && h->n <= ipc::kMaxBlock && ipc::readAll(ipc::kAudioFd, x, h->n * sizeof(float))) {
      plugins::process(h->slot, x, (int)h->n);
      if (!ipc::writeAll(ipc::kAudioFd, frame.data(), sizeof *h + h->n * sizeof(float))) break;
    }
  }).detach();

  juce::MessageManager::getInstance()->runDispatchLoop();
  return 0;
}
