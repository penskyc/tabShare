#include "room.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>

#include "aoo/aoo_opus.h"
#include "aoo/aoo_pcm.h"
#include "oscpack/osc/OscOutboundPacketStream.h"
#include "oscpack/osc/OscReceivedElements.h"

#ifdef _WIN32
#pragma comment(lib, "ws2_32.lib")
#define CLOSESOCKET closesocket
#else
#include <arpa/inet.h>
#include <sys/socket.h>
#include <unistd.h>
#define CLOSESOCKET close
#define INVALID_SOCKET (-1)
#endif

namespace tsnet {

namespace {

double now() { return std::chrono::duration<double>(std::chrono::steady_clock::now().time_since_epoch()).count(); }

std::string key(const sockaddr_in &a) {
  char ip[INET_ADDRSTRLEN] = {};
  inet_ntop(AF_INET, &a.sin_addr, ip, sizeof ip);
  return std::string(ip) + ":" + std::to_string(ntohs(a.sin_port));
}

int32_t endpointSend(void *ep, const char *data, int32_t n) {
  auto e = static_cast<Endpoint *>(ep);
  return e->room->sendTo(e->addr, data, n);
}

int32_t clientSend(void *user, const char *data, int32_t n, void *addr) {
  auto sa = static_cast<const sockaddr *>(addr);
  if (sa->sa_family != AF_INET) return -1;
  return static_cast<Room *>(user)->sendTo(*static_cast<const sockaddr_in *>(addr), data, n);
}

constexpr float CENTER = 0.596f; // SonoBus's centred mono pan law (-4.5 dB per side)
constexpr int MAX_BLOCK = 4096;
constexpr double PING_INTERVAL = 2.0;

// AOO plays Opus sharp and with gaps when the audio block is bigger than the Opus frame (measured: block 64 or 120 with
// 120-sample frames clean; 128 and 256 not), so the frame is the smallest Opus size (120 x 2^k) that holds a block.
int opusFrameFor(int block) {
  int f = 120;
  while (f < block && f < 960) f *= 2;
  return f;
}

std::once_flag initOnce;

aoo::net::iserver *testServer = nullptr;
std::thread testServerThread;

} // namespace

Room::Room() : sock(INVALID_SOCKET) {
  std::call_once(initOnce, [] {
#ifdef _WIN32
    WSADATA wsa;
    WSAStartup(MAKEWORD(2, 2), &wsa); // AOO never calls it (JUCE did for SonoBus)
#endif
    aoo_initialize();
  });
}

Room::~Room() { stop(); }

int32_t Room::sendTo(const sockaddr_in &addr, const char *data, int32_t n) {
  if (sock == INVALID_SOCKET) return -1;
  return (int32_t)sendto(sock, data, n, 0, reinterpret_cast<const sockaddr *>(&addr), sizeof addr);
}

void Room::notifySend() {
  sendFlag = true;
  sendCv.notify_one();
}

// ---------------------------------------------------------------- lifecycle

void Room::start(const Config &c) {
  if (running) {
    const bool sameGroup = c.group == cfg.group && c.groupPassword == cfg.groupPassword && c.user == cfg.user &&
                           c.host == cfg.host && c.port == cfg.port;
    if (sameGroup) {
      // New stream rate/block: set every peer up again.
      std::unique_lock lock(peersMx);
      cfg.sampleRate = c.sampleRate;
      cfg.blockSize = std::min(c.blockSize, MAX_BLOCK);
      dummy->setup(cfg.sampleRate, cfg.blockSize, 1);
      for (auto &p : peers) setupPeer(*p);
      return;
    }
    stop();
  }
  cfg = c;
  cfg.blockSize = std::min(cfg.blockSize, MAX_BLOCK);
  format = cfg.format;

  sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
  if (sock == INVALID_SOCKET) {
    std::lock_guard l(stateMx);
    state = "error";
    error = "Couldn't open a network socket";
    return;
  }
  int big = 1 << 20;
  setsockopt(sock, SOL_SOCKET, SO_SNDBUF, reinterpret_cast<const char *>(&big), sizeof big);
  setsockopt(sock, SOL_SOCKET, SO_RCVBUF, reinterpret_cast<const char *>(&big), sizeof big);
#ifdef _WIN32
  DWORD tv = 20;
  // Windows reports ICMP "port unreachable" from an earlier sendto as a recv error; turn that off.
  BOOL off = FALSE;
  DWORD ret = 0;
  WSAIoctl(sock, _WSAIOW(IOC_VENDOR, 12), &off, sizeof off, nullptr, 0, &ret, nullptr, nullptr); // SIO_UDP_CONNRESET
#else
  timeval tv{0, 20000};
#endif
  setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char *>(&tv), sizeof tv);
  sockaddr_in bindAddr{};
  bindAddr.sin_family = AF_INET;
  bindAddr.sin_addr.s_addr = htonl(INADDR_ANY);
  bindAddr.sin_port = 0;
  bind(sock, reinterpret_cast<sockaddr *>(&bindAddr), sizeof bindAddr);
  socklen_t len = sizeof bindAddr;
  getsockname(sock, reinterpret_cast<sockaddr *>(&bindAddr), &len);
  localPort = ntohs(bindAddr.sin_port);

