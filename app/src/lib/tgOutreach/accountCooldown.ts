/**
 * Пауза аккаунта после лимита Telegram.
 *
 * Один и тот же cooldown_until читает круг кампании: пока дата в будущем,
 * аккаунт пропускается целиком. Раньше паузу ставили только на флуде ответа,
 * а PEER_FLOOD на первом касании оставлял номер в ротации.
 *
 * Сам срок до 01.09.2026 брался вслепую — из настройки кампании, всегда одной
 * и той же. На экране это выглядело как «кулдаун до завтра», который каждый
 * день переезжал на новое завтра: пауза истекала, круг брал аккаунт, Telegram
 * снова отвечал спам-блоком, номер парковался ещё на сутки. За неделю так
 * крутилось по 30-40 аккаунтов в день, и ни один из них не отлежался.
 *
 * Настоящий срок Telegram называет ровно в двух местах: в тексте FLOOD_WAIT
 * (там он есть сразу) и в личке @SpamBot (её приходится спрашивать). Здесь оба
 * источника сведены в одно решение — `decideCooldown`.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { TelegramClient } from 'telegram';
import { askSpamBot, describeSpamBotVerdict, type SpamBotVerdict } from './accountCheck';
import { classifyRestriction, describeRestriction, type Restriction } from './restriction';

type LogFn = (level: 'info' | 'warning' | 'error', msg: string) => void;

export function isFloodLimitReason(reason: string): boolean {
  const u = reason.toUpperCase();
  return u.includes('PEER_FLOOD') || u.includes('FLOOD_WAIT') || u.includes('SLOWMODE_WAIT');
}

export function cooldownUntilIso(hours: number, now = new Date()): string {
  return new Date(now.getTime() + hours * 3600_000).toISOString();
}

export async function writeAccountCooldown(
  db: SupabaseClient,
  accountId: string,
  untilIso: string,
): Promise<string | null> {
  const { error } = await db
    .from('tg_outreach_accounts')
    .update({ cooldown_until: untilIso })
    .eq('id', accountId);
  return error?.message ?? null;
}

/**
 * Запас после названного срока.
 *
 * Выйти из паузы ровно в минуту снятия — значит первым же действием проверить,
 * не соврал ли Telegram. Проверка стоит нового спам-блока, поэтому четверть
 * часа сверху.
 */
const SPAMBOT_MARGIN_MS = 15 * 60_000;

/**
 * Сколько держим номер, которому @SpamBot назвал ограничение без срока.
 *
 * Это и есть «бессрочно»: так бот отвечает, когда снятие не запланировано и
 * ждать нечего. Выпускать такой номер в круг каждые сутки — ровно тот холостой
 * цикл, ради которого всё и переделывалось. Но и выключать его автоматически
 * нельзя: ограничение снимают по обращению из самого аккаунта, и решение
 * «списать номер» остаётся за оператором. Неделя — компромисс: из ротации
 * выпадает, из списка не исчезает.
 */
export const INDEFINITE_PARK_HOURS = 7 * 24;

export interface CooldownDecision {
  untilIso: string;
  /** Кто назвал срок: сам Telegram в ошибке, @SpamBot или настройка кампании. */
  source: 'telegram' | 'spambot' | 'settings';
  /** Ограничение без названного срока — номер вне ротации до разбора руками. */
  indefinite: boolean;
  /** Откуда взялся срок — одной фразой для журнала и карточки. */
  note: string;
}

/**
 * Выбрать срок паузы из того, что известно.
 *
 * Правило намеренно одностороннее: **пауза не может стать короче настройки
 * кампании**. Названный срок применяется, только если он дальше — иначе правка
 * умела бы разгонять отправку, а разгон и есть причина спам-блоков. То есть
 * FLOOD_WAIT на 30 секунд суточную паузу не отменяет, а ответ бота «до 5
 * сентября» — отменяет.
 *
 * Чистая функция: время приходит параметром, в Telegram она не ходит.
 */
export function decideCooldown(args: {
  /** Разобранная ошибка Telegram. У FLOOD_WAIT в ней уже есть точный срок. */
  restriction: Restriction | null;
  /** Ответ @SpamBot, если его спрашивали. */
  verdict: SpamBotVerdict | null;
  /** «Пауза после ограничения» из настроек кампании, часы. */
  fallbackHours: number;
  now?: Date;
}): CooldownDecision {
  const now = args.now ?? new Date();
  const hours = args.fallbackHours > 0 ? args.fallbackHours : 24;
  const settingsIso = cooldownUntilIso(hours, now);

  let best: { untilIso: string; source: CooldownDecision['source']; indefinite: boolean } = {
    untilIso: settingsIso,
    source: 'settings',
    indefinite: false,
  };
  const consider = (iso: string, source: CooldownDecision['source'], indefinite = false) => {
    if (new Date(iso).getTime() > new Date(best.untilIso).getTime()) {
      best = { untilIso: iso, source, indefinite };
    }
  };
  const withMargin = (iso: string) => new Date(new Date(iso).getTime() + SPAMBOT_MARGIN_MS).toISOString();

  if (args.restriction?.until) consider(withMargin(args.restriction.until), 'telegram');

  const v = args.verdict;
  if (v?.kind === 'limited') {
    if (v.until) consider(withMargin(v.until), 'spambot');
    else consider(cooldownUntilIso(INDEFINITE_PARK_HOURS, now), 'spambot', true);
  }

  const note = (() => {
    if (best.indefinite) {
      return `${describeSpamBotVerdict(v as SpamBotVerdict)} Держим номер вне ротации ` +
        `${INDEFINITE_PARK_HOURS / 24} дней: выпускать его в круг каждые сутки бессмысленно, ` +
        `такое ограничение снимают обращением из самого аккаунта.`;
    }
    if (best.source === 'spambot') return describeSpamBotVerdict(v as SpamBotVerdict);
    if (best.source === 'telegram') return 'Срок назвал сам Telegram в тексте ошибки.';
    if (v?.kind === 'free') {
      return `@SpamBot: ограничений на аккаунте нет — Telegram, похоже, придержал только скорость отправки. ` +
        `Пауза ${hours}ч по настройке кампании.`;
    }
    if (v?.kind === 'limited') {
      return `${describeSpamBotVerdict(v)} Это ближе, чем пауза кампании, поэтому оставляем ${hours}ч.`;
    }
    if (v?.kind === 'unknown') {
      return `${describeSpamBotVerdict(v)} Срок берём из настройки кампании — ${hours}ч.`;
    }
    return `@SpamBot не ответил, срока Telegram не назвал — пауза ${hours}ч по настройке кампании.`;
  })();

  return { ...best, note };
}

