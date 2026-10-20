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
 * доедет, при ДЕФОЛТНОЙ конфигурации: ни уведомлений, которых никто не шлёт (а
 * то, что шлют, названо у HE_TEAM_ON_IT_EN вместе с отправителем), ни
 * автопродолжения, которого нет (провайдерский отказ терминален сразу, ночной
 * реконсилер и авто-резюм выключены по умолчанию и упавшую работу не
 * переоплачивают), ни кнопок, которых в кабинете нет. Действия называются теми
 * же словами, что и кнопки: «Try again» (шаг 1, только у research, вставшего
 * техническим сбоем — heResearchRetryAllowed ниже), «Save and continue» (шаг
 * 1, только у research, остановленного кодом website_thin —
 * HE_RESEARCH_NEEDS_DESCRIPTION_CODE ниже), «Launch»
 * (шаг 3) и «Collect again» (карточка рынка шага 3, только у остановок
 * HE_COLLECT_STOP_REPEATS_CODES). Повтор собирает НОВУЮ базу, а не продолжает
 * упавшую (упавшая база не переиспользуется), поэтому «всё собранное
 * сохранено» здесь не пишется — сохранено то, что уже было закончено.
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
  /**
   * Релевант-гейт, судивший целью по гипотезам (флаг HE_GATE_HYPOTHESIS_SCOPE,
   * по умолчанию выключен), снял ВСЕ компании сборки: ни одна не подходит под
   * неотклонённые гипотезы вертикали. Не audience_mismatch: компании могли
   * принадлежать вертикали.
   */
  | 'hypothesis_mismatch'
  /** No company had confirmed evidence for both the selected audience and countries. */
  | 'company_unverified'
  /** Company checking stopped at its own lifetime spending limit. */
  | 'qualification_limit'
  /** A paid company-check result is missing or cannot be trusted. */
  | 'qualification_incomplete'
  /** В источниках не осталось новых компаний после исключения уже собранных. */
  | 'segment_exhausted'
  /**
   * Всё, что вернул конструктор этой сборки, — компании и адреса, которые уже
   * лежат в других базах проекта (повторная сверка после импорта,
   * stages/baseCollect.ts): сохранить их во вторую базу значило бы написать им
   * дважды.
   */
  | 'already_collected'
  /** Источник не отдал строк (ошибка чтения каталога или пустая выдача). */
  | 'source'
  /**
   * План сборки пуст из-за списка стран проекта: ни один источник не покрывает
   * выбранные страны для этого рынка, коллекторы не вызывались
   * (stages/baseCollect.ts; план docs/handoff/2026-10-16-eng-countries, §1A).
   */
  | 'countries_uncovered'
  /**
   * Сборка не дала строк, и главная причина — список Do not contact клиента:
   * все найденные компании на его доменах (§1B).
   */
  | 'do_not_contact'
  /** Список Do not contact клиента больше лимита — сборка не может его проверить (§1B). */
  | 'do_not_contact_over_cap'
  /**
   * Адрес сайта клиента не привёл к публичному серверу (род `dns`
   * HeSiteUnreachableError: домен не резолвится, адрес невалидный или
   * приватный) — исследованию нечего было читать.
   */
  | 'website_unreachable'
  /**
   * Сайт клиента принял соединение, но ни один его адрес не отдал HTML (род
   * `no_html` HeSiteUnreachableError). Бывает и из-за наших маршрутов чтения
   * (прокси, блокировка ботов), поэтому — технический сбой.
   */
  | 'website_no_html'
  /**
   * Сайт клиента ENG-кабинета открылся, но текста в нём мало (или это
   * JS-заглушка), а описания бизнеса нет: site_profile отказала до первого
   * платного вызова (HeSiteThinNeedsBusinessError, stages/siteProfile.ts) и ждёт
   * описания — НЕ технический сбой, повтор «Try again» ему не положен
   * (HE_RESEARCH_FINAL_STOP_CODES), его продолжает «Save and continue» шага 1.
   */
  | 'website_thin'
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
 * Остановки сборки, которые НОВАЯ сборка той же вертикали почти наверняка
 * повторит: решение движка о самом срезе (проба среза или релевант-гейт снял
 * все компании — audience_mismatch / hypothesis_mismatch) и источники, в
 * которых не осталось новых компаний (segment_exhausted). Провайдер, срок,
 * конструктор, отмена и прочее сюда не входят — их повтор может пройти.
 *
 * Читатели — три места одного правила, поэтому список здесь, в модуле без
 * зависимостей, который тянут и сервер, и браузер:
 *  - «Launch» шага 3 (autopilotReconcile.ts, нажатие клиента): вертикаль,
 *    чья ПОСЛЕДНЯЯ своя база кончилась таким кодом, новую сборку не получает
 *    (пропуск 'collect_stop_repeats'); раньше каждое нажатие покупало её
 *    заново — до AUTOPILOT_BASE_LIMIT (2 000) строк сборки на такую вертикаль;
 *  - кнопка «Collect again» шага 3 (EngStepLaunch.tsx) — явный повтор этой
 *    вертикали, рисуется у такой базы;
 *  - роут этой кнопки (POST /api/client/eng/verticals/[id]/collect) повтор
 *    разрешает — это и есть явное решение клиента.
 * Ночной проход повтор ЛЮБОЙ упавшей сборки не покупает и так
 * ('collect_failed_before').
 */