  dummy = aoo::isource::create(0);
  dummy->setup(cfg.sampleRate, cfg.blockSize, 1);
  client = aoo::net::iclient::create(this, clientSend, localPort);

  running = true;
  recvThread = std::thread(&Room::recvLoop, this);
  sendThread = std::thread(&Room::sendLoop, this);
  eventThread = std::thread(&Room::eventLoop, this);
  clientThread = std::thread([this] { client->run(); });
  connect();
}

void Room::connect() {
  {
    std::lock_guard l(stateMx);
    state = "connecting";
    error.clear();
    joined = false;
  }
  client->connect(cfg.host.c_str(), cfg.port, cfg.user.c_str(), "");
  notifySend();
}

void Room::stop() {
  if (!running) return;
  if (joined) client->group_leave(cfg.group.c_str());
  client->disconnect();
  // Give the leave/disconnect a moment to go out before the client thread stops.
  std::this_thread::sleep_for(std::chrono::milliseconds(50));
  client->quit();
  running = false;
  sendCv.notify_all();
  for (auto *t : {&clientThread, &recvThread, &sendThread, &eventThread})
    if (t->joinable()) t->join();
  closeAll();
}

void Room::closeAll() {
  removeAllPeers();
  if (client) aoo::net::iclient::destroy(client);
  client = nullptr;
  if (dummy) aoo::isource::destroy(dummy);
  dummy = nullptr;
  if (sock != INVALID_SOCKET) CLOSESOCKET(sock);
  sock = INVALID_SOCKET;
  {
    std::lock_guard l(epMx);
    endpoints.clear();
  }
  std::lock_guard l(stateMx);
  state = "off";
  joined = false;
  failed.clear();
}

// ---------------------------------------------------------------- peers

Endpoint *Room::endpointFor(const sockaddr_in &addr) {
  std::lock_guard l(epMx);
  auto &e = endpoints[key(addr)];
  if (!e) e.reset(new Endpoint{this, addr});
  return e.get();
}

Peer *Room::peerByEndpoint(void *ep) {
  for (auto &p : peers)
    if (p->ep == ep) return p.get();
  return nullptr;
}

