'use client';

import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { authFetch, getAccessToken } from '@/lib/authFetch';
import {
  MessageSquareMore,
  Plus,
  Loader2,
  Settings,
  Users,
  ScrollText,
  MessageCircle,
  UserCheck,
  Play,
  Square,
  Trash2,
  ChevronDown,
  ChevronUp,
  Send,
  Download,
  Search,
  X,
  Network,
  Upload,
  Ban,
  RefreshCw,
  AlertCircle,
  Flame,
  Database,
  ShieldCheck,
  FileSpreadsheet,
  LayoutDashboard,
} from 'lucide-react';
import DashboardTab from '@/components/tg-outreach/DashboardTab';
import BaseComparison from '@/components/tg-outreach/BaseComparison';
import WarmupTab from '@/components/tg-outreach/WarmupTab';
import type {
  CampaignStatus,
  DialogStatus,
  OutreachCampaign,
  OutreachAccount,
  OutreachProxy,
  OutreachDialog,
  OutreachProcessed,
  OutreachLog,
  OutreachBlockedUser,
  OpenAISettings,
  TelegramSettings,
} from '@/lib/tgOutreach/types';
import {
  DEFAULT_OPENAI_SETTINGS,
  DEFAULT_TELEGRAM_SETTINGS,
  DEFAULT_FOLLOW_UP,
} from '@/lib/tgOutreach/types';
import {
  describeAutoForward,
  autoForwardWarning,
  type AutoForwardMark,
} from '@/lib/tgOutreach/autoForward';
import { DEFAULT_MAX_MESSAGE_CHARS } from '@/lib/tgOutreach/firstTouch/validateMessage';
import { summarizeAccounts } from '@/lib/tgOutreach/accountsSummary';
import {
  takenProxyUrls,
  selectableProxies,
  proxyOptionsFor,
} from '@/lib/tgOutreach/proxySelection';
import {
  describeSending,
  describeProxy,
  countSendingAccounts,
  type AccountSendingStat,
  type HealthMark,
} from '@/lib/tgOutreach/accountHealth';
// Только тип: сам модуль серверный (тянет gramJS), в клиентский бандл он не
// попадает — import type стирается при сборке. Берём его, чтобы набор статусов
// проверки был один на портал, а не переписанный руками на экране.
import type { AccountCheckResult, OtherSession } from '@/lib/tgOutreach/accountCheck';
import type { ProxyCheckResult } from '@/lib/tgOutreach/proxyCheck';

const API_BASE = '/api/tools/tg-outreach';

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

/**
 * Маппинг короткого кода `can_send_changed_reason` в человекочитаемую
 * подпись для UI. Коды одобрены схемой (см. migration / blockedUsers /
 * disableDialogIfUnreachable); если приходит неизвестный код — отдаём
 * сам код как есть, чтобы оператор хотя бы видел сигнал, а не пустоту.
 */
function describeCanSendReason(reason: string | null | undefined): string {
  switch (reason) {
    case 'manual': return 'вручную';
    case 'blocklist_add': return 'добавлен в чёрный список';
    case 'blocklist_remove': return 'удалён из чёрного списка';
    case 'tg_user_deactivated': return 'Telegram: пользователь удалил аккаунт';
    case 'tg_peer_invalid': return 'Telegram: невалидный peer';
    case 'tg_user_blocked_bot': return 'Telegram: пользователь заблокировал бота';
    case 'tg_user_banned_in_channel': return 'Telegram: пользователь забанен в канале';
    case 'tg_unreachable': return 'Telegram: пользователь недоступен';
    default: return reason ?? '';
  }
}

const STATUS_LABELS: Record<string, { label: string; cls: string }> = {
  stopped: { label: 'Остановлена', cls: 'bg-gray-100 text-gray-600' },
  running: { label: 'Запущена', cls: 'bg-emerald-100 text-emerald-700' },
  stopping: { label: 'Останавливается...', cls: 'bg-amber-100 text-amber-700 animate-pulse' },
  paused: { label: 'Пауза', cls: 'bg-amber-100 text-amber-700' },
  error: { label: 'Ошибка', cls: 'bg-rose-100 text-rose-700' },
  // Прогрев — самостоятельное состояние, а не разновидность «остановлена»:
  // пока он идёт, боевой аутрич запустить нельзя.
  warming: { label: 'Прогрев', cls: 'bg-blue-100 text-blue-700' },
};

/** Цвет точки кампании в списке. */
function statusDotClass(status: string): string {
  switch (status) {
    case 'running': return 'bg-emerald-400';
    case 'warming': return 'bg-blue-400';
    case 'error': return 'bg-rose-400';
    default: return 'bg-gray-400';
  }
}

const DIALOG_STATUS_LABELS: Record<string, { label: string; cls: string }> = {
  none: { label: '—', cls: 'text-gray-400' },
  lead: { label: 'Лид', cls: 'bg-emerald-100 text-emerald-700' },
  not_lead: { label: 'Не лид', cls: 'bg-gray-100 text-gray-600' },
  later: { label: 'Потом', cls: 'bg-amber-100 text-amber-700' },
};

/**
 * Плашка передачи диалога человеку.
 *
 * Одна и та же в свёрнутой строке списка и в раскрытой карточке. В списке она
 * нужна больше: «кого уже отдали менеджеру» — вопрос про весь список сразу, а
 * раскрывать ради ответа каждый диалог по очереди оператор не станет.
 *
 * «Передан» показываем наравне с «в очереди»: если бы метка жила только до
 * отправки, она исчезала бы ровно в тот момент, когда передача удалась, и это
 * читалось бы как отмена.
 */
/**
 * Живая передача: стоит в очереди или уже ушла.
 *
 * Отработавшие — сорвавшаяся и снятая оператором — до менеджера не дошли, и
 * обращаться с ними надо одинаково: показывать причину и возвращать кнопки.
 */
function isActiveForward(
  forward: OutreachDialog['forward'],
): forward is NonNullable<NonNullable<OutreachDialog['forward']>> {
  return !!forward && (forward.status === 'pending' || forward.status === 'sent');
}

function ForwardBadge({
  forward,
  compact = false,
}: {
  forward: NonNullable<NonNullable<OutreachDialog['forward']>>;
  /** Компактный размер — под остальные бейджи в строке списка. */
  compact?: boolean;
}) {
  const pending = forward.status === 'pending';
  const size = compact ? 'gap-1 px-2 py-0.5' : 'ml-2 gap-1.5 px-3 py-1';
  const tone = pending
    ? 'border-amber-200 bg-amber-50 text-amber-700'
    : 'border-gray-200 bg-gray-50 text-gray-600';
  return (
    <span
      title={pending
        ? 'Стоит в очереди — уйдёт, когда воркер дойдёт до этого аккаунта'
        : 'Уже отправлено. Передать ещё раз, в том числе другим видом, нельзя'}
      className={`inline-flex items-center rounded-full border text-[10px] font-medium ${size} ${tone}`}
    >
      <Send className="h-3 w-3" />
      {pending ? 'В очереди: ' : 'Передан: '}
      {forward.kind === 'lead' ? 'лид' : 'партнёр'}
    </span>
  );
}

/**
 * Контакт ушёл менеджеру сам, по положительному триггеру.
 *
 * Отдельно от `ForwardBadge`: та плашка про очередь ручной передачи, эта — про
 * то, что воркер уже сделал без оператора. Раньше от автопересылки в карточке
 * оставался только статус «Лид», который точно так же ставится руками, и
 * человека передавали менеджеру второй раз, не зная, что он уже там.
 */
function AutoForwardBadge({
  mark,
  compact = false,
}: {
  mark: AutoForwardMark;
  /** Компактный размер — под остальные бейджи в строке списка. */
  compact?: boolean;
}) {
  const sent = mark.state === 'sent';
  const size = compact ? 'gap-1 px-2 py-0.5' : 'ml-2 gap-1.5 px-3 py-1';
  const tone = sent
    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
    : 'border-rose-200 bg-rose-50 text-rose-700';
  const where = mark.chat ? `, чат ${mark.chat}` : '';
  return (
    <span
      title={sent
        ? `Переписка ушла менеджеру автоматически, по положительному триггеру${where}. ${formatDate(mark.at)}`
        : `Автопересылка менеджеру не удалась${where} — ${mark.reason}. Лид до менеджера не дошёл.`}
      className={`inline-flex items-center rounded-full border text-[10px] font-medium ${size} ${tone}`}
    >
      <UserCheck className="h-3 w-3" />
      {sent ? 'Ушёл менеджеру' : 'Не ушёл менеджеру'}
    </span>
  );
}

