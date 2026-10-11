import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ChatMessage,
  ClientMessage,
  LoopState,
  MixState,
  Peer,
  Presence,
  ServerMessage,
  TabMeta,
  TabVideo,
  TickRange,
  TransportState,
} from '../shared/protocol';
import type { Profile, Session } from './api';

export type ConnStatus = 'connecting' | 'open' | 'reconnecting' | 'unauthorized';

type PresenceUpdate = Partial<Presence> & { jam?: boolean };

export interface RoomConnection {
  status: ConnStatus;
  clientId: string | null;
  roomName: string;
  tabs: TabMeta[];
  currentTabId: string | null;
  loop: LoopState | null;
  transport: TransportState | null;
  mix: MixState | null;
  chat: ChatMessage[];
  peers: Record<string, Peer>;
  /** serverTime ≈ Date.now() + clockOffset */
  clockOffset: number;
  lastEvent: string | null;
  setPresence: (p: PresenceUpdate) => void;
  setTab: (tabId: string) => void;
  setLoop: (loop: TickRange | null) => void;
  sendTransport: (playing: boolean, timeMs: number, speed: number) => void;
  sendMix: (mix: Omit<MixState, 'by'>) => void;
  sendChat: (text: string) => void;
  sendRtc: (to: string, data: unknown) => void;
  /** Subscribe to WebRTC signaling messages; returns an unsubscribe function. */
  onRtc: (fn: (from: string, data: unknown) => void) => () => void;
  sendTabMeta: (tabId: string, title?: string, artist?: string) => void;
  sendTabVideo: (tabId: string, youtube: TabVideo | null) => void;
}

const PRESENCE_INTERVAL_MS = 50;