export interface ParkOutcome extends CooldownDecision {
  /** Диагноз целиком: что случилось и откуда взялся срок. Для журнала и карточки. */
  diagnosis: string;
}

/**
 * Увести аккаунт в паузу после ограничения Telegram — со сроком, а не вслепую.
 *
 * Соединение аккаунта уже открыто у вызывающего, поэтому @SpamBot спрашиваем
 * прямо здесь: одно сообщение `/start` и четыре секунды ожидания против суток
 * холостого простоя. У забаненного номера не спрашиваем — там вопрос не в
 * сроке, а в замене номера; у FLOOD_WAIT тоже не спрашиваем — срок уже в
 * тексте ошибки.
 *
 * Никогда не бросает: парковка защищает круг и падать не имеет права.
 */
export async function parkAccountAfterLimit(args: {
  db: SupabaseClient;
  /** Живое соединение аккаунта. Без него спросить некого — паркуем по настройке. */
  client?: TelegramClient | null;
  account: {
    id: string;
    cooldown_until?: string | null;
    check_status?: string | null;
    check_detail?: string | null;
  };
  /** «Пауза после ограничения» из настроек кампании, часы. */
  hours: number;
  /** Код или причина, как её назвал вызывающий. */
  reason: string;
  /** Полный текст ошибки Telegram — по нему видно, временное это или навсегда. */
  rawError?: string;
  log: LogFn;
  now?: Date;
}): Promise<ParkOutcome | null> {
  const now = args.now ?? new Date();
  const restriction = classifyRestriction(args.rawError ?? args.reason, now.getTime());

  const needBot = Boolean(args.client) && restriction?.kind !== 'permanent' && !restriction?.until;
  const verdict = needBot ? await askSpamBot(args.client as TelegramClient) : null;

  const decision = decideCooldown({ restriction, verdict, fallbackHours: args.hours, now });

  const err = await writeAccountCooldown(args.db, args.account.id, decision.untilIso);
  if (err) {
    args.log('error', `Не смог сохранить паузу аккаунта в базе — ${err}`);
    return null;
  }
  args.account.cooldown_until = decision.untilIso;

  const humanRestriction = restriction
    ? describeRestriction(restriction)
    : verdict?.kind === 'limited'
      ? 'ВРЕМЕННОЕ ограничение — Telegram закрыл аккаунту переписку с незнакомыми.'
      : `Ограничение отправки (${args.reason}).`;
  const diagnosis = `${humanRestriction} ${decision.note}`;

  /**
   * Диагноз пишем и в карточку аккаунта, а не только в ленту журнала: журнал за
   * сутки — это тысячи строк, и «Telegram ограничил аккаунт» тонет в них к утру,
   * а вопрос «что с этим номером» оператор задаёт, глядя на список аккаунтов.
   *
   * Временное ограничение НЕ пишется как `banned`: спам-блок проходит сам, и
   * списывать из-за него живой номер незачем. И наоборот — статус не трогаем
   * вовсе, если ограничения не подтвердил ни Telegram, ни бот: назвать
   * ограниченным исправный аккаунт значит спрятать его от рассылки без причины.
   */
  const status = restriction?.kind === 'permanent'
    ? 'banned'
    : restriction || verdict?.kind === 'limited'
      ? 'restricted'
      : null;
  if (status) {
    const { error: diagErr } = await args.db
      .from('tg_outreach_accounts')
      .update({
        check_status: status,
        check_detail: diagnosis.slice(0, 500),
        checked_at: now.toISOString(),
      })
      .eq('id', args.account.id);
    if (diagErr) {
      args.log('warning', `Не смог записать диагноз ограничения в карточку аккаунта — ${diagErr.message}`);
    } else {
      args.account.check_status = status;
      args.account.check_detail = diagnosis.slice(0, 500);
    }
  }

  return { ...decision, diagnosis };
}

/**
 * Ограничение снято делом: аккаунт только что написал незнакомому человеку.
 *
 * Спам-блок в профиле не виден, и «отпустило» Telegram не сообщает никак —
 * единственное доказательство, что переписка с незнакомыми открыта, это
 * успешно ушедшее первое касание. Без этой отметки статус «ограничен» висел бы
 * в карточке вечно, потому что поставить его есть кому, а снять — некому.
 */
export async function clearRestrictionAfterSend(
  db: SupabaseClient,
  account: { id: string; check_status?: string | null; check_detail?: string | null },
): Promise<void> {
  if (account.check_status !== 'restricted') return;
  const detail = 'жив: ограничение снято — первое касание незнакомому человеку ушло';
  const { error } = await db
    .from('tg_outreach_accounts')
    .update({ check_status: 'ok', check_detail: detail, checked_at: new Date().toISOString() })
    .eq('id', account.id);
  if (error) return;
  account.check_status = 'ok';
  account.check_detail = detail;
}