/* =================== GLOBAL BLOCKLIST SECTION =================== */
function GlobalBlocklistSection() {
  const [items, setItems] = useState<OutreachBlockedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [addId, setAddId] = useState('');
  const [addUsername, setAddUsername] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await authFetch(`${API_BASE}/blocked-users`);
    if (res.ok) {
      const d = await res.json() as { items: OutreachBlockedUser[] };
      setItems(d.items);
    }
    setLoading(false);
  }, []);

  useEffect(() => { queueMicrotask(() => { void load(); }); }, [load]);

  const add = async () => {
    const idNum = Number(addId.trim());
    if (!Number.isFinite(idNum) || idNum <= 0) {
      setError('Укажи числовой tg_user_id');
      return;
    }
    setAdding(true);
    setError(null);
    const res = await authFetch(`${API_BASE}/blocked-users`, {
      method: 'POST',
      body: JSON.stringify({
        tg_user_id: idNum,
        tg_username: addUsername.trim() ? addUsername.trim().replace(/^@/, '') : null,
      }),
    });
    setAdding(false);
    if (!res.ok) {
      const d = await res.json().catch(() => ({})) as { error?: string };
      setError(d.error ?? 'Не удалось добавить');
      return;
    }
    setAddId(''); setAddUsername('');
    void load();
  };

  const remove = async (tgUserId: number) => {
    await authFetch(`${API_BASE}/blocked-users/${tgUserId}`, { method: 'DELETE' });
    void load();
  };

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-gray-800">Глобальный чёрный список (по tg_user_id)</h3>
        <p className="mt-1 text-[11px] text-gray-500">
          Применяется ко всем твоим кампаниям и аккаунтам. Бот не будет отвечать и не создаст диалог
          для пользователей из этого списка — даже если у них нет username.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-gray-200 p-3">
        <input
          value={addId}
          onChange={e => setAddId(e.target.value)}
          placeholder="tg_user_id"
          className="rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-xs outline-none focus:border-indigo-400 w-40"
        />
        <input
          value={addUsername}
          onChange={e => setAddUsername(e.target.value)}
          placeholder="@username (необязательно)"
          className="rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-xs outline-none focus:border-indigo-400 w-56"
        />
        <button
          type="button"
          onClick={add}
          disabled={adding}
          className="inline-flex items-center gap-1.5 rounded-full bg-rose-600 px-4 py-2 text-xs font-semibold text-white hover:bg-rose-700 hover:shadow-md transition disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
        >
          {adding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Ban className="h-3.5 w-3.5" />}
          Заблокировать
        </button>
        {error && <span className="text-[11px] text-rose-600">{error}</span>}
      </div>
      {loading ? (
        <div className="flex items-center gap-2 py-4 text-xs text-gray-400">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />Загрузка...
        </div>
      ) : items.length === 0 ? (
        <p className="text-xs text-gray-400 py-4 text-center">Пока никто не заблокирован</p>
      ) : (
        <div className="divide-y divide-gray-100 rounded-lg border border-gray-200">
          {items.map(b => (
            <div key={b.tg_user_id} className="flex items-center gap-3 px-3 py-2 text-xs">
              <Ban className="h-3.5 w-3.5 text-rose-400 shrink-0" />
              <span className="font-medium text-gray-800 w-36">{b.tg_user_id}</span>
              <span className="text-gray-500 flex-1">{b.tg_username ? `@${b.tg_username}` : '—'}</span>
              <span className="text-gray-400">{formatDate(b.created_at)}</span>
              <button
                type="button"
                onClick={() => void remove(b.tg_user_id)}
                className="p-2 rounded-lg text-gray-400 hover:text-rose-600 hover:bg-rose-50 transition cursor-pointer"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/* =================== SETTINGS TAB =================== */
function SettingsTab({ campaign, onSave }: {
  campaign: OutreachCampaign;
  onSave: (openai: OpenAISettings, telegram: TelegramSettings) => Promise<void>;
}) {
  const [openai, setOpenai] = useState<OpenAISettings>({ ...DEFAULT_OPENAI_SETTINGS, ...campaign.openai_settings });
  const [telegram, setTelegram] = useState<TelegramSettings>({
    ...DEFAULT_TELEGRAM_SETTINGS,
    ...campaign.telegram_settings,
    follow_up: {
      ...DEFAULT_FOLLOW_UP,
      ...campaign.telegram_settings?.follow_up,
      delay_minutes: campaign.telegram_settings?.follow_up?.delay_minutes ?? 0,
      prompt: (campaign.telegram_settings?.follow_up?.prompt ?? '').trim() || DEFAULT_FOLLOW_UP.prompt,
    },
  });
  const [saving, setSaving] = useState(false);
  const [blockedRaw, setBlockedRaw] = useState(
    (campaign.telegram_settings?.blocked_usernames ?? []).join(', ')
  );

  const handleSave = async () => {
    setSaving(true);
    const parsed = blockedRaw.split(',').map(s => s.trim().replace(/^@/, '')).filter(Boolean);
    const updatedTelegram = { ...telegram, blocked_usernames: parsed };
    try { await onSave(openai, updatedTelegram); } finally { setSaving(false); }
  };

  const setOAI = <K extends keyof OpenAISettings>(k: K, v: OpenAISettings[K]) =>
    setOpenai(prev => ({ ...prev, [k]: v }));
  const setTG = <K extends keyof TelegramSettings>(k: K, v: TelegramSettings[K]) =>
    setTelegram(prev => ({ ...prev, [k]: v }));

  return (
    <div className="space-y-6">
      {/* Промпт, триггеры и чаты-приёмники. Заголовка нет намеренно: «OpenRouter»
          называл поставщика модели, а не то, что оператор здесь настраивает. */}
      <section className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Название проекта" value={openai.project_name} onChange={v => setOAI('project_name', v)} />
        </div>
        <FieldArea label="Системный промпт" value={openai.system_prompt} onChange={v => setOAI('system_prompt', v)} rows={6} />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <FieldArea label="Триггер (положительный)" value={openai.trigger_phrases_positive} onChange={v => setOAI('trigger_phrases_positive', v)} rows={2} />
          <FieldArea label="Триггер (отрицательный)" value={openai.trigger_phrases_negative} onChange={v => setOAI('trigger_phrases_negative', v)} rows={2} />
          <Field label="Чат для пересылки (+)" value={openai.target_chats_positive} onChange={v => setOAI('target_chats_positive', v)} placeholder="@username" />
          <Field label="Чат для пересылки (−)" value={openai.target_chats_negative} onChange={v => setOAI('target_chats_negative', v)} placeholder="@username" />
          <div className="space-y-1 md:col-span-2">
            <Field
              label="Чат для партнёров"
              value={openai.target_chats_partner ?? ''}
              onChange={v => setOAI('target_chats_partner', v)}
              placeholder="@username или оставьте пустым"
            />
            <p className="text-[10px] text-gray-400">
              Куда уходит кнопка «Передать партнёра» на вкладке «Диалоги». Заинтересованного клиента
              и человека, который хочет стать партнёром, обычно разбирают разные люди. Пусто —
              уйдёт в «Чат для пересылки (+)».
            </p>
          </div>
        </div>
        {/* Два верхних поля наполняет автоматика по триггерным фразам, нижнее —
            только ручная кнопка. Сказать об этом стоит здесь: иначе разница
            между «чатом пересылки» и «чатом партнёров» выглядит произвольной. */}
        <p className="text-[10px] text-gray-400 -mt-2">
          В чаты пересылки (+) и (−) бот отправляет сам, когда в его ответе встречается триггерная
          фраза. Передача лида и партнёра с вкладки «Диалоги» — всегда ручная, по кнопке и с
          подтверждением.
        </p>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 text-xs text-gray-700">
            <input type="checkbox" checked={openai.use_fallback_on_fail} onChange={e => setOAI('use_fallback_on_fail', e.target.checked)} className="rounded border-gray-300" />
            Резервный ответ при ошибке
          </label>
        </div>
        {openai.use_fallback_on_fail && (
          <FieldArea label="Резервный текст" value={openai.fallback_text} onChange={v => setOAI('fallback_text', v)} rows={2} />
        )}
      </section>

      {/* Telegram */}
      <section className="space-y-4">
        <h3 className="text-sm font-semibold text-gray-800">Telegram</h3>
        {/* Названия сверены с кодом: каждое поле подписано тем, что оно делает
            на самом деле, а не тем, как называется переменная. Три подписи были
            неверны и вводили в заблуждение — история в комментариях ниже. */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="space-y-1">
            <FieldNum label="Сообщений в пересылке" value={telegram.forward_limit} onChange={v => setTG('forward_limit', v)} />
            <p className="text-[10px] text-gray-400">
              Сколько последних сообщений диалога уйдёт в чат-приёмник при пересылке лида.
            </p>
          </div>
          <div className="space-y-1">
            <FieldNum label="Сообщений в контексте GPT" value={telegram.history_limit} onChange={v => setTG('history_limit', v)} />
            <p className="text-[10px] text-gray-400">
              Сколько последних сообщений диалога читает модель, прежде чем ответить.
            </p>
          </div>
          <div className="space-y-1">
            <FieldNum label="Часовой пояс (UTC±)" value={telegram.timezone_offset} onChange={v => setTG('timezone_offset', v)} />
            <p className="text-[10px] text-gray-400">
              Влияет только на «Периоды сна». 3 — Москва.
            </p>
          </div>
          {/* Было «Пауза аккаунта (часов)» — читалось как штатная пауза между
              заходами и создавало ложное чувство, что нагрузка размазана по
              суткам. На деле пауза включается ТОЛЬКО после того, как Telegram
              ограничил аккаунт (FloodError/Frozen), см. campaignLoop:1507. */}
          <div className="space-y-1">
            <FieldNum label="Пауза после ограничения (часов)" value={telegram.account_cooldown_hours} onChange={v => setTG('account_cooldown_hours', v)} />
            <p className="text-[10px] text-gray-400">
              Сколько аккаунт отдыхает после PEER_FLOOD / FloodWait — и на ответе, и на
              первом касании. Пока пауза не кончилась, воркер этот номер не берёт.
              Для холодной рассылки ставьте сутки, не 5 часов.
            </p>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1">
            <FieldNum
              label="Первых сообщений на аккаунт в сутки"
              value={telegram.first_touch_per_account_per_day ?? 0}
              onChange={v => setTG('first_touch_per_account_per_day', v)}
            />
            {/* Прежняя подсказка предлагала «16 аккаунтов по 20» как пример.
                В связке с паузой между действиями в 5–10 сек это означает 20
                новых чатов с незнакомыми людьми за три минуты — на молодом
                аккаунте почти верное ограничение. Пример заменён на лестницу. */}
            <p className="text-[10px] text-gray-400">
              Ноль — рассылка первых сообщений выключена. Норма считается на каждый аккаунт:
              18 аккаунтов по 3 — это 54 сообщения в день. Свежие аккаунты начинайте с 2–3 и
              поднимайте на ступень раз в 2–3 дня, только если в логах не было ограничений.
              Всю норму аккаунт отправляет одной очередью — разносите её полем
              «Пауза между действиями».
            </p>
          </div>
          {/* Порог был захардкожен в 400 знаков — число из статистики прошлых
              кампаний (медиана 260, 99% в 400), а не правило Telegram. На базе
              с ровными текстами по 430–460 знаков он останавливал рассылку
              целиком: каждый контакт откладывался, за три круга уходил в
              «отложенные», и не отправлялось ни одно сообщение. Ручка нужна
              оператору под рукой. */}
          <div className="space-y-1">
            <FieldNum
              label="Максимум знаков в первом сообщении"
              value={telegram.first_touch_max_chars ?? DEFAULT_MAX_MESSAGE_CHARS}
              onChange={v => setTG('first_touch_max_chars', v)}
            />
            <p className="text-[10px] text-gray-400">
              Длиннее — контакт откладывается, а не отправляется. Это фильтр мусора в файле
              (съехавшая колонка, обрезанная строка), а не ограничение Telegram: у него предел
              4096 знаков, выше него значение не поднимется. Ноль вернёт значение по умолчанию — 400.
              Если подняли порог уже после запуска, верните отложенные контакты в очередь на вкладке «Базы».
            </p>
          </div>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="space-y-1">
            <RangeField label="Пауза перед прочтением (сек)" value={telegram.pre_read_delay_range} onChange={v => setTG('pre_read_delay_range', v)} />
            <p className="text-[10px] text-gray-400">
              Сколько ждём, прежде чем отметить входящее прочитанным.
            </p>
          </div>
          {/* Было «Задержка до ответа» — подпись покрывала лишь одно из четырёх
              применений. Тот же диапазон задаёт паузу между ПЕРВЫМИ сообщениями
              внутри дневной нормы (firstTouch/send.ts, gapMs), а при 5–10 сек
              аккаунт пишет всю норму незнакомым людям за полминуты — самый
              короткий путь к ограничению. Об этом обязана говорить подпись. */}
          <div className="space-y-1">
            <RangeField label="Пауза между действиями (сек)" value={telegram.read_reply_delay_range} onChange={v => setTG('read_reply_delay_range', v)} />
            <p className="text-[10px] text-gray-400">
              Перед ответом, перед follow-up и <span className="text-amber-600">между первыми сообщениями</span>.
              5–10 сек означает, что вся дневная норма уйдёт очередью за полминуты. Для холодной
              рассылки ставьте 60–300.
            </p>
          </div>
          <div className="space-y-1">
            <RangeField label="Пауза между аккаунтами (сек)" value={telegram.account_loop_delay_range} onChange={v => setTG('account_loop_delay_range', v)} />
            <p className="text-[10px] text-gray-400">
              Разбежка между заходами разных аккаунтов, чтобы они не работали гурьбой.
            </p>
          </div>
          {/* Пауза между полными кругами по всем аккаунтам. Раньше была
              захардкожена в 30 секунд, что на «горячих» mobile-pool IP
              слишком быстро (Telegram продолжал отвечать silent throttle).
              Сейчас вынесено в настройки с дефолтом [300, 600] сек. */}
          <div className="space-y-1">
            <RangeField label="Пауза между кругами (сек)" value={telegram.cycle_delay_range ?? [300, 600]} onChange={v => setTG('cycle_delay_range', v)} />
            <p className="text-[10px] text-gray-400">
              Между полными обходами всех аккаунтов.
            </p>
          </div>
        </div>
        {/* «Окно ожидания диалога» (dialog_wait_window_range) убрано с экрана:
            ключ есть в TelegramSettings и в дефолтах, но НИ ОДНА строка кода его
            не читает — поле ничего не делало, а операторы его крутили. Значение
            в БД оставлено как есть, чтобы не трогать сохранённые кампании. */}
        <Field label="Периоды сна" value={telegram.sleep_periods.join(', ')} onChange={v => setTG('sleep_periods', v.split(',').map(s => s.trim()).filter(Boolean))} placeholder="00:00-08:00, 19:00-00:00" />
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-xs text-gray-700">
            <input type="checkbox" checked={telegram.reply_only_if_previously_wrote} onChange={e => setTG('reply_only_if_previously_wrote', e.target.checked)} className="rounded border-gray-300" />
            Отвечать только если ранее писали
          </label>
          <label className="flex items-center gap-2 text-xs text-gray-700">
            <input type="checkbox" checked={telegram.auto_allow_new_dialogs} onChange={e => setTG('auto_allow_new_dialogs', e.target.checked)} className="rounded border-gray-300" />
            Новым диалогам разрешать отправку автоматически
          </label>
          <label className="flex items-center gap-2 text-xs text-gray-700">
            <input type="checkbox" checked={telegram.reply_only_to_base_contacts ?? false} onChange={e => setTG('reply_only_to_base_contacts', e.target.checked)} className="rounded border-gray-300" />
            Писать только контактам из баз
          </label>
          <label className="flex items-center gap-2 text-xs text-gray-700">
            <input type="checkbox" checked={telegram.ignore_bot_usernames} onChange={e => setTG('ignore_bot_usernames', e.target.checked)} className="rounded border-gray-300" />
            Игнорировать ботов
          </label>
          <label className="flex items-center gap-2 text-xs text-gray-700">
            <input type="checkbox" checked={telegram.ignore_no_username} onChange={e => setTG('ignore_no_username', e.target.checked)} className="rounded border-gray-300" />
            Игнорировать без имени пользователя
          </label>
        </div>
        <p className="text-[10px] text-gray-400 -mt-2">
          «Писать только контактам из баз» — бот отвечает лишь тем, кому мы сами написали по базе
          этой кампании. Без неё он отвечает в любом чате, где есть наше исходящее, включая
          переписку прогрева между своими же аккаунтами: партнёр по прогреву получал боевой скрипт,
          а его ответ мог уехать в чат менеджера как лид. Обратная сторона: тот, кто написал первым
          сам, без первого касания, ответа не получит.
        </p>
        <Field
          label="Чёрный список username (через запятую)"
          value={blockedRaw}
          onChange={setBlockedRaw}
          placeholder="SpamBot, another_bot"
        />
      </section>

      <GlobalBlocklistSection />

      {/* Follow-up */}
      <section className="space-y-4">
        <h3 className="text-sm font-semibold text-gray-800">Настройки Follow-up сообщений</h3>
        <div className="rounded-lg border border-blue-100 bg-blue-50/50 p-3 text-xs text-gray-700">
          Follow-up отправляется автоматически, если человек не ответил на сообщение в течение заданного времени. Отправляется только 1 раз для каждого диалога.
        </div>
        <label className="flex items-center gap-2 text-sm font-medium text-gray-700">
          <input type="checkbox" checked={telegram.follow_up.enabled} onChange={e => setTG('follow_up', { ...telegram.follow_up, enabled: e.target.checked })} className="rounded border-gray-300" />
          Включить Follow-up сообщения
        </label>
        {telegram.follow_up.enabled && (
          <div className="space-y-4 rounded-lg border border-gray-200 p-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <FieldNum label="Задержка перед отправкой (часы)" value={telegram.follow_up.delay_hours} onChange={v => setTG('follow_up', { ...telegram.follow_up, delay_hours: v })} />
              </div>
              <div>
                <FieldNum label="Задержка (минуты)" value={telegram.follow_up.delay_minutes ?? 0} onChange={v => setTG('follow_up', { ...telegram.follow_up, delay_minutes: v })} />
              </div>
            </div>
            <p className="text-[11px] text-gray-500">Через сколько времени без ответа отправить follow-up (по умолчанию: 24 часа 0 минут)</p>
            <div>
              <FieldArea label="Промпт для генерации сообщения" value={telegram.follow_up.prompt} onChange={v => setTG('follow_up', { ...telegram.follow_up, prompt: v })} rows={4} placeholder="Напиши короткое напоминание о себе..." />
              <p className="mt-1 text-[11px] text-gray-500">GPT учтёт историю переписки. Опишите, каким должно быть сообщение.</p>
            </div>
            <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-3 text-[11px] text-gray-700">
              <strong>Важно:</strong>
              <ul className="mt-1 list-inside list-disc space-y-0.5">
                <li>Отправляется только если последнее сообщение от бота</li>
                <li>Только 1 раз для каждого пользователя</li>
                <li>Не отправляется для уже обработанных клиентов</li>
              </ul>
            </div>
          </div>
        )}
      </section>

      <button type="button" onClick={handleSave} disabled={saving}
        className="inline-flex items-center gap-2 rounded-full bg-indigo-600 px-6 py-2.5 text-xs font-semibold text-white hover:bg-indigo-700 hover:shadow-md transition disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer">
        {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
        Сохранить настройки
      </button>
    </div>
  );
}

/* =================== LOGS TAB =================== */
/**
 * Окна, по которым режется журнал. Месяц добавлен 27.08.2026: на семи днях не
 * видно медленного — аккаунт, замолчавший две недели назад, в таком окне
 * выглядит как никогда не работавший.
 */
type ErrorRange = '6h' | '24h' | '7d' | '30d';

const RANGE_MS: Record<ErrorRange, number> = {
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

const RANGE_LABEL: Record<ErrorRange, string> = {
  '6h': '6 часов', '24h': '24 часа', '7d': '7 дней', '30d': '30 дней',
};

type ErrorCountsResponse = {
  range: ErrorRange;
  since: string;
  until: string;
  truncated: boolean;
  counts: Record<string, { error: number; warning: number; account_id: string }>;
  other: {
    error: number;
    warning: number;
    recent: { id: number; level: 'error' | 'warning'; message: string; created_at: string }[];
  };
};

function formatPeriod(sinceIso: string, untilIso: string) {
  const opts: Intl.DateTimeFormatOptions = {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  };
  const since = new Date(sinceIso).toLocaleString('ru-RU', opts);
  const until = new Date(untilIso).toLocaleString('ru-RU', opts);
  return `${since} — ${until}`;
}

function LogsTab({ campaignId }: { campaignId: string }) {
  const [logs, setLogs] = useState<OutreachLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [exportingRange, setExportingRange] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isAutoScroll = useRef(true);

  // Side panel state: range, accounts (for opening AccountLogsModal on click)
  // and the aggregated error counts. Polled on the same 5s cadence as logs so
  // a fresh ошибка in the dark block doesn't lag behind in the side list.
  const [panelRange, setPanelRange] = useState<ErrorRange>('24h');
  /**
   * Глубина живой ленты. Раньше была намертво зашита в шесть часов, и на
   * вопрос «когда этот аккаунт замолчал» журнал ответить не мог вовсе: всё,
   * что старше утра, было доступно только выгрузкой в файл.
   */
  const [viewRange, setViewRange] = useState<ErrorRange>('6h');
  /** Лента упёрлась в потолок строк — часть периода в неё не поместилась. */
  const [viewCapped, setViewCapped] = useState(false);
  const [accounts, setAccounts] = useState<OutreachAccount[]>([]);
  const [proxies, setProxies] = useState<OutreachProxy[]>([]);
  const [errData, setErrData] = useState<ErrorCountsResponse | null>(null);
  const [errLoading, setErrLoading] = useState(true);
  const [selectedAccount, setSelectedAccount] = useState<OutreachAccount | null>(null);

  const fetchLogs = useCallback(async () => {
    /**
     * Потолок в пять тысяч строк — предел читаемости тёмного блока: больше
     * просто не пролистать, а DOM на месяце болтливой кампании уже ощутимо
     * тормозит. Запрос идёт от новых к старым, поэтому обрезается хвост
     * истории, а не свежие строки, — и об обрезке говорим словами, иначе
     * «логов за месяц нет» и «они не поместились» неразличимы.
     */
    const LIMIT = 5000;
    const sinceIso = new Date(Date.now() - RANGE_MS[viewRange]).toISOString();
    const params = new URLSearchParams({ since: sinceIso, limit: String(LIMIT) });
    const res = await authFetch(`${API_BASE}/campaigns/${campaignId}/logs?${params}`);
    if (res.ok) {
      const d = await res.json() as { items: OutreachLog[]; total?: number };
      setLogs(d.items.reverse());
      setViewCapped((d.total ?? d.items.length) > d.items.length);
    }
    setLoading(false);
  }, [campaignId, viewRange]);

  const fetchSidePanel = useCallback(async () => {
    const [errRes, accRes, proxRes] = await Promise.all([
      authFetch(`${API_BASE}/campaigns/${campaignId}/accounts/error-counts?range=${panelRange}`),
      authFetch(`${API_BASE}/accounts?campaign_id=${campaignId}`),
      authFetch(`${API_BASE}/proxies?campaign_id=${campaignId}`),
    ]);
    if (errRes.ok) {
      const d = await errRes.json() as ErrorCountsResponse;
      setErrData(d);
    }
    if (accRes.ok) {
      const d = await accRes.json() as { items: OutreachAccount[] };
      setAccounts(d.items);
    }
    if (proxRes.ok) {
      const d = await proxRes.json() as { items: OutreachProxy[] };
      setProxies(d.items);
    }
    setErrLoading(false);
  }, [campaignId, panelRange]);

  const exportLogs = useCallback(
    async (range: ErrorRange) => {
      setExportingRange(range);
      try {
        const res = await authFetch(`${API_BASE}/campaigns/${campaignId}/logs/export?range=${range}`);
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          alert((data as { error?: string }).error ?? `Не удалось выгрузить логи (HTTP ${res.status})`);
          return;
        }
        // Pick up the server-suggested filename from Content-Disposition; fall
        // back to a sensible default if the browser/proxy stripped it.
        const cd = res.headers.get('content-disposition') ?? '';
        const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(cd);
        const ascii = /filename="?([^";]+)"?/i.exec(cd);
        const filename = utf8
          ? decodeURIComponent(utf8[1])
          : (ascii?.[1] ?? `tg-outreach-logs-${range}.txt`);

        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } finally {
        setExportingRange(null);
      }
    },
    [campaignId],
  );

  useEffect(() => { queueMicrotask(() => { void fetchLogs(); }); }, [fetchLogs]);
  useEffect(() => { queueMicrotask(() => { void fetchSidePanel(); }); }, [fetchSidePanel]);

  useEffect(() => {
    const interval = setInterval(() => {
      void fetchLogs();
      void fetchSidePanel();
    }, 10000);
    return () => clearInterval(interval);
  }, [fetchLogs, fetchSidePanel]);

  const handleScroll = useCallback(() => {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    // Если мы в пределах 50px от низа, включаем автоскролл
    isAutoScroll.current = scrollHeight - scrollTop - clientHeight < 50;
  }, []);

  useEffect(() => {
    if (isAutoScroll.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs]);

  const levelColor = (l: string) => {
    switch (l) {
      case 'error': return 'text-rose-400';
      case 'warning': return 'text-amber-400';
      default: return 'text-gray-400';
    }
  };

  // Sort accounts by error count desc; only show those with non-zero errors or
  // warnings. Account-side keys are session_name (matches API contract).
  const accountsWithErrors = React.useMemo(() => {
    if (!errData) return [] as { account: OutreachAccount; error: number; warning: number }[];
    return accounts
      .map(a => {
        const c = errData.counts[a.session_name];
        return {
          account: a,
          error: c?.error ?? 0,
          warning: c?.warning ?? 0,
        };
      })
      .filter(x => x.error > 0 || x.warning > 0)
      .sort((a, b) => (b.error - a.error) || (b.warning - a.warning));
  }, [errData, accounts]);

  const totalErr = errData?.other.error ?? 0;
  const totalWarn = errData?.other.warning ?? 0;
  const accErr = accountsWithErrors.reduce((s, x) => s + x.error, 0);
  const accWarn = accountsWithErrors.reduce((s, x) => s + x.warning, 0);

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_360px] gap-4">
      {/* Left: existing export bar + dark log block */}
      <div className="space-y-3 min-w-0">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-gray-400">Показывать за:</span>
            {(['6h', '24h', '7d', '30d'] as const).map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setViewRange(r)}
                className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition cursor-pointer border ${viewRange === r ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-gray-600 border-gray-200 hover:border-indigo-300 hover:bg-indigo-50'}`}
              >
                {RANGE_LABEL[r]}
              </button>
            ))}
            <span className="ml-1 text-[11px] text-gray-400">
              · обновление каждые 10 сек
              {viewCapped && ' · поместились только последние 5000 строк, весь период — кнопкой «Выгрузить .txt»'}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500 mr-1">Выгрузить .txt:</span>
            {(['6h', '24h', '7d', '30d'] as const).map((r) => {
              const labels: Record<typeof r, string> = { '6h': '6 часов', '24h': '24 часа', '7d': '7 дней', '30d': '30 дней' };
              const busy = exportingRange === r;
              return (
                <button
                  key={r}
                  type="button"
                  onClick={() => void exportLogs(r)}
                  disabled={exportingRange !== null}
                  className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-3.5 py-1.5 text-xs font-medium text-gray-700 hover:border-indigo-300 hover:bg-indigo-50 hover:shadow-sm transition disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                >
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                  {labels[r]}
                </button>
              );
            })}
          </div>
        </div>
        <div
          ref={containerRef}
          onScroll={handleScroll}
          className="rounded-lg border border-gray-800 bg-gray-950 p-3 font-mono text-[11px] leading-relaxed h-[500px] overflow-auto"
        >
          {loading && <p className="text-gray-500">Загрузка логов...</p>}
          {!loading && logs.length === 0 && <p className="text-gray-600">Нет логов. Запустите кампанию.</p>}
          {logs.map(log => (
            <div key={log.id} className="flex gap-2">
              <span className="text-gray-600 shrink-0">{new Date(log.created_at).toLocaleTimeString('ru-RU')}</span>
              <span className={`shrink-0 font-bold uppercase w-14 ${levelColor(log.level)}`}>{log.level}</span>
              <span className="text-gray-300 break-all">{log.message}</span>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* Right: errors side panel */}
      <aside className="rounded-lg border border-gray-200 bg-white flex flex-col h-[538px] min-h-0 overflow-hidden">
        <header className="px-3.5 py-3 border-b border-gray-100 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold text-gray-800 flex items-center gap-1.5">
              <AlertCircle className="h-3.5 w-3.5 text-rose-500" />
              Ошибки за период
            </h3>
            <button
              type="button"
              onClick={() => { setErrLoading(true); void fetchSidePanel(); }}
              title="Обновить"
              className="p-1 rounded-md text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 transition cursor-pointer"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${errLoading ? 'animate-spin' : ''}`} />
            </button>
          </div>
          <div className="flex items-center gap-1">
            {(['6h', '24h', '7d', '30d'] as const).map(r => {
              const labels: Record<ErrorRange, string> = { '6h': '6ч', '24h': '24ч', '7d': '7д', '30d': '30д' };
              const active = panelRange === r;
              return (
                <button
                  key={r}
                  type="button"
                  onClick={() => { setPanelRange(r); setErrLoading(true); }}
                  className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition cursor-pointer ${
                    active
                      ? 'bg-indigo-600 text-white'
                      : 'bg-white text-gray-600 border border-gray-200 hover:border-indigo-300 hover:bg-indigo-50'
                  }`}
                >
                  {labels[r]}
                </button>
              );
            })}
          </div>
          {errData && (
            <p className="text-[10px] text-gray-500 leading-snug">
              Период: <span className="text-gray-700 font-medium">{formatPeriod(errData.since, errData.until)}</span>
            </p>
          )}
          <div className="flex items-center gap-2 text-[11px]">
            <span className="inline-flex items-center gap-1 rounded-md bg-rose-50 px-1.5 py-0.5 text-rose-700">
              <span className="font-semibold">{accErr + totalErr}</span> ошибок
            </span>
            <span className="inline-flex items-center gap-1 rounded-md bg-amber-50 px-1.5 py-0.5 text-amber-700">
              <span className="font-semibold">{accWarn + totalWarn}</span> предупр.
            </span>
            {errData?.truncated && (
              <span className="text-[10px] text-gray-400 ml-auto">обрезано</span>
            )}
          </div>
        </header>

        <div className="flex-1 overflow-auto">
          {/* Accounts with errors */}
          <div className="px-3.5 py-3 border-b border-gray-100">
            <h4 className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 mb-2">
              Аккаунты с ошибками
            </h4>
            {errLoading && !errData ? (
              <div className="flex items-center gap-2 py-2 text-[11px] text-gray-400">
                <Loader2 className="h-3 w-3 animate-spin" /> Загрузка...
              </div>
            ) : accountsWithErrors.length === 0 ? (
              <p className="text-[11px] text-gray-400 py-2">Нет ошибок у аккаунтов</p>
            ) : (
              <ul className="space-y-1">
                {accountsWithErrors.map(({ account, error, warning }) => (
                  <li key={account.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedAccount(account)}
                      title="Открыть логи аккаунта"
                      className="w-full flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-gray-50 transition cursor-pointer text-left"
                    >
                      <span className="text-[11px] font-medium text-gray-800 truncate flex-1 min-w-0">
                        {account.session_name}
                      </span>
                      {error > 0 && (
                        <span className="inline-flex items-center gap-0.5 rounded-full bg-rose-50 px-1.5 py-0.5 text-[10px] font-semibold text-rose-700 shrink-0">
                          <AlertCircle className="h-2.5 w-2.5" />
                          {error}
                        </span>
                      )}
                      {warning > 0 && (
                        <span className="inline-flex items-center gap-0.5 rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 shrink-0">
                          {warning}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Other errors (not tied to any account) */}
          <div className="px-3.5 py-3">
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                Прочие ошибки
              </h4>
              {errData && (totalErr + totalWarn > 0) && (
                <span className="text-[10px] text-gray-400">
                  {totalErr} ош. · {totalWarn} пред.
                </span>
              )}
            </div>
            {errLoading && !errData ? (
              <div className="flex items-center gap-2 py-2 text-[11px] text-gray-400">
                <Loader2 className="h-3 w-3 animate-spin" /> Загрузка...
              </div>
            ) : !errData || errData.other.recent.length === 0 ? (
              <p className="text-[11px] text-gray-400 py-2">
                Нет ошибок без привязки к аккаунту
              </p>
            ) : (
              <ul className="space-y-1.5">
                {errData.other.recent.map(row => (
                  <li
                    key={row.id}
                    className="rounded-md border border-gray-100 bg-gray-50 px-2 py-1.5 text-[11px]"
                  >
                    <div className="flex items-center gap-1.5 text-[10px] text-gray-500 mb-0.5">
                      <span className={`font-semibold uppercase ${row.level === 'error' ? 'text-rose-600' : 'text-amber-600'}`}>
                        {row.level}
                      </span>
                      <span>
                        {new Date(row.created_at).toLocaleString('ru-RU', {
                          day: '2-digit', month: '2-digit',
                          hour: '2-digit', minute: '2-digit',
                        })}
                      </span>
                    </div>
                    <p className="text-gray-700 break-words leading-snug">{row.message}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </aside>

      {selectedAccount && (
        <AccountLogsModal
          account={selectedAccount}
          proxy={proxies.find(p => p.id === selectedAccount.proxy_id) ?? null}
          onClose={() => setSelectedAccount(null)}
        />
      )}
    </div>
  );
}

/* =================== DIALOGS TAB =================== */
// Флага «своя/чужая кампания» здесь больше нет. Он появился как зеркало RLS из
// 20260320_0003 (читать всем, писать владельцу) — а 20260807_0004 это правило
// сняла: аутрич командный, кампанию ведут несколько специалистов.
function DialogsTab({ campaignId }: {
  campaignId: string;
}) {
  const [dialogs, setDialogs] = useState<OutreachDialog[]>([]);
  /** Диалог, у которого не сохранилось изменение, и причина — под его карточкой. */
  const [dialogSaveError, setDialogSaveError] = useState<{ id: string; message: string } | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [offset, setOffset] = useState(0);
  const [filterStatus, setFilterStatus] = useState('');
  /**
   * Поиск по нику. `search` — то, что в поле, `query` — то, что уже ушло на
   * сервер. Разделены ради задержки: без неё каждая буква била бы запросом по
   * базе, и список моргал бы на каждом нажатии.
   */
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [filterCanSend, setFilterCanSend] = useState<'all' | 'enabled' | 'disabled'>('all');
  const [filterAudience, setFilterAudience] = useState<'all' | 'users' | 'bots'>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [sendText, setSendText] = useState('');
  const [sending, setSending] = useState(false);
  const [accounts, setAccounts] = useState<OutreachAccount[]>([]);
  /** `<dialogId>:<kind>` пока собирается предпросмотр и ставится задача. */
  const [forwarding, setForwarding] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const limit = 30;

  const fetchAccounts = useCallback(async () => {
    const res = await authFetch(`${API_BASE}/accounts?campaign_id=${campaignId}`);
    if (res.ok) {
      const d = await res.json() as { items: OutreachAccount[] };
      setAccounts(d.items);
    }
  }, [campaignId]);

  const accountNameMap = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const a of accounts) map.set(a.id, a.session_name);
    return map;
  }, [accounts]);

  const fetchDialogs = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ campaign_id: campaignId, limit: String(limit), offset: String(offset) });
    if (query.trim()) params.set('q', query.trim());
    if (filterStatus) params.set('status', filterStatus);
    if (filterCanSend === 'enabled') params.set('can_send', 'true');
    if (filterCanSend === 'disabled') params.set('can_send', 'false');
    if (filterAudience === 'bots') params.set('tg_is_bot', 'true');
    if (filterAudience === 'users') params.set('tg_is_bot', 'false');
    const res = await authFetch(`${API_BASE}/dialogs?${params}`);
    if (res.ok) {
      const d = await res.json() as { items: OutreachDialog[]; total: number };
      setDialogs(d.items); setTotal(d.total);
    }
    setLoading(false);
  }, [campaignId, offset, query, filterStatus, filterCanSend, filterAudience]);

  // Полсекунды тишины — и запрос уходит. Заодно сбрасываем страницу: искать на
  // третьей странице прошлого фильтра бессмысленно.
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery((cur) => (cur === search ? cur : search));
      setOffset((cur) => (search === query ? cur : 0));
    }, 500);
    return () => clearTimeout(timer);
  }, [search, query]);

  useEffect(() => { queueMicrotask(() => { void fetchDialogs(); void fetchAccounts(); }); }, [fetchDialogs, fetchAccounts]);

  /**
   * Пометка статуса и тумблер «можно писать» — оптимистично.
   *
   * Раньше после сохранения перезагружался весь список: раскрытая карточка
   * схлопывалась, прокрутка уезжала, и оператор, размечающий подряд, каждый раз
   * искал место заново. Ответ сервера при этом ничего нового не приносит — он
   * возвращает то же значение, которое мы и отправили.
   *
   * Поэтому меняем состояние сразу, а запрос уходит фоном. Не сохранилось —
   * возвращаем прежнее значение и пишем причину рядом с карточкой: молча
   * откатить хуже, чем не откатить вовсе, оператор был бы уверен, что пометил.
   */
  const updateDialog = async (id: string, patch: { status?: DialogStatus; can_send?: boolean }) => {
    const before = dialogs.find((d) => d.id === id);
    if (!before) return;

    setDialogs((cur) => cur.map((d) => (d.id === id ? { ...d, ...patch } : d)));
    setDialogSaveError((cur) => (cur?.id === id ? null : cur));

    try {
      const res = await authFetch(`${API_BASE}/dialogs/${id}`, {
        method: 'PUT',
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `сервер ответил ${res.status}`);
      }
    } catch (err) {
      // Возвращаем именно прежний объект целиком: патч мог тронуть несколько
      // полей, и откатывать их по одному — лишний способ ошибиться.
      setDialogs((cur) => cur.map((d) => (d.id === id ? before : d)));
      setDialogSaveError({
        id,
        message: err instanceof Error ? err.message : 'не удалось связаться с сервером',
      });
    }
  };

  const deleteDialog = async (id: string) => {
    await authFetch(`${API_BASE}/dialogs/${id}`, { method: 'DELETE' });
    void fetchDialogs();
  };

  /**
   * Передать человека менеджеру: лидом или кандидатом в партнёры.
   *
   * Сначала показываем ровно тот текст, который уйдёт, — подтверждать вслепую
   * нечестно: сообщение уходит наружу, живому человеку, и отозвать его нельзя.
   * Дальше кнопка только ставит задачу: отправляет воркер тем же аккаунтом,
   * что вёл переписку, когда дойдёт до него в круге.
   */
  const forwardDialog = async (dialog: OutreachDialog, kind: 'lead' | 'partner') => {
    const key = `${dialog.id}:${kind}`;
    setForwarding(key);
    try {
      const previewRes = await authFetch(`${API_BASE}/dialogs/${dialog.id}/forward?kind=${kind}`);
      const preview = (await previewRes.json().catch(() => null)) as
        { text?: string; target_chat?: string; error?: string } | null;
      if (!previewRes.ok) {
        alert(preview?.error ?? `Не удалось собрать сообщение (${previewRes.status})`);
        return;
      }

      const what = kind === 'lead' ? 'лида' : 'кандидата в партнёры';
      // Контакт мог уйти менеджеру сам, по триггеру, — тогда ручная передача
      // задвоит его у адресата. Запрещать не за что: передать того же человека
      // в другой чат бывает нужно. Решает оператор, но с открытыми глазами.
      const warning = autoForwardWarning(
        dialog,
        dialog.auto_forwarded_at ? formatDate(dialog.auto_forwarded_at) : null,
      );
      if (!confirm(
        (warning ? `⚠ ${warning}\n\n` : '')
        + `Передать ${what} в ${preview?.target_chat}?\n\n`
        + 'Отправит аккаунт кампании, когда воркер дойдёт до него в круге.\n'
        + 'Пока задача ждёт в очереди, её можно снять кнопкой «Отменить отправку».\n\n'
        + `——— Текст сообщения ———\n${preview?.text ?? ''}`,
      )) return;

      const res = await authFetch(`${API_BASE}/dialogs/${dialog.id}/forward`, {
        method: 'POST',
        body: JSON.stringify({ kind }),
      });
      const body = (await res.json().catch(() => null)) as { error?: string; target_chat?: string } | null;
      if (!res.ok) {
        alert(body?.error ?? `Не удалось поставить передачу в очередь (${res.status})`);
        return;
      }
      alert(`Поставлено в очередь. Уйдёт в ${body?.target_chat} с аккаунта, который вёл переписку.`);
      // Перечитываем список: иначе кнопки остались бы на экране, приглашая
      // поставить в очередь то же самое ещё раз.
      void fetchDialogs();
    } finally {
      setForwarding(null);
    }
  };

  /**
   * Снять передачу из очереди, пока воркер до неё не дошёл.
   *
   * Ошибиться кнопкой «Передать» легко, а до отправки проходят часы — всё это
   * время исправить ещё можно. Раньше нельзя было: очередь гасили запросом в
   * базу руками (13.08.2026 так снимали шесть лидов).
   */
  const cancelForward = async (dialog: OutreachDialog) => {
    const what = dialog.forward?.kind === 'partner' ? 'кандидата в партнёры' : 'лида';
    if (!confirm(
      `Отменить передачу ${what}?\n\n`
      + 'Задача снимется из очереди, менеджеру ничего не уйдёт.\n'
      + 'Передать этого человека снова можно будет теми же кнопками.',
    )) return;

    setCancelling(dialog.id);
    try {
      const res = await authFetch(`${API_BASE}/dialogs/${dialog.id}/forward`, { method: 'DELETE' });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        // Чаще всего это «воркер успел отправить» — оператору важно узнать
        // именно это, а не общее «не получилось»: сообщение уже у менеджера.
        alert(body?.error ?? `Не удалось отменить передачу (${res.status})`);
        void fetchDialogs();
        return;
      }
      void fetchDialogs();
    } finally {
      setCancelling(null);
    }
  };

  const addToBlacklist = async (dialog: OutreachDialog) => {
    const username = (dialog.tg_username ?? '').toLowerCase().replace(/^@/, '');
    // Глобальный блок-лист по tg_user_id: запись применяется ко всем кампаниям и
    // аккаунтам пользователя; API сам выставит can_send=false на всех существующих
    // диалогах с этим tg_user_id (RLS отфильтрует только свои).
    await authFetch(`${API_BASE}/blocked-users`, {
      method: 'POST',
      body: JSON.stringify({
        tg_user_id: dialog.tg_user_id,
        tg_username: username || null,
      }),
    });
    void fetchDialogs();
  };

  const sendMessage = async (id: string) => {
    if (!sendText.trim()) return;
    setSending(true);
    await authFetch(`${API_BASE}/dialogs/${id}/send`, {
      method: 'POST',
      body: JSON.stringify({ message: sendText }),
    });
    setSendText(''); setSending(false);
    void fetchDialogs();
  };

  const exportDialogs = async (format: 'json' | 'html') => {
    const res = await authFetch(`${API_BASE}/dialogs/export?campaign_id=${campaignId}&format=${format}`);
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dialogs.${format}`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const totalPages = Math.ceil(total / limit);
  const currentPage = Math.floor(offset / limit) + 1;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          {/* Поиск стоит первым: когда ищут конкретного человека, фильтры не
              нужны, а листать три сотни диалогов руками — не вариант. */}
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Поиск по нику или ID"
              aria-label="Поиск диалога по никнейму или числовому ID"
              className="w-56 rounded-full border border-gray-200 bg-white py-1.5 pl-8 pr-7 text-xs outline-none transition focus:border-indigo-400"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                title="Очистить поиск"
                className="absolute right-2 top-1/2 -translate-y-1/2 cursor-pointer text-gray-400 hover:text-gray-600"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
          <span className="text-xs text-gray-500">Статус:</span>
          {['', 'none', 'lead', 'not_lead', 'later'].map(s => (
            <button key={s} type="button" onClick={() => { setFilterStatus(s); setOffset(0); }}
              className={`rounded-full px-4 py-1.5 text-xs font-medium transition border cursor-pointer ${filterStatus === s ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-gray-700 border-gray-200 hover:border-indigo-300 hover:bg-indigo-50'}`}>
              {s ? DIALOG_STATUS_LABELS[s]?.label : 'Все'}
            </button>
          ))}
          <span className="ml-2 text-xs text-gray-500">Отправка:</span>
          {[
            { id: 'all', label: 'Все' },
            { id: 'enabled', label: 'Разрешено' },
            { id: 'disabled', label: 'Запрещено' },
          ].map(s => (
            <button key={s.id} type="button" onClick={() => { setFilterCanSend(s.id as typeof filterCanSend); setOffset(0); }}
              className={`rounded-full px-4 py-1.5 text-xs font-medium transition border cursor-pointer ${filterCanSend === s.id ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-gray-700 border-gray-200 hover:border-indigo-300 hover:bg-indigo-50'}`}>
              {s.label}
            </button>
          ))}
          <span className="ml-2 text-xs text-gray-500">Тип:</span>
          {[
            { id: 'all', label: 'Все' },
            { id: 'users', label: 'Люди' },
            { id: 'bots', label: 'Боты' },
          ].map(s => (
            <button key={s.id} type="button" onClick={() => { setFilterAudience(s.id as typeof filterAudience); setOffset(0); }}
              className={`rounded-full px-4 py-1.5 text-xs font-medium transition border cursor-pointer ${filterAudience === s.id ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-gray-700 border-gray-200 hover:border-indigo-300 hover:bg-indigo-50'}`}>
              {s.label}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => void exportDialogs('json')} className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-white px-4 py-2 text-xs font-medium text-gray-700 hover:border-indigo-300 hover:bg-indigo-50 hover:shadow-sm transition cursor-pointer">
            <Download className="h-3.5 w-3.5" /> JSON
          </button>
          <button type="button" onClick={() => void exportDialogs('html')} className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-white px-4 py-2 text-xs font-medium text-gray-700 hover:border-indigo-300 hover:bg-indigo-50 hover:shadow-sm transition cursor-pointer">
            <Download className="h-3.5 w-3.5" /> HTML
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-8 text-sm text-gray-400"><Loader2 className="h-4 w-4 animate-spin" />Загрузка...</div>
      ) : dialogs.length === 0 ? (
        <p className="text-xs text-gray-400 py-8 text-center">
          {query.trim()
            ? `По запросу «${query.trim()}» ничего не нашлось. Ник ищется по части, но только по нику собеседника — не по тексту переписки.`
            : 'Нет диалогов'}
        </p>
      ) : (
        <div className="space-y-2">
          {dialogs.map(d => {
            const isExpanded = expandedId === d.id;
            const st = DIALOG_STATUS_LABELS[d.status] ?? DIALOG_STATUS_LABELS.none;
            const autoMark = describeAutoForward(d);
            return (
              <div key={d.id} className="rounded-xl border border-gray-200 bg-white shadow-sm">
                <button type="button" onClick={() => setExpandedId(isExpanded ? null : d.id)}
                  className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-100 transition rounded-xl cursor-pointer">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-900">{d.tg_username ? `@${d.tg_username}` : `ID ${d.tg_user_id}`}</span>
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${st.cls}`}>{st.label}</span>
                      {d.tg_is_bot ? (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700">Бот</span>
                      ) : (
                        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-600">Пользователь</span>
                      )}
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={(e) => {
                          // Бейдж лежит внутри кнопки-аккордеона (раскрытие
                          // диалога). Без stopPropagation клик одновременно
                          // переключал can_send и раскрывал/сворачивал — оператор
                          // видит «дёрнулось», а раскрыт диалог или нет —
                          // непонятно.
                          e.stopPropagation();
                          void updateDialog(d.id, { can_send: d.can_send === false });
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            e.stopPropagation();
                            void updateDialog(d.id, { can_send: d.can_send === false });
                          }
                        }}
                        title={
                          d.can_send === false
                            ? 'Сейчас отправка отключена — клик включит «Можно писать».'
                            : 'Сейчас отправка разрешена — клик переключит в «Не писать».'
                        }
                        className={`rounded-full px-2 py-0.5 text-[10px] font-medium transition cursor-pointer hover:opacity-80 ${d.can_send === false ? 'bg-rose-100 text-rose-700' : 'bg-emerald-100 text-emerald-700'}`}
                      >
                        {d.can_send === false ? 'Не писать' : 'Можно писать'}
                      </span>
                      {autoMark && <AutoForwardBadge mark={autoMark} compact />}
                      {isActiveForward(d.forward) && (
                        <ForwardBadge forward={d.forward} compact />
                      )}
                      <span className="text-[10px] text-gray-400">{d.messages.length} сообщ.</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] text-gray-400">{d.last_message_at ? formatDate(d.last_message_at) : '—'}</span>
                      {/* Из какой гипотезы человек. Второй строкой, а не в ряд
                          со статусами: разметку ведут по статусам, и лишний
                          бейдж среди них удлинял бы поиск нужного. */}
                      {d.base && (
                        <span
                          title={
                            d.base.alsoIn.length
                              ? `Написали из базы «${d.base.name}». Тот же контакт есть и в базах: ${d.base.alsoIn.join(', ')}.`
                              : `Контакт из базы «${d.base.name}»`
                          }
                          className="inline-flex items-center gap-1 rounded-full bg-violet-50 px-2 py-0.5 text-[10px] font-medium text-violet-700"
                        >
                          <Database className="h-3 w-3" />
                          {d.base.name}
                          {/* Цвет тот же, что у имени базы: у «text-violet-400»
                              нет пары в тёмной теме портала, и счётчик уезжал
                              бы в невидимое. */}
                          {d.base.alsoIn.length > 0 && <span className="opacity-70">+{d.base.alsoIn.length}</span>}
                        </span>
                      )}
                    </div>
                  </div>
                  {isExpanded ? <ChevronUp className="h-4 w-4 text-gray-400" /> : <ChevronDown className="h-4 w-4 text-gray-400" />}
                </button>
                {isExpanded && (
                  <div className="border-t border-gray-100 px-4 py-3 space-y-3">
                    {dialogSaveError?.id === d.id && (
                      <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] text-rose-700">
                        <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" />
                        <span>
                          Не сохранилось, состояние вернулось к прежнему: {dialogSaveError.message}.
                          Попробуйте ещё раз — если повторяется, проверьте связь с сервером.
                        </span>
                      </div>
                    )}
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs text-gray-500">Статус:</span>
                      {(['none', 'lead', 'not_lead', 'later'] as DialogStatus[]).map(s => (
                        <button key={s} type="button"
                          onClick={() => void updateDialog(d.id, { status: s })}
                          className={`rounded-full px-3 py-1 text-[10px] font-medium transition border cursor-pointer ${d.status === s ? 'bg-indigo-100 border-indigo-300 text-indigo-700' : 'border-gray-200 text-gray-600 hover:border-indigo-200 hover:bg-indigo-50'}`}>
                          {DIALOG_STATUS_LABELS[s]?.label}
                        </button>
                      ))}
                      {/* Передача человеку: карточка по шаблону плюс пересылка
                          переписки. Отправляет тот же аккаунт кампании, но не
                          сейчас — живое соединение только у воркера, поэтому
                          кнопка ставит задачу в очередь. */}
                      {/* Передача одна на диалог, поэтому уже переданный
                          показывает плашку вместо пары кнопок: гасить их и
                          оставлять на экране — приглашать кликать в
                          недоступное. */}
                      {/* Что произошло само, до оператора: контакт уже у
                          менеджера. Кнопки рядом остаются рабочими — передать
                          того же человека в другой чат иногда нужно. Про риск
                          задвоения предупредим на подтверждении. */}
                      {autoMark && <AutoForwardBadge mark={autoMark} />}
                      {isActiveForward(d.forward) ? (
                        <>
                          <ForwardBadge forward={d.forward} />
                          {/* Пока задача ждёт своей очереди, ошибку ещё можно
                              исправить — и только здесь: после отправки
                              сообщение уже в чате у менеджера. Поэтому кнопка
                              живёт ровно столько, сколько статус «в очереди». */}
                          {d.forward.status === 'pending' && (
                            <button
                              type="button"
                              disabled={cancelling === d.id}
                              onClick={() => void cancelForward(d)}
                              title="Снять задачу из очереди — менеджеру ничего не уйдёт"
                              className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-rose-200 bg-rose-50 px-3 py-1 text-[10px] font-medium text-rose-700 hover:bg-rose-100 hover:border-rose-300 transition disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              {cancelling === d.id
                                ? <Loader2 className="h-3 w-3 animate-spin" />
                                : <X className="h-3 w-3" />}
                              Отменить отправку
                            </button>
                          )}
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            disabled={forwarding === `${d.id}:lead`}
                            onClick={() => void forwardDialog(d, 'lead')}
                            title="Передать как лида в чат из настроек кампании"
                            className="ml-2 inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-[10px] font-medium text-emerald-700 hover:bg-emerald-100 hover:border-emerald-300 transition disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            {forwarding === `${d.id}:lead`
                              ? <Loader2 className="h-3 w-3 animate-spin" />
                              : <Send className="h-3 w-3" />}
                            Передать лида
                          </button>
                          <button
                            type="button"
                            disabled={forwarding === `${d.id}:partner`}
                            onClick={() => void forwardDialog(d, 'partner')}
                            title="Передать как кандидата в партнёры"
                            className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-indigo-200 bg-indigo-50 px-3 py-1 text-[10px] font-medium text-indigo-700 hover:bg-indigo-100 hover:border-indigo-300 transition disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            {forwarding === `${d.id}:partner`
                              ? <Loader2 className="h-3 w-3 animate-spin" />
                              : <Send className="h-3 w-3" />}
                            Передать партнёра
                          </button>
                        </>
                      )}
                      <button
                        type="button"
                        onClick={() => void addToBlacklist(d)}
                        className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-rose-200 bg-rose-50 px-3 py-1 text-[10px] font-medium text-rose-700 hover:bg-rose-100 hover:border-rose-300 transition"
                      >
                        <Ban className="h-3 w-3" />
                        В черный список
                      </button>
                      <button type="button" onClick={() => void deleteDialog(d.id)}
                        className="ml-auto cursor-pointer p-2 rounded-lg text-gray-400 hover:text-rose-600 hover:bg-rose-50 transition">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    {/* Упавшая передача: причина целиком, у этого же человека.
                        Кнопки при этом остаются — до адресата ничего не дошло,
                        и повтор после починки это единственный путь. Гонять
                        оператора за причиной в общий журнал, где она тонет
                        среди сотен строк круга, — плохой обмен. */}
                    {d.forward?.status === 'failed' && (
                      <p className="mt-1.5 rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-[10px] text-rose-700">
                        Не отправлено ({d.forward.kind === 'lead' ? 'лид' : 'партнёр'}):{' '}
                        {d.forward.error_message || 'причина не записана'}
                      </p>
                    )}
                    {/* Снятая передача — не авария, поэтому серым, а не красным:
                        оператор сам так решил. Но след нужен: без него исчезнувшая
                        плашка «в очереди» читается как сбой, и человека передают
                        второй раз, гадая, куда делся первый. */}
                    {d.forward?.status === 'cancelled' && (
                      <p className="mt-1.5 rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-[10px] text-gray-600">
                        Передача отменена ({d.forward.kind === 'lead' ? 'лид' : 'партнёр'}) — менеджеру ничего не ушло
                        {d.forward.error_message ? `. ${d.forward.error_message}` : ''}
                      </p>
                    )}
                    {/* Сорвавшаяся автопересылка: лид, который не доехал до
                        менеджера. Диалог при этом всё равно стал «Лидом» — без
                        этой строки провал не отличить от успеха, а причина
                        лежала бы только в журнале кампании. Передать руками
                        кнопкой рядом — единственный способ довести до конца. */}
                    {autoMark?.state === 'failed' && (
                      <p className="mt-1.5 rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-[10px] text-rose-700">
                        Автопересылка менеджеру не удалась{autoMark.chat ? ` (${autoMark.chat})` : ''}:{' '}
                        {autoMark.reason}
                      </p>
                    )}
                    {/* Аудит can_send: кто/когда/почему последний раз менял.
                        Показываем, только если запись о смене есть. До первого
                        переключения поля NULL — диалог унаследовал дефолт при
                        создании, и подпись была бы шумом. Также рендерим
                        крупную кнопку «Разрешить отправку», когда диалог в
                        статусе «Не писать» — чтобы оператор не искал
                        кликабельный бейдж в шапке. */}
                    {(d.can_send_changed_at || d.can_send === false) && (
                      <div className={`flex items-center gap-2 flex-wrap rounded-lg px-3 py-2 text-[11px] ${d.can_send === false ? 'bg-rose-50 text-rose-800 border border-rose-100' : 'bg-emerald-50 text-emerald-800 border border-emerald-100'}`}>
                        <span className="font-medium">
                          Отправка: {d.can_send === false ? 'отключена' : 'разрешена'}
                        </span>
                        {d.can_send_changed_at && (
                          <>
                            <span className="text-gray-400">·</span>
                            <span>
                              {d.can_send_changed_by ? 'переключил оператор' : 'переключил воркер'}
                            </span>
                            <span className="text-gray-400">·</span>
                            <span>{formatDate(d.can_send_changed_at)}</span>
                            {d.can_send_changed_reason && (
                              <>
                                <span className="text-gray-400">·</span>
                                <span>{describeCanSendReason(d.can_send_changed_reason)}</span>
                              </>
                            )}
                          </>
                        )}
                        {d.can_send === false && (
                          <button
                            type="button"
                            onClick={() => void updateDialog(d.id, { can_send: true })}
                            className="ml-auto inline-flex cursor-pointer items-center gap-1 rounded-full bg-emerald-600 px-3 py-1 text-[10px] font-medium text-white hover:bg-emerald-700 transition"
                            title="Разрешить отправку в этот диалог. История изменений сохранится в логах кампании."
                          >
                            Разрешить отправку
                          </button>
                        )}
                      </div>
                    )}
                    <div className="max-h-72 overflow-auto space-y-1.5 rounded-lg bg-gray-50 p-2">
                      {d.messages.map((m, i) => {
                        const senderName = m.role === 'user'
                          ? (d.tg_username ? `@${d.tg_username}` : `ID ${d.tg_user_id}`)
                          : accountNameMap.get(d.account_id) ?? 'Бот';
                        return (
                          <div key={i} className={`rounded-lg px-3 py-2 text-xs ${m.role === 'user' ? 'bg-blue-50 text-gray-800' : 'bg-emerald-50 text-gray-800'}`}>
                            <span className="font-semibold">{senderName}:</span> {m.content}
                          </div>
                        );
                      })}
                    </div>
                    <div className="flex gap-2">
                      <input value={sendText} onChange={e => setSendText(e.target.value)}
                        placeholder="Написать сообщение..."
                        className="flex-1 rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-xs outline-none focus:border-indigo-400 disabled:opacity-50 disabled:cursor-not-allowed"
                        onKeyDown={e => { if (e.key === 'Enter') void sendMessage(d.id); }} />
                      <button type="button" onClick={() => void sendMessage(d.id)} disabled={sending || d.can_send === false}
                        className="rounded-full bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700 hover:shadow-md transition disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer">
                        <Send className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <button type="button" disabled={currentPage <= 1} onClick={() => setOffset(Math.max(0, offset - limit))}
            className="rounded-full px-4 py-2 text-xs font-medium border border-gray-200 bg-white text-gray-700 hover:border-indigo-300 hover:bg-indigo-50 transition disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer">Назад</button>
          <span className="text-xs text-gray-500">{currentPage} / {totalPages}</span>
          <button type="button" disabled={currentPage >= totalPages} onClick={() => setOffset(offset + limit)}
            className="rounded-full px-4 py-2 text-xs font-medium border border-gray-200 bg-white text-gray-700 hover:border-indigo-300 hover:bg-indigo-50 transition disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer">Вперёд</button>
        </div>
      )}
    </div>
  );
}

/* =================== PROCESSED TAB =================== */
function ProcessedTab({ campaignId }: { campaignId: string }) {
  const [items, setItems] = useState<OutreachProcessed[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [addUserId, setAddUserId] = useState('');
  const [addUsername, setAddUsername] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    const res = await authFetch(`${API_BASE}/processed?campaign_id=${campaignId}&limit=200`);
    if (res.ok) {
      const d = await res.json() as { items: OutreachProcessed[]; total: number };
      setItems(d.items); setTotal(d.total);
    }
    setLoading(false);
  }, [campaignId]);

  useEffect(() => { queueMicrotask(() => { void load(); }); }, [load]);

  const addProcessed = async () => {
    await authFetch(`${API_BASE}/processed`, {
      method: 'POST',
      body: JSON.stringify({ campaign_id: campaignId, tg_user_id: Number(addUserId), tg_username: addUsername || null }),
    });
    setAddUserId(''); setAddUsername(''); setShowAdd(false); void load();
  };

  const removeProcessed = async (id: string) => {
    await authFetch(`${API_BASE}/processed?id=${id}`, { method: 'DELETE' });
    void load();
  };

  const filtered = search
    ? items.filter(i => (i.tg_username ?? '').toLowerCase().includes(search.toLowerCase()) || String(i.tg_user_id).includes(search))
    : items;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Search className="h-3.5 w-3.5 text-gray-400" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Поиск по имени или ID..."
            className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-xs outline-none focus:border-indigo-400 w-56" />
          <span className="text-xs text-gray-400">Всего: {total}</span>
        </div>
        <button type="button" onClick={() => setShowAdd(!showAdd)}
          className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-4 py-2 text-xs font-medium text-gray-700 hover:border-indigo-300 hover:bg-indigo-50 hover:shadow-sm transition cursor-pointer">
          <Plus className="h-3.5 w-3.5" /> Добавить
        </button>
      </div>
      {showAdd && (
        <div className="flex items-center gap-2 rounded-lg border border-gray-200 p-3">
          <input value={addUserId} onChange={e => setAddUserId(e.target.value)} placeholder="User ID" className="rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-xs outline-none w-36" />
          <input value={addUsername} onChange={e => setAddUsername(e.target.value)} placeholder="@username" className="rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-xs outline-none w-36" />
          <button type="button" onClick={addProcessed} className="rounded-full bg-indigo-600 px-5 py-2.5 text-xs font-semibold text-white hover:bg-indigo-700 hover:shadow-md transition cursor-pointer">Добавить</button>
        </div>
      )}
      {loading ? (
        <div className="flex items-center gap-2 py-8 text-sm text-gray-400"><Loader2 className="h-4 w-4 animate-spin" />Загрузка...</div>
      ) : filtered.length === 0 ? (
        <p className="text-xs text-gray-400 py-8 text-center">Нет обработанных клиентов</p>
      ) : (
        <div className="divide-y divide-gray-100 rounded-lg border border-gray-200">
          {filtered.map(p => (
            <div key={p.id} className="flex items-center gap-3 px-3 py-2 text-xs">
              <UserCheck className="h-3.5 w-3.5 text-gray-400 shrink-0" />
              <span className="font-medium text-gray-800 w-28">{p.tg_user_id}</span>
              <span className="text-gray-500 flex-1">{p.tg_username ? `@${p.tg_username}` : '—'}</span>
              <span className="text-gray-400">{formatDate(p.processed_at)}</span>
              <button type="button" onClick={() => void removeProcessed(p.id)} className="p-2 rounded-lg text-gray-400 hover:text-rose-600 hover:bg-rose-50 transition cursor-pointer"><Trash2 className="h-3.5 w-3.5" /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* =================== BULK SELECTION =================== */

/**
 * Чекбокс «выделить всё» с промежуточным состоянием.
 *
 * indeterminate нельзя выставить атрибутом — только через DOM-свойство, поэтому
 * ref + effect. Без него при частичном выделении галка выглядит как «ничего не
 * выбрано», и оператор жмёт её второй раз, снимая уже сделанный выбор.
 */
function SelectAllCheckbox({
  total,
  selectedCount,
  onChange,
}: {
  total: number;
  selectedCount: number;
  onChange: (checked: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const allSelected = total > 0 && selectedCount === total;

  useEffect(() => {
    if (ref.current) ref.current.indeterminate = selectedCount > 0 && selectedCount < total;
  }, [selectedCount, total]);

  return (
    <input
      ref={ref}
      type="checkbox"
      checked={allSelected}
      onChange={e => onChange(e.target.checked)}
      title={allSelected ? 'Снять выделение' : 'Выделить все'}
      aria-label={allSelected ? 'Снять выделение' : 'Выделить все'}
      className="h-3.5 w-3.5 cursor-pointer accent-indigo-600"
    />
  );
}

/** Панель массовых действий: появляется, только когда что-то выделено. */
function BulkActionsBar({
  selectedCount,
  deleting,
  onClear,
  onDelete,
  /** Проверка живости — у аккаунтов и у прокси; у баз её нет. */
  checking,
  canCheck,
  onCheck,
  /** Что именно проверяем — по умолчанию аккаунты, у прокси свои слова. */
  checkLabel,
  checkTitle,
}: {
  selectedCount: number;
  deleting: boolean;
  onClear: () => void;
  onDelete: () => void;
  checking?: boolean;
  canCheck?: boolean;
  onCheck?: () => void;
  checkLabel?: string;
  checkTitle?: string;
}) {
  if (selectedCount === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2">
      <span className="text-xs font-medium text-indigo-900">Выбрано: {selectedCount}</span>
      {onCheck && (
        <button
          type="button"
          onClick={onCheck}
          disabled={checking || deleting || !canCheck}
          title={canCheck
            ? checkTitle ?? 'Зайти в каждый аккаунт и проверить, жив ли он и кто ещё в нём сидит'
            : 'Сначала остановите кампанию: во время работы аккаунты заняты'}
          className="inline-flex items-center gap-1.5 rounded-full bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {checking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
          {checkLabel ?? 'Проверить аккаунты'}
        </button>
      )}
      <button
        type="button"
        onClick={onDelete}
        disabled={deleting}
        className="inline-flex items-center gap-1.5 rounded-full bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-700 transition disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
      >
        {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
        Удалить выбранные
      </button>
      <button
        type="button"
        onClick={onClear}
        disabled={deleting}
        className="text-xs text-indigo-700 hover:text-indigo-900 hover:underline transition cursor-pointer disabled:opacity-50"
      >
        Снять выделение
      </button>
    </div>
  );
}

/** Общая механика выделения строк таблицы: toggle, «выделить всё», сброс. */
function useRowSelection(allIds: string[]) {
  const [raw, setRaw] = useState<Set<string>>(new Set());

  // Выделение выводим из текущего списка, а не подчищаем эффектом после
  // перезагрузки: id удалённой строки просто перестаёт попадать в выборку.
  // Синхронизация через useEffect дала бы лишний каскадный рендер на каждую
  // загрузку таблицы ради того же результата.
  const selectedIds = useMemo(() => allIds.filter(id => raw.has(id)), [allIds, raw]);
  const isSelected = useCallback((id: string) => raw.has(id), [raw]);

  const toggle = useCallback((id: string) => {
    setRaw(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const setAll = useCallback((checked: boolean) => {
    setRaw(checked ? new Set(allIds) : new Set());
  }, [allIds]);

  const clear = useCallback(() => { setRaw(new Set()); }, []);

  return { selectedIds, isSelected, toggle, setAll, clear };
}

/** Результат чтения профиля из Telegram: ошибка либо обновлённые поля. */
type SyncResult = {
  error: string | null;
  patch?: Partial<OutreachAccount>;
  /**
   * Профиль прочитан, а аватарку не удалось положить в хранилище портала.
   * Не ошибка чтения: имя и описание приехали, поэтому и не error.
   */
  avatarError?: string;
};

/**
 * Ответ проверки по одному аккаунту.
 *
 * Общий счёт вида «Проверено 3: жив — 2» отвечал на вопрос «сколько», а
 * оператору нужен ответ на вопрос «какой»: заливали партию, а разбираться нужно
 * с конкретным аккаунтом. Чужие сеансы держим рядом со статусом — именно ими
 * «в аккаунт кто-то зашёл» отличается от «номер забанен».
 */
interface CheckRow {
  id: string;
  /** session_name — под ним аккаунт лежит в портале и в списке. */
  name: string;
  /** Из набора check_status: ok | session_revoked | banned | … */
  status: string;
  detail: string;
  otherSessions: OtherSession[];
  /**
   * Проверка не выполнена, а поставлена в очередь: кампания работает, и лезть в
   * занятую сессию из портала нельзя. Выполнит рассылка своим соединением,
   * дойдя до аккаунта в круге.
   */
  queued?: boolean;
}

/**
 * Итоги проверки аккаунта человеческим языком.
 *
 * Разделение по цвету неслучайно: жёлтое — то, что чинится нашими руками
 * (перезалить сессию, поменять прокси), красное — то, что уже не вернуть.
 * «Чужой вход» жёлтый намеренно: аккаунт жив, но в нём кто-то есть, и это
 * требует разбирательства, а не списания.
 */
/**
 * Цвет здесь — это рекомендация к действию, а не оценка серьёзности.
 *
 * Красное — аккаунт не вернуть, списывайте. Жёлтое — пройдёт само или чинится
 * перезаливкой. До 27.08.2026 временное ограничение и окончательный бан оба
 * были красными и назывались похоже («ограничен» / «забанен»), из-за чего
 * живые номера, поймавшие спам-блок на пару дней, читались как сгоревшие.
 */
const CHECK_LABEL: Record<string, { text: string; cls: string }> = {
  ok: { text: 'жив', cls: 'bg-emerald-50 text-emerald-700' },
  session_revoked: { text: 'разлогинен', cls: 'bg-amber-50 text-amber-700' },
  session_duplicate: { text: 'чужой вход', cls: 'bg-amber-50 text-amber-700' },
  no_session: { text: 'нет сессии', cls: 'bg-amber-50 text-amber-700' },
  proxy_dead: { text: 'прокси молчит', cls: 'bg-amber-50 text-amber-700' },
  restricted: { text: 'ограничен временно', cls: 'bg-amber-50 text-amber-700' },
  banned: { text: 'бан навсегда', cls: 'bg-rose-50 text-rose-700' },
  error: { text: 'ошибка', cls: 'bg-gray-100 text-gray-500' },
  // Не итог проверки, а её ожидание: кампания работает, и проверку выполнит
  // рассылка своим соединением, дойдя до аккаунта в круге.
  queued: { text: 'проверка в очереди', cls: 'bg-indigo-50 text-indigo-700' },
};

/* =================== ACCOUNT AVATAR =================== */
/**
 * Аватарка аккаунта. Пока профиль не читали из Telegram, показываем инициалы —
 * пустой серый кружок ничем не отличался бы от «фото нет».
 */
function AccountAvatar({
  account,
  size = 36,
}: {
  account: OutreachAccount;
  size?: number;
}) {
  const [broken, setBroken] = useState(false);
  const label = (account.first_name || account.session_name || '?').trim();
  const initials = label
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
  const url = account.avatar_url?.trim();

  if (url && !broken) {
    // Аватарки лежат в публичном бакете Supabase; next/image потребовал бы
    // прописывать домен хранилища в конфиг ради картинки 36×36.
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
        alt=""
        width={size}
        height={size}
        onError={() => setBroken(true)}
        style={{ width: size, height: size }}
        className="rounded-full object-cover bg-gray-100 shrink-0"
      />
    );
  }

  return (
    <span
      style={{ width: size, height: size, fontSize: Math.round(size / 2.8) }}
      className="flex items-center justify-center rounded-full bg-gray-100 font-medium text-gray-400 shrink-0"
      title={account.profile_synced_at ? 'В Telegram нет аватарки' : 'Профиль ещё не читали из Telegram'}
    >
      {initials || '?'}
    </span>
  );
}

/**
 * Итог загрузки файлов аккаунтов.
 *
 * Пропущенные и нечитаемые хранятся списками, а не одной строкой: реальная
 * партия — это два десятка архивов, и склеенный в абзац перечень имён оператор
 * не читает. Ни одно имя при этом не прячем — по нему продавцу возвращают брак.
 */
interface AccountsUploadSummary {
  headline: string;
  skipped: Array<{ name: string; reason: string }>;
  errors: Array<{ name: string; error: string }>;
  /** Аккаунты портала, которые сверить на дубль было нечем. */
  unchecked: number;
}

/* =================== CAMPAIGN ACCOUNTS TAB =================== */
/**
 * Ячейка здоровья: слово и цвет, объяснение — под курсором.
 *
 * Один компонент на обе колонки («Рассылка» и «Прокси»): состояния у них
 * разные, а язык должен быть один — иначе строка читается как два независимых
 * прибора, и оператор сравнивает не то.
 */
function HealthCell({ mark }: { mark: HealthMark }) {
  const cls = mark.tone === 'ok'
    ? 'bg-emerald-50 text-emerald-700'
    : mark.tone === 'warn'
      ? 'bg-amber-50 text-amber-700'
      : mark.tone === 'bad'
        ? 'bg-rose-50 text-rose-700'
        : 'bg-gray-100 text-gray-500';
  return (
    <span title={mark.detail} className={`w-fit cursor-help rounded-md px-1.5 py-0.5 text-[10px] font-medium ${cls}`}>
      {mark.label}
    </span>
  );
}

function CampaignAccountsTab({
  campaignId,
  campaignStatus,
  firstTouchPerDay,
}: {
  campaignId: string;
  campaignStatus: CampaignStatus;
  /**
   * Дневной лимит первых сообщений на аккаунт. Ноль — первое касание выключено
   * вовсе, и «не рассылает» тогда не поломка, а настройка: колонка здоровья
   * обязана говорить об этом словами, иначе оператор пойдёт чинить прокси.
   */
  firstTouchPerDay: number;
}) {
  const [accounts, setAccounts] = useState<OutreachAccount[]>([]);
  const [proxies, setProxies] = useState<OutreachProxy[]>([]);
  /** Адреса прокси, занятые аккаунтами по всему порталу (не только этой кампании). */
  const [takenUrls, setTakenUrls] = useState<string[]>([]);
  const [errorCounts, setErrorCounts] = useState<
    Record<string, { error: number; warning: number; account_id: string }>
  >({});
  /** Что каждый аккаунт отправил за сутки и когда отправлял в последний раз. */
  const [sendingStats, setSendingStats] = useState<Record<string, AccountSendingStat>>({});
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSummary, setUploadSummary] = useState<AccountsUploadSummary | null>(null);
  const [sessionName, setSessionName] = useState('');
  const [apiId, setApiId] = useState('');
  const [apiHash, setApiHash] = useState('');
  const [phone, setPhone] = useState('');
  const [proxyId, setProxyId] = useState('');
  const [saving, setSaving] = useState(false);
  const [editingProxyFor, setEditingProxyFor] = useState<string | null>(null);
  const [selectedAccount, setSelectedAccount] = useState<OutreachAccount | null>(null);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [profileAccount, setProfileAccount] = useState<OutreachAccount | null>(null);
  /** id аккаунтов, чей профиль сейчас читается из Telegram. */
  const [syncingIds, setSyncingIds] = useState<string[]>([]);
  const [syncSummary, setSyncSummary] = useState<string | null>(null);
  /** id аккаунтов, которые сейчас проверяются на живость. */
  const [checkingIds, setCheckingIds] = useState<string[]>([]);
  const [resettingIds, setResettingIds] = useState<string[]>([]);
  /** Отказ на сбросе сеансов показываем в самой строке — рядом с кнопкой. */
  const [resetError, setResetError] = useState<{ id: string; message: string } | null>(null);
  /** Ответ Telegram по каждому проверенному аккаунту; висит, пока не закроют. */
  const [checkResults, setCheckResults] = useState<CheckRow[] | null>(null);
  /**
   * Когда список последний раз пришёл с сервера. Точка отсчёта для «данным
   * больше суток»: `Date.now()` во время рендера — нечистый вызов, да и возраст
   * честнее мерить от момента загрузки данных, а не от момента перерисовки.
   */
  const [loadedAt, setLoadedAt] = useState<number | null>(null);

  // Профиль читается через то же соединение, что и работа кампании, поэтому
  // на запущенной кампании в Telegram не ходим — см. гейт в API.
  const profileReadable = campaignStatus === 'stopped' || campaignStatus === 'error';

  const accountIds = useMemo(() => accounts.map(a => a.id), [accounts]);
  const { selectedIds, isSelected, toggle, setAll, clear } = useRowSelection(accountIds);

  /**
   * Прокси, которые ещё никому не назначены.
   *
   * Ключ занятости — АДРЕС, а не строка в базе, и берётся он по всему порталу.
   *
   * По id и в пределах кампании это ломалось двумя способами сразу. Один и тот
   * же адрес заведён несколькими строками (598 записей на 532 адреса, дубли
   * есть и внутри одной кампании): назначил первую — вторая оставалась
   * «свободной» и тут же предлагалась следующему аккаунту, хотя это тот же
   * прокси. И отдельно: 66 адресов заведены в двух кампаниях, так что занятый
   * в соседней здесь числился свободным.
   *
   * Для Telegram один адрес — это одно устройство: два аккаунта на нём прямой
   * повод для блокировки, ради экономии запроса такое допускать нельзя.
   *
   * `takenUrls` приходит с сервера (портал целиком), к нему добавляем то, что
   * назначено прямо сейчас на этом экране: между назначением и перезагрузкой
   * списка оператор успевает открыть следующую строку.
   */
  const takenUrlSet = useMemo(
    () => takenProxyUrls({ serverTakenUrls: takenUrls, accounts, proxies }),
    [takenUrls, accounts, proxies],
  );

  const freeProxies = useMemo(
    () => selectableProxies(proxies, takenUrlSet),
    [proxies, takenUrlSet],
  );

  /**
   * Варианты для строки аккаунта: свободные плюс его собственный прокси.
   *
   * Без своего оператор не увидел бы, что вообще стоит в строке, и открытая
   * выпадашка выглядела бы как «прокси сбросился».
   */
  const proxyOptions = useCallback(
    (currentId: string | null) => proxyOptionsFor(currentId, proxies, freeProxies),
    [freeProxies, proxies],
  );

  const load = useCallback(async () => {
    setLoading(true);
    const [accRes, proxRes, errRes, sendRes] = await Promise.all([
      authFetch(`${API_BASE}/accounts?campaign_id=${campaignId}`),
      authFetch(`${API_BASE}/proxies?campaign_id=${campaignId}`),
      // Bulk error counts in last 24h — cheap (one query, grouped server-side).
      // Used to render the ⚠ N chips next to each account name.
      authFetch(`${API_BASE}/campaigns/${campaignId}/accounts/error-counts?range=24h`),
      // Отправки по аккаунтам — колонка «Рассылка» и счётчик «рассылают N».
      authFetch(`${API_BASE}/campaigns/${campaignId}/accounts/sending`),
    ]);
    if (accRes.ok) {
      const d = await accRes.json() as { items: OutreachAccount[] };
      setAccounts(d.items);
    }
    if (proxRes.ok) {
      const d = await proxRes.json() as { items: OutreachProxy[]; taken_urls?: string[] };
      setProxies(d.items);
      setTakenUrls(d.taken_urls ?? []);
    }
    if (errRes.ok) {
      const d = await errRes.json() as {
        counts: Record<string, { error: number; warning: number; account_id: string }>;
      };
      setErrorCounts(d.counts ?? {});
    }
    if (sendRes.ok) {
      const d = await sendRes.json() as { stats: Record<string, AccountSendingStat> };
      setSendingStats(d.stats ?? {});
    }
    setLoadedAt(Date.now());
    setLoading(false);
  }, [campaignId]);

  useEffect(() => { queueMicrotask(() => { void load(); }); }, [load]);

  const addAccount = async () => {
    if (!sessionName.trim() || !apiId.trim() || !apiHash.trim()) return;
    setSaving(true);
    await authFetch(`${API_BASE}/accounts`, {
      method: 'POST',
      body: JSON.stringify({
        campaign_id: campaignId,
        session_name: sessionName.trim(),
        api_id: Number(apiId),
        api_hash: apiHash.trim(),
        phone: phone.trim(),
        proxy_id: proxyId || null,
      }),
    });
    setSaving(false);
    setSessionName(''); setApiId(''); setApiHash(''); setPhone(''); setProxyId('');
    setShowAdd(false);
    void load();
  };

  /**
   * Прочитать профиль одного аккаунта из Telegram и обновить строку списка.
   * Возвращает текст ошибки или null, если всё получилось.
   */
  const syncProfile = useCallback(async (id: string): Promise<SyncResult> => {
    setSyncingIds(prev => [...prev, id]);
    try {
      const res = await authFetch(`${API_BASE}/accounts/${id}/profile`);
      if (!res.ok) {
        const d = (await res.json().catch(() => null)) as { error?: string } | null;
        return { error: d?.error ?? `Ошибка ${res.status}` };
      }
      // avatar_error — не поле аккаунта, а объяснение от сервера, поэтому в
      // строку списка его не подмешиваем.
      const { avatar_error: avatarError, ...patch } =
        (await res.json()) as Partial<OutreachAccount> & { avatar_error?: string };
      setAccounts(prev => prev.map(a => (a.id === id ? { ...a, ...patch } : a)));
      return { error: null, patch, ...(avatarError ? { avatarError } : {}) };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    } finally {
      setSyncingIds(prev => prev.filter(x => x !== id));
    }
  }, []);

  /**
   * Аккаунты, чьи профили обновит кнопка: выбранные, а если ничего не выбрано —
   * все. Чтение одного профиля занимает десятки секунд, и на кампании из
   * семнадцати аккаунтов ждать полный круг ради одной строки оператору незачем.
   */
  const syncTargets = useMemo(
    () => (selectedIds.length ? accounts.filter(a => selectedIds.includes(a.id)) : accounts),
    [accounts, selectedIds],
  );

  /**
   * Обновить профили выбранных аккаунтов (или всех, если выбора нет).
   *
   * Идём пачками по четыре: каждое чтение — это подключение через мобильный
   * прокси на десятки секунд. Шестнадцать подряд оператор ждать не станет, а все
   * разом — это шестнадцать одновременных соединений в один пул, который и так
   * бракует часть портов.
   */
  const syncProfiles = useCallback(async () => {
    const targets = syncTargets.map(a => ({ id: a.id, name: a.session_name }));
    if (!targets.length) return;
    setSyncSummary(null);

    const failures: string[] = [];
    // Причина у всех аккаунтов одна и та же (хранилище портала), поэтому в
    // отчёте показываем её один раз, а не семнадцать.
    const avatarProblems = new Set<string>();
    let next = 0;
    const worker = async () => {
      while (next < targets.length) {
        const t = targets[next++];
        const { error, avatarError } = await syncProfile(t.id);
        if (error) failures.push(`${t.name}: ${error}`);
        if (avatarError) avatarProblems.add(avatarError);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(4, targets.length) }, () => worker()),
    );

    const headline = failures.length
      ? `Обновлено ${targets.length - failures.length} из ${targets.length}. Не получилось — ${failures.slice(0, 3).join('; ')}${failures.length > 3 ? ` и ещё ${failures.length - 3}` : ''}`
      : `Профили обновлены: ${targets.length}`;
    setSyncSummary(
      avatarProblems.size
        ? `${headline}. Аватарки не сохранились: ${[...avatarProblems].join('; ')}`
        : headline,
    );
  }, [syncTargets, syncProfile]);

  /**
   * Проверить выбранные аккаунты.
   *
   * Идём пачками по четыре — как и чтение профилей: каждая проверка это
   * подключение через мобильный прокси на десятки секунд, а полсотни
   * одновременных соединений в один пул он не переживёт.
   *
   * Ответ проверки — это и есть результат: статус, объяснение и чужие сеансы
   * приходят от самого Telegram, и ровно их же ручка кладёт в аккаунт. Поэтому
   * список после проверки не перечитываем: строку обновляем тем, что ответило
   * Telegram по этому аккаунту.
   */
  const checkSelected = useCallback(async () => {
    const targets = accounts
      .filter((a) => selectedIds.includes(a.id))
      .map((a) => ({ id: a.id, name: a.session_name }));
    if (!targets.length) return;
    setCheckResults(null);

    // По месту в targets, а не в порядке ответов: четыре воркера заканчивают
    // вразнобой, а оператор ищет строку там, где выделял.
    const rows: CheckRow[] = new Array<CheckRow>(targets.length);
    let next = 0;
    const worker = async () => {
      while (next < targets.length) {
        const i = next++;
        const t = targets[i];
        setCheckingIds((prev) => [...prev, t.id]);
        try {
          const res = await authFetch(`${API_BASE}/accounts/${t.id}/check`, { method: 'POST' });
          const data = (await res.json().catch(() => null)) as
            | (Partial<AccountCheckResult> & { error?: string; queued?: boolean; requested_at?: string })
            | null;

          // Кампания работает — ручка не ходила в Telegram, а поставила заказ.
          // Строку аккаунта помечаем ожиданием: результат придёт сам, когда
          // рассылка дойдёт до аккаунта.
          if (res.ok && data?.queued) {
            rows[i] = {
              id: t.id,
              name: t.name,
              status: 'queued',
              detail: data.detail ?? 'проверка поставлена в очередь',
              otherSessions: [],
              queued: true,
            };
            setAccounts((prev) => prev.map((a) => (a.id === t.id
              ? { ...a, check_requested_at: data.requested_at ?? new Date().toISOString() }
              : a)));
            continue;
          }

          // Отказ ручки (аккаунта нет, база не ответила) — это не ответ
          // Telegram, поэтому и статуса из его набора у него нет: error.
          const status = res.ok && data?.status ? data.status : 'error';
          const detail = (res.ok ? data?.detail : data?.error)
            ?? (res.ok ? 'Telegram ничего не объяснил' : `сервер ответил ${res.status}`);
          const otherSessions = (res.ok && data?.other_sessions) || [];
          rows[i] = { id: t.id, name: t.name, status, detail, otherSessions };

          setAccounts((prev) => prev.map((a) => (a.id === t.id
            ? {
                ...a,
                check_status: status,
                check_detail: detail,
                checked_at: new Date().toISOString(),
                other_sessions: otherSessions,
                // Личность и телефон проверка узнаёт заодно — их ручка тоже
                // записала, и в строке они должны появиться без перезагрузки.
                ...(data?.tg_user_id != null ? { tg_user_id: data.tg_user_id } : {}),
                ...(data?.tg_username ? { tg_username: data.tg_username } : {}),
                ...(data?.phone ? { phone: data.phone } : {}),
              }
            : a)));
        } catch (e) {
          rows[i] = {
            id: t.id,
            name: t.name,
            status: 'error',
            detail: e instanceof Error ? e.message : String(e),
            otherSessions: [],
          };
        } finally {
          setCheckingIds((prev) => prev.filter((x) => x !== t.id));
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, targets.length) }, () => worker()));

    setCheckResults(rows);
  }, [accounts, selectedIds]);

  /**
   * Завершить чужие сеансы аккаунта.
   *
   * Ответ ручки — это уже перечитанное состояние аккаунта, поэтому строку
   * обновляем им же: счётчик чужих сеансов должен обнулиться на глазах, иначе
   * непонятно, сработало или нет.
   */
  const resetSessions = async (id: string) => {
    setResettingIds((prev) => [...prev, id]);
    try {
      const res = await authFetch(`${API_BASE}/accounts/${id}/sessions`, { method: 'DELETE' });
      const data = (await res.json().catch(() => null)) as
        | (Partial<AccountCheckResult> & { error?: string })
        | null;
      if (!res.ok) {
        setResetError({ id, message: data?.error ?? `Сервер ответил ${res.status}` });
        return;
      }
      setResetError(null);
      setAccounts((prev) => prev.map((a) => (a.id === id
        ? {
            ...a,
            check_status: data?.status ?? a.check_status,
            check_detail: data?.detail ?? a.check_detail,
            checked_at: new Date().toISOString(),
            other_sessions: data?.other_sessions ?? [],
          }
        : a)));
    } catch (e) {
      setResetError({ id, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setResettingIds((prev) => prev.filter((x) => x !== id));
    }
  };

  const toggleActive = async (id: string, current: boolean) => {
    await authFetch(`${API_BASE}/accounts/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ is_active: !current }),
    });
    void load();
  };

  const deleteAccount = async (id: string) => {
    if (!confirm('Удалить аккаунт?')) return;
    // Ответ проверяем: раньше отказ прилетал молча, список перезагружался, и
    // строка оставалась на месте без объяснения (см. коммент в DELETE-роуте).
    const res = await authFetch(`${API_BASE}/accounts/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const body = await res.json().catch(() => null) as { error?: string } | null;
      alert(body?.error ?? `Не удалось удалить аккаунт (HTTP ${res.status})`);
      return;
    }
    void load();
  };

  const deleteSelected = async () => {
    const ids = selectedIds;
    if (!ids.length) return;
    if (!confirm(`Удалить аккаунтов: ${ids.length}? Действие необратимо.`)) return;
    setBulkDeleting(true);
    setUploadError(null);
    try {
      const res = await authFetch(`${API_BASE}/accounts/bulk`, {
        method: 'DELETE',
        body: JSON.stringify({ campaign_id: campaignId, ids }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => null)) as { error?: string } | null;
        setUploadError(d?.error ?? `Не удалось удалить (${res.status})`);
        return;
      }
      clear();
      void load();
    } finally {
      setBulkDeleting(false);
    }
  };

  const assignProxy = async (accountId: string, newProxyId: string) => {
    await authFetch(`${API_BASE}/accounts/${accountId}`, {
      method: 'PUT',
      body: JSON.stringify({ proxy_id: newProxyId || null }),
    });
    setAccounts(prev => prev.map(a => a.id === accountId ? { ...a, proxy_id: newProxyId || null } : a));
    setEditingProxyFor(null);
  };

  const handleFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files?.length) return;
    setUploading(true);
    setUploadError(null);
    setUploadSummary(null);
    try {
      const token = await getAccessToken();
      const formData = new FormData();
      Array.from(files).forEach(f => formData.append('files', f));
      // fetch отклоняется, только когда ответа нет вовсе: обрыв связи,
      // соединение, разорванное на середине многомегабайтной партии. Это не то
      // же, что отказ сервера — там ответ есть, и он объясняет причину. Здесь
      // же неизвестно даже, доехало что-нибудь или нет, поэтому и текст другой.
      const res = await fetch(`${API_BASE}/accounts/bulk-files?campaign_id=${campaignId}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      }).catch(() => null);
      if (!res) {
        setUploadError('Файлы не дошли до сервера: связь оборвалась. Проверьте интернет и попробуйте ещё раз.');
        return;
      }
      // Тело читаем бережно, как в deleteSelected выше. Партия tdata-архивов
      // весит мегабайты, и до приложения запрос может не доехать: прокси
      // отвечает 413 обычной HTML-страницей, на которой res.json() падает.
      // Раньше такое падение выглядело как «нажал и ничего не произошло».
      const body = await res.json().catch(() => null) as {
        error?: string;
        count?: number;
        skipped?: Array<{ name: string; reason: string }>;
        errors?: Array<{ name: string; error: string }>;
        unchecked_existing_accounts?: number;
      } | null;
      if (!body) {
        // 413 называем словами: с «слишком большая загрузка» оператор может
        // что-то сделать сам, с голым номером статуса — нет.
        setUploadError(
          res.status === 413
            ? 'Загрузка слишком большая. Залейте архивы меньшими партиями.'
            : `Не удалось прочитать ответ сервера (HTTP ${res.status})`,
        );
      } else if (!res.ok) {
        setUploadError(body.error ?? 'Ошибка загрузки');
      } else {
        const count = body.count ?? 0;
        const skipped = body.skipped ?? [];
        const errors = body.errors ?? [];
        // «Добавлено аккаунтов: 0» само по себе ничего не объясняет, поэтому
        // пустой результат проговариваем словами.
        const headline = count > 0
          ? `Добавлено аккаунтов: ${count}`
          : skipped.length || errors.length
            ? 'Ни одного аккаунта не добавлено — почему, ниже'
            : 'Ни одного аккаунта не добавлено: в этих файлах их не нашлось';
        setUploadSummary({
          headline,
          skipped,
          errors,
          unchecked: body.unchecked_existing_accounts ?? 0,
        });
      }
    } catch (err) {
      // Всё остальное: отказ авторизации или наша собственная ошибка. Молчать
      // нельзя и здесь — оператор смотрит на остановившийся спиннер и не знает,
      // уехали его двадцать аккаунтов или нет.
      setUploadError(`Загрузка сорвалась: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setUploading(false);
      // Сбрасываем всегда, а не после try: иначе после сбоя input сохраняет
      // прежнее значение, повторный выбор тех же файлов не даёт события
      // change — и оператор остаётся без единого способа повторить загрузку.
      e.target.value = '';
      void load();
    }
  };

  /** Сводка по партии; сам счёт — в `lib/tgOutreach/accountsSummary` под тестами. */
  const accountStats = useMemo(
    () => summarizeAccounts(accounts, errorCounts, loadedAt),
    [accounts, errorCounts, loadedAt],
  );

  /**
   * Сколько аккаунтов реально ведут рассылку.
   *
   * Отдельно от «жив» и «Активен»: и то, и другое — про разрешения, а не про
   * работу. Аккаунт может быть живым, включённым, с рабочим прокси — и при этом
   * не написать никому ни разу, потому что кончилась очередь контактов или круг
   * до него не доходит.
   */
  const sendingCount = useMemo(
    () => countSendingAccounts(accounts, sendingStats),
    [accounts, sendingStats],
  );

  /** Кто именно не рассылает — под курсор на плашке, чтобы не искать глазами. */
  const notSendingNames = useMemo(
    () => accounts
      .filter((a) => (sendingStats[a.id]?.sent_24h ?? 0) === 0)
      .map((a) => a.session_name)
      .slice(0, 12)
      .join(', '),
    [accounts, sendingStats],
  );

  /** Разбивка мёртвых по причине — человеческими ярлыками, для подсказки. */
  const deadBreakdown = useMemo(
    () => Object.entries(accountStats.byStatus)
      .sort((a, b) => b[1] - a[1])
      .map(([st, n]) => `${CHECK_LABEL[st]?.text ?? st} — ${n}`)
      .join(', '),
    [accountStats.byStatus],
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <span className="text-sm font-medium text-gray-700">
          Аккаунты кампании <span className="text-gray-400 font-normal">({accounts.length})</span>
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={!profileReadable || syncingIds.length > 0 || syncTargets.length === 0}
            onClick={() => { void syncProfiles(); }}
            title={profileReadable
              ? selectedIds.length
                ? `Прочитать из Telegram профили выбранных аккаунтов: ${syncTargets.length}`
                : 'Прочитать имя, телефон, описание и аватарку каждого аккаунта из Telegram. Выделите строки, чтобы обновить только их'
              : 'Сначала остановите кампанию: во время работы аккаунты заняты'}
            className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-4 py-2 text-xs font-medium text-gray-700 hover:border-indigo-300 hover:bg-indigo-50 transition cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
          >
            {syncingIds.length ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            {/* Что именно нажимается, видно до нажатия: «выбранных» и «всех» —
                это минуты ожидания разницы. */}
            {syncingIds.length
              ? `Читаю профили (${syncingIds.length})…`
              : selectedIds.length
                ? `Обновить профили выбранных (${syncTargets.length})`
                : `Обновить профили всех (${syncTargets.length})`}
          </button>
          <label
            title="tdata — zip-архивами (можно сразу несколько), старый формат — парами .session и .json"
            className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-4 py-2 text-xs font-medium text-gray-700 hover:border-indigo-300 hover:bg-indigo-50 transition cursor-pointer"
          >
            {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
            Загрузить файлы
            <input type="file" multiple accept=".json,.session,.zip" className="hidden" onChange={e => { void handleFiles(e); }} />
          </label>
          <button type="button" onClick={() => setShowAdd(!showAdd)}
            className="inline-flex items-center gap-1.5 rounded-full bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700 hover:shadow-md transition cursor-pointer">
            <Plus className="h-3.5 w-3.5" /> Добавить
          </button>
        </div>
      </div>

      {/* Сводка идёт до таблицы: вопрос «сколько из партии рабочих» встаёт
          раньше, чем вопрос про конкретную строку. Возраст проверки стоит
          рядом с числами намеренно — зелёное «жив 20» на позавчерашней
          проверке читается как «сейчас всё хорошо», а это не так. */}
      {!loading && accounts.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-gray-200 bg-white px-3 py-2 text-[11px]">
          {/* Первым числом — то, ради чего экран открывают: сколько аккаунтов
              реально пишут людям. «Жив» и «Активен» отвечают только на вопрос
              о разрешениях. */}
          <span
            className={`rounded-md px-2 py-1 font-medium ${sendingCount > 0 ? 'bg-indigo-50 text-indigo-700' : 'bg-rose-50 text-rose-700'}`}
            title={
              `За сутки первое сообщение ушло с ${sendingCount} из ${accounts.length} аккаунтов.`
              + (notSendingNames ? ` Не рассылают: ${notSendingNames}${accounts.length - sendingCount > 12 ? ' и другие' : ''}. Причина по каждому — в колонке «Рассылка».` : '')
            }
          >
            рассылают {sendingCount} из {accounts.length}
          </span>

          <span className="mx-1 h-4 w-px bg-gray-200" aria-hidden />

          <span
            className="rounded-md bg-emerald-50 px-2 py-1 font-medium text-emerald-700"
            title="Последняя проверка вернула «жив». Проверку теперь ставит и сама рассылка: каждый успешный круг аккаунта — это подтверждение, что он жив, без остановки кампании."
          >
            жив {accountStats.alive}
          </span>
          <span
            className={`rounded-md px-2 py-1 font-medium ${accountStats.dead > 0 ? 'bg-rose-50 text-rose-700' : 'bg-gray-100 text-gray-500'}`}
            title={deadBreakdown
              ? `По причинам: ${deadBreakdown}`
              : 'Аккаунтов с неудачной проверкой нет'}
          >
            не жив {accountStats.dead}
          </span>
          <span
            className={`rounded-md px-2 py-1 font-medium ${accountStats.unchecked > 0 ? 'bg-gray-100 text-gray-600' : 'bg-gray-50 text-gray-400'}`}
            title="Проверка ни разу не запускалась. Эти аккаунты не входят ни в «жив», ни в «не жив» — про них просто ничего не известно."
          >
            не проверялись {accountStats.unchecked}
          </span>
          {accountStats.disabled > 0 && (
            <span
              className="rounded-md bg-amber-50 px-2 py-1 font-medium text-amber-700"
              title="Выключены в портале — воркер их не берёт в работу вообще. Аккаунт выключается сам после трёх AUTH_KEY_DUPLICATED подряд; чинится завершением чужих сеансов и перевыпуском session_data."
            >
              выключены {accountStats.disabled}
            </span>
          )}

          <span className="mx-1 h-4 w-px bg-gray-200" aria-hidden />

          <span
            className={`rounded-md px-2 py-1 font-medium ${accountStats.withErrors > 0 ? 'bg-rose-50 text-rose-700' : 'bg-gray-50 text-gray-400'}`}
            title={`Аккаунты, у которых за сутки в логах были строки уровня «ошибка». Всего таких строк: ${accountStats.errorTotal}.`}
          >
            с ошибками за 24ч {accountStats.withErrors}
          </span>
          {accountStats.withWarningsOnly > 0 && (
            <span
              className="rounded-md bg-amber-50 px-2 py-1 font-medium text-amber-700"
              title="За сутки были только предупреждения, ошибок не было. Обычно это подключение со второй попытки или отложенный контакт."
            >
              только предупреждения {accountStats.withWarningsOnly}
            </span>
          )}

          <span
            className={`rounded-md px-2 py-1 font-medium ${freeProxies.length > 0 ? 'bg-gray-100 text-gray-600' : 'bg-amber-50 text-amber-700'}`}
            title={
              `Прокси в кампании: ${proxies.length}. Свободных — ${freeProxies.length}: только они и предлагаются при назначении. `
              + 'Занятость считается по адресу и по всему порталу — один адрес это одно устройство для Telegram, '
              + 'и два аккаунта на нём это повод для блокировки.'
            }
          >
            свободных прокси {freeProxies.length} из {proxies.length}
          </span>

          <span className="ml-auto text-[10px] text-gray-400">
            {accountStats.newestCheck === null ? (
              'проверок ещё не было — «жив» и «не жив» показывать не из чего'
            ) : (
              <>
                проверка от{' '}
                {new Date(accountStats.newestCheck).toLocaleString('ru-RU', {
                  day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
                })}
                {accountStats.ageHours !== null && accountStats.ageHours >= 24 && (
                  <span className="text-amber-600"> — данным больше суток</span>
                )}
              </>
            )}
          </span>
        </div>
      )}

      {uploadError && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{uploadError}</div>
      )}

      {uploadSummary && (
        <div className="flex items-start justify-between gap-3 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600">
          <div className="space-y-1.5">
            <div>{uploadSummary.headline}</div>
            {uploadSummary.skipped.length > 0 && (
              <div>
                <div className="text-gray-500">Пропущено {uploadSummary.skipped.length}:</div>
                <ul className="list-disc pl-4">
                  {uploadSummary.skipped.map((s, i) => (
                    <li key={`skip-${i}-${s.name}`}><span className="font-medium">{s.name}</span> — {s.reason}</li>
                  ))}
                </ul>
              </div>
            )}
            {uploadSummary.errors.length > 0 && (
              <div>
                <div className="text-gray-500">Не прочиталось {uploadSummary.errors.length}:</div>
                <ul className="list-disc pl-4">
                  {uploadSummary.errors.map((x, i) => (
                    <li key={`err-${i}-${x.name}`}><span className="font-medium">{x.name}</span> — {x.error}</li>
                  ))}
                </ul>
              </div>
            )}
            {/* Оговорка к отчёту, а не ошибка: часть аккаунтов портала сверить
                было нечем, и «Пропущено 0» по ним ничего не доказывает. */}
            {uploadSummary.unchecked > 0 && (
              <div className="text-gray-500">
                Не удалось проверить на дубли аккаунтов портала: {uploadSummary.unchecked} — среди
                загруженных мог оказаться повтор.
              </div>
            )}
          </div>
          <button type="button" onClick={() => setUploadSummary(null)} className="text-gray-400 hover:text-gray-600 cursor-pointer">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {syncSummary && (
        <div className="flex items-start justify-between gap-3 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600">
          <span>{syncSummary}</span>
          <button type="button" onClick={() => setSyncSummary(null)} className="text-gray-400 hover:text-gray-600 cursor-pointer">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {showAdd && (
        <div className="rounded-lg border border-gray-200 p-4 space-y-3 bg-gray-50">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <label className="space-y-1 col-span-2">
              <span className="text-[11px] font-medium text-gray-500">Session name</span>
              <input value={sessionName} onChange={e => setSessionName(e.target.value)} placeholder="my_account"
                className="block w-full rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs outline-none focus:border-indigo-400" />
            </label>
            <label className="space-y-1">
              <span className="text-[11px] font-medium text-gray-500">API ID</span>
              <input type="number" value={apiId} onChange={e => setApiId(e.target.value)}
                className="block w-full rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs outline-none focus:border-indigo-400" />
            </label>
            <label className="space-y-1">
              <span className="text-[11px] font-medium text-gray-500">API Hash</span>
              <input value={apiHash} onChange={e => setApiHash(e.target.value)}
                className="block w-full rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs outline-none focus:border-indigo-400" />
            </label>
            <label className="space-y-1">
              <span className="text-[11px] font-medium text-gray-500">Телефон</span>
              <input value={phone} onChange={e => setPhone(e.target.value)} placeholder="+79001234567"
                className="block w-full rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs outline-none focus:border-indigo-400" />
            </label>
            <label className="space-y-1">
              <span className="text-[11px] font-medium text-gray-500">Прокси</span>
              <select value={proxyId} onChange={e => setProxyId(e.target.value)}
                className="block w-full rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs outline-none focus:border-indigo-400">
                <option value="">Без прокси</option>
                {freeProxies.map(p => <option key={p.id} value={p.id}>{p.name || p.url}</option>)}
                {freeProxies.length === 0 && <option disabled>Свободных прокси нет</option>}
              </select>
            </label>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => { void addAccount(); }} disabled={saving || !sessionName.trim() || !apiId || !apiHash.trim()}
              className="rounded-full bg-indigo-600 px-5 py-2 text-xs font-semibold text-white hover:bg-indigo-700 transition disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer">
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Сохранить'}
            </button>
            <button type="button" onClick={() => setShowAdd(false)}
              className="rounded-full border border-gray-200 px-4 py-2 text-xs text-gray-500 hover:bg-gray-100 transition cursor-pointer">Отмена</button>
          </div>
        </div>
      )}

      {/* Проверять можно и на работающей кампании: там нажатие не лезет в
          Telegram, а ставит заказ — выполнит рассылка своим соединением в
          ближайшем круге. Раньше кнопка была просто заблокирована, и «жив/не
          жив» на экране устаревал неделями. */}
      <BulkActionsBar
        selectedCount={selectedIds.length}
        deleting={bulkDeleting}
        onClear={clear}
        onDelete={() => { void deleteSelected(); }}
        checking={checkingIds.length > 0}
        canCheck
        onCheck={() => { void checkSelected(); }}
        checkTitle={profileReadable
          ? 'Зайти в каждый аккаунт и проверить, жив ли он и кто ещё в нём сидит'
          : 'Кампания работает: проверка встанет в очередь и выполнится рассылкой в ближайшем круге, обычно за несколько минут. Останавливать кампанию не нужно.'}
        checkLabel={profileReadable ? 'Проверить аккаунты' : 'Проверить (в очередь)'}
      />

      {checkResults && checkResults.length > 0 && (
        <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600">
          <div className="flex items-start justify-between gap-3">
            <span>
              {checkResults.every((r) => r.queued)
                ? `Поставлено в очередь: ${checkResults.length}. Рассылка выполнит проверку своим соединением, когда дойдёт до аккаунта в круге — обычно за несколько минут. Результат появится в строке аккаунта сам.`
                : `Проверено аккаунтов: ${checkResults.length}. Что ответил Telegram по каждому:`}
            </span>
            <button type="button" onClick={() => setCheckResults(null)} className="cursor-pointer text-gray-400 hover:text-gray-600">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <ul className="mt-2 space-y-2">
            {checkResults.map((r) => (
              <li key={r.id} className="space-y-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium text-gray-800">{r.name}</span>
                  {/* Технический код статуса рядом с человеческим словом: по
                      нему инженер ищет причину в логах, продавцу хватает слова. */}
                  <span className={`rounded-md px-1.5 py-0.5 ${CHECK_LABEL[r.status]?.cls ?? 'bg-gray-100 text-gray-500'}`}>
                    {CHECK_LABEL[r.status]?.text ?? r.status} ({r.status})
                  </span>
                  <span className="text-gray-500">{r.detail}</span>
                </div>
                {/* Главная находка проверки: аккаунт жив, но в нём сидит кто-то
                    ещё — именно так «нас разлогинили» отличается от «бан». */}
                {r.otherSessions.length > 0 && (
                  <div className="rounded-md bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
                    <div>В аккаунт заходит кто-то ещё, чужих сеансов: {r.otherSessions.length}</div>
                    <ul className="mt-0.5 space-y-0.5 text-amber-700">
                      {r.otherSessions.slice(0, 3).map((s, i) => (
                        <li key={`${r.id}-s${i}`}>
                          {s.device} · {s.app} · {s.country} · был{' '}
                          {new Date(s.last_active).toLocaleString('ru-RU', {
                            day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
                          })}
                        </li>
                      ))}
                      {r.otherSessions.length > 3 && (
                        <li>
                          и ещё {r.otherSessions.length - 3} — весь список под курсором на пометке
                          «чужих сеансов» в строке аккаунта
                        </li>
                      )}
                    </ul>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 py-8 text-sm text-gray-400"><Loader2 className="h-4 w-4 animate-spin" />Загрузка...</div>
      ) : accounts.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-200 p-8 text-center">
          <Users className="mx-auto h-8 w-8 text-gray-300 mb-2" />
          <p className="text-xs text-gray-400">Нет аккаунтов. Добавьте вручную или загрузите файлы.</p>
        </div>
      ) : (
        <div className="divide-y divide-gray-100 rounded-xl border border-gray-200 bg-white overflow-hidden">
          <div className="grid grid-cols-[32px_44px_minmax(0,1fr)_126px_120px_360px_138px_60px_64px] gap-4 px-4 py-2 text-[11px] font-medium text-gray-400 bg-gray-50 items-center">
            <SelectAllCheckbox total={accounts.length} selectedCount={selectedIds.length} onChange={setAll} />
            <span />
            <span>Аккаунт</span>
            <span title="Идёт ли с этого аккаунта рассылка первых сообщений. Если нет — почему и сколько дней уже.">
              Рассылка
            </span>
            <span>Телефон</span>
            <span>Прокси</span>
            <span title="Проходят ли через прокси круги рассылки. Если нет — сколько дней уже не проходят.">
              Здоровье прокси
            </span>
            <span>Активен</span><span />
          </div>
          {accounts.map(a => {
            const proxy = proxies.find(p => p.id === a.proxy_id);
            const onCooldown = a.cooldown_until && new Date(a.cooldown_until) > new Date();
            const counts = errorCounts[a.session_name];
            const errorCount = counts?.error ?? 0;
            // Обе колонки здоровья считаются от момента загрузки списка, а не
            // от момента отрисовки: Date.now() в рендере — нечистый вызов, и
            // «молчит 2 дня» не должно меняться от того, что React перерисовал
            // строку.
            // Ноль тут был бы хуже, чем неточность: с ним любой кулдаун
            // оказывается «в будущем», и все аккаунты разом объявляются
            // стоящими на паузе.
            const healthNow = loadedAt ?? Date.now();
            const sendingMark = describeSending({
              account: a,
              stat: sendingStats[a.id],
              proxy: proxy ?? null,
              campaignRunning: campaignStatus === 'running',
              firstTouchEnabled: firstTouchPerDay > 0,
              now: healthNow,
            });
            const proxyMark = describeProxy(proxy ?? null, healthNow);
            return (
              <div
                key={a.id}
                className={`grid grid-cols-[32px_44px_minmax(0,1fr)_126px_120px_360px_138px_60px_64px] gap-4 items-center px-4 py-3 ${isSelected(a.id) ? 'bg-indigo-50/60' : ''}`}
              >
                <input
                  type="checkbox"
                  checked={isSelected(a.id)}
                  onChange={() => toggle(a.id)}
                  aria-label={`Выбрать ${a.session_name}`}
                  className="h-3.5 w-3.5 cursor-pointer accent-indigo-600"
                />
                <button
                  type="button"
                  onClick={() => setProfileAccount(a)}
                  title="Профиль в Telegram"
                  className="relative cursor-pointer rounded-full transition hover:opacity-80"
                >
                  <AccountAvatar account={a} />
                  {(syncingIds.includes(a.id) || checkingIds.includes(a.id)) && (
                    <span className="absolute inset-0 flex items-center justify-center rounded-full bg-white/70">
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-indigo-500" />
                    </span>
                  )}
                </button>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                  {/* Клик по имени открывает профиль — то же, что и клик по
                      аватарке рядом. Логи переехали на кнопку со свитком
                      справа: к профилю обращаются постоянно, к логам — когда
                      что-то сломалось. */}
                  <button
                    type="button"
                    onClick={() => setProfileAccount(a)}
                    title="Профиль в Telegram"
                    className="min-w-0 text-left text-xs font-medium text-gray-800 truncate hover:text-indigo-600 hover:underline transition cursor-pointer"
                  >
                    {a.session_name}
                  </button>
                  {errorCount > 0 && (
                    <button
                      type="button"
                      onClick={() => setSelectedAccount(a)}
                      title={`${errorCount} ошибок за 24ч — открыть логи`}
                      className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-1.5 py-0.5 text-[10px] font-semibold text-rose-700 hover:bg-rose-100 transition cursor-pointer shrink-0"
                    >
                      <AlertCircle className="h-3 w-3" />
                      {errorCount}
                    </button>
                  )}
                  {onCooldown && (
                    <span className="text-[10px] text-amber-600 shrink-0">
                      Кулдаун до {new Date(a.cooldown_until!).toLocaleString('ru-RU', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })}
                    </span>
                  )}
                  </div>
                  {/* Имя из самого Telegram — не путать с session_name, под
                      которым аккаунт загружен в портал. */}
                  <div className="truncate text-[10px] text-gray-400">
                    {[a.first_name, a.last_name].filter(Boolean).join(' ') ||
                      (a.profile_synced_at ? 'без имени в Telegram' : 'профиль не прочитан')}
                    {a.tg_username ? ` · @${a.tg_username}` : ''}
                  </div>
                  {/* Итог проверки. Чужие сеансы выносим отдельно: это ответ на
                      вопрос, почему аккаунты теряют сессии пачками. */}
                  {(a.check_status || a.check_requested_at) && (
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      {a.check_requested_at && (
                        <span
                          title={`Проверку заказал ${a.check_requested_by_name || 'сотрудник портала'} — ${new Date(a.check_requested_at).toLocaleString('ru-RU')}. Выполнит рассылка своим соединением, когда дойдёт до аккаунта в круге: подключаться из портала к занятой сессии нельзя, Telegram выключит аккаунт.`}
                          className="cursor-help rounded-md bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700"
                        >
                          проверка в очереди
                        </span>
                      )}
                      {a.check_status && (
                        <span
                          title={a.check_detail ?? undefined}
                          className={`rounded-md px-1.5 py-0.5 text-[10px] ${CHECK_LABEL[a.check_status]?.cls ?? 'bg-gray-100 text-gray-500'}`}
                        >
                          {CHECK_LABEL[a.check_status]?.text ?? a.check_status}
                        </span>
                      )}
                      {(a.other_sessions?.length ?? 0) > 0 && (
                        <span
                          title={a.other_sessions!
                            .map((s) => `${s.device} · ${s.app} · ${s.country} · ${new Date(s.last_active).toLocaleString('ru-RU')}`)
                            .join('\n')}
                          className="cursor-help rounded-md bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700"
                        >
                          чужих сеансов: {a.other_sessions!.length}
                        </span>
                      )}
                      {/* Кнопка стоит рядом с плашкой, а не в общем ряду
                          действий: чужие сеансы — редкая находка, и убирать их
                          логично там же, где их увидели. */}
                      {(a.other_sessions?.length ?? 0) > 0 && (
                        <button
                          type="button"
                          disabled={resettingIds.includes(a.id)}
                          onClick={() => { void resetSessions(a.id); }}
                          title="Завершить все сеансы, кроме портального. Аккаунт останется подключённым к порталу."
                          className="inline-flex items-center gap-1 rounded-md border border-amber-200 bg-white px-1.5 py-0.5 text-[10px] font-medium text-amber-700 transition hover:bg-amber-50 disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
                        >
                          {resettingIds.includes(a.id) && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
                          {resettingIds.includes(a.id) ? 'Завершаю…' : 'Завершить чужие'}
                        </button>
                      )}
                      {resetError?.id === a.id && (
                        <span className="text-[10px] text-rose-600">{resetError.message}</span>
                      )}
                      {a.checked_at && (
                        <span className="text-[10px] text-gray-400">
                          {new Date(a.checked_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                        </span>
                      )}
                    </div>
                  )}
                </div>
                <HealthCell mark={sendingMark} />
                <span className="text-xs text-gray-500 truncate">{a.phone || '—'}</span>
                {editingProxyFor === a.id ? (
                  <select
                    autoFocus
                    defaultValue={a.proxy_id ?? ''}
                    onBlur={e => { void assignProxy(a.id, e.target.value); }}
                    onChange={e => { void assignProxy(a.id, e.target.value); }}
                    className="w-full rounded border border-indigo-300 bg-white px-1.5 py-0.5 text-xs outline-none focus:border-indigo-500 cursor-pointer"
                  >
                    <option value="">Без прокси</option>
                    {proxyOptions(a.proxy_id).map(p => (
                      <option key={p.id} value={p.id}>{p.name || p.url}</option>
                    ))}
                    {proxyOptions(a.proxy_id).length === 0 && (
                      <option disabled>Свободных прокси нет</option>
                    )}
                  </select>
                ) : (
                  <button
                    type="button"
                    // Колонка рассчитана на всю строку прокси (55 знаков — это
                    // весь пул), но на узком экране она всё же подрежется.
                    // Подсказка при наведении показывает адрес целиком.
                    title={proxy ? `${proxy.name || proxy.url} — нажмите, чтобы сменить` : 'Назначить прокси'}
                    onClick={() => setEditingProxyFor(a.id)}
                    className="w-full text-left text-xs truncate rounded px-1 py-0.5 hover:bg-indigo-50 hover:text-indigo-700 transition cursor-pointer group"
                  >
                    {proxy ? (proxy.name || proxy.url) : <span className="text-gray-300 group-hover:text-indigo-400">—</span>}
                  </button>
                )}
                <HealthCell mark={proxyMark} />
                <button type="button" onClick={() => { void toggleActive(a.id, a.is_active); }}
                  className={`rounded-full px-2.5 py-1 text-[10px] font-medium transition cursor-pointer w-fit ${a.is_active ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}>
                  {a.is_active ? 'Да' : 'Нет'}
                </button>
                <div className="flex items-center gap-0.5">
                  <button type="button" onClick={() => setSelectedAccount(a)} title="Логи и информация"
                    className="p-1.5 rounded-lg text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 transition cursor-pointer">
                    <ScrollText className="h-3.5 w-3.5" />
                  </button>
                  <button type="button" onClick={() => { void deleteAccount(a.id); }} title="Удалить аккаунт"
                    className="p-1.5 rounded-lg text-gray-400 hover:text-rose-600 hover:bg-rose-50 transition cursor-pointer">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {selectedAccount && (
        <AccountLogsModal
          account={selectedAccount}
          proxy={proxies.find(p => p.id === selectedAccount.proxy_id) ?? null}
          onClose={() => setSelectedAccount(null)}
        />
      )}

      {profileAccount && (
        <AccountProfileModal
          account={accounts.find(a => a.id === profileAccount.id) ?? profileAccount}
          canRead={profileReadable}
          syncing={syncingIds.includes(profileAccount.id)}
          onSync={() => syncProfile(profileAccount.id)}
          onClose={() => setProfileAccount(null)}
          onSaved={() => { void load(); }}
        />
      )}
    </div>
  );
}