export const HE_COLLECT_STOP_REPEATS_CODES = [
  'audience_mismatch',
  'hypothesis_mismatch',
  'company_unverified',
  'qualification_limit',
  'qualification_incomplete',
  'segment_exhausted',
  // Повтор упрётся в тот же список стран / тот же Do not contact, пока клиент
  // его не поправит (§1A, §1B). Список сверх лимита — так же: его текст зовёт
  // «Collect again», а кнопка рисуется только у кодов этого списка.
  'countries_uncovered',
  'do_not_contact',
  'do_not_contact_over_cap',
] as const satisfies readonly HeClientErrorCode[];

export function heCollectStopRepeats(code: unknown): boolean {
  return (HE_COLLECT_STOP_REPEATS_CODES as readonly unknown[]).includes(code);
}

/**
 * ПОВТОР RESEARCH ТОЛЬКО ПОСЛЕ ТЕХНИЧЕСКОГО СБОЯ — решение владельца 10.10.2026:
 * research проекта клиент запускает ещё раз только после сбоя («Try again» шага
 * 1 и роут api/client/eng/projects/[id]/research), а не кнопкой когда угодно.
 *
 * СПИСОК ПЕРЕВЁРНУТ: перечислены НЕ технические остановки research, всё прочее
 * — сбой. Причина — источник кода. Код причины проекта даёт классификатор по
 * ТЕКСТУ (clientErrors.classifyHeClientError), и его правила написаны в
 * основном для баз, долива и тарифа. Ошибка research, в которой случайно
 * встретилась их подстрока («JSON.parse failed: … warm-up …» →
 * subscription_warmup), при списке «технических» кодов навсегда запирала бы
 * клиента — без «Try again», с Support как единственным выходом. Здесь цена
 * ошибки обратная и ограничена: лишний повтор, который держит дневной лимит
 * стартов (HE_US_MAX_RESEARCH_PER_DAY, гейт роута под замком).
 *
 * Не технические остановки research:
 *  - website_unreachable — ТОЛЬКО род `dns` HeSiteUnreachableError
 *    (stages/io.ts, assertPublicWebsite): адрес, который дал клиент, не привёл
 *    к публичному серверу — имени нет (у рынка 'us' — только ENOTFOUND /
 *    ENODATA резолвера; сбой самого резолвера — `internal`), адрес невалидный
 *    или приватный. Правило кабинета, а не вывод о виновнике: повтор того же
 *    адреса дал бы тот же исход. Род `no_html` сюда не входит (он
 *    `website_no_html`: так же выглядит и наш маршрут чтения, который не
 *    дошёл); истёкший срок чтения — `timeout`;
 *  - `cancelled` (код проекции, не этого словаря) — проект остановили руками.
 *    Ту же отмену чаще видно по последней research-джобе 'cancelled' — её
 *    проверяет вердикт (researchJob.ts, engResearchRetryVerdict);
 *  - website_thin — сайт открылся, но текста мало, а описания бизнеса нет
 *    (HeSiteThinNeedsBusinessError, stages/siteProfile.ts): research ждёт
 *    описания, а не повтора. Повтор «Try again» (новый старт с первой стадии,
 *    в счёт дневного лимита стартов) ему не положен — его продолжает «Save and
 *    continue» шага 1 (HE_RESEARCH_NEEDS_DESCRIPTION_CODE ниже): роут
 *    исследования возвращает ту же строку site_profile в очередь, не трогая
 *    ни этот вердикт, ни лимит стартов.
 * Причины нет (`null`/нет ключа) — «остановился без записанной причины»: тоже
 * сбой.
 *
 * Всё остальное — повтор положен, в том числе коды, которые research сам не
 * пишет (audience_mismatch, segment_exhausted, subscription_*, refill_* и
 * т. д.): на проекте такой код — почти наверняка неверно прочитанный текст.
 */
export const HE_RESEARCH_FINAL_STOP_CODES = ['website_unreachable', 'website_thin', 'cancelled'] as const;

/**
 * Research ждёт описания бизнеса: site_profile отказала на тонком сайте без
 * описания у проекта клиента ENG-кабинета (HeSiteThinNeedsBusinessError,
 * stages/siteProfile.ts). Один код на трёх читателей: шаг 1 (форма описания и
 * «Save and continue» вместо «Try again»), роут исследования (продолжение той
 * же джобы без вердикта повтора и без лимита стартов) и письмо об остановке
 * research (без совета «Try again» и без «технической проблемы»).
 */
export const HE_RESEARCH_NEEDS_DESCRIPTION_CODE = 'website_thin' as const satisfies HeClientErrorCode;

