/**
 * ENG: алерты команде про ОТПРАВКУ без сотрудника (S2) — в health-бот, тем же
 * транспортом, что opsAlert / sendingPool (sendWorkerAlert).
 *
 * ВИДЫ:
 *  - 'access_requested' — клиент упёрся в выключатель отправки аккаунта
 *    (engSendingAccess): запуск или «Start sending» отказаны. Сделать —
 *    включить отправку в /admin/users. Клиенту сказано «sending for your
 *    account is being enabled by our team», и это правда, только пока этот
 *    алерт уходит;
 *  - 'access_unavailable' — выключатель не читается (миграция 20261011_0002 не
 *    применена, сбой БД): отказан ЛЮБОЙ запуск и старт ENG-клиента;
 *  - 'mailboxes_mismatch' — в живой кампании адреса не из ящиков пула проекта
 *    или кампания в другом воркспейсе (поправленный пресет, правка у
 *    рассыльщика, запуск сотрудника чужим пресетом): кампания НЕ стартована;
 *  - 'needs_attention' — кампания у рассыльщика в отрицательном статусе
 *    (аккаунт заблокирован, ящики нездоровы, защита от bounce) или её нет:
 *    не стартована, клиенту сказано «message Support»;
 *  - 'pause_failed' — клиент нажал Pause (кнопкой или посреди старта), а часть
 *    кампаний рассыльщик не поставил на паузу: они МОГУТ продолжать отправку
 *    против желания клиента. `stateRecorded` — записано ли желание «пауза»:
 *    только тогда паузу держат доводка при чтении статуса и ночной гейт.
 *    `cause: 'state_unreadable'` — паузу поставил старт сам: желание клиента
 *    после цикла старта не прочиталось (fail-closed);
 *  - 'revoke_pause_failed' — сотрудник выключил отправку аккаунта (или
 *    выключение застало старт посреди цикла, или чтение статуса нашло
 *    отправляющую кампанию выключенного аккаунта), а часть кампаний рассыльщик
 *    не остановил: своя тема и свой совет — клиент паузу не просил, и
 *    повторную паузу делает только чтение статуса, пока клиент смотрит кабинет.
 *    `launchUnread` — запись запуска не прочиталась при выключении: его
 *    кампании на паузу не ставились вовсе;
 *  - 'setup_unavailable' — старт отказан из-за настройки на нашей стороне, а
 *    не из-за кампании: таблицы пула нет, ящики проекта в разных воркспейсах,
 *    ящик проекта стоит у другого клиента, пресет записи о запуске не клиента /
 *    его нет / его воркспейс не настроен.
 *    Клиент видит «problem on our side — message Support»; совет — по причине.
 *
 * ДЕДУПЛИКАЦИЯ — в памяти процесса, окно HE_OPS_TEAM_FIX_REPEAT_MS (1 ч) по
 * ключу (вид + аккаунт / шаблон / причина). Окно держится, только если
 * сообщение принял хоть один чат; иначе снимается, и следующий такой же случай
 * пишет снова. После рестарта процесса та же новость может прийти ещё раз.
 *
 * НЕ БРОСАЕТ и не держит вызывающего дольше HE_OPS_SEND_TIMEOUT_MS; роуты
 * зовут без ожидания (`void`).
 */

import { sendWorkerAlert } from '@/lib/telegram/workerAlert';
import { HE_OPS_SEND_TIMEOUT_MS, HE_OPS_TEAM_FIX_REPEAT_MS, heOpsReasonText } from './opsAlert';

