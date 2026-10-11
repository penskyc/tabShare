// window.tabshareNative inside the WebView: the same API the desktop app's preload exposes (src/rig/native.ts), so the
// page's native rig branch drives the iOS engine unchanged. Float32Array samples cross as base64 (WebView messages are
// strings). Injected before the page loads, into the server's own pages only.
export function bridgeScript(origin: string) {
  return `(function () {
  if (window.tabshareNative || location.origin !== ${JSON.stringify(origin)}) return;
  var listeners = new Set();
  function toF32(b64) {
    var bin = atob(b64), u = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return new Float32Array(u.buffer);
  }
  function fromF32(a) {
    var u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength), s = '';
    for (var i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(s);
  }
  window.__tabshareNativeReceive = function (m) {
    if (typeof m.samples === 'string') m.samples = toF32(m.samples);
    listeners.forEach(function (l) { l(m); });
  };
  window.tabshareNative = {
    platform: 'ios',
    send: function (msg) {
      var m = Object.assign({}, msg);
      if (m.samples instanceof Float32Array) m.samples = fromF32(m.samples);
      window.ReactNativeWebView.postMessage(JSON.stringify(m));
    },
    onMessage: function (cb) { listeners.add(cb); return function () { listeners.delete(cb); }; },
  };
})(); true;`;
}

/** Page -> engine messages the bridge accepts (anything else from the page is ignored). */
const ENGINE_MESSAGES = new Set(['devices', 'start', 'stop', 'params', 'loadModel', 'unloadModel', 'ir', 'tap', 'vstList']);

// Checked from the leading `{"type":"…"` (JSON.stringify keeps key order) so multi-MB model messages aren't parsed twice.
export function isEngineMessage(json: string) {
  const type = /^\{"type":"(\w+)"/.exec(json)?.[1];
  return !!type && ENGINE_MESSAGES.has(type);
}
