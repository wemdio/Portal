/**
 * Справочник английских текстов отказов ENG-кабинета: машинный код причины →
 * заголовок, «что уцелело», «что делать». Только код → текст.
 *
 * ПОЧЕМУ ОТДЕЛЬНЫМ МОДУЛЕМ. Тексты нужны и серверу (классификатор
 * `lib/hypothesisEngine/clientErrors.ts` и роут запуска), и браузеру
 * (`engText.ts` разворачивает код причины в текст). Пока браузер импортировал
 * `clientErrors` целиком, в клиентский чанк /client/eng уезжал и сам
 * классификатор: регэкспы с именами провайдеров, наших каталогов и таблиц и
 * русские фразы стадий. Здесь нет ни одного импорта и ни одного регэкспа —
 * только строки, которые клиенту и так показываются. Классификатор остаётся на
 * сервере и реэкспортирует этот справочник, поэтому серверные импорты
 * (`llm.ts`, роут запуска, архитектурный тест) не меняются.
 *
 * Модуль без 'use client' и без зависимостей намеренно: его тянет и воркер
 * (через `clientErrors` ← `llm.ts`), и любой лишний импорт здесь уехал бы в
 * бандлы обоих.
 *
 * ПРАВИЛА ТЕКСТОВ. Только английский; без имён провайдеров, таблиц и внутренних
 * id. Каждое предложение обязано быть правдой для ЛЮБОЙ строки, которая до него
 * доедет, при ДЕФОЛТНОЙ конфигурации: ни уведомлений, которых никто не шлёт, ни
 * автопродолжения, которого нет (провайдерский отказ терминален сразу, ночной
 * реконсилер и авто-резюм выключены по умолчанию и упавшую работу не
 * переоплачивают), ни кнопок, которых в кабинете нет. Действия называются теми
 * же словами, что и кнопки: «Re-run research» (шаг 1) и «Start outreach»
 * (шаг 2). Повтор собирает НОВУЮ базу, а не продолжает упавшую (упавшая база не
 * переиспользуется), поэтому «всё собранное сохранено» здесь не пишется —
 * сохранено то, что уже было закончено.
 */

export type HeClientErrorCode =
  /** У провайдера ИИ/поиска кончились деньги — повтор бессмысленен. */
  | 'billing'
  /** Ключ провайдера не задан/отклонён — нужна правка конфигурации. */
  | 'configuration'
  /** Провайдер временно недоступен или ограничил запросы. */
  | 'provider'
  /** Проба каталожного среза: сегмент не про эту вертикаль, база не собиралась. */
  | 'audience_mismatch'
  /** В источниках не осталось новых компаний после исключения уже собранных. */
  | 'segment_exhausted'
  /** Источник не отдал строк (ошибка чтения каталога или пустая выдача). */
  | 'source'
  /** Сайт самого клиента не открылся — исследованию нечего было читать. */
  | 'website_unreachable'
  /** Конструктор баз не обогатил строки почтами. */
  | 'enrichment'
  /** Шаг не уложился в отведённое время. */
  | 'timeout'
  /** Идёт прогрев ящиков — отправка/долив пока закрыты. */
  | 'subscription_warmup'
  /** Подписка не активна. */
  | 'subscription_inactive'
  /** Подписка оформлена, оплата не поступила. */
  | 'awaiting_payment'
  /** Исчерпан лимит контактов тарифа. */
  | 'contacts_exhausted'
  /** У рассыльщика нет места под новые контакты — ёмкость, а не тариф клиента. */
  | 'sending_capacity'
  /** Дневной кап добора ПРОЕКТА на сегодня занят другими бронями ('cap_exhausted'). */
  | 'refill_budget_spent'
  /**
   * Повтор прогона долива той же базы: её первый прогон ещё держит свою бронь
   * дневного капа ('already_reserved'). Кап проекта при этом может быть
   * свободен — поэтому это НЕ `refill_budget_spent`.
   */
  | 'refill_repeat_run'
  /** Узнанный сбой инфраструктуры (БД/сеть) — клиенту деталей не даём. */
  | 'internal'
  /** Ничего не опознали. */
  | 'unknown';