export type HeEngSendingAlert =
  | {
      kind: 'access_requested';
      userId: string;
      email: string | null;
      projectId: string | null;
      /** Где упёрся: запуск шаблона или кнопка старта. */
      via: 'launch' | 'start';
    }
  | { kind: 'access_unavailable'; reason: string }
  | {
      kind: 'mailboxes_mismatch';
      projectId: string;
      templateId: string;
      campaignIds: string[];
      reason: string;
    }
  | {
      kind: 'needs_attention';
      projectId: string;
      templateId: string;
      campaigns: Array<{ id: string; status: number | null }>;
    }
  | {
      kind: 'pause_failed';
      projectId: string;
      templateId: string;
      campaignIds: string[];
      /**
       * Желание клиента «пауза» записано в he_eng_launch_sending: тогда эту
       * паузу держат доводка при чтении статуса и ночной гейт добора; false —
       * не держит никто.
       */
      stateRecorded: boolean;
      /**
       * 'state_unreadable' — паузу поставил не клиент, а старт (шаг 9
       * engCampaignSending): желание клиента после цикла не прочиталось, и
       * стартованное ставится на паузу fail-closed. Нет поля — Pause клиента.
       */
      cause?: 'state_unreadable';
    }
  | {
      kind: 'revoke_pause_failed';
      projectId: string;
      templateId: string | null;
      campaignIds: string[];
      /**
       * Где: выключение сотрудником (/admin/users), старт, который выключение
       * застало посреди цикла, или фоновое чтение статуса.
       */
      where: 'staff_turn_off' | 'start' | 'status_read';
      /**
       * Запись запуска не прочиталась — его кампании на паузу не ставились
       * вовсе (`campaignIds` пуст: какие они, неизвестно).
       */
      launchUnread?: boolean;
    }
  | {
      kind: 'setup_unavailable';
      projectId: string;
      templateId: string;
      cause: HeEngSendingSetupCause;
      /** Подробность (воркспейсы, причина) — команде. */
      detail: string;
    };

/**
 * Почему старт отказан настройкой на нашей стороне ('setup_unavailable'):
 *  - pool_missing — таблицы пула нет (миграция 20261011_0001 не применена);
 *  - pool_mixed — ящики проекта в пуле лежат в разных воркспейсах;
 *  - preset_missing — в записи о запуске нет preset_id;
 *  - preset_foreign — пресет записи о запуске не пресет клиента (запуск
 *    сотрудника другим пресетом) или его больше нет;
 *  - workspace_unconfigured — воркспейс пресета не настроен в окружении portal;
 *  - mailbox_in_use — ящик пула проекта стоит в пресете другого клиента или в
 *    живом запуске RU-кабинета (sendingPool.findHeSendingPoolMailboxUses).
 */
export type HeEngSendingSetupCause =
  | 'pool_missing'
  | 'pool_mixed'
  | 'mailbox_in_use'
  | 'preset_missing'
  | 'preset_foreign'
  | 'workspace_unconfigured';

const ALERT_WORKER_ID = 'hypothesis-engine · ENG';

/** Что клиент видит при отказе старта настройкой (engSendingAccess.ENG_SENDING_ACCESS_PROBLEM_TEXT). */
const CLIENT_SETUP_PROBLEM_TEXT =
  'Campaigns cannot be started right now because of a problem on our side. Message Support.';

const TELL_CLIENT_TO_START =
  'напишите клиенту, чтобы нажал кнопку старта в блоке отправки вертикали («Start sending», «Start the rest» или ' +
  '«Resume» — какая стоит)';

/**
 * Что клиент видит при выключенной отправке аккаунта — пояснение блока
 * отправки вертикали в ЛЮБОМ состоянии (engText.engSendingNote; с ним же
 * совпадает отказ старта ENG_SENDING_TURNED_OFF_TEXT).
 */
const CLIENT_TURNED_OFF_TEXT = 'Sending is turned off for your account, so campaigns cannot be started. Message Support.';

const SETUP_ACTION: Record<HeEngSendingSetupCause, string> = {
  pool_missing: `применить миграцию 20261011_0001_he_sending_pool.sql; затем ${TELL_CLIENT_TO_START}`,
  pool_mixed:
    'ящики проекта в пуле лежат в разных воркспейсах — из такого набора кабинет не стартует; оставить проекту ' +
    'ящики одного воркспейса (у запущенного проекта возврат закрыт — только правкой he_sending_pool руками), ' +
    `затем ${TELL_CLIENT_TO_START}`,
  preset_missing:
    'в записи о запуске нет preset_id (запись старого формата) — кабинет эти кампании не стартует никогда; ' +
    'проверить их у рассыльщика и стартовать руками или оставить на паузе и написать клиенту',
  preset_foreign:
    'пресет записи о запуске — не пресет клиента (запуск сотрудника другим пресетом или пресет удалён) — кабинет ' +
    'эти кампании не стартует никогда; проверить ящики кампаний у рассыльщика и стартовать руками или оставить на ' +
    'паузе и написать клиенту',
  workspace_unconfigured:
    'воркспейс пресета клиента не настроен в окружении portal (INSTANTLY_ACCOUNTS_JSON) — добавить его и ' +
    `перезапустить portal, затем ${TELL_CLIENT_TO_START}`,
  mailbox_in_use:
    'ящик пула проекта стоит в чужом пресете или в живом запуске RU-кабинета (подробность выше) — снять его в ' +
    'чужом пресете (/admin/clients/<чужой клиент>/preset) или решить с владельцем, кто остаётся с ящиком, если ' +
    `его уже шлёт RU-кампания; уже отправляющие кампании проекта этот отказ не останавливает; затем ${TELL_CLIENT_TO_START}`,
};