void Room::applyFormat(aoo::isource *src) {
  aoo_format_storage st{};
  const int f = format;
  if (f <= 1) {
    auto *o = reinterpret_cast<aoo_format_opus *>(&st);
    o->header.codec = AOO_CODEC_OPUS;
    o->header.blocksize = opusFrameFor(cfg.blockSize);
    o->bitrate = f == 0 ? 96000 : 128000;
    o->complexity = 10;
    o->signal_type = OPUS_SIGNAL_MUSIC;
    o->application_type = OPUS_APPLICATION_RESTRICTED_LOWDELAY;
  } else {
    auto *p = reinterpret_cast<aoo_format_pcm *>(&st);
    p->header.codec = AOO_CODEC_PCM;
    p->header.blocksize = std::max(cfg.blockSize, 16);
    p->header.samplerate = cfg.sampleRate;
    p->header.nchannels = 1;
    p->bitdepth = f == 2 ? AOO_PCM_INT16 : AOO_PCM_INT24;
  }
  src->set_format(st.header);
}

void Room::setupPeer(Peer &p) {
  const int32_t flags = AOO_PROTOCOL_FLAG_COMPACT_DATA;
  p.work.assign(2 * cfg.blockSize, 0.0f);
  p.sink->setup(cfg.sampleRate, cfg.blockSize, 2);
  p.sink->set_buffersize((int32_t)std::lround(p.bufferMs.load()));
  p.sink->set_option(aoo_opt_protocol_flags, (void *)&flags, sizeof flags);
  p.sink->set_dynamic_resampling(0);
  applyFormat(p.source);
  p.source->setup(cfg.sampleRate, cfg.blockSize, 1);
  p.source->set_buffersize((int32_t)std::max(10.0, 2.0 * 1000 * cfg.blockSize / cfg.sampleRate));
  p.source->set_packetsize(600);
  p.source->set_ping_interval(2000);
  p.source->set_respect_codec_change_requests(1);
  p.source->set_dynamic_resampling(0);
}

void Room::addPeer(const std::string &user, const sockaddr_in &addr) {
  Endpoint *ep = endpointFor(addr);
  std::unique_lock lock(peersMx);
  if (peerByEndpoint(ep)) return;
  int id = 1;
  while (std::any_of(peers.begin(), peers.end(), [&](auto &p) { return p->id == id; })) id++;
  auto p = std::make_unique<Peer>();
  p->id = id;
  p->user = user;
  p->ep = ep;
  p->linkedAt = p->lastIncrease = now();
  {
    std::lock_guard l(prefsMx);
    auto it = prefs.find(user);
    if (it != prefs.end()) {
      p->gain = it->second.gain;
      if (it->second.bufferMs > 0) {
        p->autoBuffer = false;
        p->bufferMs = it->second.bufferMs;
      }
    }
    failed.erase(std::remove(failed.begin(), failed.end(), user), failed.end());
  }
  if (p->autoBuffer) p->bufferMs = 1000.0 * cfg.blockSize / cfg.sampleRate; // start at one block, grow on drops
  p->sink = aoo::isink::create(id);
  p->source = aoo::isource::create(id);
  setupPeer(*p);
  // Invite their dummy source 0 (SonoBus convention); they invite back with their real id.
  p->sink->invite_source(ep, 0, endpointSend);
  if (sending) p->source->start();
  peers.push_back(std::move(p));
  notifySend();
}

void Room::removePeer(const sockaddr_in &addr) {
  Endpoint *ep = endpointFor(addr);
  std::unique_lock lock(peersMx);
  auto it = std::find_if(peers.begin(), peers.end(), [&](auto &p) { return p->ep == ep; });
  if (it == peers.end()) return;
  aoo::isink::destroy((*it)->sink);
  aoo::isource::destroy((*it)->source);
  peers.erase(it);
}

void Room::removeAllPeers() {
  std::unique_lock lock(peersMx);
  for (auto &p : peers) {
    aoo::isink::destroy(p->sink);
    aoo::isource::destroy(p->source);
  }
  peers.clear();
}

void Room::setSending(bool on) {
  if (sending.exchange(on) == on) return;
  std::shared_lock lock(peersMx);
  for (auto &p : peers) on ? p->source->start() : p->source->stop();
}

void Room::setFormat(int index) {
  format = std::clamp(index, 0, 3);
  std::shared_lock lock(peersMx);
  for (auto &p : peers) applyFormat(p->source);
}