export function useRoom(session: Session, profile: Profile): RoomConnection {
  const [status, setStatus] = useState<ConnStatus>('connecting');
  const [clientId, setClientId] = useState<string | null>(null);
  const [roomName, setRoomName] = useState(session.roomName);
  const [tabs, setTabs] = useState<TabMeta[]>([]);
  const [currentTabId, setCurrentTabId] = useState<string | null>(null);
  const [loop, setLoopState] = useState<LoopState | null>(null);
  const [transport, setTransport] = useState<TransportState | null>(null);
  const [mix, setMix] = useState<MixState | null>(null);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [peers, setPeers] = useState<Record<string, Peer>>({});
  const [clockOffset, setClockOffset] = useState(0);
  const [lastEvent, setLastEvent] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const rtcListeners = useRef(new Set<(from: string, data: unknown) => void>());
  const pendingPresence = useRef<PresenceUpdate>({});
  // Full local presence, replayed after a reconnect.
  const localPresence = useRef<PresenceUpdate>({});
  const flushTimer = useRef<number | null>(null);

  const raw = useCallback((msg: ClientMessage) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  useEffect(() => {
    let closed = false;
    let retry = 0;
    let retryTimer: number | undefined;
    let pingTimer: number | undefined;

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const q = new URLSearchParams({ room: session.roomId, token: session.token });
      const ws = new WebSocket(`${proto}://${location.host}/ws?${q}`);
      wsRef.current = ws;

      ws.onopen = () => {
        retry = 0;
        ws.send(JSON.stringify({ type: 'hello', name: profile.name, color: profile.color } satisfies ClientMessage));
        // Measure clock offset a few times; keep the lowest-latency sample.
        let best = Infinity;
        let n = 0;
        const ping = () => {
          if (ws.readyState !== WebSocket.OPEN) return;
          ws.send(JSON.stringify({ type: 'ping', t: Date.now() } satisfies ClientMessage));
          if (++n < 5) pingTimer = window.setTimeout(ping, 300);
        };
        ping();
        ws.addEventListener('message', (e) => {
          const m = JSON.parse(e.data) as ServerMessage;
          if (m.type !== 'pong') return;
          const now = Date.now();
          const rtt = now - m.t;
          if (rtt < best) {
            best = rtt;
            setClockOffset(m.server - (m.t + rtt / 2));
          }
        });
      };

      ws.onmessage = (e) => {
        const m = JSON.parse(e.data) as ServerMessage;
        switch (m.type) {
          case 'welcome':
            setStatus('open');
            setClientId(m.clientId);
            setRoomName(m.room.name);
            setTabs(m.room.tabs);
            setCurrentTabId(m.room.currentTabId);
            setLoopState(m.room.loop);
            setTransport(m.room.transport);
            setMix(m.room.mix);
            setChat(m.room.chat);
            setPeers(Object.fromEntries(m.peers.map((p) => [p.clientId, p])));
            if (Object.keys(localPresence.current).length) {
              ws.send(JSON.stringify({ type: 'presence', presence: localPresence.current } satisfies ClientMessage));
            }
            break;
          case 'peerJoined':
            setPeers((p) => ({ ...p, [m.peer.clientId]: m.peer }));
            setLastEvent(`${m.peer.name} joined`);
            break;
          case 'peerLeft':
            setPeers((p) => {
              const next = { ...p };
              if (next[m.clientId]) setLastEvent(`${next[m.clientId].name} left`);
              delete next[m.clientId];
              return next;
            });
            break;
          case 'presence':
            setPeers((p) => (p[m.clientId] ? { ...p, [m.clientId]: { ...p[m.clientId], ...m.presence } } : p));
            break;
          case 'tabs':
            setTabs(m.tabs);
            setCurrentTabId(m.currentTabId);
            break;
          case 'currentTab':
            setCurrentTabId(m.tabId);
            setLoopState(null);
            setTransport(null);
            setMix(null);
            setLastEvent(`${m.by} switched the tab`);
            break;
          case 'loop':
            setLoopState(m.loop);
            setLastEvent(m.loop ? `${m.loop.setBy} set a loop` : 'Loop cleared');
            break;
          case 'transport':
            setTransport(m.transport);
            break;
          case 'mix':
            setMix(m.mix);
            break;
          case 'chat':
            setChat((c) => [...c.slice(-199), m.message]);
            break;
          case 'rtc':
            rtcListeners.current.forEach((fn) => fn(m.from, m.data));
            break;
          case 'chatPreview':
            setChat((c) => c.map((msg) => (msg.id === m.id ? { ...msg, preview: m.preview } : msg)));
            break;
        }
      };

      ws.onclose = (e) => {
        window.clearTimeout(pingTimer);
        if (closed) return;
        if (e.code === 4401) {
          setStatus('unauthorized');
          return;
        }
        setStatus('reconnecting');
        retryTimer = window.setTimeout(connect, Math.min(10000, 500 * 2 ** retry++));
      };
    };

    connect();
    return () => {
      closed = true;
      window.clearTimeout(retryTimer);
      window.clearTimeout(pingTimer);
      wsRef.current?.close();
    };
  }, [session.roomId, session.token, profile.name, profile.color]);

  const setPresence = useCallback(
    (p: PresenceUpdate) => {
      Object.assign(pendingPresence.current, p);
      Object.assign(localPresence.current, p);
      if (flushTimer.current != null) return;
      flushTimer.current = window.setTimeout(() => {
        flushTimer.current = null;
        const presence = pendingPresence.current;
        pendingPresence.current = {};
        raw({ type: 'presence', presence });
      }, PRESENCE_INTERVAL_MS);
    },
    [raw],
  );

  return {
    status,
    clientId,
    roomName,
    tabs,
    currentTabId,
    loop,
    transport,
    mix,
    chat,
    peers,
    clockOffset,
    lastEvent,
    setPresence,
    setTab: useCallback((tabId: string) => {
      setCurrentTabId(tabId);
      setLoopState(null);
      raw({ type: 'setTab', tabId });
    }, [raw]),
    setLoop: useCallback((l: TickRange | null) => raw({ type: 'setLoop', loop: l }), [raw]),
    sendTransport: useCallback(
      (playing: boolean, timeMs: number, speed: number) => raw({ type: 'transport', playing, timeMs, speed }),
      [raw],
    ),
    sendMix: useCallback((mix: Omit<MixState, 'by'>) => raw({ type: 'mix', ...mix }), [raw]),
    sendChat: useCallback((text: string) => raw({ type: 'chat', text }), [raw]),
    sendTabVideo: useCallback((tabId: string, youtube: TabVideo | null) => raw({ type: 'tabVideo', tabId, youtube }), [raw]),
    sendRtc: useCallback((to: string, data: unknown) => raw({ type: 'rtc', to, data }), [raw]),
    onRtc: useCallback((fn: (from: string, data: unknown) => void) => {
      rtcListeners.current.add(fn);
      return () => void rtcListeners.current.delete(fn);
    }, []),
    sendTabMeta: useCallback(
      (tabId: string, title?: string, artist?: string) => raw({ type: 'tabMeta', tabId, title, artist }),
      [raw],
    ),
  };
}
