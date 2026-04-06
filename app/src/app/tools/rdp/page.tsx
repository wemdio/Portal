'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabaseClient';
import {
  Monitor,
  Play,
  Square,
  Loader2,
  CircleDot,
  User,
  Maximize,
  Minimize,
  AlarmClock,
} from 'lucide-react';

async function getToken() {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ?? '';
}

async function api<T = unknown>(
  path: string,
  opts: RequestInit = {},
): Promise<{ data?: T; error?: string }> {
  const token = await getToken();
  const res = await fetch(`/api/tools/rdp${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...opts.headers,
    },
  });
  const json = await res.json();
  if (!res.ok) return { error: json.error ?? 'Ошибка запроса' };
  return { data: json };
}

interface ActiveSession {
  id: string;
  userId: string;
  userName: string | null;
  startedAt: string;
  isOwn: boolean;
}

interface RdpStatus {
  activeSession: ActiveSession | null;
  currentUserId: string;
  isAdmin?: boolean;
}

function formatDuration(startIso: string) {
  const ms = Date.now() - new Date(startIso).getTime();
  const mins = Math.floor(ms / 60000);
  const hrs = Math.floor(mins / 60);
  if (hrs > 0) return `${hrs}ч ${mins % 60}м`;
  return `${mins}м`;
}

// ---------------------------------------------------------------------------
// Inactivity timeout constants
// ---------------------------------------------------------------------------

const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;
const INACTIVITY_WARNING_MS = 25 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 2 * 60 * 1000;
const IDLE_CHECK_MS = 10_000;

// ---------------------------------------------------------------------------
// RDP Viewer (Guacamole)
// ---------------------------------------------------------------------------

function RdpViewer({
  onDisconnect,
  remoteScale = 1.0,
}: {
  onDisconnect: () => void;
  remoteScale?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const clientRef = useRef<{ disconnect(): void } | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);
  const clipboardCleanupRef = useRef<(() => void) | null>(null);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'error'>('connecting');
  const [errorMsg, setErrorMsg] = useState('');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const zoomRef = useRef(1.0);
  const baseScaleRef = useRef(1.0);
  const currentScaleRef = useRef(1.0);
  const remoteScaleRef = useRef(remoteScale);

  const lastActivityRef = useRef(Date.now());
  const lastHeartbeatRef = useRef(0);
  const [idleMinutesLeft, setIdleMinutesLeft] = useState<number | null>(null);

  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (!wrapperRef.current) return;
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      wrapperRef.current.requestFullscreen();
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function connect() {
      try {
        const { data, error } = await api<{ token: string }>('/token', { method: 'POST' });
        if (error || !data?.token) {
          setStatus('error');
          setErrorMsg(error ?? 'Не удалось получить токен');
          return;
        }

        const Guacamole = (await import('guacamole-common-js')).default;

        const wsProtocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
        const wsUrl =
          process.env.NEXT_PUBLIC_RDP_WS_URL ??
          `${wsProtocol}://${window.location.hostname}:8082`;

        const tunnel = new Guacamole.WebSocketTunnel(
          wsUrl.includes('?') 
            ? `${wsUrl}&token=${data.token}`
            : `${wsUrl}/?token=${data.token}`
        );
        const client = new Guacamole.Client(tunnel);

        if (cancelled) return;
        clientRef.current = client;

        const guacDisplay = client.getDisplay();
        const displayEl = guacDisplay.getElement();
        containerRef.current?.appendChild(displayEl);
        
        const fitToContainer = () => {
          if (!containerRef.current) return;
          const dw = guacDisplay.getWidth();
          const dh = guacDisplay.getHeight();
          if (!dw || !dh) return;
          const cw = containerRef.current.clientWidth;
          const ch = containerRef.current.clientHeight;
          const base = Math.min(cw / dw, ch / dh);
          baseScaleRef.current = base;
          const totalScale = base * zoomRef.current;
          currentScaleRef.current = totalScale;
          guacDisplay.scale(totalScale);
          // Размер в layout = масштабированный, не больше контейнера (чтобы не было скролла/обрезки)
          const scaledW = Math.min(cw, Math.floor(dw * totalScale));
          const scaledH = Math.min(ch, Math.floor(dh * totalScale));
          displayEl.style.width = `${scaledW}px`;
          displayEl.style.height = `${scaledH}px`;
          displayEl.style.maxWidth = '100%';
          displayEl.style.maxHeight = '100%';
        };
        guacDisplay.onresize = fitToContainer;
        roRef.current = new ResizeObserver(fitToContainer);
        if (containerRef.current) roRef.current.observe(containerRef.current);

        client.onerror = (err: unknown) => {
          console.error('[rdp] Client error', err);
          if (!cancelled) {
            setStatus('error');
            setErrorMsg(err instanceof Error ? err.message : 'Ошибка подключения');
          }
        };

        client.onstatechange = (state: number) => {
          if (cancelled) return;
          // states: 0=IDLE, 1=CONNECTING, 2=WAITING, 3=CONNECTED, 4=DISCONNECTING, 5=DISCONNECTED
          if (state === 3) {
            setStatus('connected');
            fitToContainer();
            // After Windows session starts (especially new sessions), the desktop
            // may not send an initial frame until it receives user input.
            // Nudge the mouse to force the server to send a full display refresh.
            const nudge = (x: number, y: number) => {
              try {
                client.sendMouseState(
                  new Guacamole.Mouse.State(x, y, false, false, false, false, false),
                );
              } catch { /* ignore if API differs */ }
            };
            const dw = guacDisplay.getWidth() || 1280;
            const dh = guacDisplay.getHeight() || 720;
            setTimeout(() => nudge(dw / 2, dh / 2), 500);
            setTimeout(() => nudge(dw / 2 + 1, dh / 2 + 1), 1000);
            setTimeout(() => nudge(dw / 2, dh / 2), 1500);
          }
          if (state === 5) {
            setStatus('error');
            setErrorMsg('Соединение разорвано');
          }
        };

        const mouse = new Guacamole.Mouse(displayEl);
        type GuacMouseState = {
          state: { x: number; y: number; left: boolean; middle: boolean; right: boolean; up: boolean; down: boolean };
        };
        mouse.onEach(['mousedown', 'mousemove', 'mouseup'], (e: GuacMouseState) => {
          lastActivityRef.current = Date.now();
          const s = currentScaleRef.current || 1;
          const state = new Guacamole.Mouse.State(
            e.state.x / s,
            e.state.y / s,
            e.state.left,
            e.state.middle,
            e.state.right,
            e.state.up,
            e.state.down,
          );
          client.sendMouseState(state);
        });

        const keyboard = new Guacamole.Keyboard(document);
        const BLOCKED_KEYSYMS = new Set([0xFFC8, 0xFFC9]);
        keyboard.onkeydown = (keysym: number) => {
          if (BLOCKED_KEYSYMS.has(keysym)) return;
          lastActivityRef.current = Date.now();
          client.sendKeyEvent(1, keysym);
        };
        keyboard.onkeyup = (keysym: number) => {
          if (BLOCKED_KEYSYMS.has(keysym)) return;
          client.sendKeyEvent(0, keysym);
        };

        // Clipboard: local → remote
        const handlePaste = (e: ClipboardEvent) => {
          const text = e.clipboardData?.getData('text/plain');
          if (!text) return;
          const stream = client.createClipboardStream('text/plain');
          const writer = new Guacamole.StringWriter(stream);
          writer.sendText(text);
          writer.sendEnd();
        };
        window.addEventListener('paste', handlePaste);

        // Clipboard: remote → local
        client.onclipboard = (stream: { onblob: ((data: string) => void) | null; onend: (() => void) | null }, mimetype: string) => {
          if (!mimetype.startsWith('text/')) return;
          let data = '';
          stream.onblob = (blob: string) => { data += atob(blob); };
          stream.onend = () => {
            if (data && navigator.clipboard?.writeText) {
              navigator.clipboard.writeText(data).catch(() => {});
            }
          };
        };

        const syncClipboardToRemote = async () => {
          try {
            if (!navigator.clipboard?.readText) return;
            const text = await navigator.clipboard.readText();
            if (!text) return;
            const stream = client.createClipboardStream('text/plain');
            const writer = new Guacamole.StringWriter(stream);
            writer.sendText(text);
            writer.sendEnd();
          } catch { /* clipboard permission denied */ }
        };
        window.addEventListener('focus', syncClipboardToRemote);

        clipboardCleanupRef.current = () => {
          window.removeEventListener('paste', handlePaste);
          window.removeEventListener('focus', syncClipboardToRemote);
        };

        // Ждём размеры контейнера (flex может дать 0×0 до первого layout). Таймаут — чтобы не висеть вечно.
        const DIM_WAIT_MS = 2500;
        const FALLBACK_W = 1920;
        const FALLBACK_H = 1080;
        const { vw, vh } = await new Promise<{ vw: number; vh: number }>((resolve) => {
          const deadline = Date.now() + DIM_WAIT_MS;
          const check = () => {
            if (cancelled) return;
            const el = containerRef.current;
            if (el && el.clientWidth > 0 && el.clientHeight > 0) {
              resolve({ vw: el.clientWidth, vh: el.clientHeight });
              return;
            }
            if (Date.now() >= deadline) {
              resolve({ vw: FALLBACK_W, vh: FALLBACK_H });
              return;
            }
            requestAnimationFrame(check);
          };
          check();
        });
        if (cancelled) return;
        const rs = remoteScaleRef.current;
        const w = Math.max(320, Math.round(vw / rs));
        const h = Math.max(240, Math.round(vh / rs));
        client.connect(`width=${w}&height=${h}`);
      } catch (err: unknown) {
        if (!cancelled) {
          setStatus('error');
          setErrorMsg(err instanceof Error ? err.message : 'Не удалось подключиться');
        }
      }
    }

    connect();

    return () => {
      cancelled = true;
      roRef.current?.disconnect();
      clipboardCleanupRef.current?.();
      if (clientRef.current) {
        try {
          clientRef.current.disconnect();
        } catch {
          // ignore
        }
      }
    };
  }, []);


  // ---- Inactivity check + heartbeat ----
  useEffect(() => {
    const interval = setInterval(() => {
      const idle = Date.now() - lastActivityRef.current;

      if (idle >= INACTIVITY_TIMEOUT_MS) {
        onDisconnect();
        return;
      }

      if (idle >= INACTIVITY_WARNING_MS) {
        const left = Math.ceil((INACTIVITY_TIMEOUT_MS - idle) / 60_000);
        setIdleMinutesLeft(left);
      } else {
        setIdleMinutesLeft(null);
      }

      const sinceBeat = Date.now() - lastHeartbeatRef.current;
      if (idle < HEARTBEAT_INTERVAL_MS && sinceBeat >= HEARTBEAT_INTERVAL_MS) {
        lastHeartbeatRef.current = Date.now();
        api('/sessions', { method: 'PATCH' }).catch(() => {});
      }
    }, IDLE_CHECK_MS);

    // Initial heartbeat on mount
    lastHeartbeatRef.current = Date.now();
    api('/sessions', { method: 'PATCH' }).catch(() => {});

    return () => clearInterval(interval);
  }, [onDisconnect]);

  const resetIdleTimer = useCallback(() => {
    lastActivityRef.current = Date.now();
    setIdleMinutesLeft(null);
    lastHeartbeatRef.current = Date.now();
    api('/sessions', { method: 'PATCH' }).catch(() => {});
  }, []);

  return (
    <div ref={wrapperRef} className="flex flex-col flex-1 min-h-0 w-full">
      <div className="flex items-center justify-between border-b border-gray-200 bg-gray-50 px-4 py-1.5 shrink-0">
        <div className="flex items-center gap-2 text-sm">
          {status === 'connecting' && (
            <>
              <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
              <span className="text-blue-600">Подключение...</span>
            </>
          )}
          {status === 'connected' && (
            <>
              <CircleDot className="h-4 w-4 text-green-500" />
              <span className="text-green-600">Подключено</span>
            </>
          )}
          {status === 'error' && (
            <>
              <CircleDot className="h-4 w-4 text-red-500" />
              <span className="text-red-600">{errorMsg}</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={toggleFullscreen}
            className="flex items-center gap-1 rounded-lg bg-gray-200 px-2.5 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-300 transition"
            title={isFullscreen ? 'Выйти из полноэкранного режима' : 'Полноэкранный режим'}
          >
            {isFullscreen ? <Minimize className="h-3.5 w-3.5" /> : <Maximize className="h-3.5 w-3.5" />}
          </button>
          <button
            onClick={onDisconnect}
            className="flex items-center gap-1 rounded-lg bg-red-100 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-200 transition"
          >
            <Square className="h-3.5 w-3.5" />
            Отключиться
          </button>
        </div>
      </div>
      {idleMinutesLeft !== null && (
        <div className="flex items-center justify-between gap-3 bg-amber-50 border-b border-amber-200 px-4 py-2 shrink-0">
          <div className="flex items-center gap-2 text-sm text-amber-800">
            <AlarmClock className="h-4 w-4 shrink-0" />
            <span>
              Отключение через {idleMinutesLeft} мин из-за бездействия
            </span>
          </div>
          <button
            onClick={resetIdleTimer}
            className="shrink-0 rounded-lg bg-amber-200 px-3 py-1 text-sm font-medium text-amber-900 hover:bg-amber-300 transition"
          >
            Я здесь
          </button>
        </div>
      )}
      <div
        ref={containerRef}
        className="bg-black overflow-hidden w-full flex-1 min-h-0 flex items-center justify-center"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

const DEFAULT_REMOTE_SCALE = 0.8;

export default function RdpPage() {
  const [status, setStatus] = useState<RdpStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');

  const fetchStatus = useCallback(async () => {
    const { data, error: err } = await api<RdpStatus>('/status');
    if (err) {
      setError(err);
      return;
    }
    if (data) setStatus(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    const t = setTimeout(fetchStatus, 0);
    const interval = setInterval(fetchStatus, 5000);
    return () => {
      clearTimeout(t);
      clearInterval(interval);
    };
  }, [fetchStatus]);

  useEffect(() => {
    if (status?.activeSession?.isOwn) {
      queueMicrotask(() => setConnected(true));
    }
  }, [status?.activeSession?.isOwn]);

  async function handleConnect() {
    setError('');
    setActionLoading(true);
    const { error: err } = await api('/sessions', { method: 'POST' });
    setActionLoading(false);
    if (err) {
      setError(err);
      return;
    }
    setConnected(true);
    fetchStatus();
  }

  const handleDisconnect = useCallback(async () => {
    setActionLoading(true);
    await api('/sessions', { method: 'DELETE' });
    setActionLoading(false);
    setConnected(false);
    fetchStatus();
  }, [fetchStatus]);

  const canConnect = status && !status.activeSession && !connected;

  if (loading) {
    return (
      <div className="flex flex-col flex-1 min-h-0">
        <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2 shrink-0 mb-4">
          <Monitor className="h-6 w-6 text-violet-600" />
          Удалённый рабочий стол
        </h1>
        <div className="flex-1 min-h-0 flex items-center justify-center rounded-2xl border border-gray-200 bg-gray-50">
          <Loader2 className="h-10 w-10 animate-spin text-violet-500" />
        </div>
      </div>
    );
  }

  if (connected) {
    return (
      <div className="flex flex-col flex-1 min-h-0 h-full">
        <div
          className="rounded-xl border border-gray-200 overflow-hidden bg-white shadow-sm flex-1 min-h-0 flex flex-col"
          style={{ maxHeight: 'calc(100vh - 60px)' }}
        >
          <RdpViewer onDisconnect={handleDisconnect} remoteScale={DEFAULT_REMOTE_SCALE} />
        </div>
      </div>
    );
  }

  // Один большой экран: занято (серый + надпись) или свободно (кнопка подключения)
  return (
    <div className="flex flex-col flex-1 min-h-0 h-full">
      <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2 shrink-0 mb-4">
        <Monitor className="h-6 w-6 text-violet-600" />
        Удалённый рабочий стол
      </h1>

      {error && (
        <div className="shrink-0 rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700 mb-4">
          {error}
        </div>
      )}

      <div
        className={`flex-1 min-h-0 rounded-2xl border border-gray-200 flex flex-col items-center justify-center ${
          status?.activeSession ? 'bg-gray-300' : 'bg-gray-100'
        }`}
      >
        {status?.activeSession ? (
          <>
            <div className="h-20 w-20 rounded-full bg-gray-400 flex items-center justify-center mb-4">
              <User className="h-10 w-10 text-gray-600" />
            </div>
            <p className="text-xl font-semibold text-gray-700 text-center px-4">
              Использует: {status.activeSession.userName ?? 'пользователь'}
            </p>
            <p className="text-sm text-gray-500 mt-1">
              Подключён {formatDuration(status.activeSession.startedAt)} назад
            </p>
          </>
        ) : (
          <>
            <p className="text-lg text-gray-600 mb-6">Подключение к удалённому ПК через браузер</p>
            <button
              type="button"
              onClick={handleConnect}
              disabled={actionLoading || !canConnect}
              className="flex items-center gap-2 rounded-xl bg-violet-600 px-8 py-4 text-base font-medium text-white hover:bg-violet-700 disabled:opacity-50 transition shadow-md"
            >
              {actionLoading ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                <Play className="h-5 w-5" />
              )}
              Подключиться
            </button>
          </>
        )}
      </div>
    </div>
  );
}
