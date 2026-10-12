/**
 * ENG: алерты команде про ОТПРАВКУ без сотрудника (S2) — в health-бот, тем же
 * транспортом, что opsAlert / sendingPool (sendWorkerAlert).
 *
 * ВИДЫ:
 *  - 'access_requested' — клиент упёрся в выключатель отправки аккаунта
 *    (engSendingAccess): запуск или «Start sending» отказаны. Сделать —
 *    включить отправку в карточке клиента раздела «Английские клиенты»
 *    (/admin/eng-clients). Клиенту сказано «sending for your account is being
 *    enabled by our team», и это правда, только пока этот алерт уходит;
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
 *  - 'revoke_pause_failed' — сотрудник выключил отправку аккаунта или
 *    заблокировал клиента (или выключение застало старт посреди цикла, или
 *    чтение статуса нашло отправляющую кампанию выключенного либо
 *    заблокированного аккаунта), а часть кампаний рассыльщик не остановил:
 *    своя тема и свой совет — клиент паузу не просил. Повторную паузу делают
 *    повторное нажатие сотрудника в карточке клиента и чтение статуса: пока
 *    клиент смотрит кабинет, а у заблокированного — фоновая проверка воркера.
 *    `launchUnread` — запись запуска не прочиталась при выключении: его
 *    кампании на паузу не ставились вовсе;
 *  - 'block_incomplete' — блокировка ENG-клиента (engAccountBlock) не
 *    остановила часть работы: какие шаги не легли — в тексте. Окно повтора —
 *    своё, HE_ENG_BLOCK_INCOMPLETE_REPEAT_MS по аккаунту: повторное нажатие
 *    через 10 минут, которое снова не довершилось, — снова алерт;
 *  - 'unblock_incomplete' — разблокировка ENG-клиента не подтвердила
 *    остановку, которую повторяет до снятия бана, и бан оставила (если бана
 *    не было — `banBefore` false — оставила отметку блокировки): что не
 *    остановилось — в тексте. Окно — то же, что у 'block_incomplete';
 *  - 'campaigns_unreachable' — блокировка или разблокировка нашла кампании
 *    аккаунта, до которых кабинет не дотягивается (запущены не из кабинета —
 *    инструментом сотрудника чужим пресетом — или воркспейс неизвестен):
 *    они не на паузе, ставит их на паузу человек в Instantly. Снятие
 *    блокировки они не держат (решение S3b). Ключ — аккаунт и где;
 *  - 'block_marker_unreadable' — отметки блокировки (he_eng_account_blocks)
 *    не читаются постоянным сбоем (не блип: например 42501 — нет прав), его
 *    заметил страж джоб воркера или фоновая проверка заблокированных
 *    (engBlockedSweep). Ключ — код сбоя: раз в час на код;
 *  - 'setup_unavailable' — старт отказан из-за настройки на нашей стороне, а
 *    не из-за кампании: таблицы пула нет, ящики проекта в разных воркспейсах,
 *    ящик проекта стоит у другого клиента, пресет записи о запуске не клиента /
 *    его нет / его воркспейс не настроен.
 *    Клиент видит «problem on our side — message Support»; совет — по причине;
 *  - 'auto_launch_stuck' — автозапуск вертикали после «Launch» проекта
 *    (engAutoLaunch) вошёл в состояние, которое без команды или клиента не
 *    сдвинется; алерт — один раз при входе (перепроверка строки его не
 *    повторяет). Сам НЕ продолжит (автозапуск вертикали остановлен и больше
 *    не платит; клиенту письмо «нужно действие», если почта настроена):
 *    6 сбоев подряд на нашей стороне (`server_error`), 3 платных сбоя
 *    (`launch_failed`), брошенные посреди попытки (`abandoned`),
 *    незаконченный запуск не достроился за 3 попытки (`unfinished`),
 *    блокировка аккаунта (`account_blocked`; письма клиенту нет; продолжит
 *    только новое нажатие «Launch» клиентом).
 *    Продолжит сам, когда причину снимут (перепроверка раз в час): отказ
 *    ядра не по гейту (`needs_support`; письмо клиенту), отказ проверки рынка
 *    аккаунта или шаблона (`scope_refused`; у повтора только старта — не
 *    продолжит).
 *
 * ДЕДУПЛИКАЦИЯ — в памяти процесса, окно HE_OPS_TEAM_FIX_REPEAT_MS (1 ч) по
 * ключу (вид + аккаунт / шаблон / причина; у 'block_incomplete' — своё окно,
 * см. выше). Окно держится, только если
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
       * Где: выключение отправки сотрудником, блокировка клиента
       * (engAccountBlock), старт, который выключение застало посреди цикла,
       * или фоновое чтение статуса.
       */
      where: 'staff_turn_off' | 'staff_block' | 'start' | 'status_read';
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
    }
  | {
      kind: 'auto_launch_stuck';
      projectId: string;
      templateId: string;
      /** Код строки автозапуска (engAutoLaunch.HE_ENG_AUTO_LAUNCH_CODES). */
      code: string;
    }
  | {
      kind: 'block_incomplete';
      userId: string;
      email: string | null;
      /** Шаги блокировки, которые не легли, — по-русски, коротко (engAccountBlock). */
      failed: string[];
    }
  | {
      kind: 'unblock_incomplete';
      userId: string;
      email: string | null;
      /** Шаги остановки перед снятием бана, которые не подтвердились, — по-русски, коротко (engAccountBlock). */
      failed: string[];
      /** Бан перед разблокировкой: true — стоял, false — не стоял (держит одна отметка), null — не прочитан. */
      banBefore: boolean | null;
    }
  | {
      kind: 'campaigns_unreachable';
      userId: string;
      email: string | null;
      where: 'block' | 'unblock';
      /** Каждая кампания — одной строкой: имя / id и воркспейс (engAccountBlock). */
      campaigns: string[];
    }
  | {
      kind: 'block_marker_unreadable';
      /** Код Postgres/PostgREST постоянного сбоя чтения (например 42501). */
      code: string;
      /** Подробность сбоя (текст читателя отметки). */
      detail: string;
      /** Кто заметил: страж джобы воркера или фоновая проверка заблокированных. */
      where: 'job_guard' | 'sweep';
    };

