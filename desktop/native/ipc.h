// Wire format between the macOS plugin host (host.cpp) and the addon that drives it (vst.cpp), over two socketpairs.
// Control (fd 3 in the host): frames of [u32 length][fields joined by '\0'].
//   request  id, op, slot, args...       ops: list, prepare(rate, block), load(path, state), unload, editor, state
//   reply    id, "ok" | "err", values...  (unload and editor get no reply)
//   event    "0", type, slot, payload     (editorClosed)
// Audio (fd 4 in the host): request [AudioHeader][n floats], reply the same with the processed samples.
#pragma once
#include <cerrno>
#include <cstdint>
#include <string>
#include <unistd.h>
#include <vector>

namespace ipc {

constexpr int kControlFd = 3;
constexpr int kAudioFd = 4;
constexpr uint32_t kMaxBlock = 4096;

struct AudioHeader {
  uint32_t seq;
  int32_t slot;
  uint32_t n;
};

inline bool readAll(int fd, void* p, size_t n) {
  auto* c = static_cast<char*>(p);
  while (n) {
    ssize_t r = ::read(fd, c, n);
    if (r < 0 && errno == EINTR) continue;
    if (r <= 0) return false;
    c += r;
    n -= (size_t)r;
  }
  return true;
}

inline bool writeAll(int fd, const void* p, size_t n) {
  auto* c = static_cast<const char*>(p);
  while (n) {
    ssize_t r = ::write(fd, c, n);
    if (r < 0 && errno == EINTR) continue;
    if (r <= 0) return false;
    c += r;
    n -= (size_t)r;
  }
  return true;
}

inline bool sendFields(int fd, const std::vector<std::string>& fields) {
  std::string frame(4, '\0');
  for (size_t i = 0; i < fields.size(); i++) {
    if (i) frame.push_back('\0');
    frame += fields[i];
  }
  uint32_t len = (uint32_t)(frame.size() - 4);
  frame.replace(0, 4, reinterpret_cast<const char*>(&len), 4);
  return writeAll(fd, frame.data(), frame.size());  // one write, so frames from one writer never interleave
}

inline bool recvFields(int fd, std::vector<std::string>& fields) {
  uint32_t len;
  if (!readAll(fd, &len, 4)) return false;
  std::string body(len, '\0');
  if (len && !readAll(fd, body.data(), len)) return false;
  fields.clear();
  size_t start = 0;
  for (size_t i = 0; i <= body.size(); i++) {
    if (i == body.size() || body[i] == '\0') {
      fields.push_back(body.substr(start, i - start));
      start = i + 1;
    }
  }
  return true;
}

}  // namespace ipc