export interface HeClientFailure {
  code: HeClientErrorCode;
  /** Одна строка заголовка: что произошло. */
  title: string;
  /** Что при этом уцелело (оплаченные строки, кампания). */
  whatIsSaved: string;
  /** Следующий шаг клиента. */
  whatToDo: string;
}

/**
 * Где клиент перезапускает остановившийся шаг. Кнопок две, у каждой своя
 * область: research перезапускает «Re-run research» шага 1, упавшую сборку
 * базы — «Start outreach» шага 2 (клиентское нажатие ставит новую сборку
 * вертикали, у которой нет живой или готовой базы; упавшая база этому не
 * мешает). Один код причины бывает и у проекта, и у базы, поэтому названы обе.
 */
const WHERE_TO_RESTART =
  '«Re-run research» on step 1 if the research stopped, «Start outreach» on step 2 if a base collection stopped';

/**
 * Что уцелело при остановке шага движка. Ровно то, что правда для любой формы:
 * законченное. Про сам остановившийся шаг не обещаем ничего — повтор его не
 * продолжает, а собирает/исследует заново.
 */
const FINISHED_WORK_KEPT =
  'Your project and everything that had already finished — earlier bases and running campaigns — are kept.';

/**
 * Что уцелело у прогона ежедневного долива, который не добавил контактов.
 * Про компании этой ночи не обещаем ничего: вернутся ли они в выборку, решает
 * не только статус базы, но и закладка каталога (catalogCursor), а у
 * каталожных источников она сдвигается за прочитанное ещё во время сборки и
 * при отказе долива назад не откатывается.
 */
export const HE_REFILL_RUN_KEPT_EN = 'Contacts already in your campaigns stay there and keep sending.';

/**
 * Кто снимает паузу долива по ёмкости. ОДНА фраза на два экрана — карточку
 * базы (`sending_capacity` ниже) и Command Center (`engRefillHoldText`), чтобы
 * они не могли разойтись: автоснятия по таймеру у паузы нет, снимает её только
 * сотрудник (staff-роут refill-pause), а уведомления сотруднику о паузе нет —
 * поэтому клиента просят написать менеджеру, а не ждать.
 */
export const HE_REFILL_HOLD_LIFT_EN =
  'Only our team can lift this hold — it does not resume by itself, so contact your manager if you need the daily refill back.';

/**
 * Что делать с остановившимся прогоном ежедневного долива, если у кода нет
 * своего доливного ответа. Кнопки перезапуска ночи у клиента нет (ночь ставит
 * крон), а пойдёт ли следующая — зависит от конфига, паузы и бюджета, которые
 * карточка базы не видит; их показывает Command Center.
 */
export const HE_REFILL_RUN_WHAT_TO_DO_EN =
  'This was one run of the daily refill, and a refill run is not restarted by hand; the Command Center shows whether the daily refill goes on. Contact your manager if it keeps stopping.';