void Room::setPeer(const std::string &user, float gain, double bufferMs) {
  {
    std::lock_guard l(prefsMx);
    prefs[user] = {gain, bufferMs};
  }
  std::shared_lock lock(peersMx);
  for (auto &p : peers) {
    if (p->user != user) continue;
    p->gain = gain;
    if (bufferMs > 0) {
      p->autoBuffer = false;
      p->bufferMs = bufferMs;
      p->sink->set_buffersize((int32_t)std::lround(bufferMs));
    } else if (!p->autoBuffer) {
      p->autoBuffer = true;
      p->baseline = 0;
    }
  }
}

// ---------------------------------------------------------------- audio

void Room::process(const float *in, float *out, int n) {
  if (!running || n > cfg.blockSize) return;
  std::shared_lock lock(peersMx, std::try_to_lock);
  if (!lock.owns_lock()) return; // a peer is being added/removed: skip this block rather than wait
  const uint64_t t = aoo_osctime_get();
  for (auto &p : peers) {
    float *ch[2] = {p->work.data(), p->work.data() + cfg.blockSize};
    std::fill(p->work.begin(), p->work.end(), 0.0f);
    p->sink->process(ch, n, t);
    float peak = 0;
    for (int i = 0; i < n; i++) peak = std::max(peak, std::abs(ch[0][i]));
    p->level = std::max(p->level.load(std::memory_order_relaxed), peak);
    if (peak > 1e-6f) p->receiving.store(true, std::memory_order_relaxed);
    const float g = p->safetyMuted ? 0.0f : p->gain.load() * CENTER;
    if (g == 0.0f) continue;
    for (int i = 0; i < n; i++) {
      out[2 * i] += ch[0][i] * g;
      out[2 * i + 1] += ch[0][i] * g;
    }
  }
  if (in && sending)
    for (auto &p : peers) {
      const aoo_sample *chans[1] = {in};
      p->source->process(chans, n, t);
    }
  notifySend();
}

// ---------------------------------------------------------------- threads

void Room::recvLoop() {
  char buf[AOO_MAXPACKETSIZE];
  while (running) {
    sockaddr_in from{};
    socklen_t len = sizeof from;
    const int n = (int)recvfrom(sock, buf, sizeof buf, 0, reinterpret_cast<sockaddr *>(&from), &len);
    if (n <= 0 || from.sin_family != AF_INET) continue;
    int32_t type = -1, id = 0;
    if (aoo_parse_pattern(buf, n, &type, &id) > 0 || aoonet_parse_pattern(buf, n, &type) > 0) {
      if (type == AOO_TYPE_CLIENT || type == AOO_TYPE_PEER) {
        client->handle_message(buf, n, &from);
      } else if (type == AOO_TYPE_SINK || type == AOO_TYPE_SOURCE) {
        Endpoint *ep = endpointFor(from);
        std::shared_lock lock(peersMx);
        if (type == AOO_TYPE_SOURCE && id == 0) {
          dummy->handle_message(buf, n, ep, endpointSend);
        } else if (type == AOO_TYPE_SOURCE) {
          for (auto &p : peers)
            if (p->id == id || id == AOO_ID_WILDCARD) p->source->handle_message(buf, n, ep, endpointSend);
        } else if (id == AOO_ID_NONE) { // compact data: whichever sink takes it
          for (auto &p : peers)
            if (p->ep == ep && p->sink->handle_message(buf, n, ep, endpointSend)) break;
        } else {
          for (auto &p : peers)
            if (p->id == id || id == AOO_ID_WILDCARD) p->sink->handle_message(buf, n, ep, endpointSend);
        }
      }
      notifySend();
    } else if (n > 3 && std::memcmp(buf, "/sb", 3) == 0) {
      handleSb(buf, n, endpointFor(from));
    }
  }
}