const SETUP_SUBJECT: Record<HeEngSendingSetupCause, string> = {
  pool_missing: 'таблицы пула ящиков нет',
  pool_mixed: 'ящики проекта в разных воркспейсах',
  preset_missing: 'в записи о запуске нет пресета',
  preset_foreign: 'запуск сделан не пресетом клиента',
  workspace_unconfigured: 'воркспейс пресета не настроен',
  mailbox_in_use: 'ящик проекта занят другим клиентом',
};

const REVOKE_WHERE: Record<'staff_turn_off' | 'start' | 'status_read', string> = {
  staff_turn_off: 'выключение отправки аккаунта в /admin/users',
  start: 'выключение застало старт кампаний посреди цикла',
  status_read: 'чтение статуса нашло отправляющую кампанию выключенного аккаунта',
};

const silentUntil = new Map<string, { until: number }>();

function alertKey(alert: HeEngSendingAlert): string {
  switch (alert.kind) {
    case 'access_requested':
      return `access_requested|${alert.userId}`;
    case 'access_unavailable':
      return 'access_unavailable';
    case 'mailboxes_mismatch':
      return `mailboxes_mismatch|${alert.templateId}|${alert.reason}`;
    case 'needs_attention':
      return `needs_attention|${alert.templateId}`;
    case 'pause_failed':
      // Сохранено ли желание и чья пауза — разные новости и разные советы.
      return `pause_failed|${alert.templateId}|${alert.stateRecorded ? 'held' : 'unsaved'}|${alert.cause ?? ''}`;
    case 'revoke_pause_failed':
      return `revoke_pause_failed|${alert.projectId}|${alert.templateId ?? ''}|${alert.where}`;
    case 'setup_unavailable':
      return `setup_unavailable|${alert.templateId}|${alert.cause}`;
  }
}

const STATUS_LABEL: Record<string, string> = {
  '-99': 'аккаунт заблокирован (-99)',
  '-1': 'ящики нездоровы (-1)',
  '-2': 'защита от bounce (-2)',
  null: 'кампании нет у рассыльщика',
};

