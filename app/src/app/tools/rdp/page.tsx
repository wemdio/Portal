'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabaseClient';
import {
  Monitor,
  Play,
  Square,
  CalendarPlus,
  Trash2,
  Loader2,
  CircleDot,
  Clock,
  User,
  AlertCircle,
  LogOut,
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

interface Booking {
  id: string;
  userId: string;
  userName: string | null;
  startsAt: string;
  endsAt: string;
  status: string;
  notes: string | null;
  isOwn: boolean;
}

interface RdpStatus {
  activeSession: ActiveSession | null;
  bookings: Booking[];
  currentUserId: string;
  isAdmin?: boolean;
}

function formatDateTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDuration(startIso: string) {
  const ms = Date.now() - new Date(startIso).getTime();
  const mins = Math.floor(ms / 60000);
  const hrs = Math.floor(mins / 60);
  if (hrs > 0) return `${hrs}ч ${mins % 60}м`;
  return `${mins}м`;
}

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
  const clientRef = useRef<{ disconnect(): void } | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'error'>('connecting');
  const [errorMsg, setErrorMsg] = useState('');
  const zoomRef = useRef(1.0);
  const baseScaleRef = useRef(1.0);
  const currentScaleRef = useRef(1.0);
  // remoteScale: visual fraction of the remote desktop (e.g. 0.8 → connect at 125%
  // resolution so the remote renders more content → appears at 80% visual size).
  const remoteScaleRef = useRef(remoteScale);

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
          // e.state.x/y are in CSS pixels relative to the scaled bounds element.
          // Divide by the current display scale to get guacamole logical coordinates.
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
        // F11 (0xFFC8) and F12 (0xFFC9) are intercepted by the browser for
        // fullscreen and devtools — don't forward them to the remote session.
        const BLOCKED_KEYSYMS = new Set([0xFFC8, 0xFFC9]);
        keyboard.onkeydown = (keysym: number) => {
          if (BLOCKED_KEYSYMS.has(keysym)) return;
          client.sendKeyEvent(1, keysym);
        };
        keyboard.onkeyup = (keysym: number) => {
          if (BLOCKED_KEYSYMS.has(keysym)) return;
          client.sendKeyEvent(0, keysym);
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
      if (clientRef.current) {
        try {
          clientRef.current.disconnect();
        } catch {
          // ignore
        }
      }
    };
  }, []);


  return (
    <div className="flex flex-col flex-1 min-h-0 w-full">
      <div className="flex items-center justify-between border-b border-gray-200 bg-gray-50 px-4 py-2 shrink-0">
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
        <div className="flex items-center gap-3">
          <button
            onClick={onDisconnect}
            className="flex items-center gap-1 rounded-lg bg-red-100 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-200 transition"
          >
            <Square className="h-3.5 w-3.5" />
            Отключиться
          </button>
        </div>
      </div>
      <div
        ref={containerRef}
        className="bg-black overflow-hidden w-full flex-1 min-h-0 flex items-center justify-center"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Booking Form
// ---------------------------------------------------------------------------

function BookingForm({ onCreated, existingBookings = [] }: { onCreated: () => void; existingBookings?: Booking[] }) {
  const [date, setDate] = useState('');
  const [timeFrom, setTimeFrom] = useState('');
  const [timeTo, setTimeTo] = useState('');
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    if (!date || !timeFrom || !timeTo) {
      setError('Заполните дату и время');
      return;
    }

    const startsAt = new Date(`${date}T${timeFrom}:00`).toISOString();
    const endsAt = new Date(`${date}T${timeTo}:00`).toISOString();

    const startMs = new Date(startsAt).getTime();
    const endMs = new Date(endsAt).getTime();
    if (endMs <= startMs) {
      setError('Время «До» должно быть позже времени «С»');
      return;
    }

    const overlaps = existingBookings.some(
      (b) => startMs < new Date(b.endsAt).getTime() && endMs > new Date(b.startsAt).getTime(),
    );
    if (overlaps) {
      setError('На это время уже есть бронь, перепроверьте расписание броней');
      return;
    }

    setLoading(true);
    const { error: apiError } = await api('/bookings', {
      method: 'POST',
      body: JSON.stringify({ starts_at: startsAt, ends_at: endsAt, notes }),
    });
    setLoading(false);

    if (apiError) {
      setError(apiError);
      return;
    }

    setDate('');
    setTimeFrom('');
    setTimeTo('');
    setNotes('');
    onCreated();
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="grid grid-cols-3 gap-2">
        <div>
          <label className="text-xs text-gray-500">Дата</label>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-300"
            min={new Date().toISOString().split('T')[0]}
          />
        </div>
        <div>
          <label className="text-xs text-gray-500">С</label>
          <input
            type="time"
            value={timeFrom}
            onChange={(e) => setTimeFrom(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-300"
          />
        </div>
        <div>
          <label className="text-xs text-gray-500">До</label>
          <input
            type="time"
            value={timeTo}
            onChange={(e) => setTimeTo(e.target.value)}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-300"
          />
        </div>
      </div>
      <input
        type="text"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Комментарий (необязательно)"
        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-300"
      />
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button
        type="submit"
        disabled={loading}
        className="flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50 transition"
      >
        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <CalendarPlus className="h-4 w-4" />}
        Забронировать
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

const DEFAULT_REMOTE_SCALE = 0.8;

const FIVE_MIN_MS = 5 * 60 * 1000;

export default function RdpPage() {
  const [status, setStatus] = useState<RdpStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  const [showFiveMinWarning, setShowFiveMinWarning] = useState(false);
  const fiveMinWarnedRef = useRef(false);
  const [showSoonBookingWarning, setShowSoonBookingWarning] = useState(false);
  const [soonBookingUserName, setSoonBookingUserName] = useState<string | null>(null);
  const warnedSoonBookingIdRef = useRef<string | null>(null);
  const forceDisconnectDoneRef = useRef(false);
  const mySessionEndsAtRef = useRef<number | null>(null);
  const [renderTime, setRenderTime] = useState(() => Date.now());

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

  // При возврате на страницу — если у пользователя уже есть активная сессия, показываем просмотр (возврат в сессию)
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
    fiveMinWarnedRef.current = false;
    warnedSoonBookingIdRef.current = null;
    forceDisconnectDoneRef.current = false;
    mySessionEndsAtRef.current = null;
    fetchStatus();
  }, [fetchStatus]);

  // Обновление времени для отображения текущего слота (без вызова Date.now в render)
  useEffect(() => {
    const t = setInterval(() => setRenderTime(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  // Запоминаем конец своей брони, пока сидим в сессии (бронь потом исчезнет из API)
  useEffect(() => {
    if (!connected || !status?.bookings) return;
    const now = Date.now();
    const myCurrent = status.bookings.find(
      (b) => b.isOwn && new Date(b.startsAt).getTime() <= now && new Date(b.endsAt).getTime() > now,
    );
    if (myCurrent) mySessionEndsAtRef.current = new Date(myCurrent.endsAt).getTime();
  }, [connected, status?.bookings]);

  // Принудительное отключение: время своей брони вышло или начался слот другого пользователя
  useEffect(() => {
    if (!connected || forceDisconnectDoneRef.current) return;
    const check = () => {
      if (forceDisconnectDoneRef.current) return;
      const now = Date.now();
      const myEndsAt = mySessionEndsAtRef.current;
      const myBookingEnded = myEndsAt != null && now >= myEndsAt;
      const otherSlotStarted =
        status?.bookings?.some(
          (b) => !b.isOwn && new Date(b.startsAt).getTime() <= now && new Date(b.endsAt).getTime() > now,
        ) ?? false;
      const myCurrent = status?.bookings?.find(
        (b) => b.isOwn && new Date(b.startsAt).getTime() <= now && new Date(b.endsAt).getTime() > now,
      );
      if (myBookingEnded || (otherSlotStarted && !myCurrent)) {
        forceDisconnectDoneRef.current = true;
        void handleDisconnect();
      }
    };
    check();
    const t = setInterval(check, 20000);
    return () => clearInterval(t);
  }, [connected, status?.bookings, handleDisconnect]);

  // Предупреждение за 5 минут до окончания своей брони и за 5 минут до начала чужой (когда сидишь без брони)
  useEffect(() => {
    if (!connected || !status?.bookings) return;
    const check = () => {
      const now = Date.now();
      const myCurrent = status.bookings.find(
        (b) => b.isOwn && new Date(b.startsAt).getTime() <= now && new Date(b.endsAt).getTime() > now,
      );
      if (myCurrent && new Date(myCurrent.endsAt).getTime() - now < FIVE_MIN_MS && !fiveMinWarnedRef.current) {
        fiveMinWarnedRef.current = true;
        setShowFiveMinWarning(true);
        return;
      }
      const nextOther = status.bookings
        .filter((b) => !b.isOwn && new Date(b.startsAt).getTime() > now)
        .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime())[0];
      if (
        nextOther &&
        new Date(nextOther.startsAt).getTime() - now < FIVE_MIN_MS &&
        warnedSoonBookingIdRef.current !== nextOther.id
      ) {
        warnedSoonBookingIdRef.current = nextOther.id;
        setSoonBookingUserName(nextOther.userName ?? 'Пользователь');
        setShowSoonBookingWarning(true);
      }
    };
    check();
    const t = setInterval(check, 60000);
    return () => clearInterval(t);
  }, [connected, status?.bookings]);

  async function handleCancelBooking(id: string) {
    setActionLoading(true);
    const { error: err } = await api(`/bookings/${id}`, { method: 'DELETE' });
    setActionLoading(false);
    if (err) {
      setError(err);
      return;
    }
    fetchStatus();
  }

  const canConnect =
    status &&
    !status.activeSession &&
    !connected &&
    !status.bookings.some(
      (b) => !b.isOwn && b.status !== 'cancelled' && b.status !== 'expired' &&
        new Date(b.startsAt) <= new Date() && new Date(b.endsAt) > new Date(),
    );

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-violet-500" />
      </div>
    );
  }

  if (connected) {
    return (
      <div className="flex flex-col flex-1 min-h-0 h-full">
        <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2 shrink-0 mb-4">
          <Monitor className="h-6 w-6 text-violet-600" />
          Удалённый рабочий стол
        </h1>
        <div
          className="rounded-2xl border border-gray-200 overflow-hidden bg-white shadow-sm flex-1 min-h-0 flex flex-col"
          style={{ maxHeight: 'calc(100vh - 140px)' }}
        >
          <RdpViewer onDisconnect={handleDisconnect} remoteScale={DEFAULT_REMOTE_SCALE} />
        </div>
        {showFiveMinWarning && (
          <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-2xl shadow-2xl max-w-sm w-full overflow-hidden border border-amber-100">
              <div className="bg-amber-50 px-6 pt-6 pb-4 flex flex-col items-center">
                <div className="h-12 w-12 rounded-full bg-amber-100 flex items-center justify-center mb-3">
                  <AlertCircle className="h-6 w-6 text-amber-600" />
                </div>
                <p className="text-amber-900 font-semibold text-center">
                  Осталось менее 5 минут
                </p>
              </div>
              <div className="px-6 pb-6 pt-2">
                <p className="text-gray-600 text-sm text-center">
                  У вас осталось менее 5 минут до окончания сессии. По истечении времени подключение будет завершено автоматически.
                </p>
                <button
                  type="button"
                  onClick={() => setShowFiveMinWarning(false)}
                  className="mt-4 w-full rounded-xl bg-amber-500 px-4 py-2.5 text-sm font-medium text-white hover:bg-amber-600 transition"
                >
                  Понятно
                </button>
              </div>
            </div>
          </div>
        )}
        {showSoonBookingWarning && soonBookingUserName && (
          <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-2xl shadow-2xl max-w-sm w-full overflow-hidden border border-violet-100">
              <div className="bg-violet-50 px-6 pt-6 pb-4 flex flex-col items-center">
                <div className="h-12 w-12 rounded-full bg-violet-100 flex items-center justify-center mb-3">
                  <LogOut className="h-6 w-6 text-violet-600" />
                </div>
                <p className="text-violet-900 font-semibold text-center">
                  Скоро слот другого пользователя
                </p>
              </div>
              <div className="px-6 pb-6 pt-2">
                <p className="text-gray-600 text-sm text-center">
                  Через менее 5 минут начинается бронь пользователя <span className="font-medium text-gray-900">{soonBookingUserName}</span>. Рекомендуем отключиться до начала слота. Иначе подключение будет завершено автоматически.
                </p>
                <button
                  type="button"
                  onClick={() => { setShowSoonBookingWarning(false); setSoonBookingUserName(null); }}
                  className="mt-4 w-full rounded-xl bg-violet-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-violet-700 transition"
                >
                  Понятно
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
          <Monitor className="h-6 w-6 text-violet-600" />
          Удалённый рабочий стол
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          Подключение к удалённому ПК через браузер
        </p>
      </div>

      {error && (
        <div className="rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Status Card */}
      <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
        <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wider mb-3">
          Текущий статус
        </h2>
        {status?.activeSession ? (
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-full bg-red-100 flex items-center justify-center">
              <User className="h-5 w-5 text-red-600" />
            </div>
            <div>
              <p className="font-medium text-gray-900">
                {status.activeSession.isOwn
                  ? 'Вы подключены'
                  : 'Сессия занята пользователем'}
              </p>
              <p className="text-xs text-gray-500">
                {status.activeSession.isOwn
                  ? `Подключен ${formatDuration(status.activeSession.startedAt)} назад`
                  : `Пользователь ${status.activeSession.userName ?? 'неизвестный'} подключён ${formatDuration(status.activeSession.startedAt)} назад`}
              </p>
            </div>
            {status.activeSession.isOwn && (
              <button
                onClick={handleDisconnect}
                disabled={actionLoading}
                className="ml-auto flex items-center gap-1 rounded-lg bg-red-100 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-200 disabled:opacity-50 transition"
              >
                <Square className="h-3.5 w-3.5" />
                Отключиться
              </button>
            )}
          </div>
        ) : (() => {
          const currentBooking = status?.bookings?.find(
            (b) => new Date(b.startsAt).getTime() <= renderTime && new Date(b.endsAt).getTime() > renderTime,
          );
          return (
          <div className="flex items-center gap-3">
            <div className={`h-10 w-10 rounded-full flex items-center justify-center ${currentBooking ? 'bg-amber-100' : 'bg-green-100'}`}>
              <CircleDot className={`h-5 w-5 ${currentBooking ? 'text-amber-600' : 'text-green-600'}`} />
            </div>
            <div>
              {currentBooking ? (
                <>
                  <p className="font-medium text-amber-800">
                    {currentBooking.isOwn
                      ? 'Ваша бронь'
                      : `Бронь пользователем ${currentBooking.userName ?? 'Пользователь'} до ${formatDateTime(currentBooking.endsAt)}`}
                  </p>
                  <p className="text-xs text-gray-500">
                    {currentBooking.isOwn
                      ? `действует до ${formatDateTime(currentBooking.endsAt)}`
                      : 'Можно подключаться после окончания брони'}
                  </p>
                </>
              ) : (
                <>
                  <p className="font-medium text-green-700">Свободно</p>
                  <p className="text-xs text-gray-500">Можно подключаться</p>
                </>
              )}
            </div>
            <button
              onClick={handleConnect}
              disabled={actionLoading || !canConnect}
              className="ml-auto flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50 transition"
            >
              {actionLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Play className="h-4 w-4" />
              )}
              Подключиться
            </button>
          </div>
          );
        })()}
      </div>

      {/* Booking section */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Booking form */}
        <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wider mb-3">
            Забронировать время
          </h2>
          <BookingForm onCreated={fetchStatus} existingBookings={status?.bookings ?? []} />
        </div>

        {/* Upcoming bookings */}
        <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm flex flex-col min-h-0">
          <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wider mb-3 shrink-0">
            Расписание
          </h2>
          {status?.bookings && status.bookings.length > 0 ? (
            <div className="space-y-2 min-h-[8rem] max-h-[22rem] overflow-y-auto overscroll-contain pr-1">
              {status.bookings.map((b) => (
                <div
                  key={b.id}
                  className={`flex items-center justify-between rounded-xl px-4 py-3 text-sm ${
                    b.isOwn
                      ? 'bg-violet-50 border border-violet-200'
                      : 'bg-gray-50 border border-gray-200'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <Clock className="h-4 w-4 text-gray-400 shrink-0" />
                    <div className="min-w-0">
                      <p className="font-medium text-gray-900 truncate">
                        {b.userName ?? 'Пользователь'}
                        {b.isOwn && (
                          <span className="ml-1 text-xs text-violet-600">(вы)</span>
                        )}
                      </p>
                      <p className="text-xs text-gray-500">
                        {formatDateTime(b.startsAt)} — {formatDateTime(b.endsAt)}
                        {b.notes && <span className="ml-1 text-gray-400">· {b.notes}</span>}
                      </p>
                    </div>
                  </div>
                  {(b.isOwn || status?.isAdmin) && (
                    <button
                      onClick={() => handleCancelBooking(b.id)}
                      disabled={actionLoading}
                      className="shrink-0 rounded-lg p-1.5 text-red-400 hover:bg-red-100 hover:text-red-600 disabled:opacity-50 transition"
                      title={b.isOwn ? 'Отменить бронь' : 'Удалить бронь (админ)'}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-gray-400 py-4 text-center">Нет предстоящих бронирований</p>
          )}
        </div>
      </div>
    </div>
  );
}