/**
 * Проект ЖДЁТ ОПИСАНИЯ БИЗНЕСА, а не стоит на сбое: 'failed' кодом
 * HE_RESEARCH_NEEDS_DESCRIPTION_CODE. Пара точная: продолжение (роут
 * исследования) первым делом переводит проект в 'researching' с error = null,
 * отмена — в 'draft' с error = null, поэтому 'failed' + website_thin значит
 * ровно «research ждёт 2–3 предложений клиента» (шаг 1, 'needs_description').
 *
 * Читатели — шапка мастера, карточка проекта в списке, Command Center: такой
 * проект они рисуют нейтральным «needs your input» (ENG_NEEDS_INPUT_LABEL_EN),
 * без красного «stopped» и без красной «Last error», которая повторяла бы
 * янтарную просьбу шага 1 словами сбоя. Настоящие сбои research остаются
 * красными.
 */
export function heProjectAwaitsDescription(status: unknown, errorCode: unknown): boolean {
  return status === 'failed' && errorCode === HE_RESEARCH_NEEDS_DESCRIPTION_CODE;
}

/** Подпись состояния «ждём ответа клиента» — бейдж проекта и тег рынка Command Center. */
export const ENG_NEEDS_INPUT_LABEL_EN = 'needs your input';

/**
 * Одна строка «что ждёт research» там, где самой просьбы шага 1 нет: шапка
 * мастера на шагах 2–3, карточка проекта в списке, лента и карточка рынка
 * Command Center. Без «stopped» и «failed»: это пауза до ответа клиента.
 */
export const ENG_NEEDS_DESCRIPTION_SHORT_EN =
  'The research is waiting for a short description of your business: we could read only a little text on your website.';

/**
 * Можно ли клиенту запустить research упавшего ('failed') проекта ещё раз —
 * по коду причины из проекции (toClientEngStageErrorCode). Один предикат на
 * роут исследования и экран шага 1: разойдись они, кабинет рисовал бы кнопку,
 * которую роут откажет.
 */
export function heResearchRetryAllowed(errorCode: unknown): boolean {
  return !(HE_RESEARCH_FINAL_STOP_CODES as readonly unknown[]).includes(errorCode);
}

/**
 * Коды, которые research-стадии действительно пишут проекту: у них заголовок
 * справочника говорит правду о research, и шаг 1 ставит его перед «Try again».
 * У любого другого кода на проекте (неверно прочитанный текст, см. выше)
 * заголовок рассказывал бы про базы или тариф — шаг 1 говорит нейтрально.
 */
export const HE_RESEARCH_STOP_CODES = [
  'billing',
  'configuration',
  'provider',
  'timeout',
  'website_unreachable',
  'website_no_html',
  'website_thin',
  'internal',
  'unknown',
] as const satisfies readonly HeClientErrorCode[];

export function heResearchStopCode(code: unknown): code is (typeof HE_RESEARCH_STOP_CODES)[number] {
  return (HE_RESEARCH_STOP_CODES as readonly unknown[]).includes(code);
}

/**
 * Сколько research-проект 'researching' без живой research-джобы ждёт, прежде
 * чем клиенту можно «Try again» (вердикт 'retry_stalled', researchJob.ts).
 * Воркер ставит следующую стадию сразу после done-записи предыдущей, и между
 * ними живой джобы нет — окно отделяет эту щель от вставшей цепочки.
 *
 * ОДНА константа на роут исследования (он решает), деталку проекта (она
 * отдаёт вердикт экрану) и текст шага 1 (он называет число минут), поэтому
 * живёт здесь — в модуле без зависимостей, который берут и сервер, и браузер.
 * Значение то же, что у сирот баз (ANALYZING_ORPHAN_GRACE_MS, autopilotNext.ts),
 * и по той же причине — с запасом на любой ответ, который вообще доходит;
 * импортировать ту константу браузер не может (модуль серверный).
 */
export const HE_RESEARCH_STALL_GRACE_MS = 10 * 60 * 1000;

/**
 * «Что делать» у этих остановок — одно предложение на три кода, и каждое его
 * слово правда при любой базе, у которой его показывают (в том числе у
 * старой, над которой уже есть новая база): кнопка описана условием, при
 * котором она есть, а не обещана.
 */
const COLLECT_AGAIN_EN =
  '«Launch» does not collect a market again while its latest collection ended this way. To try once more anyway, use «Collect again» on the market card in step 3 — it appears on the latest stopped collection of a market you have selected; a new collection is checked the same way and may stop here again.';

