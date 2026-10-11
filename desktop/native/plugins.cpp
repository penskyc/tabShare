// VST3 plugin slots (JUCE). See plugins.h.
#include "plugins.h"
#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_gui_basics/juce_gui_basics.h>
#include <array>
#include <atomic>
#include <mutex>

namespace plugins {
namespace {

struct EditorWindow : juce::DocumentWindow {
  std::function<void()> onClose;
  EditorWindow(const juce::String& name) : DocumentWindow(name, juce::Colours::black, DocumentWindow::closeButton | DocumentWindow::minimiseButton) {
    setUsingNativeTitleBar(true);
  }
  void closeButtonPressed() override { if (onClose) onClose(); }
};

struct Slot {
  std::mutex m;
  std::unique_ptr<juce::AudioPluginInstance> plugin;
  juce::AudioBuffer<float> buf;
  juce::MidiBuffer midi;
  int inCh = 0, outCh = 0;
  std::unique_ptr<EditorWindow> window;  // message thread only
};

std::array<Slot, kSlots> slots;
std::atomic<double> rate{48000};
std::atomic<int> block{512};

bool valid(int i) { return i >= 0 && i < kSlots; }

void prepareSlot(Slot& s) {
  auto& p = *s.plugin;
  // Ask for stereo in/out; plugins that refuse keep their default layout.
  juce::AudioProcessor::BusesLayout stereo;
  stereo.inputBuses.add(juce::AudioChannelSet::stereo());
  stereo.outputBuses.add(juce::AudioChannelSet::stereo());
  if (p.getBusCount(true) > 0 && p.checkBusesLayoutSupported(stereo)) p.setBusesLayout(stereo);
  p.setRateAndBufferSizeDetails(rate, block);
  p.prepareToPlay(rate, block);
  s.inCh = p.getTotalNumInputChannels();
  s.outCh = p.getTotalNumOutputChannels();
  s.buf.setSize(std::max({s.inCh, s.outCh, 1}), block, false, true, false);
}

juce::String stateOf(Slot& s) {
  juce::MemoryBlock mb;
  s.plugin->getStateInformation(mb);
  return mb.toBase64Encoding();
}

void closeEditor(int i) {
  auto& s = slots[i];
  if (!s.window) return;
  s.window.reset();  // owns the editor
  if (s.plugin && onEditorClosed) onEditorClosed(i, stateOf(s).toStdString());
}

}  // namespace

std::vector<std::string> list() {
  std::vector<std::string> out;
  juce::VST3PluginFormat fmt;
  for (auto& path : fmt.searchPathsForPlugins(fmt.getDefaultLocationsToSearch(), true, false)) out.push_back(path.toStdString());
  return out;
}

void prepare(double sampleRate, int blockSize) {
  rate = sampleRate;
  block = blockSize;
  for (auto& s : slots) {
    std::lock_guard lk(s.m);
    if (s.plugin) {
      s.plugin->releaseResources();
      prepareSlot(s);
    }
  }
}

std::string load(int i, const std::string& path, const std::string& state, std::string& name) {
  if (!valid(i)) return "slot out of range";
  juce::String error;
  juce::VST3PluginFormat fmt;
  juce::OwnedArray<juce::PluginDescription> types;
  fmt.findAllTypesForFile(types, juce::String(path));
  std::unique_ptr<juce::AudioPluginInstance> inst;
  if (types.isEmpty()) return "Not a loadable VST3: " + path;
  inst = fmt.createInstanceFromDescription(*types[0], rate, block, error);
  if (!inst) return error.isEmpty() ? "Couldn't load " + path : error.toStdString();
  name = inst->getName().toStdString();
  auto& s = slots[i];
  closeEditor(i);
  std::lock_guard lk(s.m);
  if (s.plugin) s.plugin->releaseResources();
  s.plugin = std::move(inst);
  prepareSlot(s);
  if (!state.empty()) {
    juce::MemoryBlock mb;
    if (mb.fromBase64Encoding(juce::String(state))) s.plugin->setStateInformation(mb.getData(), (int)mb.getSize());
  }
  return {};
}

void unload(int i) {
  if (!valid(i)) return;
  auto& s = slots[i];
  s.window.reset();
  std::lock_guard lk(s.m);
  if (s.plugin) s.plugin->releaseResources();
  s.plugin.reset();
}

void openEditor(int i) {
  if (!valid(i)) return;
  auto& s = slots[i];
  if (!s.plugin) return;
  // On macOS the plugin host is a background app (no Dock icon), so its windows would open behind tabShare with no way
  // to find them: bring it forward, and keep plugin windows floating like a DAW does.
  juce::Process::makeForegroundProcess();
  if (s.window) {
    s.window->toFront(true);
    return;
  }
  juce::AudioProcessorEditor* ed = s.plugin->hasEditor() ? s.plugin->createEditorIfNeeded() : nullptr;
  if (!ed) ed = new juce::GenericAudioProcessorEditor(*s.plugin);
  s.window = std::make_unique<EditorWindow>(s.plugin->getName() + " - tabShare");
  s.window->onClose = [i] { juce::MessageManager::callAsync([i] { closeEditor(i); }); };
  s.window->setContentOwned(ed, true);
  s.window->setResizable(ed->isResizable(), false);
  s.window->centreWithSize(s.window->getWidth(), s.window->getHeight());
  s.window->setAlwaysOnTop(true);
  s.window->setVisible(true);
  s.window->toFront(true);
}

std::string getState(int i) {
  if (!valid(i) || !slots[i].plugin) return {};
  return stateOf(slots[i]).toStdString();
}

int latency(int i) {
  if (!valid(i)) return 0;
  std::lock_guard lk(slots[i].m);
  return slots[i].plugin ? slots[i].plugin->getLatencySamples() : 0;
}

void process(int i, float* x, int n) {
  if (!valid(i)) return;
  auto& s = slots[i];
  std::unique_lock lk(s.m, std::try_to_lock);
  if (!lk.owns_lock() || !s.plugin || n > s.buf.getNumSamples()) return;
  // shortcut: the rig is mono, so the guitar feeds every plugin input and stereo outputs are folded back to mono.
  juce::AudioBuffer<float> view(s.buf.getArrayOfWritePointers(), s.buf.getNumChannels(), n);
  for (int ch = 0; ch < view.getNumChannels(); ch++) {
    if (ch < s.inCh) view.copyFrom(ch, 0, x, n);
    else view.clear(ch, 0, n);
  }
  s.midi.clear();
  s.plugin->processBlock(view, s.midi);
  if (s.outCh >= 2) {
    const float* l = view.getReadPointer(0);
    const float* r = view.getReadPointer(1);
    for (int k = 0; k < n; k++) x[k] = 0.5f * (l[k] + r[k]);
  } else if (s.outCh == 1) {
    std::copy_n(view.getReadPointer(0), n, x);
  }
}

}  // namespace plugins