void Room::handleSb(const char *data, int32_t n, Endpoint *ep) {
  try {
    osc::ReceivedPacket packet(data, n);
    if (!packet.IsMessage()) return;
    osc::ReceivedMessage msg(packet);
    const std::string addr = msg.AddressPattern();
    auto it = msg.ArgumentsBegin();
    if (addr == "/sb/ping") {
      const uint64_t tt = (it++)->AsTimeTag();
      char out[256];
      osc::OutboundPacketStream o(out, sizeof out);
      o << osc::BeginMessage("/sb/pngack") << osc::TimeTag(tt) << osc::TimeTag(aoo_osctime_get()) << osc::EndMessage;
      endpointSend(ep, o.Data(), (int32_t)o.Size());
    } else if (addr == "/sb/pngack") {
      const uint64_t tt1 = (it++)->AsTimeTag();
      const double rtt = aoo_osctime_duration(tt1, aoo_osctime_get()) * 1000.0;
      if (rtt < 0 || rtt > 2000) return;
      std::shared_lock lock(peersMx);
      if (Peer *p = peerByEndpoint(ep)) {
        const double old = p->rttMs;
        p->rttMs = old < 0 ? rtt : old * 0.7 + rtt * 0.3;
      }
    }
  } catch (const osc::Exception &) {
    // malformed: ignore
  }
}

void Room::sendLoop() {
  while (running) {
    {
      std::unique_lock l(sendMx);
      sendCv.wait_for(l, std::chrono::milliseconds(20), [this] { return sendFlag.load() || !running; });
      sendFlag = false;
    }
    if (!running) break;
    dummy->send();
    client->send();
    std::shared_lock lock(peersMx);
    const double t = now();
    for (auto &p : peers) {
      p->source->send();
      p->sink->send();
      if (t - p->lastPing >= PING_INTERVAL) {
        p->lastPing = t;
        char out[128];
        osc::OutboundPacketStream o(out, sizeof out);
        o << osc::BeginMessage("/sb/ping") << osc::TimeTag(aoo_osctime_get()) << osc::EndMessage;
        endpointSend(p->ep, o.Data(), (int32_t)o.Size());
      }
    }
  }
}

void Room::eventLoop() {
  while (running) {
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
    client->handle_events(
        [](void *user, const aoo_event **ev, int32_t n) -> int32_t {
          static_cast<Room *>(user)->handleClientEvents(ev, n);
          return 1;
        },
        this);
    {
      std::shared_lock lock(peersMx);
      dummy->handle_events(
          [](void *user, const aoo_event **ev, int32_t n) -> int32_t {
            static_cast<Room *>(user)->handleDummyEvents(ev, n);
            return 1;
          },
          this);
      struct Ctx { Room *room; Peer *peer; };
      const double t = now();
      for (auto &p : peers) {
        Ctx ctx{this, p.get()};
        p->source->handle_events(
            [](void *user, const aoo_event **ev, int32_t n) -> int32_t {
              auto c = static_cast<Ctx *>(user);
              c->room->handlePeerEvents(*c->peer, true, ev, n);
              return 1;
            },
            &ctx);
        p->sink->handle_events(
            [](void *user, const aoo_event **ev, int32_t n) -> int32_t {
              auto c = static_cast<Ctx *>(user);
              c->room->handlePeerEvents(*c->peer, false, ev, n);
              return 1;
            },
            &ctx);
        autoBufferTick(*p, t);
      }
    }
    // Server connection lost: try again every second; peers keep playing meanwhile.
    bool retry = false;
    {
      std::lock_guard l(stateMx);
      if (reconnectAt > 0 && now() >= reconnectAt) {
        reconnectAt = 0;
        retry = true;
      }
    }
    if (retry) connect();
  }
}