/**
 * Где клиент перезапускает остановившийся шаг. Кнопок две, у каждой своя
 * область: research перезапускает «Try again» шага 1, упавшую сборку
 * базы — «Launch» шага 3 (клиентское нажатие ставит новую сборку
 * вертикали, у которой нет живой или готовой базы; упавшая база этому не
 * мешает — кроме остановок HE_COLLECT_STOP_REPEATS_CODES, у которых свой текст
 * и своя кнопка). Один код причины бывает и у проекта, и у базы, поэтому
 * названы обе.
 *
 * «Try again» есть у research, остановленного с любым кодом, кроме
 * HE_RESEARCH_FINAL_STOP_CODES (heResearchRetryAllowed), поэтому фраза стоит
 * у кодов, которые research пишет как сбой (billing, configuration, provider,
 * timeout, internal, unknown): у них кнопка на шаге 1 есть, когда research
 * остановился с этим кодом. Одно исключение — гонка с отменой: последняя
 * research-джоба проекта 'cancelled' (engResearchRetryVerdict, researchJob.ts),
 * и тогда кнопки нет. Код проекта при этом обычно пуст (cancel-роут пишет
 * error = null), так что эту фразу клиент там почти никогда не видит.
 * website_no_html своё действие называет сам.
 */
const WHERE_TO_RESTART =
  '«Try again» on step 1 if the research stopped, «Launch» on step 3 if a base collection stopped';

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
 * Что эти контакты «отправляются», тоже не обещаем: с S2 клиент сам ставит
 * кампании вертикали на паузу, а ночь, пропущенная проверкой «кампании запуска
 * отправляют?» (autoPipeline.ts), пропущена именно потому, что они не
 * отправляют.
 */
export const HE_REFILL_RUN_KEPT_EN = 'Contacts already in your campaigns stay there.';

/**
 * ОДНА нейтральная фраза на все отказы, которые чинит только команда:
 * провайдер отказал по деньгам ('billing') или по настройке ('configuration'),
 * у рассыльщика кончилось место ('sending_capacity' и пауза ночного добора в
 * Command Center). Решение владельца 04.10.2026: клиенту не пишем ни про
 * баланс, ни про провайдеров, ключи, тарифы и ёмкость. Машинные коды при этом
 * остаются разными — их читают политика повторов воркера (llm.ts) и алерт
 * команде; сливается только то, что клиент читает.
 *
 * «Our team has been notified and is already working on it» — ПРАВДА ТОЛЬКО
 * ПОТОМУ, ЧТО КОМАНДУ УВЕДОМЛЯЕТ АЛЕРТ В HEALTH-БОТ: lib/hypothesisEngine/
 * opsAlert.ts (`notifyHeClientStop`). Его зовут: воркер
 * (worker/hypothesisEngine.ts, writeJobFailure) на КАЖДОМ отказе, который
 * кабинет свернёт в 'billing'/'configuration' (тот же предикат,
 * clientErrors.heTeamFixableFailureOf), оба места, где пишется пауза по
 * ёмкости (stages/baseCollectRefill.ts, autoPipeline.ts), и пауза ночного
 * добора по потолку расхода (autoPipeline.ts, шаг 3a-, вид 'spend_ceiling'; по
 * умолчанию потолок выключен, и такой паузы не бывает). Убрали алерт или
 * любой из вызовов — убирайте и эту фразу, иначе кабинет врёт. Алерт
 * best-effort: без TELEGRAM_HEALTH_BOT_TOKEN / TELEGRAM_HEALTH_CHAT_ID в
 * контейнере движка он молчит — их наличие в предрелизной проверке. Не
 * принятый Telegram алерт окно дедупликации не взводит: следующий такой же
 * отказ пишет снова.
 */
export const HE_TEAM_ON_IT_EN =
  'This stopped because of a temporary problem on our side. Our team has been notified and is already working on it.';

/**
 * Та же фраза для коротких подписей (лента и карточки Command Center), где
 * полное предложение не помещается. Правда по той же причине, что и у
 * HE_TEAM_ON_IT_EN, — менять их только вместе.
 */
export const HE_TEAM_ON_IT_SHORT_EN = 'temporary problem on our side, we are working on it';

/**
 * Кто снимает паузу долива. ОДНА фраза на два экрана — карточку базы
 * (`sending_capacity` ниже) и Command Center (`engRefillHoldText`), чтобы они
 * не могли разойтись: автоснятия по таймеру у паузы нет, снимает её только
 * сотрудник (staff-роут refill-pause). Срока не называем: когда он её снимет,
 * кабинет не знает.
 */
export const HE_REFILL_HOLD_LIFT_EN = 'Only our team can lift the hold — it does not resume on a timer.';

/**
 * Проект на паузе по ПОТОЛКУ РАСХОДА (lib/hypothesisEngine/spendCeiling.ts; по
 * умолчанию потолок выключен, и эту фразу не видит никто). ОДНА фраза на два
 * места: карточка паузы автопилота (`engAutopilotHoldText('spend_paused')`) и
 * отказ 409 кнопок кабинета, которые ставят платный шаг (письма, сборка,
 * шаблон, «Try again» исследования), — чтобы они не могли разойтись.
 *
 * Каждое предложение — правда при каждом пути, который её показывает:
 *  - «paused on our side, so no new step was started» — потолок только НЕ
 *    СТАВИТ следующий шаг; идущий доработает, но карточка паузы рисуется
 *    только без активных шагов, а 409 отвечает именно на непоставленный;
 *  - «Our team has been notified» — паузу пишет и отказ отдаёт только
 *    spendCeiling.enforceHeSpendCeiling, и он же в том же вызове шлёт алерт
 *    (opsAlert, вид 'spend_ceiling'); без него фразу писать нельзя;
 *  - «continues when they resume it» — сам проект не продолжится: ни таймера,
 *    ни автоснятия у паузы нет (суточный порог отпускает время — когда расход
 *    проекта за скользящие последние 24 часа опустится ниже него, — но
 *    пропущенный шаг и тогда никто не ставит сам). Срока не называем;
 *  - «Everything already done on it is kept» — потолок ничего не отменяет и
 *    не удаляет. Причину (деньги, лимит) не называем — решение владельца
 *    04.10.2026, как у HE_TEAM_ON_IT_EN.
 */
