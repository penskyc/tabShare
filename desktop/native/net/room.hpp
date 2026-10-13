// Room audio: SonoBus-compatible networking (AOO) for one tabShare room. One UDP socket, a client connection to the
// connection server, and per remote peer one AOO sink (their audio in) + one source (our instrument out).
// Threads and handshake follow SonoBus (docs/superpowers/specs/2026-10-13-aoo-brief.md). process() is the only call
// made from the audio callback: it never blocks (try-lock) and doesn't allocate.
#pragma once
#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <map>
#include <memory>
#include <mutex>
#include <shared_mutex>
#include <string>
#include <thread>
#include <vector>

#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
using socket_t = SOCKET;
#else
#include <netinet/in.h>
using socket_t = int;
#endif

#include "aoo/aoo.hpp"
#include "aoo/aoo_net.hpp"

namespace tsnet {

struct Config {
  std::string user, group, groupPassword, host;
  int port = 10998;
  int sampleRate = 48000;
  int blockSize = 128;
  int format = 1; // 0 Opus 96, 1 Opus 128, 2 PCM 16, 3 PCM 24
};

struct PeerStatus {
  std::string user;
  bool linked, receiving, muted, autoBuffer;
  double latencyMs, rttMs, bufferMs, level;
  int64_t drops;
};

struct Status {
  std::string state; // off | connecting | connected | error
  std::string error;
  std::vector<PeerStatus> peers;
  std::vector<std::string> failed; // users whose direct link couldn't be made
};

class Room;

struct Endpoint {
  Room *room;
  sockaddr_in addr;
};

struct Peer {
  int id = 0;
  std::string user;
  Endpoint *ep = nullptr;
  aoo::isink *sink = nullptr;
  aoo::isource *source = nullptr;
  std::atomic<int> remoteSourceId{AOO_ID_NONE};
  std::atomic<bool> receiving{false};
  std::atomic<bool> linked{false};
  std::atomic<bool> safetyMuted{true};
  std::atomic<float> gain{1.0f};
  std::atomic<float> level{0.0f};
  std::atomic<double> rttMs{-1};
  std::atomic<int64_t> drops{0};
  // Jitter buffer (events thread only, except bufferMs which status() reads).
  std::atomic<double> bufferMs{1};
  std::atomic<bool> autoBuffer{true};
  double baseline = 0, lastDrop = -1e9, lastDecrease = -1e9, lastIncrease = 0, linkedAt = 0;
  double lastPing = -1e9;
  int64_t recentDrops = 0;
  std::vector<float> work; // 2 channels x block
};

class Room {
public:
  Room();
  ~Room();
  /** Connects and joins; calling again while running re-applies rate/block (and reconnects if the group changed). */
  void start(const Config &c);
  void stop();
  /** Audio thread: adds the peers' mix into out (interleaved stereo) and sends `in` (mono, may be null). */
  void process(const float *in, float *out, int n);
  void setSending(bool on);
  void setFormat(int index);
  /** bufferMs <= 0: automatic. Remembered by user, applied when that peer links. */
  void setPeer(const std::string &user, float gain, double bufferMs);
  Status status();

  // Test helper: a local AOO connection server.
  static bool startServer(int port);
  static void stopServer();

  // Called from AOO callbacks.
  int32_t sendTo(const sockaddr_in &addr, const char *data, int32_t n);

private:
  void recvLoop();
  void sendLoop();
  void eventLoop();
  void notifySend();
  void handleClientEvents(const aoo_event **events, int32_t n);
  void handlePeerEvents(Peer &p, bool source, const aoo_event **events, int32_t n);
  void handleDummyEvents(const aoo_event **events, int32_t n);
  void handleSb(const char *data, int32_t n, Endpoint *ep);
  Endpoint *endpointFor(const sockaddr_in &addr);
  Peer *peerByEndpoint(void *ep); // caller holds peersMx
  void addPeer(const std::string &user, const sockaddr_in &addr);
  void removePeer(const sockaddr_in &addr);
  void removeAllPeers();
  void setupPeer(Peer &p);
  void applyFormat(aoo::isource *src);
  void autoBufferTick(Peer &p, double now);
  void connect();
  void closeAll();

  Config cfg;
  socket_t sock;
  int localPort = 0;
  aoo::net::iclient *client = nullptr;
  aoo::isource *dummy = nullptr;
  std::thread recvThread, sendThread, eventThread, clientThread;
  std::atomic<bool> running{false};
  std::atomic<bool> sending{false};
  std::atomic<int> format{1};

  std::mutex sendMx;
  std::condition_variable sendCv;
  std::atomic<bool> sendFlag{false};

  std::mutex epMx;
  std::map<std::string, std::unique_ptr<Endpoint>> endpoints;

  std::shared_mutex peersMx;
  std::vector<std::unique_ptr<Peer>> peers;

  std::mutex prefsMx;
  struct Pref { float gain; double bufferMs; };
  std::map<std::string, Pref> prefs;
  std::vector<std::string> failed;

  std::mutex stateMx;
  std::string state = "off", error;
  bool joined = false;
  double reconnectAt = 0;
};

} // namespace tsnet