void Room::handleClientEvents(const aoo_event **events, int32_t n) {
  for (int i = 0; i < n; i++) {
    switch (events[i]->type) {
    case AOONET_CLIENT_CONNECT_EVENT: {
      auto e = reinterpret_cast<const aoonet_client_event *>(events[i]);
      std::lock_guard l(stateMx);
      if (e->result > 0) {
        client->group_join(cfg.group.c_str(), cfg.groupPassword.c_str());
      } else {
        state = "error";
        error = e->errormsg ? e->errormsg : "Couldn't reach the room audio server";
        reconnectAt = now() + 5;
      }
      break;
    }
    case AOONET_CLIENT_DISCONNECT_EVENT: {
      std::lock_guard l(stateMx);
      if (!running) break;
      state = "connecting";
      joined = false;
      reconnectAt = now() + 1;
      break;
    }
    case AOONET_CLIENT_GROUP_JOIN_EVENT: {
      auto e = reinterpret_cast<const aoonet_client_group_event *>(events[i]);
      std::lock_guard l(stateMx);
      if (e->result > 0) {
        state = "connected";
        joined = true;
      } else {
        state = "error";
        error = e->errormsg ? e->errormsg : "Couldn't join the room's audio group";
      }
      break;
    }
    case AOONET_CLIENT_PEER_JOIN_EVENT: {
      auto e = reinterpret_cast<const aoonet_client_peer_event *>(events[i]);
      if (e->address && e->user && std::string(e->group ? e->group : "") == cfg.group)
        addPeer(e->user, *static_cast<const sockaddr_in *>(e->address));
      break;
    }
    case AOONET_CLIENT_PEER_JOINFAIL_EVENT: {
      auto e = reinterpret_cast<const aoonet_client_peer_event *>(events[i]);
      std::lock_guard l(prefsMx);
      if (e->user && std::find(failed.begin(), failed.end(), e->user) == failed.end()) failed.push_back(e->user);
      break;
    }
    case AOONET_CLIENT_PEER_LEAVE_EVENT: {
      auto e = reinterpret_cast<const aoonet_client_peer_event *>(events[i]);
      if (e->address) removePeer(*static_cast<const sockaddr_in *>(e->address));
      break;
    }
    case AOONET_CLIENT_GROUP_LEAVE_EVENT:
      removeAllPeers();
      break;
    default:
      break;
    }
  }
}

// Invites to our dummy source 0: a peer that saw us join asks for our audio. Answer from that peer's own source and
// invite back (SonoBus assumes our source id == our sink id). Caller holds peersMx (shared).
void Room::handleDummyEvents(const aoo_event **events, int32_t n) {
  for (int i = 0; i < n; i++) {
    if (events[i]->type != AOO_INVITE_EVENT) continue;
    auto e = reinterpret_cast<const aoo_sink_event *>(events[i]);
    Peer *p = peerByEndpoint(e->endpoint);
    if (!p) continue; // not known in the group yet; their later invite (or ours) completes the handshake
    int32_t flags = e->flags;
    p->source->add_sink(e->endpoint, e->id, endpointSend);
    p->source->set_sinkoption(e->endpoint, e->id, aoo_opt_protocol_flags, &flags, sizeof flags);
    if (sending) p->source->start();
    p->sink->invite_source(e->endpoint, e->id, endpointSend);
    p->linked = true;
  }
}