function alertBody(alert: HeEngSendingAlert): {
  subject: string;
  error: string;
  context: Record<string, string | number | null>;
} {
  switch (alert.kind) {
    case 'access_requested':
      return {
        subject: 'ENG: клиент ждёт включения отправки аккаунта',
        error:
          alert.via === 'launch'
            ? 'запуск шаблона отказан: отправка аккаунта не включена'
            : 'старт кнопкой блока отправки («Start sending», «Start the rest» или «Resume») отказан: отправка ' +
              'аккаунта не включена',
        context: {
          'клиент': alert.userId,
          'почта': alert.email,
          'проект': alert.projectId,
          'клиент видит':
            'Sending for your account is being enabled by our team — this happens once. We will email you when it is on',
          'сделать':
            '/admin/users → клиент → «Включить отправку ENG» (клиенту уйдёт письмо); после этого клиент запускает сам',
        },
      };
    case 'access_unavailable':
      return {
        subject: 'ENG: выключатель отправки не читается — отказан любой запуск и старт ENG-клиента',
        error: heOpsReasonText(alert.reason),
        context: {
          'клиент видит': 'проблема на нашей стороне — напишите в Support',
          'сделать':
            'применить миграцию 20261011_0002_he_eng_sending.sql (в ней выключатель отправки, желание клиента ' +
            '«отправлять / пауза» и кэш статуса кампаний) или проверить БД. Снимать требование ' +
            '(HE_US_SENDING_REQUIRES_ACTIVATION=0) НЕ надо: без миграции отправка всё равно не заработает (желание ' +
            'клиента и кэш статуса не читаются), а снятие убирает одноразовое включение отправки у ВСЕХ ENG-аккаунтов',
        },
      };
    case 'mailboxes_mismatch':
      return {
        subject: 'ENG: кампания не стартована — её ящики не совпадают с ящиками пула проекта',
        error: heOpsReasonText(alert.reason),
        context: {
          'проект': alert.projectId,
          'шаблон': alert.templateId,
          'кампании': alert.campaignIds.join(', ') || null,
          'клиент видит': 'кампании шлют не из ящиков проекта — напишите в Support',
          'сделать':
            'сверить email_list кампании у рассыльщика с ящиками проекта в «Пул ящиков ENG» и пресет клиента ' +
            '(/admin/clients/<клиент>/preset); старт — только ящиками пула проекта; после правки ' +
            TELL_CLIENT_TO_START,
        },
      };
    case 'needs_attention':
      return {
        subject: 'ENG: кампания клиента остановлена у рассыльщика — не стартована',
        error: alert.campaigns
          .map((c) => `${c.id}: ${STATUS_LABEL[String(c.status)] ?? `статус ${String(c.status)}`}`)
          .join('; '),
        context: {
          'проект': alert.projectId,
          'шаблон': alert.templateId,
          'клиент видит': 'Needs attention — message Support',
          'сделать': `проверить ящики проекта и кампанию у рассыльщика; после починки ${TELL_CLIENT_TO_START}`,
        },
      };
    case 'pause_failed': {
      const held = alert.stateRecorded
        ? 'желание клиента «пауза» записано, и чтение статуса кабинетом — дашборд, шаг 5 — ставит такую кампанию ' +
          'на паузу само'
        : 'желание клиента «пауза» НЕ записано (he_eng_launch_sending не пишется или не читается) — эту паузу не ' +
          'держит ни доводка паузы при чтении статуса, ни ночной гейт добора: только ручная пауза у рассыльщика';
      if (alert.cause === 'state_unreadable') {
        return {
          subject: 'ENG: старт не прочитал желание клиента — стартованное ставится на паузу, но часть не встала',
          error: `не на паузе: ${alert.campaignIds.join(', ')}`,
          context: {
            'проект': alert.projectId,
            'шаблон': alert.templateId,
            'клиент видит':
              'Because of a problem on our side we could not confirm that this vertical should keep sending, so we ' +
              'paused the campaigns we were starting, but some of them could not be paused yet and may still be ' +
              'sending — our team is stopping them. Message Support.',
            'сделать': `поставить эти кампании на паузу у рассыльщика руками (${held}); проверить he_eng_launch_sending`,
          },
        };
      }
      const notSaved =
        '«… we could not save that you paused this vertical, so the pause may not hold. Press «Pause» again in a ' +
        'minute; if this keeps happening, message Support.» (без кнопки Pause на карточке — «… Message Support so ' +
        'we can make sure it stays paused.»)';
      const fixState =
        'проверить he_eng_launch_sending (миграция 20261011_0002, БД) и записать шаблону client_state=paused; ' +
        'пока не записано, кнопка старта клиента и доводка паузы его паузу не держат («Launch all» кампании на ' +
        'паузе у рассыльщика не стартует)';
      if (alert.campaignIds.length === 0) {
        // Рассыльщик остановил всё, но Pause клиента не записался.
        return {
          subject: 'ENG: Pause клиента не записался — кампании на паузе у рассыльщика, но желание «пауза» не сохранено',
          error: 'he_eng_launch_sending не записалась и с повтора; все кампании запуска на паузе у рассыльщика',
          context: {
            'проект': alert.projectId,
            'шаблон': alert.templateId,
            'клиент видит': `«Sending is paused, but we could not save that you paused this vertical…» — ${notSaved}`,
            'сделать': fixState,
          },
        };
      }
      return {
        subject: 'ENG: клиент поставил кампании на паузу, но рассыльщик часть не остановил — они могут слать',
        error: `не на паузе: ${alert.campaignIds.join(', ')}`,
        context: {
          'проект': alert.projectId,
          'шаблон': alert.templateId,
          'клиент видит': alert.stateRecorded
            ? 'после «Pause»: «We could not pause N campaigns of this launch, so they may still be sending. Press ' +
              '«Pause» again in a minute; if it keeps failing, message Support.» (без кнопки Pause на карточке — «… ' +
              'Our team is stopping them; message Support if this keeps happening.»); Pause посреди старта: «You paused this ' +
              'vertical while it was starting, but N campaigns could not be paused yet and may still be sending — ' +
              'our team is stopping them.»'
            : `«We could not pause N campaigns of this launch, so they may still be sending, and…» — ${notSaved}`,
          'сделать': alert.stateRecorded
            ? `поставить эти кампании на паузу у рассыльщика руками (клиент хотел паузу; ${held})`
            : `поставить эти кампании на паузу у рассыльщика руками (клиент хотел паузу; ${held}); ${fixState}`,
        },
      };
    }
    case 'revoke_pause_failed':
      return {
        subject: alert.launchUnread
          ? 'ENG: отправка аккаунта выключена, но запись запуска не прочитана — его кампании не ставились на паузу'
          : 'ENG: отправка аккаунта выключена, но рассыльщик часть кампаний не остановил — они могут слать',
        error: alert.launchUnread
          ? 'запись о запуске шаблона не прочиталась — ни одна его кампания на паузу не ставилась'
          : `не на паузе: ${alert.campaignIds.join(', ') || '—'}`,
        context: {
          'проект': alert.projectId,
          'шаблон': alert.templateId,
          'где': REVOKE_WHERE[alert.where],
          'клиент видит': `в блоке отправки вертикали: «${CLIENT_TURNED_OFF_TEXT}»`,
          'сделать': alert.launchUnread
            ? 'найти кампании этого шаблона (launch_info) и поставить их на паузу у рассыльщика руками — кабинет ' +
              'их не остановит: повторную паузу делает только чтение статуса, пока клиент смотрит дашборд или шаг 5'
            : 'поставить эти кампании на паузу у рассыльщика руками — кабинет их не остановит: повторную паузу ' +
              'делает только чтение статуса, пока клиент смотрит дашборд или шаг 5',
        },
      };
    case 'setup_unavailable':
      return {
        subject: `ENG: кампании клиента не стартованы — ${SETUP_SUBJECT[alert.cause]}`,
        error: heOpsReasonText(alert.detail),
        context: {
          'проект': alert.projectId,
          'шаблон': alert.templateId,
          'клиент видит': CLIENT_SETUP_PROBLEM_TEXT,
          'сделать': SETUP_ACTION[alert.cause],
        },
      };
  }
}