export const HE_SPEND_PAUSED_EN =
  'Work on this project is paused on our side, so no new step was started. Our team has been notified, and the project continues when they resume it. Everything already done on it is kept.';

/**
 * Что делать клиенту на шаге, который остановил отказ, чинимый командой
 * ('billing'/'configuration'). Шаг сам не продолжается (отказ терминален с
 * первого ответа, авто-резюм и ночной реконсилер выключены по умолчанию и
 * такие отказы не поднимают), а нажать кнопку до починки — значит упереться в
 * тот же отказ, поэтому вопрос в Support стоит раньше кнопки. Менеджера у
 * self-serve кабинета нет; Support — чат кабинета (пункт меню «Support»,
 * /client/support), в нём отвечает команда.
 */
const TEAM_FIX_WHAT_TO_DO =
  `This step does not restart by itself. Message Support to find out when it is fixed — then start it again: ${WHERE_TO_RESTART}.`;

/**
 * Что делать с остановившимся прогоном ежедневного долива, если у кода нет
 * своего доливного ответа. Кнопки перезапуска ночи у клиента нет (ночь ставит
 * крон), а пойдёт ли следующая — зависит от конфига, паузы и бюджета, которые
 * карточка базы не видит; их показывает Command Center.
 */
export const HE_REFILL_RUN_WHAT_TO_DO_EN =
  'This was one run of the daily top-up, and a top-up run is not restarted by hand; «Daily top-up» in the Command Center shows whether it goes on. Message Support if it keeps stopping.';

