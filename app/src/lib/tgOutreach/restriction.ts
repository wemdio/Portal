/**
 * Что именно Telegram сделал с аккаунтом: придержал на время или забанил
 * насовсем.
 *
 * До этого все ограничения назывались одним словом. В журнале кампании стояло
 * «Telegram ограничил аккаунт (PEER_FLOOD)», в карточке — «забанен», и разница
 * между «подождать до утра» и «номер сгорел, покупайте новый» не читалась
 * нигде. Для оператора это два совершенно разных действия, а решение он
 * принимал вслепую.
 *
 * Разделять их можно ровно по коду ошибки — Telegram называет причину сам,
 * никуда дополнительно ходить не нужно. Здесь этот разбор собран в одном месте
 * и покрыт тестами: порядок проверок значим, а цена ошибки — выброшенный живой
 * аккаунт или, наоборот, месяц ожидания снятия бана, который не снимется.
 *
 * Чего этот модуль НЕ знает: когда закончится спам-блок (PEER_FLOOD). Срок
 * известен только самому Telegram, и спросить его можно лишь у @SpamBot —
 * отдельным сообщением от имени аккаунта. Поэтому здесь честное «срок
 * неизвестен», а не выдуманная дата.
 */

export type RestrictionKind =
  /** Аккаунт не вернуть: номер забанен или удалён. */
  | 'permanent'
  /** Пройдёт само. Иногда с точным сроком, иногда — нет. */
  | 'temporary'
  /** Заморозка Telegram: часть методов запрещена, снимается по обращению. */
  | 'frozen';

export interface Restriction {
  kind: RestrictionKind;
  /** Код Telegram, как он пришёл. Нужен инженеру, не продавцу. */
  code: string;
  /** Короткая плашка: «бан навсегда», «пауза 2 часа», «спам-блок». */
  label: string;
  /** Одна фраза: что это значит и что с этим делать. */
  detail: string;
  /** Когда закончится, ISO. null — Telegram срока не назвал. */
  until: string | null;
}