/**
 * Сообщить команде. Решение «слать / молчать» — синхронно, до первого await.
 * НЕ БРОСАЕТ.
 */
export function notifyHeEngSending(alert: HeEngSendingAlert, opts: { now?: number } = {}): Promise<void> {
  try {
    const now = opts.now ?? Date.now();
    for (const [key, hold] of silentUntil) {
      if (now >= hold.until) silentUntil.delete(key);
    }
    const key = alertKey(alert);
    const current = silentUntil.get(key);
    if (current && now < current.until) return Promise.resolve();
    const hold = { until: now + HE_OPS_TEAM_FIX_REPEAT_MS };
    silentUntil.set(key, hold);

    const delivered = sendWorkerAlert({ workerId: ALERT_WORKER_ID, ...alertBody(alert) }).catch(() => false);
    void delivered
      .then((accepted) => {
        if (!accepted && silentUntil.get(key) === hold) silentUntil.delete(key);
      })
      .catch(() => undefined);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, HE_OPS_SEND_TIMEOUT_MS);
      (timer as { unref?: () => void }).unref?.();
    });
    return Promise.race([delivered.then(() => undefined), deadline]).then(
      () => {
        if (timer) clearTimeout(timer);
      },
      () => {
        if (timer) clearTimeout(timer);
      },
    );
  } catch (e) {
    console.warn('[he-eng-sending] алерт не собран:', e);
    return Promise.resolve();
  }
}