/** Окно повтора алерта 'block_incomplete' по аккаунту (решение S3b: 10 минут). */
export const HE_ENG_BLOCK_INCOMPLETE_REPEAT_MS = 10 * 60_000;

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

const REVOKE_WHERE: Record<'staff_turn_off' | 'staff_block' | 'start' | 'status_read', string> = {
  staff_turn_off: 'выключение отправки в карточке клиента (раздел «Английские клиенты»)',
  staff_block: 'блокировка клиента в разделе «Английские клиенты»',
  start: 'выключение отправки или блокировка застали старт кампаний посреди цикла',
  status_read: 'чтение статуса нашло отправляющую кампанию выключенного или заблокированного аккаунта',
};

/**
 * Кто ещё раз поставит на паузу кампании, которые не встали: сам кабинет — только
 * повторным нажатием сотрудника (у заблокированного — и «Разблокировать»: оно
 * ставит кампании на паузу до снятия бана, engAccountBlock) и чтением статуса
 * (engCampaignStatus: пока клиент смотрит дашборд или шаг 3 «Launch»; у
 * заблокированного — фоновая проверка воркера, engBlockedSweep).
 */
const REVOKE_REPEAT_TEXT =
  'сам кабинет повторяет паузу только так: кнопка «Выключить ещё раз / доставить паузу» (или, если клиент ' +
  'заблокирован, «Заблокировать ещё раз / доставить остановку» и «Разблокировать» — до снятия бана) в карточке ' +
  'клиента раздела «Английские клиенты» и ' +
  'чтение статуса — пока клиент смотрит дашборд или шаг 3 «Launch», а у заблокированного клиента — фоновая проверка воркера ' +
  'hypothesis-engine; не ждите их';

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
    case 'auto_launch_stuck':
      return `auto_launch_stuck|${alert.templateId}|${alert.code}`;
    case 'block_incomplete':
      return `block_incomplete|${alert.userId}`;
    case 'unblock_incomplete':
      return `unblock_incomplete|${alert.userId}`;
    case 'campaigns_unreachable':
      return `campaigns_unreachable|${alert.userId}|${alert.where}`;
    case 'block_marker_unreadable':
      return `block_marker_unreadable|${alert.code}`;
  }
}

/**
 * Что с автозапуском вертикали и что делать команде — по коду алерта (код
 * строки или `alertCode` решения, engAutoLaunch.heEngAutoLaunchVerdict).
 * Алерт уходит один раз, когда строка ВХОДИТ в это состояние: перепроверка
 * строки его не повторяет. `subject` говорит, продолжит ли автозапуск сам.
 */