const FAILURES: Record<HeClientErrorCode, Omit<HeClientFailure, 'code'>> = {
  qualification_limit: {
    title: 'Company checking stopped at its spending limit.',
    whatIsSaved: 'Completed checks are saved. Companies without confirmed evidence were not added to this base.',
    whatToDo: 'Contact Support to review the saved results before starting another collection. A new collection may reach the same limit.',
  },
  qualification_incomplete: {
    title: 'Company checking could not complete reliably.',
    whatIsSaved: 'Saved results are kept. Unchecked companies were not treated as unsuitable or added to this base.',
    whatToDo: 'Contact Support to review the saved results before starting another collection.',
  },
  // 'billing' и 'configuration' читаются клиентом ОДИНАКОВО (HE_TEAM_ON_IT_EN):
  // «команда уже работает» здесь правда, потому что воркер шлёт алерт на каждый
  // такой отказ (opsAlert.ts). «Продолжится само» не пишем: шаг терминален.
  billing: {
    title: HE_TEAM_ON_IT_EN,
    whatIsSaved: FINISHED_WORK_KEPT,
    whatToDo: TEAM_FIX_WHAT_TO_DO,
  },
  configuration: {
    title: HE_TEAM_ON_IT_EN,
    whatIsSaved: FINISHED_WORK_KEPT,
    whatToDo: TEAM_FIX_WHAT_TO_DO,
  },
  /**
   * Кратковременный отказ подрядчика (429/5xx модели или поиска, «transient»
   * поиска). Решение владельца 04.10.2026: клиент не читает про провайдеров и
   * сервисы, на которых мы собраны, — только «временная проблема на нашей
   * стороне». Но «команда уже работает» (HE_TEAM_ON_IT_EN) здесь НЕПРАВДА:
   * этот код алертом команде не обеспечен (opsAlert.ts шлёт только
   * 'billing' / 'configuration' / ёмкость), такой отказ обычно проходит сам, и
   * честный совет — повторить чуть позже. Заголовок без совета: у прогона
   * долива «что делать» заменяет HE_REFILL_RUN_WHAT_TO_DO_EN (ночь руками не
   * перезапускается, engText.ts), а предупреждение запуска шаблона показывает
   * один заголовок (api/client/eng/templates/[id]/launch).
   */
  provider: {
    title: 'This stopped early because of a temporary problem on our side.',
    whatIsSaved: FINISHED_WORK_KEPT,
    whatToDo: `Trying again a little later usually helps: wait a few minutes, then start it again — ${WHERE_TO_RESTART}. If it keeps failing, message Support.`,
  },
  /**
   * Действия — только те, что в ENG-кабинете есть. Загрузки своего списка в
   * кабинете нет, а us-запуск базы без построчного вердикта всё равно откажет.
   * «Launch» такую вертикаль второй раз не собирает
   * (HE_COLLECT_STOP_REPEATS_CODES), повтор — явная «Collect again».
   */
  audience_mismatch: {
    title: 'The catalog slice we could build for this market did not match it, so no base was built.',
    whatIsSaved: 'No contacts were bought for this market.',
    whatToDo:
      `This was a deliberate stop — mailing such a list would hurt the markets that do work. ${COLLECT_AGAIN_EN} To collect another market instead, tick it on step 2 «Choose markets» and press «Launch» on step 3.`,
  },
  company_unverified: {
    title: 'No companies could be confirmed for the selected audience and countries.',
    whatIsSaved: 'No contacts from this collection are ready to send. Your other bases and campaigns are not affected.',
    whatToDo: 'Review the selected audience and countries before collecting again. Message Support if these choices are correct; repeating the same collection may give the same result.',
  },
  /**
   * Сборка, в которой релевант-гейт снял все компании, судя целью по
   * гипотезам (stages/baseCollect.ts, offTargetNote; только при включённом
   * HE_GATE_HYPOTHESIS_SCOPE). Терминальная запись этой сборки — та же, что у
   * любой другой (harvestRow): собранные строки ЛЕЖАТ в базе (data, row_count,
   * все с пометкой _low_relevance), меняется только статус — 'failed' с этой
   * причиной. Поэтому «no base was built» здесь неправда. Каждое предложение —
   * правда при любой такой базе:
   *  - «fit the ideas it had accepted or suggested when they were
   *    checked» («ideas» — гипотезы словом шага 2) — цель гейта ровно такая: неотклонённые гипотезы вертикали на
   *    момент суда (записываются вместе с ним, relevance_gate.hypothesis_scope),
   *    «suggested» — слово, которым кабинет показывает статус proposed (ui.tsx).
   *    Отклонённые не проверялись, а вердикты с тех пор могли поменяться —
   *    отсюда «when they were checked». Если гипотез было больше потолка,
   *    остальные заменял вопрос о самой вертикали, и ей не принадлежит ни
   *    одна из компаний — им не подходят и эти гипотезы;
   *  - «this base will not be launched» — запуск берёт только 'analyzed'-базу,
   *    а «Launch» упавшую базу не поднимает (ставит новую сборку);
   *  - «saved with this base» — строки записаны той же финальной записью, что
   *    и статус: без неё базы с этой причиной не бывает;
   *  - «this collection did not look up any emails» — конструктор (поиск и
   *    проверка адресов) у такой сборки не запускается вовсе (allOffTarget
   *    требует, чтобы его джобы ещё не было). Не «no emails were looked up for
   *    these companies»: упавшая база выпадает из кросс-базового исключения, и
   *    те же компании могла обогащать прежняя сборка. «No contacts were bought
   *    for this market», как у audience_mismatch, тоже не пишем: у вертикали
   *    могут быть другие, раньше собранные базы;
   *  - «your other bases and campaigns are not affected» — без «running»: с S2
   *    кампании запуска бывают отправляющими, на паузе клиента, не стартованными
   *    и завершёнными, и «running» было бы правдой не для всех. Сама фраза
   *    верна при любом их статусе: остановка сборки рассыльщика не зовёт и
   *    кампаний не трогает;
   *  - про повтор — «may»: «Launch» эту вертикаль заново не собирает
   *    (HE_COLLECT_STOP_REPEATS_CODES, autopilotReconcile), повтор — явная
   *    «Collect again» шага 3, и новая сборка может остановиться так же. «Будет
   *    судиться тем же правилом» не пишем: флаг и вердикты гипотез к
   *    следующему суду могут поменяться. Совета «поменяйте принятые гипотезы»
   *    больше нет: шаг 2 «Choose markets» выбирает рынок целиком, отдельных
   *    гипотез клиент не размечает.
   */
  hypothesis_mismatch: {
    title:
      'None of the companies found for this market fit the ideas it had accepted or suggested when they were checked, so this base will not be launched.',
    whatIsSaved:
      'The companies found are saved with this base, but this collection did not look up any emails for them. Your other bases and campaigns are not affected.',
    whatToDo:
      `This was a deliberate stop, not a technical problem. ${COLLECT_AGAIN_EN}`,
  },
  segment_exhausted: {
    title: 'The sources have no new companies left for this market.',
    whatIsSaved: 'Companies collected earlier stay in the bases you already have.',
    whatToDo:
      `This does not mean the market is exhausted — only these sources are. ${COLLECT_AGAIN_EN} To collect another market instead, tick it on step 2 «Choose markets» and press «Launch» on step 3.`,
  },
  // Не «источники не дали строк» (это был бы `source`): строки были, но все
  // они — компании и адреса, которые уже держит другая база проекта. Сбор
  // заново не повторяет их — исключение по другим базам проекта стоит на
  // каждой сборке, — поэтому «Launch» правдив как действие. Строка
  // снимается и по одному АДРЕСУ (общий ящик у компании с другим именем и
  // доменом), поэтому текст говорит «компания или её адрес», а не только
  // «компания».
  already_collected: {
    title:
      'Every company this collection found, or its email address, is already in your other audiences for this project.',
    whatIsSaved:
      'Those companies and addresses stay in the audiences that already hold them; this collection does not add them a second time.',
    whatToDo:
      'Press «Launch» on step 3 to collect this market again — a new collection skips the companies you already have; if it keeps coming back empty, message Support.',
  },
  /**
   * Список стран проекта (§1A): план сборки опустел, потому что ни один
   * источник не покрывает выбранные страны для этого рынка. Коллекторы не
   * вызывались — компаний не покупали. «Launch» такую вертикаль заново не
   * собирает (HE_COLLECT_STOP_REPEATS_CODES); повтор — явная «Collect again»
   * после правки списка на шаге 1.
   */
  countries_uncovered: {
    title: 'None of our company sources cover the countries chosen for this project for this market.',
    whatIsSaved: 'No companies were collected or bought for this market in this collection. ' + FINISHED_WORK_KEPT,
    whatToDo:
      'Add countries or clear the list in «Countries» on step 1, then press «Collect again» for this market on step 3.',
  },
  /**
   * Список Do not contact клиента (§1B): все компании, которые нашла сборка,
   * — на доменах из списка. Они не добавлены ни в эту базу, ни в кампании.
   */
  do_not_contact: {
    title: 'Every company found for this market is on your Do not contact list.',
    whatIsSaved: 'None of those companies were added. ' + FINISHED_WORK_KEPT,
    whatToDo: 'Remove the domains you want to reach from Do not contact, then press «Collect again».',
  },
  /** Список Do not contact сверх лимита (§1B): сборка не может его проверить и остановилась. */
  do_not_contact_over_cap: {
    title: 'Your Do not contact list is over its limit of 10,000 entries.',
    whatIsSaved: FINISHED_WORK_KEPT,
    whatToDo: 'Remove entries you no longer need, then press «Collect again».',
  },
  source: {
    title: 'The company sources did not return any rows for this market.',
    whatIsSaved: FINISHED_WORK_KEPT,
    whatToDo:
      'Press «Launch» on step 3 to collect this market again; if it keeps coming back empty, message Support.',
  },
  /**
   * Адрес сайта, который клиент указал сам, не привёл к публичному серверу —
   * ТОЛЬКО род `dns` HeSiteUnreachableError (lib/hypothesisEngine/stages/io.ts,
   * assertPublicWebsite: домен не резолвится, адрес невалидный или
   * приватный). Код НЕ технический (HE_RESEARCH_FINAL_STOP_CODES): «Try again» у
   * такого research нет, и кабинет его заново не запускает — поэтому действие
   * — Support. Каждая фраза правдива для любой такой строки:
   *  - «We could not open the website you gave us» — до сайта чтение не дошло;
   *  - «does not start the research again after this kind of stop» — правило
   *    кабинета, а не вывод о виновнике;
   *  - «If the site opens for you but stays closed to us» — условие, а не
   *    утверждение: DNS, который видим мы, и DNS клиента бывают разными;
   *  - «the research can work from that description instead of the site» —
   *    стадия site_profile, не открыв сайт, строит профиль по ручному описанию
   *    бизнеса (business_override), а без него отказывает; запустить research
   *    заново может только команда (staff-инструмент), и описание с шага
   *    «Brief» она застанет. Нового проекта текст не предлагает: один аккаунт —
   *    один сайт (решение владельца 10.10.2026).
   * Род `no_html` — отдельный технический код `website_no_html` ниже.
   */
  website_unreachable: {
    title: 'We could not open the website you gave us, so the research had nothing to read.',
    whatIsSaved: 'The project and everything you entered are saved.',
    whatToDo:
      'Open the address in a browser to check it. This cabinet does not start the research again after this kind of stop, so message Support. If the site opens for you but stays closed to us, describe your business in a few sentences in «Business description» on step 1 first — the research can work from that description instead of the site.',
  },
  /**
   * Сайт клиента принял соединение, но ни один его адрес не отдал HTML — род
   * `no_html` HeSiteUnreachableError (stages/io.ts, WebsiteNoHtmlError
   * websiteParser). Код ТЕХНИЧЕСКИЙ (не в HE_RESEARCH_FINAL_STOP_CODES): чья это
   * поломка, запись не говорит — так же выглядит и наш маршрут чтения, который
   * не дошёл. Поэтому у проекта с этим кодом на шаге 1 есть «Try again», и
   * текст правдив при любом виновнике:
   *  - «This can be a problem on our side as well as on the site» — ровно то,
   *    что известно;
   *  - «press «Try again» on step 1» — кнопка есть у 'failed' с техническим
   *    кодом (кроме гонки с отменой — см. WHERE_TO_RESTART); дневной лимит
   *    стартов кнопку не прячет, а отвечает на нажатие своим текстом;
   *  - «the research can then work from that description» — site_profile
   *    строит профиль по business_override при ЛЮБОМ роде недоступного сайта
   *    (stages/siteProfile.ts), а «Try again» начинает research с неё.
   * Встречается только у проекта: наружу эту ошибку пишет одна стадия
   * site_profile (шапка HeSiteUnreachableError в stages/io.ts).
   */
  website_no_html: {
    title: 'We could not read any page of the website you gave us, so the research had nothing to read.',
    whatIsSaved: 'The project and everything you entered are saved.',
    whatToDo:
      'This can be a problem on our side as well as on the site. Check that the address opens in a browser, then press «Try again» on step 1. If it stops this way again, describe your business in a few sentences in «Business description» on step 1 and press «Try again» once more — the research can then work from that description instead of the site. If it still stops, message Support.',
  },
  /**
   * Сайт открылся, но текста мало (корпус короче порога или JS-заглушка), а
   * описания бизнеса нет — HeSiteThinNeedsBusinessError (stages/siteProfile.ts),
   * только у проекта клиента ENG-кабинета. НЕ технический сбой
   * (HE_RESEARCH_FINAL_STOP_CODES): «Try again» нет, есть форма описания и «Save
   * and continue» на шаге 1. Каждая фраза правдива для любой такой строки:
   *  - «could read only a little text» — стадия отказывает, только когда
   *    прочитанного текста (без фразы JS-заглушки главной) меньше порога:
   *    и у короткого корпуса, и у заглушки, к которой доп. страницы мало
   *    добавили, и когда они не ответили в срок — прочитано правда мало, о
   *    самом сайте не утверждаем;
   *  - «stopped before building anything from it» — стадия отказывает до
   *    профиля, первой из research; про деньги не говорим (решение владельца
   *    04.10.2026: клиенту — ни слова о расходах);
   *  - «goes on from the step where it stopped» — роут продолжения возвращает
   *    в очередь ТУ ЖЕ строку site_profile, а не начинает research новым
   *    стартом; «from your description and your website» — EN-промпт профиля
   *    получает описание блоком фактов и корпус сайта (clientBriefForProfile).
   * Встречается только у проекта: пишет его одна стадия site_profile.
   */
  website_thin: {
    title:
      'We could read only a little text on your website — not enough to tell what you sell and to whom.',
    whatIsSaved: 'The project and everything you entered are saved.',
    whatToDo:
      'Open step 1 «Your business», describe in 2–3 sentences what you sell and to whom, and press «Save and continue». The research then goes on from the step where it stopped and builds your business profile from your description and your website.',
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
      'Press «Launch» on step 3 to collect this market again — a new collection checks every address from the start. If it fails again, message Support.',
  },
  timeout: {
    title: 'The step did not finish in time and was stopped.',
    whatIsSaved: FINISHED_WORK_KEPT,
    whatToDo: `Start it again — ${WHERE_TO_RESTART}. If it times out twice, message Support.`,
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
   * доплачивать ему нечего, поэтому ни слова «plan» — и, по решению владельца
   * 04.10.2026, ни слова про ёмкость вообще: заголовок общий с 'billing' и
   * 'configuration' (HE_TEAM_ON_IT_EN). «Команда уже работает» здесь правда,
   * потому что оба места записи паузы по ёмкости шлют алерт (opsAlert.ts).
   *
   * Код стоит только на базе долива, которая ничего не отдала провайдеру
   * (база 'failed' пишется лишь при недоставленном отказе). «Ничего не
   * потеряно» писать нельзя: сборка этой ночи уже оплачена. С волны 6b тот же
   * отказ пишет durable-паузу проекта, которую снимает только сотрудник;
   * запись best-effort (нет конфига или колонок — паузы нет), поэтому про
   * паузу сказано «может», а проверить её состояние отправляем в Command
   * Center.
   */
  sending_capacity: {
    title: HE_TEAM_ON_IT_EN,
    whatIsSaved: HE_REFILL_RUN_KEPT_EN,
    whatToDo: `The daily top-up of this project may be on hold until it is fixed — «Daily top-up» in the Command Center shows whether it is. ${HE_REFILL_HOLD_LIFT_EN}`,
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
      'Nothing to do here: the limit starts over each UTC day, and «Daily top-up» in the Command Center shows the state of the daily top-up.',
  },
  refill_repeat_run: {
    title:
      "Nothing from this run was added to your campaign — an earlier attempt of the same top-up run already holds its share of today's contact limit.",
    whatIsSaved: HE_REFILL_RUN_KEPT_EN,
    whatToDo: 'Nothing to do here: this was a repeat of a top-up run that had already started today.',
  },
  internal: {
    title: 'The step stopped because of a technical problem on our side.',
    whatIsSaved: FINISHED_WORK_KEPT,
    whatToDo: `Start it again — ${WHERE_TO_RESTART}. If it happens twice, message Support.`,
  },
  unknown: {
    title: 'The step stopped because of a technical problem.',
    whatIsSaved: FINISHED_WORK_KEPT,
    whatToDo: `Start it again — ${WHERE_TO_RESTART}. If it happens twice, message Support.`,
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