const FAILURES: Record<HeClientErrorCode, Omit<HeClientFailure, 'code'>> = {
  billing: {
    title: 'The run stopped on our side — one of the services we pay for ran out of balance.',
    whatIsSaved: FINISHED_WORK_KEPT,
    // Ни «команда уже знает», ни «продолжится после пополнения»: алерта на
    // такой отказ нет, а воркер пишет его терминальным с первого ответа.
    whatToDo: `This step does not restart by itself. Tell your manager so the balance gets topped up, then start it again — ${WHERE_TO_RESTART}.`,
  },
  configuration: {
    title: 'The run stopped on our side — one of the services we rely on is not configured correctly.',
    whatIsSaved: FINISHED_WORK_KEPT,
    whatToDo: `This step does not restart by itself. Tell your manager so the setup gets fixed, then start it again — ${WHERE_TO_RESTART}.`,
  },
  provider: {
    title: 'A service we rely on was temporarily unavailable, so the step stopped early.',
    whatIsSaved: FINISHED_WORK_KEPT,
    whatToDo: `Wait a few minutes and start it again — ${WHERE_TO_RESTART}. If it keeps failing, contact your manager.`,
  },
  /**
   * Действия — только те, что в ENG-кабинете есть. Загрузки своего списка в
   * кабинете нет, а us-запуск базы без построчного вердикта всё равно откажет.
   * Отклонить гипотезы вертикали — единственный способ не дать «Start outreach»
   * снова заплатить за ту же пробу: клиентское нажатие упавшей базой не
   * останавливается.
   */
  audience_mismatch: {
    title: 'The catalog slice we could build for this vertical did not match it, so no base was built.',
    whatIsSaved: 'No contacts were bought for this vertical.',
    whatToDo:
      'This was a deliberate stop — mailing such a list would hurt the verticals that do work. To keep «Start outreach» from trying this vertical again, reject its hypotheses on step 2; to collect another vertical, accept its hypotheses there and press «Start outreach».',
  },
  segment_exhausted: {
    title: 'The sources have no new companies left for this vertical.',
    whatIsSaved: 'Companies collected earlier stay in the bases you already have.',
    whatToDo:
      'This does not mean the market is exhausted — only these sources are. To keep «Start outreach» from trying this vertical again, reject its hypotheses on step 2; to collect another vertical, accept its hypotheses there and press «Start outreach».',
  },
  source: {
    title: 'The company sources did not return any rows for this vertical.',
    whatIsSaved: FINISHED_WORK_KEPT,
    whatToDo:
      'Press «Start outreach» on step 2 to collect this vertical again; if it keeps coming back empty, contact your manager.',
  },
  /**
   * Единственный код, где виноват не наш контур: сайт, который клиент указал
   * сам, не открылся (домена нет в DNS либо ни один адрес не отдал HTML —
   * lib/hypothesisEngine/stages/io.ts, HeSiteUnreachableError). Поэтому здесь,
   * в отличие от соседей, есть шаг, который клиент реально может сделать: адрес
   * он задаёт при создании проекта, а описание бизнеса — на шаге «Brief», и
   * ровно оно снимает отказ на следующем прогоне research.
   */
  website_unreachable: {
    title: 'We could not open the website you gave us, so the research had nothing to read.',
    whatIsSaved: 'The project and everything you entered are saved.',
    whatToDo:
      'Open the address in a browser to check it: if it does not open, start a new project with the correct one. If it opens but stays closed to us, describe your business in a few sentences in the Brief step and re-run the research.',
  },
  /**
   * На упавшей базе этот код значит одно: ни одна строка не получила вердикта,
   * которому можно верить (импорт отклонён целиком либо проверка не доработала),
   * то есть запускать нечего. «Продолжить с тем, что есть» здесь было бы
   * неправдой — частичный импорт базу не валит и сюда не попадает.
   */
  enrichment: {
    title: 'Finding and validating emails did not finish for this base.',
    whatIsSaved:
      'No address in this base has a verified email, so it cannot be mailed; your other bases and running campaigns are not affected.',
    whatToDo:
      'Press «Start outreach» on step 2 to collect this vertical again — a new collection checks every address from the start. If it fails again, contact your manager.',
  },
  timeout: {
    title: 'The step did not finish in time and was stopped.',
    whatIsSaved: FINISHED_WORK_KEPT,
    whatToDo: `Start it again — ${WHERE_TO_RESTART}. If it times out twice, contact your manager.`,
  },
  subscription_warmup: {
    title: 'Your mailboxes are still warming up, so sending is on hold.',
    whatIsSaved: 'Contacts collected for you are saved and wait for the warm-up to finish.',
    whatToDo: 'Sending resumes automatically when the warm-up period ends.',
  },
  subscription_inactive: {
    title: 'Sending is paused because the subscription is not active.',
    whatIsSaved: 'Contacts collected for you are saved.',
    whatToDo: 'Renew the subscription in Billing to resume sending.',
  },
  awaiting_payment: {
    title: 'Sending is paused until the first payment goes through.',
    whatIsSaved: 'Contacts collected for you are saved.',
    whatToDo: 'Complete the payment in Billing to resume sending.',
  },
  contacts_exhausted: {
    title: 'The contact limit of your plan is used up for this billing period.',
    whatIsSaved: 'Contacts already uploaded keep running in your campaigns.',
    whatToDo: 'Upgrade the plan or wait for the next billing period to add more contacts.',
  },
  /**
   * НЕ путать с contacts_exhausted: тот про тариф клиента («поднимите план»), а
   * этот — про ёмкость НАШЕГО рассыльщика, за которую клиент не отвечает и
   * доплачивать ему нечего, поэтому ни слова «plan».
   *
   * Код стоит только на базе долива, которая ничего не отдала провайдеру
   * (база 'failed' пишется лишь при недоставленном отказе), — отсюда «ничего
   * не добавлено». «Ничего не потеряно» писать нельзя: сборка этой ночи уже
   * оплачена. С волны 6b тот же отказ пишет durable-паузу проекта, которую
   * снимает только сотрудник; запись best-effort (нет конфига или колонок —
   * паузы нет), поэтому про паузу сказано «может», а проверить её состояние
   * отправляем в Command Center.
   */
  sending_capacity: {
    title: 'Nothing from this run was added to your campaign — our sending platform had no room for new contacts.',
    whatIsSaved: HE_REFILL_RUN_KEPT_EN,
    whatToDo: `The daily refill of this project may now be on hold — the Command Center shows whether it is. ${HE_REFILL_HOLD_LIFT_EN}`,
  },
  /**
   * Дневной кап добора проекта на сегодня занят другими бронями. Отдельный
   * код, потому что волна 6b сделала такую ночь 'failed'; общий `internal`
   * говорил бы «техническая проблема, попробуйте ещё раз» про штатный конец
   * дневного лимита, а кнопки ночного добора у клиента нет. «Подберём завтра»
   * не обещаем: пойдёт ли вертикаль следующей ночью, решают конфиг, пауза,
   * сухость и число вертикалей за ночь.
   */
  refill_budget_spent: {
    title: "Nothing from this run was added to your campaign — this project's daily contact limit was already taken for today.",
    whatIsSaved: HE_REFILL_RUN_KEPT_EN,
    whatToDo:
      'Nothing to do here: the limit starts over each UTC day, and the Command Center shows the state of the daily refill.',
  },
  refill_repeat_run: {
    title:
      "Nothing from this run was added to your campaign — an earlier attempt of the same refill run already holds its share of today's contact limit.",
    whatIsSaved: HE_REFILL_RUN_KEPT_EN,
    whatToDo: 'Nothing to do here: this was a repeat of a refill run that had already started today.',
  },
  internal: {
    title: 'The step stopped because of a technical problem on our side.',
    whatIsSaved: FINISHED_WORK_KEPT,
    whatToDo: `Start it again — ${WHERE_TO_RESTART}. If it happens twice, contact your manager.`,
  },
  unknown: {
    title: 'The step stopped because of a technical problem.',
    whatIsSaved: FINISHED_WORK_KEPT,
    whatToDo: `Start it again — ${WHERE_TO_RESTART}. If it happens twice, contact your manager.`,
  },
};

/** Полный список кодов — для ревью текстов и исчерпывающих switch'ей. */
export const HE_CLIENT_ERROR_CODES = Object.keys(FAILURES) as HeClientErrorCode[];

/**
 * Текст по известному коду — для мест, где причина уже машинная и разбирать
 * нечего: код причины из проекции кабинета, префлайт тарифа, гейт конфигурации.
 */
export function heClientFailureFor(code: HeClientErrorCode): HeClientFailure {
  return { code, ...FAILURES[code] };
}

/** Одной строкой — для компактных мест кабинета (карточка базы, список проектов). */
export function formatHeClientFailure(failure: Pick<HeClientFailure, 'title' | 'whatIsSaved' | 'whatToDo'>): string {
  return `${failure.title} ${failure.whatIsSaved} ${failure.whatToDo}`;
}