void Room::handlePeerEvents(Peer &p, bool source, const aoo_event **events, int32_t n) {
  const double t = now();
  for (int i = 0; i < n; i++) {
    const int type = events[i]->type;
    if (source) {
      if (type == AOO_INVITE_EVENT) {
        auto e = reinterpret_cast<const aoo_sink_event *>(events[i]);
        int32_t flags = e->flags;
        p.source->add_sink(e->endpoint, e->id, endpointSend);
        p.source->set_sinkoption(e->endpoint, e->id, aoo_opt_protocol_flags, &flags, sizeof flags);
        if (sending) p.source->start();
        p.linked = true;
      } else if (type == AOO_UNINVITE_EVENT) {
        p.source->remove_all();
      }
      continue;
    }
    switch (type) {
    case AOO_SOURCE_ADD_EVENT: {
      auto e = reinterpret_cast<const aoo_source_event *>(events[i]);
      if (e->id == 0) break; // the bogus id-0 entry from our first invite
      p.remoteSourceId = e->id;
      p.sink->uninvite_source(e->endpoint, 0, endpointSend);
      p.sink->invite_source(e->endpoint, e->id, endpointSend);
      p.linked = true;
      break;
    }
    case AOO_SOURCE_STATE_EVENT: {
      auto e = reinterpret_cast<const aoo_source_state_event *>(events[i]);
      p.receiving = e->state == AOO_SOURCE_STATE_PLAY;
      break;
    }
    case AOO_BLOCK_LOST_EVENT: {
      auto e = reinterpret_cast<const aoo_block_lost_event *>(events[i]);
      p.drops += e->count;
      p.recentDrops += e->count;
      // AutoFull: grow by one block when drops come faster than 0.5/s, checked at most every 0.5 s.
      if (p.autoBuffer && t - p.lastIncrease > 0.5 && p.recentDrops / (t - p.lastIncrease) > 0.5) {
        p.bufferMs = std::min(250.0, p.bufferMs.load() + 1000.0 * cfg.blockSize / cfg.sampleRate);
        p.sink->set_buffersize((int32_t)std::lround(p.bufferMs.load()));
        if (t - p.lastDecrease < 2.0) p.baseline = p.bufferMs; // drops came back right after shrinking: floor here
        p.lastIncrease = t;
        p.recentDrops = 0;
      }
      p.lastDrop = t;
      break;
    }
    default:
      break;
    }
  }
}

// AutoFull shrink: one block after 10 s without drops, never below the level where drops last came back. Also lifts
// the new-peer safety mute once the stream is clean (SonoBus mutes new peers until the buffer settles).
void Room::autoBufferTick(Peer &p, double t) {
  if (p.safetyMuted && p.receiving && (t - p.lastDrop > 0.75 || p.bufferMs > 15) && t - p.linkedAt > 0.5)
    p.safetyMuted = false;
  if (!p.autoBuffer || t - p.lastDrop < 10 || t - p.lastDecrease < 10) return;
  const double block = 1000.0 * cfg.blockSize / cfg.sampleRate;
  const double next = std::max({p.baseline, block, p.bufferMs - block});
  if (next < p.bufferMs) {
    p.bufferMs = next;
    p.sink->set_buffersize((int32_t)std::lround(next));
  }
  p.lastDecrease = t;
}

Status Room::status() {
  Status s;
  {
    std::lock_guard l(stateMx);
    s.state = state;
    s.error = error;
  }
  {
    std::lock_guard l(prefsMx);
    s.failed = failed;
  }
  std::shared_lock lock(peersMx);
  const double block = 1000.0 * cfg.blockSize / cfg.sampleRate;
  for (auto &p : peers) {
    const double rtt = p->rttMs;
    // What you hear is this late: half the round trip + their jitter buffer + a block each side.
    const double lat = rtt < 0 ? -1 : rtt / 2 + p->bufferMs + 2 * block;
    s.peers.push_back({p->user, p->linked.load(), p->receiving.load(), p->safetyMuted.load(), p->autoBuffer.load(), lat,
                       rtt, p->bufferMs.load(), p->level.exchange(0.0f), p->drops.load()});
  }
  return s;
}

// ---------------------------------------------------------------- test server

bool Room::startServer(int port) {
  if (testServer) return true;
  Room warm; // runs WSAStartup + aoo_initialize
  int32_t err = 0;
  testServer = aoo::net::iserver::create(port, &err);
  if (!testServer) return false;
  testServerThread = std::thread([] { testServer->run(); });
  return true;
}

void Room::stopServer() {
  if (!testServer) return;
  testServer->quit();
  if (testServerThread.joinable()) testServerThread.join();
  aoo::net::iserver::destroy(testServer);
  testServer = nullptr;
}

} // namespace tsnet