/** «45 секунд», «12 минут», «2 часа», «3 дня» — для срока из FLOOD_WAIT. */
export function humanDuration(seconds: number): string {
  const plural = (n: number, one: string, few: string, many: string) => {
    const mod100 = n % 100;
    const mod10 = n % 10;
    if (mod100 > 10 && mod100 < 20) return many;
    if (mod10 === 1) return one;
    if (mod10 >= 2 && mod10 <= 4) return few;
    return many;
  };
  if (seconds < 60) return `${seconds} ${plural(seconds, 'секунду', 'секунды', 'секунд')}`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} ${plural(minutes, 'минуту', 'минуты', 'минут')}`;
  const hours = Math.round(seconds / 3600);
  if (hours < 24) return `${hours} ${plural(hours, 'час', 'часа', 'часов')}`;
  const days = Math.round(seconds / 86_400);
  return `${days} ${plural(days, 'день', 'дня', 'дней')}`;
}

/**
 * Сколько секунд просит подождать Telegram.
 *
 * Два написания, и оба встречаются в проде. Голый код `FLOOD_WAIT_120` приходит
 * обычным RPCError. А типизированные ошибки gramJS переписывают текст на
 * человеческий — `A wait of 120 seconds is required (caused by …)`, и самого
 * кода в строке уже нет. Матч только по коду пропускал бы половину случаев.
 */
function waitSeconds(msg: string): number | null {
  const byCode = /(?:FLOOD_WAIT|SLOWMODE_WAIT|FLOOD_PREMIUM_WAIT)_(\d+)/i.exec(msg);
  if (byCode) return Number(byCode[1]);
  const byText = /a wait of (\d+) seconds? is required/i.exec(msg);
  if (byText) return Number(byText[1]);
  return null;
}

/**
 * Разобрать сообщение об ошибке в «временно / навсегда», или null — если
 * ограничения тут нет вовсе.
 *
 * `null` — это важный ответ, а не отсутствие ответа. Отозванная сессия и
 * конфликт входа выглядят в логах не менее страшно, но баном не являются:
 * аккаунт цел, его нужно перезалить. Назвать это баном значит отправить
 * рабочий номер в мусор.
 *
 * @param now Точка отсчёта для срока. Снаружи — чтобы функция осталась чистой.
 */
export function classifyRestriction(rawMessage: string, now: number): Restriction | null {
  const msg = rawMessage ?? '';
  const upper = msg.toUpperCase();

  /**
   * Порядок значим. `INPUT_USER_DEACTIVATED` — про СОБЕСЕДНИКА, который удалил
   * свой аккаунт, и содержит в себе `USER_DEACTIVATED`. Не отсечь его первым —
   * и каждый удалённый контакт читался бы как бан нашего аккаунта.
   */
  if (upper.includes('INPUT_USER_DEACTIVATED')) return null;

  if (upper.includes('USER_DEACTIVATED_BAN')) {
    return {
      kind: 'permanent',
      code: 'USER_DEACTIVATED_BAN',
      label: 'бан навсегда',
      detail: 'Telegram забанил номер за спам. Это окончательно: аккаунт не разблокируется сам и не чинится перезаливкой сессии — нужен новый номер.',
      until: null,
    };
  }
  if (upper.includes('PHONE_NUMBER_BANNED')) {
    return {
      kind: 'permanent',
      code: 'PHONE_NUMBER_BANNED',
      label: 'бан навсегда',
      detail: 'Номер забанен в Telegram — войти под ним больше нельзя. Нужен новый номер.',
      until: null,
    };
  }
  if (upper.includes('USER_DEACTIVATED')) {
    return {
      kind: 'permanent',
      code: 'USER_DEACTIVATED',
      label: 'аккаунт удалён',
      detail: 'Аккаунт удалён или деактивирован — восстановить его нельзя. Нужен новый номер.',
      until: null,
    };
  }

  if (/FROZEN_METHOD_INVALID|FROZEN/i.test(upper)) {
    return {
      kind: 'frozen',
      code: 'FROZEN_METHOD_INVALID',
      label: 'заморозка',
      detail: 'Telegram заморозил часть действий аккаунта. Само не проходит и баном не является: снимается обращением в поддержку из самого аккаунта.',
      until: null,
    };
  }

  const seconds = waitSeconds(msg);
  if (seconds !== null) {
    const code = /SLOWMODE_WAIT/i.test(upper) ? 'SLOWMODE_WAIT' : 'FLOOD_WAIT';
    return {
      kind: 'temporary',
      code,
      label: `пауза ${humanDuration(seconds)}`,
      detail: `Временное ограничение: Telegram просит подождать ${humanDuration(seconds)}. Пройдёт само, аккаунт цел — это защита от частых запросов, а не бан.`,
      until: new Date(now + seconds * 1000).toISOString(),
    };
  }

  if (upper.includes('PEER_FLOOD')) {
    return {
      kind: 'temporary',
      code: 'PEER_FLOOD',
      label: 'спам-блок',
      /**
       * Срок Telegram здесь не называет, и подставлять «обычно неделя» нельзя:
       * оператор запомнит дату как обещание. Честнее сказать, где узнать точно.
       */
      detail: 'Временное ограничение: Telegram закрыл аккаунту переписку с незнакомыми — выдаётся за частые сообщения новым людям. Срок не сообщается; узнать и оспорить можно у @SpamBot из самого аккаунта. Это не бан, аккаунт цел.',
      until: null,
    };
  }

  if (upper.includes('USER_BANNED_IN_CHANNEL')) {
    return {
      kind: 'temporary',
      code: 'USER_BANNED_IN_CHANNEL',
      label: 'запрет писать в чаты',
      detail: 'Временное ограничение: аккаунту закрыли отправку сообщений в группы и каналы. На личную переписку обычно не влияет.',
      until: null,
    };
  }

  return null;
}

/**
 * Ограничение из флага самого аккаунта (`user.restricted` + `restrictionReason`).
 *
 * Отдельно от разбора ошибки: сюда попадает то, что Telegram рассказывает о
 * себе в ответ на getMe, а не то, чем он ответил на неудачное действие. Текст
 * причины приходит от Telegram и человеку понятен, поэтому его и показываем —
 * но срок он тоже не содержит, так что называем ограничение временным только
 * когда сам Telegram говорит о бане отдельно.
 */
export function restrictionFromProfile(reasons: string[]): Restriction {
  const text = reasons.filter(Boolean).join('; ').trim();
  const permanent = /\bban\b|banned|навсегда|перманент/i.test(text);
  return {
    kind: permanent ? 'permanent' : 'temporary',
    code: 'USER_RESTRICTED',
    label: permanent ? 'бан навсегда' : 'ограничен',
    detail: permanent
      ? `Telegram забанил аккаунт${text ? `: ${text}` : ''}. Восстановить нельзя — нужен новый номер.`
      : `Telegram ограничил аккаунт${text ? `: ${text}` : ''}. Срок не сообщается; проверить и оспорить можно у @SpamBot из самого аккаунта.`,
    until: null,
  };
}

/**
 * Строка для журнала и карточки аккаунта.
 *
 * «Временное» и «постоянное» стоят в начале и заглавными: это единственное, что
 * оператор обязан прочитать, даже если пробежит строку глазами.
 */
export function describeRestriction(r: Restriction, tzOffsetHours = 3): string {
  const head = r.kind === 'permanent'
    ? 'ПОСТОЯННЫЙ бан'
    : r.kind === 'frozen'
      ? 'ЗАМОРОЗКА'
      : 'ВРЕМЕННОЕ ограничение';

  const until = r.until
    ? ` Снимется примерно в ${new Date(new Date(r.until).getTime() + tzOffsetHours * 3_600_000)
        .toISOString()
        .slice(11, 16)}.`
    : '';

  return `${head} (${r.code}) — ${r.label}. ${r.detail}${until}`;
}