const AUTO_LAUNCH_STUCK: Record<string, { subject: string; what: string; client: string; todo: string }> = {
  needs_support: {
    subject: 'ENG: ядро запуска отказало вертикали не по гейту — автозапуск перепроверяет раз в час',
    what:
      'ядро запуска отказало шаблону не по гейту (нет писем, нет колонки адреса, все контакты в чёрном списке, ' +
      'у соседнего шаблона той же базы уже есть запуск, в пресете нет ящиков, пресет незаконченного запуска ' +
      'пропал) — строка «held», автозапуск зовёт ядро снова раз в час; пока причина не снята, ничего не создаётся',
    client:
      'Sending could not start for this market. Nothing was sent. Press «Launch now» to see the reason, or ' +
      'message Support. (у незаконченного запуска — «Part of this market’s audience has not gone out yet: ' +
      'finishing it ran into a problem. Message Support.»)',
    todo:
      'причина — в application_logs (client.eng.template.launch*, поле trigger=auto) или в ответе «Launch now» ' +
      'клиента; починить данные/пресет — дальше автозапуск возьмёт шаблон сам в течение часа',
  },
  scope_refused: {
    subject: 'ENG: автозапуск вертикали отказан проверкой рынка аккаунта или шаблона',
    what:
      'перед запуском проверка рынка аккаунта (requireEngMarket) или шаблона у владельца проекта ' +
      '(loadClientHeTemplate) ответила 4xx: профиль не ENG или шаблона нет у этого владельца (удалён, проект ' +
      'передан). У не запущенной вертикали строка «held», автозапуск перепроверяет раз в час и продолжит сам; ' +
      'у законченного запуска (повтор только старта) — «done», сам не продолжит',
    client:
      'если аккаунт видит проект — у рынка на шаге 3 общий отказ («Sending could not start for this market…» ' +
      'или у законченного запуска «Starting this market ran into a problem… message Support»)',
    todo:
      'проверить профиль клиента (market, role) и владельца проекта; если шаблон законно не его — ничего не делать',
  },
  server_error: {
    subject: 'ENG: автозапуск вертикали остановлен — сам не продолжит',
    what:
      'шесть попыток подряд упали на нашей стороне ДО платной части (чтения БД: аккаунт, рынок, шаблон, пресет, ' +
      'чёрный список, защиты; запись начала запуска) — строка «failed», автозапуск вертикали остановлен',
    client:
      'We could not start this market after several tries. Nothing was sent. Press «Launch now» to try once ' +
      'more; if it does not start, message Support. (у незаконченного запуска — «Part of this market’s ' +
      'audience has not gone out yet. Press «Launch now» to finish it…»)',
    todo:
      'проверить application_logs client.eng.template.launch_failed (trigger=auto) и БД; после починки клиент ' +
      'нажимает «Launch» на шаге 3 (счётчики сбросятся) или «Launch now» у вертикали',
  },
  launch_failed: {
    subject: 'ENG: автозапуск вертикали остановлен — сам не продолжит и больше не платит',
    what:
      'третий запуск упал ПОСЛЕ платной части (классификатор сегментов не ответил по большинству адресов, ' +
      'первая кампания не создалась или ядро упало посреди; брошенные посреди попытки идут в тот же счёт) — ' +
      'строка «failed», автозапуск вертикали остановлен и больше не платит',
    client:
      'We could not start this market after several tries. Nothing was sent. Press «Launch now» to try once ' +
      'more; if it does not start, message Support. (у незаконченного запуска — «Part of this market’s ' +
      'audience has not gone out yet. Press «Launch now» to finish it…»)',
    todo:
      'проверить ключ/баланс модели классификатора и рассыльщика (application_logs client.eng.template.launch_failed, ' +
      'trigger=auto); после починки клиент нажимает «Launch» на шаге 3 (это его решение платить снова) или ' +
      '«Launch now» у вертикали',
  },
  abandoned: {
    subject: 'ENG: автозапуск вертикали остановлен — попытки обрываются, сам не продолжит',
    what:
      'попытки запуска брошены посреди — процесс умер (воркер hypothesis-engine: OOM, рестарт, деплой; или ' +
      'сервер кабинета посреди «Launch now»): вторая подряд или третий платный сбой вместе с ними — строка ' +
      '«failed», автозапуск вертикали остановлен и больше не платит',
    client:
      'We could not start this market after several tries. Nothing was sent. Press «Launch now» to try once ' +
      'more; if it does not start, message Support. (у незаконченного запуска — «Part of this market’s ' +
      'audience has not gone out yet. Press «Launch now» to finish it…»)',
    todo:
      'проверить логи и рестарты воркера hypothesis-engine и портала вокруг запуска (OOM, деплой) и application_logs ' +
      'client.eng.template.launch* (trigger=auto); после починки клиент нажимает «Launch» на шаге 3 (счётчики ' +
      'сбросятся) или «Launch now» у вертикали',
  },
  unfinished: {
    subject: 'ENG: незаконченный запуск вертикали не достроился — автозапуск сам не продолжит',
    what:
      'незаконченный запуск не достроился за три попытки подряд (раз в 30 мин) — часть аудитории вертикали не ' +
      'ушла; строка «done», автозапуск больше не достраивает (уже стартованные кампании отправляют)',
    client:
      'Part of this market’s audience has not gone out yet. Press «Launch now» to finish it — the campaigns ' +
      'already created are reused, only the addresses that have not gone out are added, and nobody is contacted twice.',
    todo:
      'причина — в предупреждениях ядра и application_logs client.eng.template.launch* (trigger=auto); после ' +
      'починки клиент нажимает «Launch now» у вертикали (достраивается только долг)',
  },
  account_blocked: {
    subject: 'ENG: автозапуск вертикали стоит — аккаунт клиента заблокирован; сам не продолжит',
    what:
      'аккаунт клиента заблокирован (блокировка в разделе «Английские клиенты» или бан входа, поставленный мимо ' +
      'раздела), демо-аккаунт или роль не client/admin. Автозапуск не начинает запуск, а если блокировка пришла ' +
      'посреди запуска — кампании созданы и не стартованы. Строка «held» сама больше не перепроверяется: снова её ' +
      'берёт только новое нажатие «Launch» клиентом на шаге 3. Уже отправляющие кампании ставит на паузу ' +
      'блокировка в разделе «Английские клиенты»; бан мимо раздела их не трогает',
    client:
      'письма нет; кабинет этого проекта аккаунт не видит (блокировка — вход закрыт, демо — демо-данные, не ' +
      'client/admin — отказ 403)',
    todo:
      'если клиента заблокировали намеренно — ничего не делать. Если в карточке клиента раздела «Английские ' +
      'клиенты» стоит «Вход закрыт баном, а отметки блокировки нет» — нажать там «Заблокировать ещё раз / доставить ' +
      'остановку»: бан мимо раздела не ставит на паузу уже отправляющие кампании и не гасит уже поставленные ' +
      'задачи (новые платные шаги, ночной добор и письма клиенту бан держит и без отметки). Если блокировка ' +
      'ошибочна — «Разблокировать» в карточке (или исправить роль, снять демо), затем «Включить отправку» там же ' +
      'и попросить клиента нажать «Launch» на шаге 3: только это нажатие продолжит автозапуск',
  },
};

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
            'раздел «Английские клиенты» (/admin/eng-clients) → карточка клиента → «Включить отправку» (клиенту ' +
            'уйдёт письмо); после этого готовые вертикали проекта, где клиент нажал «Launch», запускает автозапуск ' +
            '(в течение минуты), остальные клиент запускает сам',
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
        ? 'желание клиента «пауза» записано, и чтение статуса кабинетом — дашборд, шаг 3 «Launch» — ставит такую кампанию ' +
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
              'Because of a problem on our side we could not confirm that this market should keep sending, so we ' +
              'paused the campaigns we were starting, but some of them could not be paused yet and may still be ' +
              'sending — our team is stopping them. Message Support.',
            'сделать': `поставить эти кампании на паузу у рассыльщика руками (${held}); проверить he_eng_launch_sending`,
          },
        };
      }
      const notSaved =
        '«… we could not save that you paused this market, so the pause may not hold. Press «Pause» again in a ' +
        'minute; if this keeps happening, message Support.» (без кнопки Pause на карточке — «… Message Support so ' +
        'we can make sure it stays paused.»)';
      const fixState =
        'проверить he_eng_launch_sending (миграция 20261011_0002, БД) и записать шаблону client_state=paused; ' +
        'пока не записано, кнопка старта клиента и доводка паузы его паузу не держат («Launch now» и автозапуск ' +
        'кампании на паузе у рассыльщика не стартуют)';
      if (alert.campaignIds.length === 0) {
        // Рассыльщик остановил всё, но Pause клиента не записался.
        return {
          subject: 'ENG: Pause клиента не записался — кампании на паузе у рассыльщика, но желание «пауза» не сохранено',
          error: 'he_eng_launch_sending не записалась и с повтора; все кампании запуска на паузе у рассыльщика',
          context: {
            'проект': alert.projectId,
            'шаблон': alert.templateId,
            'клиент видит': `«Sending is paused, but we could not save that you paused this market…» — ${notSaved}`,
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
              'market while it was starting, but N campaigns could not be paused yet and may still be sending — ' +
              'our team is stopping them.»'
            : `«We could not pause N campaigns of this launch, so they may still be sending, and…» — ${notSaved}`,
          'сделать': alert.stateRecorded
            ? `поставить эти кампании на паузу у рассыльщика руками (клиент хотел паузу; ${held})`
            : `поставить эти кампании на паузу у рассыльщика руками (клиент хотел паузу; ${held}); ${fixState}`,
        },
      };
    }
    case 'revoke_pause_failed': {
      const blocked = alert.where === 'staff_block';
      return {
        subject: alert.launchUnread
          ? blocked
            ? 'ENG: клиент заблокирован, но запись запуска не прочитана — его кампании не ставились на паузу'
            : 'ENG: отправка аккаунта выключена, но запись запуска не прочитана — его кампании не ставились на паузу'
          : blocked
            ? 'ENG: клиент заблокирован, но рассыльщик часть кампаний не остановил — они могут слать'
            : 'ENG: отправка аккаунта выключена, но рассыльщик часть кампаний не остановил — они могут слать',
        error: alert.launchUnread
          ? 'запись о запуске шаблона не прочиталась — ни одна его кампания на паузу не ставилась'
          : `не на паузе: ${alert.campaignIds.join(', ') || '—'}`,
        context: {
          'проект': alert.projectId,
          'шаблон': alert.templateId,
          'где': REVOKE_WHERE[alert.where],
          'клиент видит': blocked
            ? 'ничего: вход заблокированному закрыт'
            : `в блоке отправки вертикали: «${CLIENT_TURNED_OFF_TEXT}» (заблокированный клиент — ничего: вход закрыт)`,
          'сделать': alert.launchUnread
            ? `найти кампании этого шаблона (launch_info) и поставить их на паузу у рассыльщика руками — ${REVOKE_REPEAT_TEXT}`
            : `поставить эти кампании на паузу у рассыльщика руками — ${REVOKE_REPEAT_TEXT}`,
        },
      };
    }
    case 'block_incomplete':
      return {
        subject: 'ENG: блокировка клиента не довершена — часть работы не остановилась',
        error:
          `Блокировка ENG-клиента не довершена: ${alert.email ?? alert.userId}. ` +
          `Не остановилось: ${alert.failed.join('; ') || '—'}.`,
        context: {
          'клиент': alert.userId,
          'почта': alert.email,
          'карточка': `/admin/eng-clients/${alert.userId}`,
          'сделать':
            'открыть карточку клиента и нажать «Заблокировать ещё раз / доставить остановку» — остановка ' +
            'повторится там, где не дошла; кампании, которые и после этого не встали на паузу, поставить на паузу ' +
            'у рассыльщика руками',
        },
      };
    case 'unblock_incomplete': {
      const held =
        alert.banBefore === false
          ? { subject: 'отметка блокировки осталась (бана не было)', error: 'Отметка блокировки осталась (бана нет — вход открыт, но платные шаги, запуск, отправку и ночной добор клиенту не включить).', lifts: 'отметка снимется' }
          : alert.banBefore === null
            ? { subject: 'блокировка осталась', error: 'Блокировка осталась (бан перед разблокировкой не прочитался).', lifts: 'блокировка снимется' }
            : { subject: 'бан остался', error: 'Бан остался.', lifts: 'бан снимется' };
      return {
        subject: `ENG: разблокировка клиента не выполнена — остановка не подтвердилась, ${held.subject}`,
        error:
          `Разблокировка ENG-клиента не выполнена: ${alert.email ?? alert.userId}. ${held.error} ` +
          `Не остановилось: ${alert.failed.join('; ') || '—'}.`,
        context: {
          'клиент': alert.userId,
          'почта': alert.email,
          'карточка': `/admin/eng-clients/${alert.userId}`,
          'сделать':
            `открыть карточку клиента и нажать «Разблокировать» ещё раз — остановка повторится, ${held.lifts}, когда ` +
            'подтвердится всё; кампании, которые уже встали на паузу, повтор не трогает и продолжает с остальных. ' +
            'Кампанию, которую рассыльщик раз за разом отказывается ставить на паузу, можно поставить на паузу ' +
            'руками в Instantly — следующее нажатие засчитает паузу, как только рассыльщик её подтвердит',
        },
      };
    }
    case 'campaigns_unreachable':
      return {
        subject: 'ENG: кампании клиента не на паузе — кабинет до них не дотягивается, поставьте на паузу руками в Instantly',
        error:
          `${alert.where === 'block' ? 'Блокировка' : 'Разблокировка'} ENG-клиента ${alert.email ?? alert.userId}: ` +
          `кабинет не может поставить на паузу кампании (${alert.campaigns.length}) — они запущены не из кабинета ` +
          '(например, инструментом сотрудника), или их воркспейс неизвестен.' +
          (alert.where === 'unblock' ? ' Снятие блокировки они не держат.' : ''),
        context: {
          'клиент': alert.userId,
          'почта': alert.email,
          'карточка': `/admin/eng-clients/${alert.userId}`,
          'кампании': alert.campaigns.join('; '),
          'сделать':
            'поставить эти кампании на паузу руками в Instantly (воркспейс — в списке; где он неизвестен — искать по ' +
            'имени или id). Кабинет их не видит: повторные нажатия в карточке их не остановят',
        },
      };
    case 'block_marker_unreadable':
      return {
        subject: 'ENG: отметки блокировки не читаются — английский кабинет и его фоновая работа стоят',
        error: heOpsReasonText(alert.detail),
        context: {
          'код': alert.code,
          'заметил':
            alert.where === 'job_guard'
              ? 'страж джоб воркера hypothesis-engine'
              : 'фоновая проверка заблокированных (воркер hypothesis-engine)',
          'что стоит':
            'пока he_eng_account_blocks не читается: джобы us-проектов не запускаются (воркер возвращает их в ' +
            'очередь раз в 15 минут, попытки не тратятся); платные действия кабинета (новый проект, исследование, ' +
            '«Launch», «Start sending», включение «Daily top-up», письма, сбор контактов) отвечают клиенту ' +
            '«Service temporarily unavailable — refresh the page»; автозапуск рынков повторяет попытки и ' +
            'останавливается — запуск после шести сбоев («failed»), старт после двух повторов («start_failed»); ' +
            'письма клиенту не уходят, а письмо автозапуска, решённого за это время, не уйдёт и потом; ночной добор ' +
            'пропускает проекты; фоновая проверка заблокированных не идёт. Пауза кампаний и выключение «Daily ' +
            'top-up» работают',
          'сделать':
            'проверить права на таблицу he_eng_account_blocks: доступ нужен service_role — выполнить ещё раз блок ' +
            'revoke / grant миграции 20261013_0001 (миграция идемпотентна). После починки джобы, письма и добор ' +
            'пойдут сами; рынок с автозапуском «failed» клиент запускает снова кнопкой «Launch» на шаге 3, рынок со ' +
            '«start_failed» — кнопкой «Start sending» у рынка',
        },
      };
    case 'auto_launch_stuck': {
      const known = AUTO_LAUNCH_STUCK[alert.code];
      return {
        // Тема — своя у каждого кода: одни продолжат сами (перепроверка), другие нет.
        subject: known?.subject ?? 'ENG: автозапуск вертикали встал',
        error: known?.what ?? `код ${alert.code}`,
        context: {
          'проект': alert.projectId,
          'шаблон': alert.templateId,
          'клиент видит': known?.client ?? 'Support',
          'сделать':
            known?.todo ??
            'посмотреть строку he_eng_auto_launch шаблона и application_logs client.eng.template.launch* (trigger=auto)',
        },
      };
    }
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
    const windowMs =
      alert.kind === 'block_incomplete' || alert.kind === 'unblock_incomplete'
        ? HE_ENG_BLOCK_INCOMPLETE_REPEAT_MS
        : HE_OPS_TEAM_FIX_REPEAT_MS;
    const hold = { until: now + windowMs };
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
