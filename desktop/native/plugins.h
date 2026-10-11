// VST3 plugin slots (JUCE), shared by the in-process addon (Windows, vst.cpp) and the macOS plugin host (host.cpp).
// Everything except process() must run on the JUCE message thread. Plugins sit in fixed slots so process() never sees
// a container change; a per-slot mutex (try_lock on the audio side) covers load/unload.
#pragma once
#include <functional>
#include <string>
#include <vector>

namespace plugins {

constexpr int kSlots = 16;

/** Called on the message thread when a plugin window closes, with the plugin's state (base64). */
inline std::function<void(int slot, const std::string& state)> onEditorClosed;

/** Installed .vst3 bundles (file system only; nothing is loaded, so a broken plugin can't crash the list). */
std::vector<std::string> list();
/** Sets the stream format and re-prepares loaded plugins. */
void prepare(double sampleRate, int blockSize);
/** Loads into a slot (replacing what's there). Returns "" on success, else the error; `name` gets the plugin name. */
std::string load(int slot, const std::string& path, const std::string& stateBase64, std::string& name);
void unload(int slot);
/** The plugin's own window (or a generic one if it has none). */
void openEditor(int slot);
/** Base64 state, "" when the slot is empty. */
std::string getState(int slot);
/** Samples the plugin reports it delays the signal by. Any thread. */
int latency(int slot);
/** Audio thread: mono, in place. Passes audio through untouched if the slot is empty, busy or out of range. */
void process(int slot, float* x, int n);

}  // namespace plugins