/* =================== ACCOUNT PROFILE MODAL =================== */
/**
 * Правка настоящего профиля в Telegram: ФИО, описание, аватарка.
 *
 * Не путать с аватаркой у аккаунтов пула — та косметическая, лежит в хранилище
 * портала и в Telegram не уходит. Здесь меняется сам аккаунт, поэтому и
 * предупреждение, и требование остановленной кампании.
 */
function AccountProfileModal({
  account,
  canRead,
  syncing,
  onSync,
  onClose,
  onSaved,
}: {
  account: OutreachAccount;
  /** Можно ли сейчас ходить в Telegram (кампания остановлена). */
  canRead: boolean;
  syncing: boolean;
  onSync: () => Promise<SyncResult>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [firstName, setFirstName] = useState(account.first_name ?? '');
  const [lastName, setLastName] = useState(account.last_name ?? '');
  const [bio, setBio] = useState(account.bio ?? '');
  const [username, setUsername] = useState(account.tg_username ?? '');
  // Превью держим рядом с файлом: ссылку на blob создаём в момент выбора, а не
  // эффектом на каждый рендер.
  const [avatar, setAvatar] = useState<{ file: File; url: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Аватарка не доехала до хранилища портала. Не ошибка: в самом Telegram всё
   * применилось, а вот в списке аккаунтов картинки не будет — и молчать об этом
   * нельзя, иначе это выглядит как «у аккаунта нет фото».
   */
  const [avatarWarning, setAvatarWarning] = useState<string | null>(null);

  const pickAvatar = (file: File | null) => {
    setAvatar((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return file ? { file, url: URL.createObjectURL(file) } : null;
    });
  };

  /**
   * Прочитать профиль из Telegram и подставить в поля.
   *
   * Уже начатую правку не затираем: оператор мог открыть карточку, начать
   * печатать имя и только потом дождаться ответа Telegram.
   */
  const syncNow = useCallback(async () => {
    setError(null);
    const { error: err, patch, avatarError } = await onSync();
    setAvatarWarning(avatarError ?? null);
    if (err) { setError(err); return; }
    if (!patch) return;
    setFirstName((v) => (v ? v : patch.first_name ?? ''));
    setLastName((v) => (v ? v : patch.last_name ?? ''));
    setBio((v) => (v ? v : patch.bio ?? ''));
    setUsername((v) => (v ? v : patch.tg_username ?? ''));
  }, [onSync]);

  // Профиль, который ни разу не читали, подтягиваем сразу при открытии: иначе
  // карточка выглядит пустой, хотя в самом Telegram всё заполнено.
  const neverSynced = !account.profile_synced_at;
  useEffect(() => {
    if (neverSynced && canRead) queueMicrotask(() => { void syncNow(); });
    // Только на открытии карточки: повторные автопопытки при обрыве связи
    // превратились бы в бесконечный цикл подключений через прокси.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const token = await getAccessToken();
      const form = new FormData();
      form.append('first_name', firstName);
      form.append('last_name', lastName);
      form.append('bio', bio);
      // Шлём всегда, в том числе пустым: пустое поле означает «снять юзернейм».
      // Отсутствие поля роут читает как «не трогать» — это разные намерения.
      form.append('username', username);
      if (avatar) form.append('avatar', avatar.file);

      const res = await fetch(`${API_BASE}/accounts/${account.id}/profile`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      const body = (await res.json().catch(() => null)) as
        { error?: string; avatar_error?: string } | null;
      if (!res.ok) {
        setError(body?.error ?? `Ошибка ${res.status}`);
        return;
      }
      onSaved();
      // Профиль в Telegram уже изменён, поэтому не откатываем и не считаем это
      // ошибкой — но карточку не закрываем, иначе предупреждение никто не увидит.
      if (body?.avatar_error) {
        setAvatarWarning(body.avatar_error);
        return;
      }
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose} role="dialog" aria-modal="true">
      <div className="w-full max-w-md rounded-xl border border-gray-200 bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4">
          <h2 className="text-lg font-semibold text-gray-900">Профиль в Telegram</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="h-5 w-5" /></button>
        </div>

        <div className="space-y-4 px-6 py-5">
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Меняется настоящий профиль аккаунта в Telegram. Частая смена имени и особенно аватарки — сигнал для
            антиспама: настраивайте один раз перед запуском. Кампания должна быть остановлена.
          </div>

          {/* Текущая аватарка и загрузка новой: кликабельно всё — и картинка,
              и подпись под ней. */}
          <div className="flex items-center gap-4">
            <label
              className="group relative cursor-pointer"
              title="Выбрать новую аватарку"
            >
              {avatar ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={avatar.url} alt="" className="h-20 w-20 rounded-full object-cover" />
              ) : (
                <AccountAvatar account={account} size={80} />
              )}
              <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/45 text-[10px] font-medium text-white opacity-0 transition group-hover:opacity-100">
                {syncing ? '' : 'Изменить'}
              </span>
              {syncing && (
                <span className="absolute inset-0 flex items-center justify-center rounded-full bg-white/70">
                  <Loader2 className="h-5 w-5 animate-spin text-indigo-500" />
                </span>
              )}
              <input
                type="file"
                accept="image/jpeg,image/png"
                className="hidden"
                onChange={(e) => pickAvatar(e.target.files?.[0] ?? null)}
              />
            </label>

            <div className="min-w-0 space-y-1.5">
              <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 transition hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700">
                <Upload className="h-3.5 w-3.5" />
                {avatar ? 'Выбрать другую' : 'Загрузить аватарку'}
                <input
                  type="file"
                  accept="image/jpeg,image/png"
                  className="hidden"
                  onChange={(e) => pickAvatar(e.target.files?.[0] ?? null)}
                />
              </label>
              <div className="truncate text-[11px] text-gray-400">
                {avatar
                  ? `${avatar.file.name} · ${Math.round(avatar.file.size / 1024)} КБ`
                  : 'Квадратный JPEG до 1 МБ'}
              </div>
              {avatar && (
                <button
                  type="button"
                  onClick={() => pickAvatar(null)}
                  className="text-[11px] text-gray-400 underline hover:text-gray-600 cursor-pointer"
                >
                  Отменить выбор
                </button>
              )}
            </div>
          </div>

          {/* Откуда взяты значения полей. Без этой строки пустая карточка
              читается как «в Telegram ничего не заполнено». */}
          <div className="flex items-center justify-between gap-2 text-[11px] text-gray-400">
            <span>
              {syncing
                ? 'Читаю профиль из Telegram…'
                : account.profile_synced_at
                  ? `Профиль прочитан ${new Date(account.profile_synced_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`
                  : canRead
                    ? 'Профиль ещё не читали из Telegram'
                    : 'Профиль не прочитан: кампания работает, аккаунт занят'}
            </span>
            <button
              type="button"
              disabled={!canRead || syncing}
              onClick={() => { void syncNow(); }}
              title={canRead ? 'Перечитать профиль из Telegram' : 'Сначала остановите кампанию'}
              className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-2 py-1 text-[11px] text-gray-600 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 cursor-pointer"
            >
              <RefreshCw className={`h-3 w-3 ${syncing ? 'animate-spin' : ''}`} />
              Обновить
            </button>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1">
              <span className="text-[11px] font-medium text-gray-500">Имя</span>
              <input value={firstName} onChange={(e) => setFirstName(e.target.value)} maxLength={64}
                className="block w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs outline-none focus:border-indigo-400" />
            </label>
            <label className="space-y-1">
              <span className="text-[11px] font-medium text-gray-500">Фамилия</span>
              <input value={lastName} onChange={(e) => setLastName(e.target.value)} maxLength={64}
                className="block w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs outline-none focus:border-indigo-400" />
            </label>
          </div>

          <label className="space-y-1 block">
            <span className="text-[11px] font-medium text-gray-500">Юзернейм</span>
            <div className="relative">
              <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-gray-400">@</span>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                maxLength={32}
                placeholder="без юзернейма"
                className="block w-full rounded-lg border border-gray-200 py-1.5 pl-6 pr-2.5 text-xs outline-none focus:border-indigo-400"
              />
            </div>
            <span className="block text-[10px] text-gray-400">
              5–32 знака, латиница, цифры и подчёркивание. Пустое поле снимет юзернейм.
              Telegram ограничивает частоту смен — не меняйте у рассылающих аккаунтов без нужды.
            </span>
          </label>

          <label className="space-y-1 block">
            <span className="text-[11px] font-medium text-gray-500">Описание ({bio.length}/70)</span>
            <textarea value={bio} onChange={(e) => setBio(e.target.value)} maxLength={70} rows={2}
              className="block w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs outline-none focus:border-indigo-400 resize-y" />
          </label>

          {error && <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</div>}
          {avatarWarning && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Аватарка не сохранилась в портале: {avatarWarning}. В Telegram она при этом на месте —
              не видно только в списке аккаунтов.
            </div>
          )}
        </div>

        <div className="border-t border-gray-100 px-6 py-4">
          <button type="button" onClick={() => { void save(); }} disabled={saving || !firstName.trim()}
            className="w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50 transition cursor-pointer">
            {saving ? 'Применяю в Telegram...' : 'Применить'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* =================== ACCOUNT LOGS MODAL =================== */
function AccountLogsModal({
  account,
  proxy,
  onClose,
}: {
  account: OutreachAccount;
  proxy: OutreachProxy | null;
  onClose: () => void;
}) {
  const [range, setRange] = useState<ErrorRange>('24h');
  const [logs, setLogs] = useState<OutreachLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [exportingRange, setExportingRange] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authFetch(`${API_BASE}/accounts/${account.id}/logs?range=${range}`);
      if (res.ok) {
        const d = await res.json() as {
          items: OutreachLog[];
          truncated: boolean;
        };
        setLogs(d.items ?? []);
        setTruncated(Boolean(d.truncated));
      } else {
        setLogs([]);
        setTruncated(false);
      }
    } finally {
      setLoading(false);
    }
  }, [account.id, range]);

  useEffect(() => { void fetchLogs(); }, [fetchLogs]);

  // Close on Escape so the modal feels native.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Auto-scroll to bottom (newest) after each refresh.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [logs]);

  const exportLogs = useCallback(
    async (r: ErrorRange) => {
      setExportingRange(r);
      try {
        const res = await authFetch(`${API_BASE}/accounts/${account.id}/logs?range=${r}&format=txt`);
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          alert((data as { error?: string }).error ?? `Не удалось выгрузить логи (HTTP ${res.status})`);
          return;
        }
        const cd = res.headers.get('content-disposition') ?? '';
        const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(cd);
        const ascii = /filename="?([^";]+)"?/i.exec(cd);
        const filename = utf8
          ? decodeURIComponent(utf8[1])
          : (ascii?.[1] ?? `tg-outreach-account-${account.session_name}-${r}.txt`);
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } finally {
        setExportingRange(null);
      }
    },
    [account.id, account.session_name],
  );

  const levelColor = (l: string) => {
    switch (l) {
      case 'error': return 'text-rose-400';
      case 'warning': return 'text-amber-400';
      default: return 'text-gray-400';
    }
  };

  const errorCount = logs.filter(l => l.level === 'error').length;
  const warningCount = logs.filter(l => l.level === 'warning').length;
  const onCooldown = account.cooldown_until && new Date(account.cooldown_until) > new Date();

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-4xl max-h-[90vh] flex flex-col rounded-2xl bg-white shadow-2xl overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <header className="flex items-start justify-between border-b border-gray-100 px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-gray-900 truncate">
              {account.session_name}
            </h2>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500">
              {account.phone && account.phone !== account.session_name && (
                <span>Телефон: <span className="text-gray-700">{account.phone}</span></span>
              )}
              <span>Прокси: <span className="text-gray-700">{proxy ? (proxy.name || proxy.url) : '—'}</span></span>
              <span>
                Активен:{' '}
                <span className={account.is_active ? 'text-emerald-700' : 'text-gray-500'}>
                  {account.is_active ? 'Да' : 'Нет'}
                </span>
              </span>
              {onCooldown && (
                <span className="text-amber-600">
                  Кулдаун до {new Date(account.cooldown_until!).toLocaleString('ru-RU', {
                    hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit',
                  })}
                </span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ml-3 p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-700 transition cursor-pointer"
            aria-label="Закрыть"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="px-5 py-3 border-b border-gray-100 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-gray-500 mr-1">Период:</span>
            {(['6h', '24h', '7d', '30d'] as const).map(r => {
              const labels: Record<typeof r, string> = { '6h': '6ч', '24h': '24ч', '7d': '7д', '30d': '30д' };
              const active = range === r;
              return (
                <button
                  key={r}
                  type="button"
                  onClick={() => setRange(r)}
                  className={`rounded-full px-3 py-1 text-xs font-medium transition cursor-pointer ${
                    active
                      ? 'bg-indigo-600 text-white'
                      : 'bg-white text-gray-600 border border-gray-200 hover:border-indigo-300 hover:bg-indigo-50'
                  }`}
                >
                  {labels[r]}
                </button>
              );
            })}
          </div>

          <div className="text-xs text-gray-500">
            {loading ? '…' : (
              <>
                Всего строк: <span className="font-semibold text-gray-700">{logs.length}</span>
                {errorCount > 0 && (
                  <> · <span className="text-rose-600 font-semibold">{errorCount} ошибок</span></>
                )}
                {warningCount > 0 && (
                  <> · <span className="text-amber-600 font-semibold">{warningCount} предупреждений</span></>
                )}
                {truncated && (
                  <> · <span className="text-gray-400">(поместились только первые 5000 строк — весь период есть в выгрузке .txt)</span></>
                )}
              </>
            )}
          </div>

          <div className="ml-auto flex items-center gap-1.5">
            <span className="text-xs text-gray-500 mr-1">.txt:</span>
            {(['6h', '24h', '7d', '30d'] as const).map(r => {
              const labels: Record<typeof r, string> = { '6h': '6ч', '24h': '24ч', '7d': '7д', '30d': '30д' };
              const busy = exportingRange === r;
              return (
                <button
                  key={r}
                  type="button"
                  onClick={() => void exportLogs(r)}
                  disabled={exportingRange !== null}
                  className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 hover:border-indigo-300 hover:bg-indigo-50 transition disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                >
                  {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                  {labels[r]}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex-1 overflow-auto bg-gray-950 p-3 font-mono text-[11px] leading-relaxed">
          {loading && <p className="text-gray-500">Загрузка логов…</p>}
          {!loading && logs.length === 0 && (
            <p className="text-gray-600">
              По этому аккаунту ничего не найдено в выбранном периоде.
            </p>
          )}
          {logs.map((log, idx) => (
            <div key={`${log.id}-${idx}`} className="flex gap-2">
              <span className="text-gray-600 shrink-0">
                {new Date(log.created_at).toLocaleTimeString('ru-RU')}
              </span>
              <span className={`shrink-0 font-bold uppercase w-14 ${levelColor(log.level)}`}>
                {log.level}
              </span>
              <span className="text-gray-300 break-all">{log.message}</span>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      </div>
    </div>
  );
}

/* =================== CAMPAIGN BASES TAB =================== */
interface OutreachBase {
  id: string;
  name: string;
  notes: string;
  /**
   * Чаты, из которых собрана гипотеза: по одной ссылке в строке. Кормит
   * «Кол-во обработанных чатов» и «Канал/чат» в отчёте по договору — в самом
   * файле базы источника нет, там только юзернейм и текст сообщения.
   */
  source_chats?: string;
  /** Кампания-владелец. null — база осталась без владельца от старой модели. */
  campaign_id: string | null;
  counts: { total: number; pending: number; sent: number; replied: number; failed: number; skipped: number };
}

/**
 * Базы контактов для первого касания.
 *
 * База принадлежит кампании. Раньше она жила сама по себе — «одну и ту же можно
 * запустить на разных кампаниях и сравнить результат», — и вкладка показывала
 * все базы портала: оператор открывал свою кампанию и видел чужую базу на 2206
 * контактов, в одной галочке от запуска, да ещё и с её собственными счётчиками.
 * Сравнивать гипотезы это не помогало, а путало.
 *
 * Галочка теперь означает не «чья база», а «участвует в рассылке» — выключатель,
 * которым базу ставят на паузу, не удаляя.
 */
function CampaignBasesTab({ campaignId }: { campaignId: string }) {
  const [bases, setBases] = useState<OutreachBase[]>([]);
  /**
   * Базы без кампании — наследство старой модели: кнопка «Создать базу» не
   * спрашивала кампанию. Показываем отдельно, чтобы они не пропали молча, а
   * оператор перенёс их руками.
   */
  const [orphans, setOrphans] = useState<OutreachBase[]>([]);
  const [linked, setLinked] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** База, у которой сейчас правят список чатов-источников. */
  const [editingChatsFor, setEditingChatsFor] = useState<string | null>(null);
  const [chatsDraft, setChatsDraft] = useState('');
  const [savingChats, setSavingChats] = useState(false);
  /** id базы, пока её файл собирается на сервере. */
  const [exporting, setExporting] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [basesRes, linkRes] = await Promise.all([
      authFetch(`${API_BASE}/bases?campaign_id=${campaignId}`),
      authFetch(`${API_BASE}/campaigns/${campaignId}/bases`),
    ]);
    if (basesRes.ok) {
      const d = (await basesRes.json()) as { items: OutreachBase[]; orphans?: OutreachBase[] };
      setBases(d.items);
      setOrphans(d.orphans ?? []);
    }
    if (linkRes.ok) {
      const d = (await linkRes.json()) as { items: Array<{ base_id: string }> };
      setLinked(new Set(d.items.map((i) => i.base_id)));
    }
    setLoading(false);
  }, [campaignId]);

  useEffect(() => { queueMicrotask(() => { void load(); }); }, [load]);

  const createBase = async () => {
    if (!newName.trim()) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const res = await authFetch(`${API_BASE}/bases`, {
        method: 'POST',
        body: JSON.stringify({ name: newName.trim(), campaign_id: campaignId }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(d?.error ?? `Ошибка ${res.status}`);
        return;
      }
      setNewName('');
      void load();
    } finally { setBusy(false); }
  };

  const toggleLink = async (baseId: string) => {
    const next = new Set(linked);
    if (next.has(baseId)) next.delete(baseId); else next.add(baseId);
    setLinked(next);
    setError(null);
    const res = await authFetch(`${API_BASE}/campaigns/${campaignId}/bases`, {
      method: 'PUT',
      body: JSON.stringify({ base_ids: [...next] }),
    });
    if (!res.ok) {
      const d = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(d?.error ?? `Не удалось сохранить выбор баз (${res.status})`);
      // Возвращаем список к состоянию сервера: иначе галочка останется стоять,
      // а на сервере ничего не изменилось.
      void load();
    }
  };

  /** Забрать базу без владельца в эту кампанию. */
  const adoptBase = async (base: OutreachBase) => {
    if (!confirm(
      `Перенести базу «${base.name}» (${base.counts.total} контактов) в эту кампанию?`
      + ' После переноса она будет видна только здесь. Рассылка не начнётся сама —'
      + ' для этого нужно отметить базу галочкой.',
    )) return;

    setBusy(true); setError(null); setNotice(null);
    try {
      const res = await authFetch(`${API_BASE}/bases/${base.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ campaign_id: campaignId }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(d?.error ?? `Не удалось перенести базу (${res.status})`);
        return;
      }
      setNotice(`База «${base.name}» перенесена в кампанию.`);
      void load();
    } finally { setBusy(false); }
  };

  /**
   * Сохранить чаты-источники гипотезы.
   *
   * Ввести их один раз на базу дешевле, чем добавлять колонку в файл на триста
   * строк, — а отчёту хватает и того, и другого: он складывает объявленные тут
   * чаты с теми, что пришли в файле, и считает уникальные.
   */
  const saveSourceChats = async (baseId: string) => {
    setSavingChats(true); setError(null); setNotice(null);
    try {
      const res = await authFetch(`${API_BASE}/bases/${baseId}`, {
        method: 'PUT',
        body: JSON.stringify({ source_chats: chatsDraft }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(d?.error ?? `Не удалось сохранить чаты-источники (${res.status})`);
        return;
      }
      setBases((cur) => cur.map((b) => (b.id === baseId ? { ...b, source_chats: chatsDraft.trim() } : b)));
      setEditingChatsFor(null);
    } finally { setSavingChats(false); }
  };

  /**
   * Скачать базу файлом Excel.
   *
   * Формат не спрашиваем: выбор между xlsx и csv — лишний шаг там, где ответ
   * всегда один, а роут при необходимости отдаёт и `format=csv`.
   *
   * Через `fetch`, а не обычной ссылкой: роут закрыт токеном, а `<a href>` его
   * не передаёт. Имя файла берём из `Content-Disposition` — там оно с
   * кириллицей и датой выгрузки.
   */
  const downloadBase = async (base: OutreachBase) => {
    setExporting(base.id);
    setError(null); setNotice(null);
    try {
      const res = await authFetch(`${API_BASE}/bases/${base.id}/export?format=xlsx`);
      if (!res.ok) {
        const d = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(d?.error ?? `Не удалось выгрузить базу (${res.status})`);
        return;
      }
      const cd = res.headers.get('content-disposition') ?? '';
      const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(cd);
      const ascii = /filename="?([^";]+)"?/i.exec(cd);
      const filename = utf8
        ? decodeURIComponent(utf8[1])
        : (ascii?.[1] ?? `${base.name}.xlsx`);

      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } finally { setExporting(null); }
  };

  /**
   * Кнопка «скачать» — одна и та же в обоих списках баз.
   *
   * Функция, а не вложенный компонент: вложенный пересоздавался бы на каждый
   * ререндер вкладки.
   */
  const exportButton = (base: OutreachBase) => (
    <button
      type="button"
      onClick={() => { void downloadBase(base); }}
      disabled={exporting !== null || base.counts.total === 0}
      title={base.counts.total === 0 ? 'В базе нет контактов' : 'Скачать базу в Excel'}
      aria-label={`Скачать базу ${base.name}`}
      className="p-1 rounded-lg text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-gray-400 disabled:hover:bg-transparent"
    >
      {exporting === base.id
        ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
        : <Download className="h-3.5 w-3.5" />}
    </button>
  );

  const deleteBase = async (base: OutreachBase) => {
    // Предупреждаем про отправленных отдельно: контакты уйдут каскадом, и
    // история «кому мы уже писали по этой гипотезе» пропадёт вместе с базой.
    const sentNote = base.counts.sent > 0
      ? ` По ней уже отправлено ${base.counts.sent} сообщений — эта история будет потеряна.`
      : '';
    if (!confirm(`Удалить базу «${base.name}» и все ${base.counts.total} контактов?${sentNote}`)) return;

    setBusy(true); setError(null); setNotice(null);
    try {
      const res = await authFetch(`${API_BASE}/bases/${base.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const d = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(d?.error ?? `Не удалось удалить базу (${res.status})`);
        return;
      }
      void load();
    } finally { setBusy(false); }
  };

  /**
   * Контакт, трижды не прошедший отправку, уходит в «отложенные» и больше не
   * выбирается — иначе мусорная строка в начале файла заткнула бы всю базу.
   * Но часть причин снимается настройкой, а не правкой файла: подняли порог
   * длины первого сообщения — контакты обязаны вернуться в работу.
   */
  const requeueBase = async (base: OutreachBase) => {
    if (!confirm(
      `Вернуть в очередь ${base.counts.failed} отложенных контактов базы «${base.name}»?`
      + ' Они снова пойдут в отправку — сначала убедитесь, что причина устранена'
      + ' (например, поднят порог длины первого сообщения в настройках кампании).',
    )) return;

    setBusy(true); setError(null); setNotice(null);
    try {
      const res = await authFetch(`${API_BASE}/bases/${base.id}/requeue`, { method: 'POST' });
      const d = (await res.json().catch(() => null)) as { error?: string; requeued?: number } | null;
      if (!res.ok) {
        setError(d?.error ?? `Не удалось вернуть контакты в очередь (${res.status})`);
        return;
      }
      setNotice(`Возвращено в очередь: ${d?.requeued ?? 0}.`);
      void load();
    } finally { setBusy(false); }
  };

  const uploadContacts = async (baseId: string, e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const token = await getAccessToken();
      const form = new FormData();
      form.append('file', file);
      const res = await fetch(`${API_BASE}/bases/${baseId}/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      const d = (await res.json().catch(() => null)) as {
        error?: string;
        stats?: { total: number; accepted: number; noUsername: number; noMessage: number; duplicates: number };
      } | null;
      if (!res.ok) {
        setError(d?.error ?? `Ошибка загрузки (${res.status})`);
        return;
      }
      const s = d?.stats;
      if (s) {
        setNotice(
          `Загружено ${s.accepted} из ${s.total}. Без юзернейма — ${s.noUsername}, без текста — ${s.noMessage}, дублей — ${s.duplicates}.`,
        );
      }
      void load();
    } finally {
      setBusy(false);
      e.target.value = '';
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <span className="text-sm font-medium text-gray-700">
          Базы контактов <span className="text-gray-400 font-normal">({bases.length})</span>
        </span>
        <div className="flex items-center gap-2">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Гипотеза 1"
            className="rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs outline-none focus:border-indigo-400"
          />
          <button type="button" onClick={() => { void createBase(); }} disabled={busy || !newName.trim()}
            className="inline-flex items-center gap-1.5 rounded-full bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700 transition disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer">
            <Plus className="h-3.5 w-3.5" /> Создать базу
          </button>
        </div>
      </div>

      {notice && (
        <div className="rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs text-indigo-900">{notice}</div>
      )}
      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 py-8 text-sm text-gray-400"><Loader2 className="h-4 w-4 animate-spin" />Загрузка...</div>
      ) : bases.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-200 p-8 text-center">
          <Database className="mx-auto h-8 w-8 text-gray-300 mb-2" />
          <p className="text-xs text-gray-400">
            Баз пока нет. Создайте базу и загрузите файл: юзернейм в первой колонке, текст сообщения во второй.
          </p>
        </div>
      ) : (
        <div className="divide-y divide-gray-100 rounded-xl border border-gray-200 bg-white overflow-hidden">
          {/* «Отложено» (status=failed) раньше не показывали вовсе: контакты
              копились в невидимой колонке, и база, вставшая на пороге длины,
              выглядела просто пустеющей. */}
          <div className="grid grid-cols-[32px_1fr_repeat(5,80px)_180px] gap-4 px-4 py-2 text-[11px] font-medium text-gray-400 bg-gray-50 items-center">
            <span />
            <span>База</span><span>Всего</span><span>Ждут</span><span>Отправлено</span><span>Пропущено</span><span>Отложено</span><span />
          </div>
          {bases.map((b) => {
            const chats = (b.source_chats ?? '')
              .split(/[\n,;]+/)
              .map((c) => c.trim())
              .filter(Boolean);
            return (
            <React.Fragment key={b.id}>
            <div className={`grid grid-cols-[32px_1fr_repeat(5,80px)_180px] gap-4 items-center px-4 py-2.5 ${linked.has(b.id) ? 'bg-indigo-50/60' : ''}`}>
              <input
                type="checkbox"
                checked={linked.has(b.id)}
                onChange={() => { void toggleLink(b.id); }}
                title="Участвует в рассылке. Снятая галочка ставит базу на паузу, контакты и счётчики сохраняются"
                aria-label={`Участвует в рассылке: база ${b.name}`}
                className="h-3.5 w-3.5 cursor-pointer accent-indigo-600"
              />
              <div className="min-w-0">
                <div className="text-xs font-medium text-gray-800 truncate">{b.name}</div>
                {/* Чаты-источники живут в строке базы, а не в отдельном экране:
                    их спрашивает отчёт по договору, и заполнить их проще там
                    же, где базу заводят. */}
                <button
                  type="button"
                  onClick={() => {
                    setEditingChatsFor(editingChatsFor === b.id ? null : b.id);
                    setChatsDraft(b.source_chats ?? '');
                  }}
                  title="Чаты, из которых собрана эта гипотеза. Идут в отчёт: «Кол-во обработанных чатов» и «Канал/чат»."
                  className={`mt-0.5 text-[10px] underline decoration-dotted underline-offset-2 transition cursor-pointer ${chats.length ? 'text-gray-400 hover:text-indigo-600' : 'text-amber-600 hover:text-amber-700'}`}
                >
                  {chats.length ? `чатов-источников: ${chats.length}` : 'чаты-источники не указаны — отчёт не посчитает'}
                </button>
              </div>
              <span className="text-xs text-gray-600">{b.counts.total}</span>
              <span className="text-xs text-gray-600">{b.counts.pending}</span>
              <span className="text-xs text-gray-600">{b.counts.sent}</span>
              <span className="text-xs text-gray-600">{b.counts.skipped}</span>
              <span className={`text-xs ${b.counts.failed > 0 ? 'text-amber-600 font-medium' : 'text-gray-600'}`}>
                {b.counts.failed}
              </span>
              <div className="flex items-center gap-1">
              <label className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-2 py-1 text-[11px] text-gray-700 hover:bg-gray-50 transition cursor-pointer w-fit">
                <Upload className="h-3 w-3" /> Загрузить
                <input type="file" accept=".xlsx,.xls,.csv" className="hidden" disabled={busy}
                  onChange={(e) => { void uploadContacts(b.id, e); }} />
              </label>
                {exportButton(b)}
                <button type="button" onClick={() => { void requeueBase(b); }} disabled={busy || b.counts.failed === 0}
                  title="Вернуть отложенные контакты в очередь — например, после того как подняли порог длины первого сообщения"
                  className="p-1 rounded-lg text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-gray-400 disabled:hover:bg-transparent">
                  <RefreshCw className="h-3.5 w-3.5" />
                </button>
                <button type="button" onClick={() => { void deleteBase(b); }} disabled={busy}
                  title="Удалить базу вместе с контактами"
                  className="p-1 rounded-lg text-gray-400 hover:text-rose-600 hover:bg-rose-50 transition cursor-pointer disabled:opacity-50">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
            {editingChatsFor === b.id && (
              <div className="space-y-2 border-t border-gray-100 bg-gray-50 px-4 py-3">
                <div className="text-[11px] font-medium text-gray-700">
                  Чаты-источники базы «{b.name}»
                </div>
                <p className="text-[10px] text-gray-500">
                  По одной ссылке в строке — те чаты, из которых собирали контакты этой гипотезы
                  (обычно 3–4). Отсюда берутся «Кол-во обработанных чатов» и колонка «Канал/чат»
                  в отчёте по договору: в самом файле базы источника нет.
                </p>
                <textarea
                  value={chatsDraft}
                  onChange={(e) => setChatsDraft(e.target.value)}
                  rows={4}
                  placeholder={'https://t.me/buhrussia\nhttps://t.me/buhcha\n@tilda_official_chat'}
                  className="block w-full rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 font-mono text-[11px] outline-none focus:border-indigo-400"
                />
                <div className="flex items-center gap-2">
                  <button type="button" disabled={savingChats} onClick={() => { void saveSourceChats(b.id); }}
                    className="rounded-full bg-indigo-600 px-4 py-1.5 text-[11px] font-semibold text-white transition hover:bg-indigo-700 disabled:opacity-50 cursor-pointer">
                    {savingChats ? 'Сохраняю…' : 'Сохранить'}
                  </button>
                  <button type="button" onClick={() => setEditingChatsFor(null)}
                    className="rounded-full border border-gray-200 px-3 py-1.5 text-[11px] text-gray-500 transition hover:bg-gray-100 cursor-pointer">
                    Отмена
                  </button>
                </div>
              </div>
            )}
            </React.Fragment>
            );
          })}
        </div>
      )}

      {/* Сравнение — под списком: сначала оператор видит, какие базы вообще
          есть и что с ними, и только потом сравнивает две из них. Обратный
          порядок заставлял бы выбирать вслепую. */}
      {!loading && bases.length > 0 && (
        <BaseComparison
          campaignId={campaignId}
          bases={bases.map((b) => ({ id: b.id, name: b.name }))}
        />
      )}

      {/* Наследство старой модели: кнопка «Создать базу» кампанию не спрашивала,
          и такие базы висели во вкладке каждой кампании портала. Прятать их
          молча нельзя — это чьи-то загруженные контакты; показываем отдельно и
          просим перенести. Когда таких не останется, блок исчезнет сам. */}
      {!loading && orphans.length > 0 && (
        <div className="space-y-2 rounded-xl border border-amber-200 bg-amber-50/50 p-3">
          <div className="text-xs font-medium text-amber-900">
            Базы без кампании ({orphans.length})
          </div>
          <p className="text-[10px] text-amber-800">
            Заведены до того, как базы стали принадлежать кампании, и не подключены ни к одной.
            Они не участвуют ни в одной рассылке. Перенесите нужные сюда, остальные удалите —
            после этого блок пропадёт.
          </p>
          <div className="divide-y divide-amber-100 rounded-lg border border-amber-200 bg-white overflow-hidden">
            {orphans.map((b) => (
              <div key={b.id} className="grid grid-cols-[1fr_80px_80px_230px] gap-3 items-center px-3 py-2">
                <span className="text-xs font-medium text-gray-800 truncate">{b.name}</span>
                <span className="text-xs text-gray-500">{b.counts.total} всего</span>
                <span className="text-xs text-gray-500">{b.counts.sent} отправлено</span>
                <div className="flex items-center justify-end gap-1">
                  {exportButton(b)}
                  <button type="button" onClick={() => { void adoptBase(b); }} disabled={busy}
                    className="rounded-lg border border-amber-300 px-2 py-1 text-[11px] text-amber-900 hover:bg-amber-100 transition cursor-pointer disabled:opacity-50">
                    Перенести в эту кампанию
                  </button>
                  <button type="button" onClick={() => { void deleteBase(b); }} disabled={busy}
                    title="Удалить базу вместе с контактами"
                    className="p-1 rounded-lg text-gray-400 hover:text-rose-600 hover:bg-rose-50 transition cursor-pointer disabled:opacity-50">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* =================== CAMPAIGN PROXIES TAB =================== */

/**
 * Прокси отвечает дольше этого — формально жив, практически бесполезен: на
 * таких аккаунт получает таймауты уже в боевом цикле. Поэтому «жив за 9 секунд»
 * красим не зелёным, а жёлтым.
 */
const SLOW_PROXY_MS = 3000;

/** Задержка человеческим языком: до секунды — миллисекунды, дальше — секунды. */
function formatLatency(ms: number | null): string {
  if (ms == null) return '—';
  return ms < 1000 ? `${ms} мс` : `${(ms / 1000).toFixed(1)} с`;
}

/** Что случилось с самим прокси — словом, по статусу проверки. */
function proxyVerdictWord(r: ProxyCheckResult): string {
  if (r.proxy_ok) return 'жив';
  if (r.status === 'bad_url') return 'строку не разобрать';
  if (r.status === 'proxy_rejected') return 'не пускает';
  if (r.status === 'proxy_dead') return 'не отвечает';
  return 'проверка сорвалась';
}

/**
 * Один из двух вердиктов проверки прокси.
 *
 * Вердикта именно два, и они стоят рядом не для симметрии: «прокси мёртв» и
 * «прокси жив, но Telegram через него не проходит» — это разные действия.
 * Первое лечится заменой у поставщика, второе значит, что прокси заблокирован
 * в Telegram, и аккаунты на нём тихо перестанут работать.
 */
function ProxyVerdict({
  label,
  verdict,
  ok,
  latencyMs,
  skipped,
}: {
  label: string;
  verdict: string;
  ok: boolean;
  latencyMs: number | null;
  /** До этой проверки не дошли — например, туннель не пробовали на мёртвом прокси. */
  skipped?: boolean;
}) {
  const slow = ok && latencyMs != null && latencyMs >= SLOW_PROXY_MS;
  const cls = skipped
    ? 'bg-gray-100 text-gray-500'
    : ok
      ? slow ? 'bg-amber-50 text-amber-700' : 'bg-emerald-50 text-emerald-700'
      : 'bg-rose-50 text-rose-700';
  return (
    <span
      className={`rounded-md px-1.5 py-0.5 ${cls}`}
      title={slow ? 'Отвечает, но слишком медленно для боевой рассылки' : undefined}
    >
      {label}: {verdict}
      {latencyMs != null && ` · ${formatLatency(latencyMs)}`}
    </span>
  );
}

function CampaignProxiesTab({ campaignId }: { campaignId: string }) {
  const [proxies, setProxies] = useState<OutreachProxy[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [showBulk, setShowBulk] = useState(false);
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [bulkText, setBulkText] = useState('');
  const [saving, setSaving] = useState(false);
  /** Previously errors were ignored — authFetch does not throw on 4xx/5xx, so users saw "nothing happened". */
  const [proxyError, setProxyError] = useState<string | null>(null);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [checking, setChecking] = useState(false);
  /**
   * Секунды с начала проверки. Проверка идёт одним запросом на сервере, и
   * прогресса по одному прокси у нас нет — но сорок штук занимают до минуты, и
   * без бегущего счётчика экран выглядит зависшим.
   */
  const [checkElapsed, setCheckElapsed] = useState(0);
  /** Ответ проверки: по строке на прокси плюс те, что не нашлись в кампании. */
  const [checkRun, setCheckRun] = useState<
    { rows: ProxyCheckResult[]; missing: number; checkedAt: string } | null
  >(null);

  const proxyIds = useMemo(() => proxies.map(p => p.id), [proxies]);
  const { selectedIds, isSelected, toggle, setAll, clear } = useRowSelection(proxyIds);

  /** Итог по каждому прокси — чтобы строка списка показала его без перезагрузки. */
  const checkById = useMemo(() => {
    const map = new Map<string, ProxyCheckResult>();
    checkRun?.rows.forEach((r) => map.set(r.id, r));
    return map;
  }, [checkRun]);

  // Счётчик заводим таймером, а не сразу в эффекте: обнуление делает сама
  // проверка перед стартом, чтобы не дёргать состояние синхронно в эффекте.
  useEffect(() => {
    if (!checking) return;
    const started = Date.now();
    const timer = setInterval(() => setCheckElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [checking]);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await authFetch(`${API_BASE}/proxies?campaign_id=${campaignId}`);
    if (res.ok) {
      const d = await res.json() as { items: OutreachProxy[] };
      setProxies(d.items);
    }
    setLoading(false);
  }, [campaignId]);

  useEffect(() => { queueMicrotask(() => { void load(); }); }, [load]);

  const addProxy = async () => {
    if (!url.trim()) return;
    setSaving(true);
    setProxyError(null);
    try {
      const res = await authFetch(`${API_BASE}/proxies`, {
        method: 'POST',
        body: JSON.stringify({ campaign_id: campaignId, url: url.trim(), name: name.trim() }),
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => null)) as { error?: string } | null;
        setProxyError(errBody?.error ?? `Ошибка сервера (${res.status})`);
        return;
      }
      setUrl(''); setName(''); setShowAdd(false);
      void load();
    } finally {
      setSaving(false);
    }
  };

  const addBulk = async () => {
    const lines = bulkText.split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length) return;
    setSaving(true);
    setProxyError(null);
    try {
      for (let i = 0; i < lines.length; i++) {
        const res = await authFetch(`${API_BASE}/proxies`, {
          method: 'POST',
          body: JSON.stringify({ campaign_id: campaignId, url: lines[i], name: '' }),
        });
        if (!res.ok) {
          const errBody = (await res.json().catch(() => null)) as { error?: string } | null;
          setProxyError(
            `Строка ${i + 1}: ${errBody?.error ?? `ошибка ${res.status}`}. Остальные строки не загружены.`,
          );
          return;
        }
      }
      setBulkText(''); setShowBulk(false);
      void load();
    } finally {
      setSaving(false);
    }
  };

  /**
   * Проверить выбранные прокси: жив ли сам прокси и доходит ли через него
   * Telegram.
   *
   * Одним запросом на всю пачку: проверка сетевая, сервер гоняет её пачками сам,
   * а сорок отдельных запросов из браузера только растянули бы то же самое.
   * Список после проверки не перечитываем — ответ и есть результат.
   */
  const checkSelected = async () => {
    const ids = selectedIds;
    if (!ids.length) return;
    setProxyError(null);
    setCheckRun(null);
    setCheckElapsed(0);
    setChecking(true);
    try {
      const res = await authFetch(`${API_BASE}/proxies/check`, {
        method: 'POST',
        body: JSON.stringify({ campaign_id: campaignId, proxy_ids: ids }),
      });
      const body = (await res.json().catch(() => null)) as
        | { items?: ProxyCheckResult[]; checked_at?: string; missing_ids?: string[]; error?: string }
        | null;
      // Отказ ручки — не вердикт по прокси: он ничего не говорит ни о прокси, ни
      // о Telegram, поэтому едет в общую красную плашку вкладки, а не в итоги.
      if (!res.ok || !body?.items) {
        setProxyError(body?.error ?? `Не удалось проверить прокси (HTTP ${res.status})`);
        return;
      }
      // Порядок ответа нам не обещан, а оператор ищет строки там, где выделял.
      const byId = new Map(body.items.map((r) => [r.id, r]));
      setCheckRun({
        rows: ids.map((id) => byId.get(id)).filter((r): r is ProxyCheckResult => Boolean(r)),
        missing: body.missing_ids?.length ?? 0,
        checkedAt: body.checked_at ?? new Date().toISOString(),
      });
    } catch (e) {
      setProxyError(`Проверка не дошла до сервера: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setChecking(false);
    }
  };

  const toggleActive = async (id: string, current: boolean) => {
    await authFetch(`${API_BASE}/proxies/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ is_active: !current }),
    });
    void load();
  };

  const deleteProxy = async (id: string) => {
    if (!confirm('Удалить прокси? Аккаунты с этим прокси будут отвязаны.')) return;
    await authFetch(`${API_BASE}/proxies/${id}`, { method: 'DELETE' });
    void load();
  };

  const deleteSelected = async () => {
    const ids = selectedIds;
    if (!ids.length) return;
    if (!confirm(`Удалить прокси: ${ids.length}? Аккаунты с этими прокси будут отвязаны.`)) return;
    setBulkDeleting(true);
    setProxyError(null);
    try {
      const res = await authFetch(`${API_BASE}/proxies/bulk`, {
        method: 'DELETE',
        body: JSON.stringify({ campaign_id: campaignId, ids }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => null)) as { error?: string } | null;
        setProxyError(d?.error ?? `Не удалось удалить (${res.status})`);
        return;
      }
      clear();
      void load();
    } finally {
      setBulkDeleting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <span className="text-sm font-medium text-gray-700">
          Прокси кампании <span className="text-gray-400 font-normal">({proxies.length})</span>
        </span>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => { setShowBulk(!showBulk); setShowAdd(false); setProxyError(null); }}
            className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-4 py-2 text-xs font-medium text-gray-700 hover:border-indigo-300 hover:bg-indigo-50 transition cursor-pointer">
            Массовое добавление
          </button>
          <button type="button" onClick={() => { setShowAdd(!showAdd); setShowBulk(false); setProxyError(null); }}
            className="inline-flex items-center gap-1.5 rounded-full bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700 hover:shadow-md transition cursor-pointer">
            <Plus className="h-3.5 w-3.5" /> Добавить
          </button>
        </div>
      </div>

      {/* Без привязки к showAdd/showBulk: ошибка массового удаления приходит при
          закрытых формах и иначе была бы не видна вообще. */}
      {proxyError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {proxyError}
        </div>
      )}

      {showAdd && (
        <div className="rounded-lg border border-gray-200 p-4 space-y-3 bg-gray-50">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="space-y-1">
              <span className="text-[11px] font-medium text-gray-500">URL прокси</span>
              <input value={url} onChange={e => setUrl(e.target.value)} placeholder="http://user:pass@host:port"
                className="block w-full rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs outline-none focus:border-indigo-400" />
            </label>
            <label className="space-y-1">
              <span className="text-[11px] font-medium text-gray-500">Название (необязательно)</span>
              <input value={name} onChange={e => setName(e.target.value)} placeholder="Proxy 1"
                className="block w-full rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs outline-none focus:border-indigo-400" />
            </label>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => { void addProxy(); }} disabled={saving || !url.trim()}
              className="rounded-full bg-indigo-600 px-5 py-2 text-xs font-semibold text-white hover:bg-indigo-700 transition disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer">
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Сохранить'}
            </button>
            <button type="button" onClick={() => setShowAdd(false)}
              className="rounded-full border border-gray-200 px-4 py-2 text-xs text-gray-500 hover:bg-gray-100 transition cursor-pointer">Отмена</button>
          </div>
        </div>
      )}

      {showBulk && (
        <div className="rounded-lg border border-gray-200 p-4 space-y-3 bg-gray-50">
          <p className="text-xs text-gray-500">Введите по одному URL прокси на строку:</p>
          <textarea value={bulkText} onChange={e => setBulkText(e.target.value)} rows={5}
            placeholder={'http://user:pass@host:port\nпо одному URL на строку'}
            className="block w-full rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs outline-none focus:border-indigo-400 resize-y font-mono" />
          <div className="flex gap-2">
            <button type="button" onClick={() => { void addBulk(); }} disabled={saving || !bulkText.trim()}
              className="rounded-full bg-indigo-600 px-5 py-2 text-xs font-semibold text-white hover:bg-indigo-700 transition disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer">
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Добавить'}
            </button>
            <button type="button" onClick={() => setShowBulk(false)}
              className="rounded-full border border-gray-200 px-4 py-2 text-xs text-gray-500 hover:bg-gray-100 transition cursor-pointer">Отмена</button>
          </div>
        </div>
      )}

      <BulkActionsBar
        selectedCount={selectedIds.length}
        deleting={bulkDeleting}
        onClear={clear}
        onDelete={() => { void deleteSelected(); }}
        checking={checking}
        canCheck
        onCheck={() => { void checkSelected(); }}
        checkLabel={checking
          ? `Проверяю прокси (${selectedIds.length})… ${checkElapsed} с`
          : `Проверить прокси (${selectedIds.length})`}
        checkTitle="Проверить два раза подряд: отвечает ли сам прокси и открывается ли через него туннель до Telegram"
      />

      {/* Проверка сетевая и небыстрая: сорок прокси — около минуты. Молчащая
          кнопка со спиннером на минуту читается как «всё зависло». */}
      {checking && (
        <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-indigo-500" />
          Проверяю прокси: {selectedIds.length}. Идёт {checkElapsed} с — на сорок прокси уходит около
          минуты, вкладку можно не трогать.
        </div>
      )}

      {checkRun && checkRun.rows.length > 0 && (
        <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600">
          <div className="flex items-start justify-between gap-3">
            <span>
              Проверено прокси: {checkRun.rows.length} в{' '}
              {new Date(checkRun.checkedAt).toLocaleString('ru-RU', {
                day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
              })}
              . Слева — отвечает ли сам прокси, справа — доходит ли через него Telegram:
            </span>
            <button type="button" onClick={() => setCheckRun(null)} className="cursor-pointer text-gray-400 hover:text-gray-600">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <ul className="mt-2 space-y-1.5">
            {checkRun.rows.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-1.5">
                <span className="font-medium text-gray-800">{r.name || 'без названия'}</span>
                <ProxyVerdict
                  label="прокси"
                  verdict={proxyVerdictWord(r)}
                  ok={r.proxy_ok}
                  latencyMs={r.proxy_latency_ms}
                />
                <ProxyVerdict
                  label="Telegram"
                  verdict={r.telegram_ok ? 'доходит' : r.proxy_ok ? 'не доходит' : 'не проверяли'}
                  ok={r.telegram_ok}
                  latencyMs={r.telegram_latency_ms}
                  skipped={!r.proxy_ok && !r.telegram_ok}
                />
                {/* Технический код — для инженера в логах, словами — оператору. */}
                <span className="text-gray-400">({r.status})</span>
                {r.reason && <span className="text-gray-500">{r.reason}</span>}
              </li>
            ))}
          </ul>
          {/* Прокси удалили в другой вкладке, пока оператор выбирал строки. */}
          {checkRun.missing > 0 && (
            <div className="mt-2 text-gray-500">
              Не нашлись в кампании: {checkRun.missing} — список на экране устарел, обновите страницу.
            </div>
          )}
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 py-8 text-sm text-gray-400"><Loader2 className="h-4 w-4 animate-spin" />Загрузка...</div>
      ) : proxies.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-200 p-8 text-center">
          <Network className="mx-auto h-8 w-8 text-gray-300 mb-2" />
          <p className="text-xs text-gray-400">Нет прокси. Добавьте для этой кампании.</p>
        </div>
      ) : (
        <div className="divide-y divide-gray-100 rounded-xl border border-gray-200 bg-white overflow-hidden">
          <div className="grid grid-cols-[32px_1fr_80px_40px] gap-4 px-4 py-2 text-[11px] font-medium text-gray-400 bg-gray-50 items-center">
            <SelectAllCheckbox total={proxies.length} selectedCount={selectedIds.length} onChange={setAll} />
            <span>URL / Название</span><span>Активен</span><span />
          </div>
          {proxies.map(p => {
            const check = checkById.get(p.id);
            return (
            <div
              key={p.id}
              className={`grid grid-cols-[32px_1fr_80px_40px] gap-4 items-center px-4 py-2.5 ${isSelected(p.id) ? 'bg-indigo-50/60' : ''}`}
            >
              <input
                type="checkbox"
                checked={isSelected(p.id)}
                onChange={() => toggle(p.id)}
                aria-label={`Выбрать ${p.name || p.url}`}
                className="h-3.5 w-3.5 cursor-pointer accent-indigo-600"
              />
              <div className="min-w-0">
                {p.name && <p className="text-xs font-medium text-gray-800">{p.name}</p>}
                <p className="text-xs text-gray-500 truncate font-mono">{p.url}</p>
                {/* Итог последней проверки прямо в строке: список не
                    перечитываем, показываем то, что ответила проверка. */}
                {check && (
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px]">
                    <ProxyVerdict
                      label="прокси"
                      verdict={proxyVerdictWord(check)}
                      ok={check.proxy_ok}
                      latencyMs={check.proxy_latency_ms}
                    />
                    <ProxyVerdict
                      label="Telegram"
                      verdict={check.telegram_ok ? 'доходит' : check.proxy_ok ? 'не доходит' : 'не проверяли'}
                      ok={check.telegram_ok}
                      latencyMs={check.telegram_latency_ms}
                      skipped={!check.proxy_ok && !check.telegram_ok}
                    />
                  </div>
                )}
              </div>
              <button type="button" onClick={() => { void toggleActive(p.id, p.is_active); }}
                className={`rounded-full px-2.5 py-1 text-[10px] font-medium transition cursor-pointer w-fit ${p.is_active ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}>
                {p.is_active ? 'Да' : 'Нет'}
              </button>
              <button type="button" onClick={() => { void deleteProxy(p.id); }}
                className="p-1.5 rounded-lg text-gray-400 hover:text-rose-600 hover:bg-rose-50 transition cursor-pointer">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* =================== CAMPAIGN REPORT TAB =================== */

interface ReportResponse {
  report: {
    weeks: Array<{
      period: string; chats: number | null; contacts: number; delivered: number;
      anyReplies: number; targetReplies: number; blocks: number; conversion: number | null;
    }>;
    total: ReportResponse['report']['weeks'][number];
    leads: Array<{
      sourceChat: string; criterion: string; nickname: string; offerSentAt: string;
      offerNumber: string; quality: string; handedOverAt: string;
    }>;
    offers: Array<{
      offerNumber: string; offer: string; channel: string; language: string;
      status: string; deadline: string; comment: string; conclusions: string;
    }>;
  };
}

/** `YYYY-MM-DD` для <input type="date"> в московском времени. */
function toDateInput(ms: number): string {
  const d = new Date(ms + 3 * 3_600_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Отчёт к договору: три раздела формы, выгрузка в XLSX.
 *
 * По умолчанию — текущий месяц с первого числа по сегодня включительно. Отчёт
 * чаще всего смотрят «что накопилось в этом месяце», и открывать его на уже
 * закрытой прошлой неделе значило бы прятать свежие дни. Даты можно менять —
 * форма допускает и длинный период с накоплением недельных строк.
 *
 * Колонки, которых в данных нет (номер оффера, критерий отбора, качество лида,
 * дата передачи клиенту), отдаются пустыми и заполняются руками уже в файле.
 * Показывать вместо них догадку было бы хуже пустоты: цифры уходят клиенту.
 */
function CampaignReportTab({ campaignId }: { campaignId: string }) {
  const [{ from, to }, setPeriod] = useState(() => {
    // Первое число текущего месяца собираем из частей московской даты, а не
    // арифметикой по миллисекундам: длина месяца разная, и вычитать «столько-то
    // суток» пришлось бы с оглядкой на февраль.
    const now = Date.now();
    const msk = new Date(now + 3 * 3_600_000);
    const month = String(msk.getUTCMonth() + 1).padStart(2, '0');
    return {
      from: `${msk.getUTCFullYear()}-${month}-01`,
      // Сегодня — и поле, и API трактуют верхнюю границу включительно
      // (`range()` ниже сам добавляет сутки).
      to: toDateInput(now),
    };
  });
  const [data, setData] = useState<ReportResponse['report'] | null>(null);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Границы запроса: `to` в поле включительный, в API — исключающий. */
  const range = useCallback(() => {
    const fromIso = `${from}T00:00:00+03:00`;
    const toIso = new Date(new Date(`${to}T00:00:00+03:00`).getTime() + 86_400_000).toISOString();
    return `from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`;
  }, [from, to]);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await authFetch(`${API_BASE}/campaigns/${campaignId}/report?${range()}`);
      const body = (await res.json().catch(() => null)) as (ReportResponse & { error?: string }) | null;
      if (!res.ok) {
        setError(body?.error ?? `Не удалось собрать отчёт (${res.status})`);
        return;
      }
      setData(body?.report ?? null);
    } finally { setLoading(false); }
  }, [campaignId, range]);

  const download = async () => {
    setDownloading(true); setError(null);
    try {
      const res = await authFetch(`${API_BASE}/campaigns/${campaignId}/report?${range()}&format=xlsx`);
      if (!res.ok) {
        setError(`Не удалось выгрузить файл (${res.status})`);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `otchet-${from}_${to}.xlsx`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } finally { setDownloading(false); }
  };

  const cell = 'px-2 py-1.5 text-xs text-gray-700 border border-gray-200';
  const head = 'px-2 py-1.5 text-[11px] font-medium text-gray-500 border border-gray-200 bg-gray-50 text-left';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="space-y-1">
          <span className="block text-[11px] font-medium text-gray-500">Период с</span>
          <input type="date" value={from} onChange={(e) => setPeriod((p) => ({ ...p, from: e.target.value }))}
            className="rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-xs text-gray-800 outline-none focus:border-indigo-400" />
        </label>
        <label className="space-y-1">
          <span className="block text-[11px] font-medium text-gray-500">по (включительно)</span>
          <input type="date" value={to} onChange={(e) => setPeriod((p) => ({ ...p, to: e.target.value }))}
            className="rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-xs text-gray-800 outline-none focus:border-indigo-400" />
        </label>
        <button type="button" onClick={() => { void load(); }} disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-full bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700 transition disabled:opacity-50 cursor-pointer">
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileSpreadsheet className="h-3.5 w-3.5" />}
          Собрать отчёт
        </button>
        <button type="button" onClick={() => { void download(); }} disabled={downloading || !data}
          title={data ? 'Скачать в форме договора' : 'Сначала соберите отчёт'}
          className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-4 py-2 text-xs font-medium text-gray-700 hover:border-indigo-300 hover:bg-indigo-50 transition disabled:opacity-50 cursor-pointer">
          {downloading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
          Скачать XLSX
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</div>
      )}

      {!data && !loading && (
        <p className="text-xs text-gray-400">
          По умолчанию стоит текущий месяц: с первого числа по сегодня включительно. Нажмите «Собрать отчёт».
        </p>
      )}

      {data && (
        <div className="space-y-6">
          <div className="space-y-2">
            <h3 className="text-sm font-medium text-gray-800">1. Рассылка и реакция</h3>
            <div className="overflow-x-auto">
              <table className="min-w-full border-collapse">
                <thead>
                  <tr>
                    <th className={head}>Период</th>
                    <th className={head}>Обработано чатов</th>
                    <th className={head}>Подобрано контактов</th>
                    <th className={head}>Доставлено</th>
                    <th className={head}>Любых ответов</th>
                    <th className={head}>Целевых ответов</th>
                    <th className={head}>Блокировок</th>
                    <th className={head}>Конверсия, %</th>
                  </tr>
                </thead>
                <tbody>
                  {[...data.weeks, data.total].map((w, i) => (
                    <tr key={w.period + i} className={w.period === 'Итого' ? 'font-medium bg-gray-50' : ''}>
                      <td className={cell}>{w.period}</td>
                      <td className={cell}>{w.chats === null ? '—' : w.chats}</td>
                      <td className={cell}>{w.contacts}</td>
                      <td className={cell}>{w.delivered}</td>
                      <td className={cell}>{w.anyReplies}</td>
                      <td className={cell}>{w.targetReplies}</td>
                      <td className={cell}>{w.blocks}</td>
                      <td className={cell}>{w.conversion === null ? '—' : w.conversion}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* Оговорки, без которых цифрам нельзя доверять вслепую. Уходят
                клиенту — лучше знать заранее, что именно они означают. */}
            <p className="text-[10px] text-gray-400">
              Блокировки — только выявленные: мы узнаём о них, когда пытаемся написать
              повторно, поэтому заблокировавшие сразу после первого касания сюда не попадают.
              Обработанные чаты — уникальные чаты-источники контактов, загруженных в базы этой
              кампании за период. Целевые ответы отнесены к неделе последнего сообщения диалога:
              момент срабатывания триггера в базе не хранится.
            </p>
            {[...data.weeks, data.total].every((w) => w.chats === null) && (
              <p className="text-[11px] text-amber-600">
                «Обработано чатов» — прочерк: в файлах базы этой кампании нет колонки
                «Ссылка на источник», и портал не знает, из каких чатов взяты контакты.
                Добавьте её при следующей загрузке базы — TG-парсер отдаёт её в выгрузке, —
                и цифра начнёт считаться сама. За прошлые недели впишите её в файл руками.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <h3 className="text-sm font-medium text-gray-800">
              2. Лиды <span className="font-normal text-gray-400">({data.leads.length})</span>
            </h3>
            {data.leads.length === 0 ? (
              <p className="text-xs text-gray-400">За период целевых ответов не было.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full border-collapse">
                  <thead>
                    <tr>
                      <th className={head}>Чат/группа</th>
                      <th className={head}>Критерий отбора</th>
                      <th className={head}>Никнейм</th>
                      <th className={head}>Дата оффера</th>
                      <th className={head}>№ оффера</th>
                      <th className={head}>Качество лида</th>
                      <th className={head}>Передан клиенту</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.leads.map((l, i) => (
                      <tr key={l.nickname + i}>
                        <td className={cell}>{l.sourceChat || <span className="text-gray-300">—</span>}</td>
                        <td className={cell} />
                        <td className={cell}>{l.nickname}</td>
                        <td className={cell}>{l.offerSentAt}</td>
                        <td className={cell} />
                        <td className={cell} />
                        <td className={cell} />
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="text-[10px] text-gray-400">
              Пустые колонки портал не заполняет — их дописывают руками в выгруженном файле.
              Чат-источник берётся из колонки «Ссылка на источник» загруженного файла базы;
              если её при загрузке не было, останется пусто.
            </p>
          </div>

          <div className="space-y-2">
            <h3 className="text-sm font-medium text-gray-800">3. План работ и офферы</h3>
            <div className="overflow-x-auto">
              <table className="min-w-full border-collapse">
                <thead>
                  <tr>
                    <th className={head}>№</th>
                    <th className={head}>Оффер</th>
                    <th className={head}>Канал/чат</th>
                    <th className={head}>Язык</th>
                    <th className={head}>Статус</th>
                    <th className={head}>Дедлайн</th>
                    <th className={head}>Комментарий</th>
                    <th className={head}>Выводы с цифрами</th>
                  </tr>
                </thead>
                <tbody>
                  {data.offers.map((o, i) => (
                    <tr key={o.offer + i}>
                      <td className={cell} />
                      <td className={cell}>{o.offer}</td>
                      <td className={cell} />
                      <td className={cell} />
                      <td className={cell} />
                      <td className={cell} />
                      <td className={cell} />
                      <td className={cell}>{o.conclusions}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[10px] text-gray-400">
              Строка на каждую базу кампании. Цифры считает портал, остальное — из плана работ.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

/* =================== CAMPAIGN VIEW (5 tabs) =================== */
const TABS = [
  // Сводка первой и стартовой: открывая кампанию, оператор спрашивает «как
  // дела», а не «какие тут настройки» — их заводят один раз и больше не трогают.
  { id: 'dashboard', label: 'Сводка', icon: LayoutDashboard },
  { id: 'settings', label: 'Настройки', icon: Settings },
  { id: 'accounts', label: 'Аккаунты', icon: Users },
  { id: 'bases', label: 'Базы', icon: Database },
  { id: 'warmup', label: 'Прогрев', icon: Flame },
  { id: 'proxies', label: 'Прокси', icon: Network },
  { id: 'logs', label: 'Логи', icon: ScrollText },
  { id: 'dialogs', label: 'Диалоги', icon: MessageCircle },
  { id: 'processed', label: 'Обработанные', icon: UserCheck },
  { id: 'report', label: 'Отчёт', icon: FileSpreadsheet },
] as const;

function CampaignView({ campaign, onUpdate, onDelete }: {
  campaign: OutreachCampaign;
  onUpdate: () => void;
  onDelete: (id: string) => void;
}) {
  const [tab, setTab] = useState<string>('dashboard');
  const [actionLoading, setActionLoading] = useState(false);
  const [stopping, setStopping] = useState(false);
  const stoppingRef = useRef(false);
  const [refetchJobId, setRefetchJobId] = useState<string | null>(null);
  const [refetchProgress, setRefetchProgress] = useState<{
    total: number; done: number; fetched: number; errors: number;
    last_username: string | null; last_messages: number;
    status: string;
  } | null>(null);

  useEffect(() => {
    if (!stopping) return;
    const poll = setInterval(async () => {
      try {
        const res = await authFetch(`${API_BASE}/campaigns/${campaign.id}/status`);
        if (!res.ok) return;
        const body = await res.json() as { status: string; is_running: boolean };
        if (!body.is_running || body.status === 'stopped') {
          setStopping(false);
          stoppingRef.current = false;
          onUpdate();
        }
      } catch { /* ignore */ }
    }, 3000);
    return () => clearInterval(poll);
  }, [stopping, campaign.id, onUpdate]);

  useEffect(() => {
    if (!refetchJobId) return;
    const poll = setInterval(async () => {
      try {
        const res = await authFetch(`${API_BASE}/jobs/${refetchJobId}`);
        if (!res.ok) return;
        const job = await res.json() as {
          status: string;
          progress?: { total: number; done: number; fetched: number; errors: number; last_username: string | null; last_messages: number } | null;
        };
        setRefetchProgress({
          total: job.progress?.total ?? 0,
          done: job.progress?.done ?? 0,
          fetched: job.progress?.fetched ?? 0,
          errors: job.progress?.errors ?? 0,
          last_username: job.progress?.last_username ?? null,
          last_messages: job.progress?.last_messages ?? 0,
          status: job.status,
        });
        if (job.status === 'completed' || job.status === 'failed') {
          setTimeout(() => {
            setRefetchJobId(null);
            setRefetchProgress(null);
            onUpdate();
          }, 3000);
        }
      } catch { /* ignore */ }
    }, 2000);
    return () => clearInterval(poll);
  }, [refetchJobId, onUpdate]);

  const doAction = async (action: 'start' | 'stop' | 'refetch') => {
    setActionLoading(true);
    const res = await authFetch(`${API_BASE}/campaigns/${campaign.id}/${action}`, { method: 'POST' });
    if (action === 'stop') {
      setStopping(true);
      stoppingRef.current = true;
    }
    if (action === 'refetch') {
      try {
        const body = await res.json() as { id?: string; empty_count?: number; message?: string; error?: string };
        if (body.error) {
          alert(`Ошибка: ${body.error}`);
        } else if (body.empty_count === 0) {
          alert('Нет диалогов с пустыми сообщениями');
        } else if (body.id) {
          setRefetchJobId(body.id);
          setRefetchProgress({ total: body.empty_count ?? 0, done: 0, fetched: 0, errors: 0, last_username: null, last_messages: 0, status: 'pending' });
        }
      } catch { /* ignore parse errors */ }
    }
    setActionLoading(false);
    onUpdate();
  };

  const saveSettings = async (openai: OpenAISettings, telegram: TelegramSettings) => {
    await authFetch(`${API_BASE}/campaigns/${campaign.id}`, {
      method: 'PUT',
      body: JSON.stringify({ openai_settings: openai, telegram_settings: telegram }),
    });
    onUpdate();
  };

  const displayStatus = stopping ? 'stopping' : campaign.status;
  const st = STATUS_LABELS[displayStatus] ?? STATUS_LABELS.stopped;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-bold text-gray-900">{campaign.name}</h2>
          <span className={`rounded-full px-2.5 py-0.5 text-[10px] font-semibold ${st.cls}`}>{st.label}</span>
        </div>
        <div className="flex items-center gap-2">
          {campaign.status !== 'running' && !stopping ? (
            <button type="button" onClick={() => void doAction('start')}
              disabled={actionLoading || campaign.status === 'warming'}
              title={campaign.status === 'warming'
                ? 'Идёт прогрев аккаунтов — остановите его на вкладке «Прогрев»'
                : undefined}
              className="inline-flex items-center gap-1.5 rounded-full bg-emerald-600 px-5 py-2.5 text-xs font-semibold text-white hover:bg-emerald-700 hover:shadow-md transition disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer">
              {actionLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
              Запустить
            </button>
          ) : stopping ? (
            <button type="button" disabled
              className="inline-flex items-center gap-1.5 rounded-full bg-amber-500 px-5 py-2.5 text-xs font-semibold text-white opacity-80 cursor-not-allowed">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Останавливается...
            </button>
          ) : (
            <button type="button" onClick={() => void doAction('stop')} disabled={actionLoading}
              className="inline-flex items-center gap-1.5 rounded-full bg-rose-600 px-5 py-2.5 text-xs font-semibold text-white hover:bg-rose-700 hover:shadow-md transition disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer">
              {actionLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3.5 w-3.5" />}
              Остановить
            </button>
          )}
          {campaign.status !== 'running' && !stopping && (
            <button type="button" onClick={() => void doAction('refetch')} disabled={actionLoading || !!refetchJobId}
              title="Перезагрузить пустые диалоги из Telegram"
              className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-4 py-2.5 text-xs font-medium text-gray-700 hover:border-indigo-300 hover:bg-indigo-50 hover:shadow-sm transition disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer">
              {actionLoading || refetchJobId ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Refetch
            </button>
          )}
          <button type="button" onClick={() => onDelete(campaign.id)}
            className="rounded-full border border-gray-200 p-2.5 text-gray-400 hover:text-rose-600 hover:border-rose-300 hover:bg-rose-50 transition cursor-pointer">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {refetchProgress && (
        <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-4 space-y-2">
          <div className="flex items-center justify-between text-xs font-medium text-indigo-800">
            <span className="flex items-center gap-2">
              {refetchProgress.status === 'completed' ? (
                <span className="text-emerald-600">✓ Refetch завершён</span>
              ) : refetchProgress.status === 'failed' ? (
                <span className="text-rose-600">✗ Refetch ошибка</span>
              ) : (
                <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Загрузка диалогов...</>
              )}
            </span>
            <span>{refetchProgress.done} / {refetchProgress.total}</span>
          </div>
          <div className="h-2 rounded-full bg-indigo-100 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${
                refetchProgress.status === 'completed' ? 'bg-emerald-500' :
                refetchProgress.status === 'failed' ? 'bg-rose-500' : 'bg-indigo-500'
              }`}
              style={{ width: `${refetchProgress.total > 0 ? (refetchProgress.done / refetchProgress.total) * 100 : 0}%` }}
            />
          </div>
          <div className="flex items-center justify-between text-[11px] text-indigo-600">
            <span>
              {refetchProgress.last_username && refetchProgress.last_messages > 0
                ? `@${refetchProgress.last_username} — ${refetchProgress.last_messages} сообщ.`
                : refetchProgress.last_username
                  ? `@${refetchProgress.last_username} — пусто`
                  : 'Ожидание...'}
            </span>
            <span>
              {refetchProgress.fetched > 0 && <span className="text-emerald-600 mr-2">+{refetchProgress.fetched} загружено</span>}
              {refetchProgress.errors > 0 && <span className="text-rose-500">{refetchProgress.errors} ошибок</span>}
            </span>
          </div>
        </div>
      )}

      <div className="flex gap-1 border-b border-gray-200">
        {TABS.map(t => {
          const Icon = t.icon;
          return (
            <button key={t.id} type="button" onClick={() => setTab(t.id)}
              className={`inline-flex items-center gap-1.5 px-5 py-3 text-xs font-medium transition border-b-2 -mb-px cursor-pointer ${tab === t.id ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-50'}`}>
              <Icon className="h-3.5 w-3.5" />
              {t.label}
            </button>
          );
        })}
      </div>

      <div>
        {tab === 'dashboard' && <DashboardTab campaignId={campaign.id} />}
        {tab === 'settings' && <SettingsTab campaign={campaign} onSave={saveSettings} />}
        {tab === 'accounts' && (
          <CampaignAccountsTab
            campaignId={campaign.id}
            campaignStatus={campaign.status}
            firstTouchPerDay={campaign.telegram_settings?.first_touch_per_account_per_day ?? 0}
          />
        )}
        {tab === 'bases' && <CampaignBasesTab campaignId={campaign.id} />}
        {tab === 'proxies' && <CampaignProxiesTab campaignId={campaign.id} />}
        {tab === 'warmup' && (
          <WarmupTab campaignId={campaign.id} campaignStatus={campaign.status} />
        )}
        {tab === 'logs' && <LogsTab campaignId={campaign.id} />}
        {tab === 'dialogs' && <DialogsTab campaignId={campaign.id} />}
        {tab === 'processed' && <ProcessedTab campaignId={campaign.id} />}
        {tab === 'report' && <CampaignReportTab campaignId={campaign.id} />}
      </div>
    </div>
  );
}

/* =================== FORM HELPERS =================== */
function Field({ label, value, onChange, placeholder, type }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string }) {
  return (
    <label className="space-y-1">
      <span className="text-[11px] font-medium text-gray-500">{label}</span>
      <input type={type ?? 'text'} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        className="block w-full rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-xs text-gray-800 outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400" />
    </label>
  );
}

function FieldNum({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label className="space-y-1">
      <span className="text-[11px] font-medium text-gray-500">{label}</span>
      <input type="number" value={value} onChange={e => onChange(Number(e.target.value))}
        className="block w-full rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-xs text-gray-800 outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400" />
    </label>
  );
}

function FieldArea({ label, value, onChange, rows, placeholder }: { label: string; value: string; onChange: (v: string) => void; rows?: number; placeholder?: string }) {
  return (
    <label className="space-y-1">
      <span className="text-[11px] font-medium text-gray-500">{label}</span>
      <textarea value={value} onChange={e => onChange(e.target.value)} rows={rows ?? 3} placeholder={placeholder}
        className="block w-full rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-xs text-gray-800 outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400 resize-y" />
    </label>
  );
}

function RangeField({ label, value, onChange }: { label: string; value: [number, number]; onChange: (v: [number, number]) => void }) {
  return (
    <label className="space-y-1">
      <span className="text-[11px] font-medium text-gray-500">{label}</span>
      <div className="flex items-center gap-1">
        <input type="number" value={value[0]} onChange={e => onChange([Number(e.target.value), value[1]])}
          className="block w-full rounded-lg border border-gray-200 bg-gray-50 px-2 py-1.5 text-xs text-gray-800 outline-none focus:border-indigo-400" />
        <span className="text-gray-400 text-xs">—</span>
        <input type="number" value={value[1]} onChange={e => onChange([value[0], Number(e.target.value)])}
          className="block w-full rounded-lg border border-gray-200 bg-gray-50 px-2 py-1.5 text-xs text-gray-800 outline-none focus:border-indigo-400" />
      </div>
    </label>
  );
}

/* =================== CAMPAIGNS SECTION =================== */
function CampaignsSection() {
  const [campaigns, setCampaigns] = useState<OutreachCampaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);

  const fetchCampaigns = useCallback(async () => {
    const token = await getAccessToken();
    if (!token) { setLoading(false); return; }
    const res = await authFetch(`${API_BASE}/campaigns`);
    if (res.ok) {
      const d = await res.json() as { items: OutreachCampaign[] };
      setCampaigns(d.items);
      // Открываем первую кампанию сразу, чтобы инструмент не встречал пустым
      // экраном с одними табами — в 99% случаев следующий клик всё равно был
      // по ней. Функциональная форма, а не чтение selectedId: иначе он попал бы
      // в зависимости useCallback, тот бы пересоздавался на каждый выбор
      // кампании и перезапускал загрузку списка. `prev ??` заодно бережёт
      // ручной выбор при фоновых обновлениях списка.
      setSelectedId((prev) => prev ?? d.items[0]?.id ?? null);
    }
    setLoading(false);
  }, []);

  useEffect(() => { queueMicrotask(() => { void fetchCampaigns(); }); }, [fetchCampaigns]);

  const createCampaign = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    const res = await authFetch(`${API_BASE}/campaigns`, {
      method: 'POST',
      body: JSON.stringify({ name: newName.trim() }),
    });
    if (res.ok) {
      const c = await res.json() as OutreachCampaign;
      setSelectedId(c.id);
      setNewName(''); setShowCreate(false);
    }
    setCreating(false);
    void fetchCampaigns();
  };

  const deleteCampaign = async (id: string) => {
    // С 12.08.2026 базы принадлежат кампании и уходят вместе с ней по cascade.
    // Раньше они переживали удаление, поэтому прежний текст «это действие
    // необратимо» больше не описывает масштаб потери.
    if (!confirm(
      'Удалить кампанию? Вместе с ней будут удалены её базы контактов и вся история отправок по ним.'
      + ' Это действие необратимо.',
    )) return;
    await authFetch(`${API_BASE}/campaigns/${id}`, { method: 'DELETE' });
    if (selectedId === id) setSelectedId(null);
    void fetchCampaigns();
  };

  const selected = campaigns.find(c => c.id === selectedId) ?? null;

  return (
    <div className="w-full text-left">
      <div className="min-w-0 w-full space-y-6">
        {/* Header */}
        <header className="space-y-2">
          <div className="inline-flex items-center gap-2 rounded-full border border-indigo-100 bg-indigo-50 px-3 py-1 text-xs font-medium text-indigo-700">
            <MessageSquareMore className="h-3.5 w-3.5" />
            TG Аутрич
          </div>
          <h1 className="text-2xl font-bold text-gray-900">Telegram Аутрич</h1>
          <p className="max-w-2xl text-sm text-gray-500">
            Массовый B2B-аутрич через Telegram. Управление кампаниями, автоответы GPT, квалификация лидов.
          </p>
        </header>

        {/* Campaign selector */}
        <div className="flex items-center gap-3 flex-wrap">
          {campaigns.map(c => {
            const st = STATUS_LABELS[c.status] ?? STATUS_LABELS.stopped;
            return (
              <button key={c.id} type="button" onClick={() => setSelectedId(c.id)} title={st.label}
                className={`inline-flex items-center gap-2 rounded-full px-5 py-2.5 text-xs font-medium transition border cursor-pointer ${selectedId === c.id ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-gray-700 border-gray-200 hover:border-indigo-300 hover:bg-indigo-50 hover:shadow-sm'}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${statusDotClass(c.status)}`} />
                {c.name}
              </button>
            );
          })}
          <button type="button" onClick={() => setShowCreate(!showCreate)}
            className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-gray-300 px-5 py-2.5 text-xs font-medium text-gray-500 hover:border-indigo-300 hover:text-indigo-600 hover:bg-indigo-50/50 transition cursor-pointer">
            <Plus className="h-3.5 w-3.5" /> Новая кампания
          </button>
        </div>

        {showCreate && (
          <div className="flex items-center gap-2 rounded-lg border border-gray-200 p-3">
            <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Название кампании"
              className="flex-1 rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-xs outline-none focus:border-indigo-400"
              onKeyDown={e => { if (e.key === 'Enter') void createCampaign(); }} />
            <button type="button" onClick={createCampaign} disabled={creating}
              className="rounded-full bg-indigo-600 px-5 py-2.5 text-xs font-semibold text-white hover:bg-indigo-700 hover:shadow-md transition disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer">
              {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Создать'}
            </button>
            <button type="button" onClick={() => setShowCreate(false)} className="p-2 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition cursor-pointer"><X className="h-4 w-4" /></button>
          </div>
        )}

        {loading && (
          <div className="flex items-center justify-center py-12 text-gray-400">
            <Loader2 className="h-5 w-5 animate-spin mr-2" />Загрузка...
          </div>
        )}

        {!loading && campaigns.length === 0 && !showCreate && (
          <div className="rounded-2xl border border-gray-200 bg-white/90 p-8 text-center">
            <MessageSquareMore className="mx-auto h-10 w-10 text-gray-300 mb-3" />
            <p className="text-sm text-gray-500">Нет кампаний. Создайте первую для начала работы.</p>
          </div>
        )}

        {selected && (
          // key на id кампании: без него React переиспускает то же поддерево
          // при переключении, и локальный стейт вкладок (черновики настроек,
          // выбранный аккаунт, подгруженные логи, номер вкладки) остаётся от
          // предыдущей кампании — видно только новое название и статус, а
          // «внутренности» показывают чужие данные. Пересоздание поддерева при
          // смене id — самый честный сброс.
          <CampaignView
            key={selected.id}
            campaign={selected}
            onUpdate={() => void fetchCampaigns()}
            onDelete={deleteCampaign}
          />
        )}
      </div>
    </div>
  );
}

/* =================== MAIN PAGE =================== */
export default function TgOutreachPage() {
  return (
    <div className="w-full text-left">
      <CampaignsSection />
    </div>
  );
}
