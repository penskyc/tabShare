// tabshare_net.node: JS wrapper around tsnet::Room (see room.hpp). Used by desktop/engine.mjs.
//   const room = new Room(); room.start({ user, group, groupPassword, host, port, sampleRate, blockSize, format });
//   room.process(monoIn | null, stereoOut)   // in the audio callback; Float32Arrays, no copies
//   room.setSending(bool); room.setFormat(i); room.setPeer(user, { gain, bufferMs }); room.status(); room.stop();
//   startTestServer(port) / stopTestServer()  // a local connection server, for tests
#include <napi.h>

#include "room.hpp"

namespace {

std::string str(const Napi::Object &o, const char *k, const std::string &def = "") {
  auto v = o.Get(k);
  return v.IsString() ? v.As<Napi::String>().Utf8Value() : def;
}
int num(const Napi::Object &o, const char *k, int def) {
  auto v = o.Get(k);
  return v.IsNumber() ? v.As<Napi::Number>().Int32Value() : def;
}

class RoomWrap : public Napi::ObjectWrap<RoomWrap> {
public:
  static Napi::Function Init(Napi::Env env) {
    return DefineClass(env, "Room",
                       {InstanceMethod("start", &RoomWrap::Start), InstanceMethod("stop", &RoomWrap::Stop),
                        InstanceMethod("process", &RoomWrap::Process), InstanceMethod("setSending", &RoomWrap::SetSending),
                        InstanceMethod("setFormat", &RoomWrap::SetFormat), InstanceMethod("setPeer", &RoomWrap::SetPeer),
                        InstanceMethod("status", &RoomWrap::GetStatus)});
  }
  RoomWrap(const Napi::CallbackInfo &info) : Napi::ObjectWrap<RoomWrap>(info) {}

private:
  tsnet::Room room;

  Napi::Value Start(const Napi::CallbackInfo &info) {
    auto o = info[0].As<Napi::Object>();
    tsnet::Config c;
    c.user = str(o, "user");
    c.group = str(o, "group");
    c.groupPassword = str(o, "groupPassword");
    c.host = str(o, "host", "aoo.sonobus.net");
    c.port = num(o, "port", 10998);
    c.sampleRate = num(o, "sampleRate", 48000);
    c.blockSize = num(o, "blockSize", 128);
    c.format = num(o, "format", 1);
    if (c.user.empty() || c.group.empty() || c.sampleRate <= 0 || c.blockSize <= 0) {
      Napi::TypeError::New(info.Env(), "start: user, group, sampleRate and blockSize are required").ThrowAsJavaScriptException();
      return info.Env().Undefined();
    }
    room.start(c);
    return info.Env().Undefined();
  }
  Napi::Value Stop(const Napi::CallbackInfo &info) {
    room.stop();
    return info.Env().Undefined();
  }
  Napi::Value Process(const Napi::CallbackInfo &info) {
    const float *in = info[0].IsTypedArray() ? info[0].As<Napi::Float32Array>().Data() : nullptr;
    auto out = info[1].As<Napi::Float32Array>();
    const int n = (int)(out.ElementLength() / 2);
    if (in && info[0].As<Napi::Float32Array>().ElementLength() < (size_t)n) in = nullptr;
    room.process(in, out.Data(), n);
    return info.Env().Undefined();
  }
  Napi::Value SetSending(const Napi::CallbackInfo &info) {
    room.setSending(info[0].ToBoolean().Value());
    return info.Env().Undefined();
  }
  Napi::Value SetFormat(const Napi::CallbackInfo &info) {
    room.setFormat(info[0].ToNumber().Int32Value());
    return info.Env().Undefined();
  }
  Napi::Value SetPeer(const Napi::CallbackInfo &info) {
    auto o = info[1].As<Napi::Object>();
    const float gain = o.Get("gain").IsNumber() ? o.Get("gain").As<Napi::Number>().FloatValue() : 1.0f;
    const double bufferMs = o.Get("bufferMs").IsNumber() ? o.Get("bufferMs").As<Napi::Number>().DoubleValue() : 0;
    room.setPeer(info[0].As<Napi::String>().Utf8Value(), std::clamp(gain, 0.0f, 2.0f), std::clamp(bufferMs, 0.0, 250.0));
    return info.Env().Undefined();
  }
  Napi::Value GetStatus(const Napi::CallbackInfo &info) {
    auto env = info.Env();
    auto s = room.status();
    auto o = Napi::Object::New(env);
    o.Set("state", s.state);
    if (!s.error.empty()) o.Set("error", s.error);
    auto peers = Napi::Array::New(env, s.peers.size());
    for (size_t i = 0; i < s.peers.size(); i++) {
      auto &p = s.peers[i];
      auto po = Napi::Object::New(env);
      po.Set("user", p.user);
      po.Set("linked", p.linked);
      po.Set("receiving", p.receiving);
      po.Set("muted", p.muted);
      po.Set("auto", p.autoBuffer);
      po.Set("latencyMs", p.latencyMs);
      po.Set("rttMs", p.rttMs);
      po.Set("bufferMs", p.bufferMs);
      po.Set("level", p.level);
      po.Set("drops", (double)p.drops);
      peers.Set((uint32_t)i, po);
    }
    o.Set("peers", peers);
    auto failed = Napi::Array::New(env, s.failed.size());
    for (size_t i = 0; i < s.failed.size(); i++) failed.Set((uint32_t)i, s.failed[i]);
    o.Set("failed", failed);
    return o;
  }
};

Napi::Value StartTestServer(const Napi::CallbackInfo &info) {
  return Napi::Boolean::New(info.Env(), tsnet::Room::startServer(info[0].ToNumber().Int32Value()));
}
Napi::Value StopTestServer(const Napi::CallbackInfo &info) {
  tsnet::Room::stopServer();
  return info.Env().Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("Room", RoomWrap::Init(env));
  exports.Set("startTestServer", Napi::Function::New(env, StartTestServer));
  exports.Set("stopTestServer", Napi::Function::New(env, StopTestServer));
  return exports;
}

} // namespace

NODE_API_MODULE(tabshare_net, Init)
