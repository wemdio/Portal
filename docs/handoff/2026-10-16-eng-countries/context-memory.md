# Context notes carried over from the local Claude memory (2026-10-16)

These are the local session's working notes (not repo docs). Paths under /private/tmp or ~/.codex exist only on the owner's Mac.

## user-sergey-team
_Who the user is (Сергей Лазуткин, Portal/Polza owner) and the specialists whose feedback drives VE2 (Ксюша, Маша/Мария Захарова, Глеб, Аня)_

The user is Сергей Лазуткин (Portal profile role admin), owner/lead of the Polza studio Portal (GitHub user Wemdio). Works from a Mac in Astrakhan time (UTC+4), uses Codex Desktop and Claude Code, does the production redeploys personally, watches Requesty/Serper spend closely.

In his Telegram screenshots, a quote block headed «Сергей Лазуткин» is HIS OWN question and the bubble under it is the other person's answer — the other side is the specialist, not him (misread 2026-10-05 on Alial, whose specialist is Дмитрий К.).

Specialists who test Vertical Engine v2 and whose messages the user forwards: Ксюша (projects «Артефакт 2.0», «Аврора»), Маша = Мария Захарова (ProfiAds (M2)), Глеб («Яндекс»), Аня (VBI, seasonality feedback). A second developer works on the Serper cache and other parts in `main`.

**How to apply:** when the user pastes a specialist's message, check that project on production read-only first, then explain in plain Russian what the specialist sees and why. Related: [[sergey-release-rules]].

## sergey-release-rules
_User's rules for VE2 work — commit/push only to Sergey, no autonomous deploys since 2026-09-17, production resumes need explicit yes, user redeploys and says «сделал редеплой»_

- Code goes to branch `Sergey` (from the codex worktree, push to `Sergey`). Merges `Sergey → test → main` and the Semaphore deploy («Run Now») are the user's; on 2026-09-17 08:56 UTC the user said «стой, не делай пока больше сам деплои» — do not run deploys or merges unless asked again explicitly.
- Resuming/continuing bases on production («Продолжить подготовку», RPC calls) is a paid production mutation: propose the exact list, ask, act only on an explicit «да».
- Typical loop: agent pushes fix → user writes «сделал редеплой» → agent verifies the version on the server read-only, then reports.
- The user reads Astrakhan time (UTC+4); reports go in Russian, short, numbers in tables, no promises of results before they are measured (the user pushed back every time a partial base was called «ready»).
- Do not claim a base is ready unless it hit the 500 target; separate «ready contacts» from «candidates/rows» and from «uploaded to Instantly».

- 2026-09-23 днём: «ты сам не запускай деплой, я его делаю» — деплой (Semaphore «Run Now») делает только Сергей; ночное разрешение 23.09 на деплой больше не действует. Auto-mode классификатор тоже блокирует переход на страницу just_run.
- При слиянии test→main проверку чужих коммитов делать условием остановки (exit), а не выводом: 23.09 чужие PR #2706/#2707 ушли в main из-за этого.

- 2026-09-29, порт ENG: «придержи пуши, потом одним пушем сделаем все коммиты» — волны порта копятся ЛОКАЛЬНЫМИ коммитами в ветке `claude/eng-port-20260925` (worktree `codex-worktrees/eng-port`), `origin` не трогать до отдельного «пушь». Значит обычная точка остановки «запушенный коммит» здесь НЕ применяется: останавливаться на локальном коммите с SHA и результатами шлюзов.

**Why:** AGENTS.md release boundary plus repeated explicit user instructions in the Codex thread.
**How to apply:** default stopping point is a pushed commit on `Sergey` with SHA and validation results; anything beyond that gets a one-line confirmation request. Related: [[ve2-codex-transfer]].

## parallel-ve2-chat
_Owner develops the Russian verticals engine (VE2) himself in a separate chat in parallel; VE2 commits on Sergey from codex/ve2-* branches are his, not unknown work_

Since at least 2026-10-14 the owner works on VE2 (Russian verticals engine) in another chat at the same time as the ENG work here. Example: 02b884f84 «controlled audience contracts» + migration 20261015_0001 and a6b2b1a7b landed on Sergey via codex/ve2-editor-sergey-review (author Wemdio) while ENG audit/fixes ran here.

**Why:** both lines ship together in the next Sergey→test→main release; VE2 readiness is owned by that other chat.
**How to apply:** don't treat new VE2 commits on Sergey as suspicious or review them unless asked; keep ENG work off VE2 files (never import verticalEngineV2); before a release, remind the owner that the deploy carries both and ask whether VE2 is ready on his side. Related: [[eng-release-state-1014]], [[sergey-release-rules]].

## portal-sergey-branch-workflow
_The main Portal checkout sits on stale claude/* branches far from origin/Sergey — build the commit on a worktree of origin/Sergey before pushing there_

Verified 2026-09-22. The main checkout
(`~/Desktop/Portal-Mac-Transfer-2026-09-06-Updated/Portal`) is usually parked on
an old `claude/*` branch: that day's `claude/email-scraper-tls-20260921` was 12
ahead / **1053 behind** `origin/Sergey`, and files differed a lot (e.g.
`instantlyCampaignCatalog.ts` by 467 lines). Editing there and pushing to
`Sergey` would either be rejected or, if forced, destroy live work.

Working recipe: commit locally, then
`git worktree add <scratchpad>/sergey-wt -b <name> origin/Sergey`, cherry-pick
the commits, `ln -s` the main `app/node_modules` into the worktree, verify
(`NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit` — the default heap
OOMs on this tree; `npx jest`), `git fetch origin Sergey && git rebase
origin/Sergey` (it moves during a session), then `git push origin HEAD:Sergey`.
There is also a permanent worktree at `external-worktrees/Portal` already on
`Sergey`.

Gotchas seen: `app/scripts/espScan.ts` fails `tsc`/`next build` on the stale
branch but does not exist on `Sergey`; the stale branch's `tests/` tree is
bigger (270 vs 106 files in `app/tests/lib`), so suite counts differ between
bases — compare within one base only.

`main` also gets commits that never pass through Sergey (Dmitry Kulaga pushes
polza-outreach, sender, tg-outreach etc. to main directly). On 2026-09-23 Sergey
lacked 82 of them, so deploying Sergey as-is would have reverted them. Fix used:
`git merge origin/main` into Sergey (never rebase — shared branch), verify on the
merged tree (full jest vs both parents, `npm run typecheck:strict`, next build in
a `git archive` copy with APFS-cloned node_modules — Turbopack rejects a
symlinked node_modules), then push (65427a205). Check
`git rev-list --no-merges --count origin/Sergey..origin/main` before any
Sergey release.

**Why:** without this, "push to Sergey" silently means pushing against a base
that is months of commits away from production.

**How to apply:** never push the main checkout's branch to `Sergey` directly;
always re-land on a fresh worktree of `origin/Sergey`. Related:
[[sergey-release-rules]].

## eng-cabinet-self-serve-1010
_Owner decision 2026-10-10 — the ENG client cabinet is SELF-SERVE (client enters site, picks hypotheses, launches himself); launches must be a couple of simple buttons; plus his answers to the 7 open port questions_

Сергей, 2026-10-10, ответы на 7 вопросов порта ENG:

1. В английском кабинете работает САМ КЛИЕНТ: вставляет сайт и всё остальное, выбирает гипотезы и т.д. Главное — запуск супер простой, понятный, «в пару кнопок». Это отменяет допущение «done-for-you / клиент говорит с менеджером», на котором построены тексты кабинета раундов 1–7 («ask your manager», «your manager starts it», «only your manager can restart…») и решения «запуск создаёт кампанию на паузе, команда запускает».
2. Денежный потолок он считал штукой из V2 для поисковой выдачи — на деле это пункт нашего же плана порта (roadmap.md волна 9, в V2 аналога нет; из V2 взят только журнал расходов). Выключен.
3. Выкатка: разрешил ветку graceful stop в drain-worker.sh для worker-hypothesis-engine и память 2 ГБ — «главное чтобы ничего не сломало».
4. Отдельные ключи Requesty и Serper для ENG — да, готов дать; спросил, сколько и как назвать.
5. «Сергей, Polza» — только в ПРИМЕРЕ внутри промпта (V1 и V2 RU, помечен «пример структуры, а не текст для копирования»); письма берут подпись клиента, он такого в письмах не видел. Я зря подал это как проблему.
6. Придержанные из-за письма строки возвращать в перенос — «если нужно, давай».
7. Запретить в редакторе цепочки короче 3 писем — ок.

Карта пути клиента 2026-10-10 (~/.codex/handoffs/ve2-to-eng-port-20260920/selfserve-1010/: map.json, plan-ru.txt): сегодня 1 поле + 6 кликов, но письма не уходят без сотрудника (пресет создаёт только админ, кампании создаются на паузе и никто их не включает, конфиг добора — только руками), ~49 текстов «ask your manager», регистрация/вход по-русски, оплаты на ENG нет вовсе. На проде (origin/Sergey) регистрация на app.outreachos.xyz открыта без подтверждения почты, и создание проекта сразу ставит платное исследование — на 10-04 никто не запускал. План: 9 кругов (деньги → оплата → безопасность писем → ящики клиента → Launch включает отправку → добор без сотрудника → путь в 3 клика → тексты); 10 вопросов владельцу (ящики/пространство Instantly, автоотправка или подтверждение, оплата Stripe/цены, потолок $10/$30, добор авто 50/день, List-Unsubscribe-заголовок, прогрев 14 дней, адрес поддержки, EN Terms/Privacy, лендинг «Start free»).

Ответы 2026-10-10 (второй раз), по плану самообслуживания:
1. Ящики: будет НАШ пул неименных, уже прогретых ящиков; ENG-проекты берут ящики из него (клиент свои не подключает, прогрев не нужен). Пула пока нет — делать механизм назначения из пула.
2. Никакой проверки сотрудником нигде: клиент сам и очень легко запускает. Значит «Launch» включает отправку (кампании не остаются на паузе), без шага «команда запустит».
3. Оплата — потом, когда решат цены и тарифы. Гейта по оплате пока не делать; защита денег — подтверждение почты, лимиты, предохранитель расходов.
4. Поддержка: чат поддержки как у RU-клиентов портала (/client/support, api/client/support/*) — открыть ENG-клиентам на английском.
Вопросы 5–10 (потолок $10/$30, авто-добор 50/день, прогрев, List-Unsubscribe, EN Terms/Privacy, лендинг) он не ответил — не считать согласием.

Решения 2026-10-10 (третий раз): ОДИН АККАУНТ — ОДИН САЙТ (второго проекта нет, клиент проект не удаляет); исследование повторяется ТОЛЬКО после технической ошибки, свободной кнопки «Re-run research» нет; регистраций ENG — не больше 3 в час с одного IP. Он спрашивал, что такое «проект» — объяснять «проект = один сайт клиента».
S1 закоммичен 8844e184e (подтверждение почты, лимиты под блокировкой, чат Support для ENG, ключи HE_US_REQUESTY_API_KEY/HE_US_SERPER_API_KEY, перенос придержанных, мягкая остановка воркера + 2G); три решения — 92db78f84 (один сайт; повтор только после сбоя, окончательно только DNS-«нет домена» и отмена; форма проекта спрашивает бизнес и ЦА; 3 регистрации/ч/IP; runbook docs/runbooks/eng-change-client-website.md).
2026-10-11 «ну давай» на план S2 «запуск без сотрудника»: пул наших ящиков (3 на проект, закреплены за проектом), Launch включает отправку, Pause/Resume у клиента, ночной добор включается сам после первого запуска (50/день) с выключателем у клиента, рассылку нового аккаунта разрешает одна галочка сотрудника (по умолчанию включена, отключается настройкой) — защита от чужих рассылок с наших доменов, пока нет оплаты.

Ответы 2026-10-11 после S2 (8f54ba1f6): пул ящиков — во ВТОРОМ аккаунте Instantly, где русские клиенты outreachOS; клиент просто видит ответы на свои рассылки (страница Replies в ENG-кабинете); завершённая основная кампания продолжается автоматически, пока есть контакты; здоровье ящиков пула команда смотрит руками; страницу «подключить свои ящики» убрать из меню; Terms/Privacy — позже. Передал EN-лендинг для заглушки outreachos.xyz (~/Downloads/outreachos-english-landing) → подготовлен в deploy/static/outreachos.xyz + deploy/nginx/outreachos.xyz.conf, форма подключена к /api/demo-lead (source eng_pilot), коммит 224e6dbe7; публикация на сервер — только с его «да». Лендинг продаёт done-for-you пилот («Is this self-serve? Not yet»), что расходится с самообслуживанием кабинета — его выбор, текст от маркетолога.

Ответы 2026-10-12 по S3: сломался платный этап → письмо клиенту + сигнал команде — «ок»; рынки, отмеченные после Launch — «реши как удобнее» → решил: отдельная кнопка «Launch N more markets» на шаге 3, галочка сама денег не тратит; английские Terms/Privacy — позже (согласие без названий документов). Про блокировку спросил «где админка и что значит блокировка» — объяснил: /admin/users → карточка пользователя → «Заблокировать» = бан входа на 100 лет + выход из всех сессий (40ef24bc4, уже на Sergey); отдельно от выключателя «Выключить отправку ENG». Ответ 2026-10-12: «если бан, то всё нужно останавливать и блокировать» — бан английского клиента = нет входа + пауза всех его кампаний + отмена всей платной работы, добора и автозапуска + никаких писем о ходе работы; и «отдельное место в админке под английских клиентов, чтобы не мешать всё в одно место» → раздел «Английские клиенты». Мой выбор (сказать ему): разблокировка возвращает только вход, отправку снова включает сотрудник в новом разделе. Дизайн S3b готов (wf_7b0b40ce-05b → eng-port/.s3b-reports/design.md + map-ban-paths.md + map-admin.md + раздел Critic C1–C11/W1–W5; извлечение в scratchpad/s3b-plan.txt): отметка he_eng_account_blocks (миграция 20261013_0001), blockHeEngAccount (отметка → выключатель → бан → остановка проектов → письма → пауза кампаний), стражи G3 воркер/G5 почта/G7 фоновая проверка/G9 платный вход/G10 автозапуск/G11 добор, /admin/eng-clients, «Launch N more markets». Порядок: сначала фиксы S3 раунд 2 (wf_5f6728aa-94c) → коммит S3 → сборка S3b.

S3b ход 2026-10-12: сборка wf_0560f2cb-17f → фиксы wf_8a6d4523-d3f (серый чип «Отправка выключена сотрудником» — решение моё по его делегированию) → wf_32cd46a7-3e4 → wf_4ebbe672-e25 (упрощение: блокировка ВСЕГДА выключает Daily top-up; разблокировка ДО снятия бана доводит остановку — добор, автопилот, намерение, пауза кампаний — и при сбое оставляет бан; «Включить отправку» снова простое включение). Урок: доводить остановку в момент, когда клиент ещё не мог действовать, а не угадывать «кто включил» позже. Вопросы по бану (вход только, ящики остаются, без защиты от повторной регистрации, раздел только админам, письма из очереди снимаются, блок только из раздела + проход «Бан без остановки», исследование перезапускает сотрудник) — без ответа, сделано по рекомендациям.

2026-10-13: «всё ок, давай дальше по плану» — подтвердил все 7 решений по бану (только вход при разблокировке; ящики остаются; без защиты от повторной регистрации; раздел только админам; письма из очереди снимаются; исследование перезапускает сотрудник; недоступные кабинету кампании не держат разблокировку). Дальше по плану самообслуживания — круг «безопасность писем» (S4, wf_d2d59cd2-7d7, отчёты eng-port/.s4-reports): нейтральные EN-примеры писем + запрет «Polza/OutreachOS» в письмах чужого клиента, страница «Do not contact», настройки кампаний пула (stop_on_reply, трекинг выкл). Решено 2026-10-13: трекинг открытий/ссылок на кампаниях пула — выключить («да»); отписку (заголовок List-Unsubscribe) и почтовый адрес в подписи — «пока не делаем», хотя я объяснил, что по FTC для B2B-писем исключения нет (он считает это деловой коммуникацией, а не рекламой). Не предлагать снова без нового повода. S4 COMMITTED 822d51eda 2026-10-13 (build wf_d2d59cd2-7d7 + fixes wf_65d7b69d-a93, wf_9eb29311-020): EN-промпты пишут от компании клиента, пример — вымышленные Vandelay/Initech/Hooli, проверка бренда на всех путях отправки (запуск, reuse, добор, старт, ночная покупка), бренд в поле брифа останавливает до оплаты и попытку не съедает, stop_on_reply + трекинг выкл на кампаниях пула, страница «Do not contact». Открыто у владельца: удаление человека из идущей кампании, блок доменов, кнопка «Block» на Replies, наш ли polza.agency, read-only запрос к проду по старым шаблонам с брендом. Потом — круги 9 (исследование), 10 (надёжность), 11 (мелочи) плана покрытия, затем сквозной аудит перед одним пушем.

2026-10-14: ответы — polza.agency «не знаю» (проверил: домена нет в DNS, вопрос закрыт); «читай что хочешь» → прочитал прод: ни одного us-шаблона с Polza/OutreachOS (всего 8 us-шаблонов: 7 ready, 1 launched), в проектах ENG-клиентов только en-цепочки, таблицы he_catalog_cursors на проде нет (смена ревизии плана бесплатна), pdl_facets() есть, service_role может, ~6 с (таймаут кода 45 с — ок); «да» — убирать человека из идущих кампаний при добавлении в Do not contact (за флагом HE_ENG_DNC_REMOVE, нужна одна живая проверка на тестовой кампании с отдельным «да»); «да» — кнопка Block на ENG Replies. Сборка wf_ea2a26ac-9cf (.dnc-reports). Ответ 2026-10-14 (второй): ключи HE_US_* — «сделаю чуть позже» (напомнить перед выкаткой); стоп платного исследования при почти пустом/JS-сайте без описания бизнеса и просьба 2–3 предложений на шаге 1 — «да»; обе отдельные задачи — «ок»: (а) линейный EMAIL_REGEX и обфускация — ветка claude/email-scraper-linear от Sergey (wf_791d4c6f-19d, отчёты .linear-reports) — касается RU, после проверки пушить в Sergey; (б) защита поиска почт polzaOutreach findEmail (явное «ок» владельца на правку polzaOutreach) — в eng-port после сборки DNC/Block.

**Why:** ENG продаётся как самообслуживание; любое «спросите менеджера» в кабинете — тупик для клиента.
**How to apply:** перед правками кабинета прогнать карту пути клиента (клики, тупики, «manager»-тексты, кто подключает ящики, стартует ли кампания при запуске) и спросить у владельца только то, что из кода не следует. Связано: [[eng-landing-concept]] (лендинг — другое: done-for-you продажа через звонок), [[eng-port-coverage-1008]], [[eng-owner-decisions-1004]].

## eng-owner-decisions-1004
_Owner decisions of 2026-10-04 for ENG auto-outreach (carry unsent companies, 14-day hiring window, neutral client text + health-bot alert, no extra capacity, RU constructor untouched); committed 7dd018022 + 5e18b291b; explain to the owner in plain words_

Решения Сергея 2026-10-04 по английскому автоаутричу (реализованы в
`7dd018022` и `5e18b291b` на `claude/eng-port-20260925`, не запушено):

1. Подготовленные компании, которым не хватило дневного лимита, НЕ выбрасывать —
   переносить на следующие ночи (очередь `he_refill_carryover`, до 7 дней, только
   `us`). Это касается и ночей, когда лимит уже выбран.
2. Свежесть вакансий для поиска — 14 дней (он сказал «7–14 норм»).
3. Клиент никогда не видит про баланс, сервисы, ключи и «место» — только
   нейтральное «временная проблема на нашей стороне, команда уже работает»; это
   допустимо ТОЛЬКО там, где реально уходит уведомление в health bot
   (`opsAlert.ts` поверх общего `lib/telegram/workerAlert.ts`).
4. Мощности поиска почт не расширять: очередь пуста, медиана ожидания 6 минут,
   большие базы ~2 ч 15 мин (замер 2026-10-04). Смотреть снова, когда пойдёт
   ENG-трафик.
5. RU-задачи конструктора не трогать: зависших нет, поиск почт не платный.

**Как объяснять владельцу.** Он попросил «проще»: после ответа на жаргоне
(«кап», «окно свежести», «срез», «FIFO») сказал, что ничего не понял. Писать
простыми словами, по пунктам «что сейчас / что выбрать / я бы», без терминов.
**Не сгущать краски:** дважды назвал гипотетический риск реальной проблемой
(затор очереди, «платный» поиск почт) — перед тем как пугать, проверять факт на
проде (только чтение).

**Не ужесточать его решения при постановке задач агентам.** Он одобрил 14 дней
для ПОИСКА вакансий; я записал агентам «вакансия в письме не старше 14 дней» —
ревью потребовало проверки возраста на ручном запуске, а это новый вопрос,
который он не решал. Открыт: проверять ли возраст вакансии при ручном запуске.

Связано: [[eng-port-reaudit-0930]], [[sergey-release-rules]], [[user-sergey-team]].

## eng-release-state-1014
_2026-10-14 the whole ENG cabinet port (34 commits) was merged with Sergey and pushed (40d17e0b3); all 24 ENG migrations applied to prod main DB; HE_ENG_AUTO_LAUNCH=0 in /home/Portal/prod/.env; NOT deployed (owner postponed) — any Sergey→main release now ships it_

2026-10-14: owner wanted to demo the ENG cabinet in prod, chose «выкатываем сегодня», then «коммит и пуш в Sergey всех накопленных изменений». Done:
- Release branch claude/eng-release-20261014 (worktree codex-worktrees/eng-release) = eng-port 222987cb1 + merge of origin/Sergey; 5 conflicts resolved by hand (landing index → Sergey UTM version; HypothesisEngineView pool panel + StatusBox; workerAlert long-alert sender + Sergey sendWorkerNotice via shared sendToChats; health-check both constant blocks; emailScraper guard/maxBytes + Sergey pageCache, cache first). Gates green (typecheck:strict needs NODE_OPTIONS=--max-old-space-size=8192 when other workflows run; jest 298/3346/2). Pushed HEAD:Sergey → 40d17e0b3.
- All 24 ENG migrations (20260920_0001 … 20261013_0001) applied to prod main-postgres with owner consent («главное чтобы не повлияло на русские вертикали» — verified: VE2 code unchanged, VE function grants already in effect, authenticated can't read ve_bases). Lesson: psql -f is autocommit — LOCK TABLE needs a transaction → run each file with -1 except `-- migrate:no-transaction` (20261011_0010). zsh does not word-split $VAR in for-loops — use while-read.
- HE_ENG_AUTO_LAUNCH=0 appended to /home/Portal/prod/.env (backup .env.bak-20261014-autolaunch).
- Owner then said «не успеваем в прод» — NOT deployed. Any merge of Sergey → test → main ships the ENG cabinet (DB ready; sending can't start: pool empty, staff switch). Old prod code + new migrations: duplicate active he_jobs (site_profile/template/base_analyze/chain) now refused by unique indexes.

Update later 10-14: email-scraper linear pushed (e991995f2). Cross-wave audit wf_f078426d-334 (result scratchpad/audit-1014-result.json; plain list in tool-results/bx05fim15.txt) → «deployable_after_fixes». Release blockers: (1) ENG spends the RU Requesty/Serper balance and every cap is off → set per-client caps + separate keys; (2) direct GoTrue /auth/v1/signup with metadata market='eng' makes ENG accounts past the 3/h limit (handle_new_user trigger); (3) cabinet promises auto-launch/email while HE_ENG_AUTO_LAUNCH=0; (4) owner yes/no on RU staff-tool changes (EN letters of RU projects gated on language not market, 3000-char offer cap, fail-closed blocklist, retry pauses…). Before the first pool mailbox: staff research re-run wipes launch_info (#5), pool in account-2 leaks replies to Mailganer partner API (#6), pool-blind «Включить отправку» copy (#7); BYO send path open for ENG (#8); rollback hazard: old cron ignores refill_paused_at (#9). Pre-existing: profiles readable by any signed-in user. Also: 24 hand-applied migrations are not in public.portal_migrations — deploy Step 1.1 (ensureDatabase.js) re-runs them unless the ledger is recorded. Sergey moved on with VE2 02b884f84 (+migration 20261015_0001) not covered by the audit. Fix round wf_0f440b92-b62 on claude/eng-audit-fixes-20261014 (worktree codex-worktrees/audit-fix-1014, off Sergey a6b2b1a7b).

UPDATE 10-15 00:30 UTC+4: the ENG port WAS deployed 10-14 ~19:13 UTC (deploy re-applied and recorded all 24 ENG migrations + VE2 20261015_0001 in portal_migrations; worker 2 GiB, HE_ENG_AUTO_LAUNCH=0, 2 ENG profiles, pool 0, no us refill configs). Fix series committed: audit fixes (6 commits on claude/eng-audit-fixes-20261014; BYO sender change reverted to keep RU unchanged; idx migration renamed 20261015_0012) + eng-port DNC/thin/polza (9b32a5b0a/710e32db9/5b04a4609) cherry-picked together onto Sergey 7b6441298 in worktree codex-worktrees/push-1015 (branch claude/eng-fixes-push-20261015, DNC migration renamed 20261015_0020; one conflict in admin eng-sending route resolved); gates green (jest 3355); merge review found only minors, fixed (67d682923). PUSHED to Sergey 2026-10-15 (314fc2cf5..67d682923, 12 commits; migrations 20261015_0010/0011/0012/0020 apply at next deploy; HE_ENG_DNC_REMOVE stays off; thin-site stop + polza read guard active on deploy). RU «как было» + stop_for_company round wf_6c378ca6-0ef running on audit-fix-1014.

2026-10-15: HE_US_CLIENT_DAY_SPEND_CAP_USD=30 appended to /home/Portal/prod/.env (backup .env.bak-20261015-spendcap, owner «наверно да»); takes effect when portal + worker-hypothesis-engine are recreated (next deploy); HE_US_SERPER_USD_PER_1000 not set (Serper not counted).

2026-10-15 ~03:00 UTC+4: RU «как было» round (wf_6c378ca6-0ef) pushed to Sergey cfb8a1e32 (93dc6fdd4 letters, cfb8a1e32 launch+stages+stop_for_company). Kept for RU on purpose (deviation from «как было», owner to confirm): best-effort client blocklist in staff launch; Requesty-based cost accounting + «[оплачено и отброшено…]» suffix in llm.ts. Residual check: no RU EN chains/templates written between the 10-14 deploy and now (no Vandelay leftovers).

2026-10-15 13:02–13:04 UTC: owner DEPLOYED Sergey (main 7c3771c0f ⊇ cfb8a1e32): migrations 20261015_0010/0011/0012/0020 applied; HE_US_CLIENT_DAY_SPEND_CAP_USD=30 live; HE_ENG_AUTO_LAUNCH=0; HE_ENG_DNC_REMOVE unset. Owner: pool not yet, separate keys «скоро»; wants a full test run of the pipeline up to (not incl.) launch on a prospective client; lockdown apply tonight (prep wf_50cae902-363, also reverts RU cost accounting in llm.ts to pre-port per «верни если менял русское»; blocklist in RU staff launch kept pending his word).

2026-10-15 21:44 UTC owner deployed main with Sergey ca1330d62 (lockdown code, signup alert site line, RU cost revert); lockdown migrations skipped (already in ledger). 21:52 UTC: HE_US_REQUESTY_API_KEY (owner's new ENG Requesty key, checked: /v1/models 200) appended to /home/Portal/prod/.env (backup .env.bak-20261016-requesty-eng), portal + worker-hypothesis-engine force-recreated, both see the key; cap 30, auto-launch 0. Key file moved to ~/.Trash. Serper still shared (HE_US_SERPER_API_KEY unset). Owner: do NOT rotate the GitHub token / PEM that leaked into agent output.

Open after this: DNC removal + Block (uncommitted in eng-port worktree, wf_ea2a26ac-9cf needs_fixes: settled rows never re-checked, failed count never decays, 'on' texts overclaim) — continue on top of the release branch; thin-site research stop (approved); polzaOutreach findEmail guard (approved); email-scraper-linear 0cb0a238a (claude/email-scraper-linear, off old Sergey 46bd0e82e) must be rebased onto 40d17e0b3 (emailScraper.ts conflicts with the release merge) before push; cross-wave audit; HE_US_* keys (owner later); mailbox pool. Related: [[eng-port-coverage-1008]], [[eng-cabinet-self-serve-1010]], [[sergey-release-rules]].

## eng-site-reader-fix-1016
_ENG site reader fix (layoutAware extractor for market us + website_thin «needs your input» UI/email) merged Sergey→test→main 2026-10-16 (main 3be78aab1), deploy = nightly scheduled; the about-chain raise was dropped on purpose_

The ENG site_profile read collapsed Elementor/HubSpot/Squarespace pages to the <title>. hst.ie read as 176 chars, so a test client was refused with «site has almost no text».

Fix: commits d01f89cac, ba2a7f99e and d0471c6f5 (branch claude/site-reader-underread-20261016). They went through PR wemdio/Portal#2995 Sergey→test and PR wemdio/Portal#2996 test→main; main was merged 2026-10-16 02:43 UTC with the owner's explicit OK. At 05:43 UTC prod was still on 90d488aa5 (deployed 2026-10-15 21:44 UTC), so the fix ships with the night of 16→17 Oct or with the owner's next manual deploy. Check /home/Portal/prod/last_deploy_sha. Main is at 3be78aab1. Not deployed by hand; the owner chose «wait for the nightly scheduled deploy».
- websiteParser.ts: opt-in `layoutAware`, turned on only by ENG_WEBSITE_ROUTE in stages/io.ts (market us). If the markup is too deep for the recursive text walk (RangeError), it falls back to the legacy reader. RU output is byte-identical (564 recorded pages + 3,000 fuzz).
- Results: hst.ie 176 → 6,591 chars. 41-site sample: wrongly-thin 9 → 0 (lullabot stays refused: Cloudflare wall, a separate issue).
- Cabinet: website_thin is «needs your input», not «stopped». The dashboard route sends `awaits_description` per project, and the empty Command Center card asks for a description. The email «We need a short description of your business».

DROPPED on purpose: raising the about-page chain to 800 chars (aboutBelowChars). Three review rounds showed it could double-count the home when /about redirects to / (a thin site then passes the 800 gate). Every attempt to dedupe broke something else:
- the extra-page dedup in siteProfile.ts (`takenTexts.includes`);
- the 3,000-char cap dropping the home's tagline;
- CJK text and shuffled cards still slipping through.
It changed no outcome on the real 41-site sample, so don't revive it without solving dedupe at the corpus/gate level.

Harnesses (offline; replay misses fail with NO_LIVE=1) live in the session scratchpad site-reader/: final-review/h, harness/replay-all.sh, delta-review.

DONE 2026-10-16. The fix shipped with a deploy at 06:47 UTC (8b8580c42). With the owner's «да» I requeued HST job 625f444e (same row, two CAS updates; script in the scratchpad hst-rerun/).
- Live read: home 3,001 + 2 extra pages = 6,591 chars, site_thin false. The profile is correct (HST Solutions, Dublin, custom software/AI/cloud, ISO 27001).
- Research done at 08:49 UTC: 13 markets, 31 hypotheses, $1.88 recorded.
- A deploy launched from this Mac (the owner's other chat), 08:34–08:42 UTC, SIGKILLed the evidence stage after 10 min. It reran for free, but the killed run's spend is NOT in he_jobs/he_projects (in-memory only). That is an accounting gap for the per-client cap.
- Glued words like «DORAAligned»: blocks are concatenated without a space (a cosmetic fix, offered to the owner).

Related: [[eng-release-state-1014]], [[eng-cabinet-self-serve-1010]].

## eng-hst-client-countries-1016
_HST Solutions (first real ENG client, hst.ie) brief and owner decisions 2026-10-16 — country lock, domain DNC and Instantly time zones being built on claude/eng-countries-dnc-tz-20261016; HST data not yet written to prod_

HST Solutions is the ENG project 2971d740-1f5e-4eb9-a9e5-c04faaf8794c (Dublin, senior engineering pods for financial services).
- The filled brief (English, about 25k chars) is ~/Downloads/HST brief Outreach (Eng) completed.docx; a text copy is in the session scratchpad hst-brief/.
- Target: fund admin, asset and wealth management, banking, payments, insurance and insurtech, and B2B software vendors selling into FS/regulated markets.
- Geography: Ireland, the UK, the EU (NL, LU, DE, Nordics) and the US East Coast.
- Size: 200+ employees, or a tech team of 20+.
- KPI: 2–4 attended calls per month.
- Do not contact: agencies, consultancies, recruiters, outsourcers, and current clients (waystone.com, fundbank.com, cameramatics.com, statsports.com) plus pipeline.

Owner decisions 2026-10-16:
- No file upload in the cabinet.
- A per-project country lock is required.
- US East Coast is irrelevant: keep the whole US.
- Decision-maker (LPR) search and «tech team 20+» are out of scope.
- The time-zone dropdown should offer all Instantly zones.
- Domain-level do-not-contact is my recommendation (the owner asked «что делать»).

The prod catalog pdl_companies has 249 countries (not the 19 in the ingest script). LU has 11,102 companies, of which 537 have 201+ employees; IE has 69,903 (1,814 with 201+). Full list: scratchpad eng-countries/catalog-countries.tsv.

Still open with the owner:
- «да» to write the fields (draft in scratchpad hst-final/: staff-patch-body.json, icp.json, he-cases-rows.json, HST-поля-черновик.md), reject off-target hypotheses and rerun research (~$1.9; wipes verticals/bases).
- Blueprint Call: keep in the offer or not.
- Prototype price: €24k or €15k.
- Whether Norway counts.
- Legal check for UK/EU sending: no opt-out line, no unsubscribe header.

Related: [[eng-site-reader-fix-1016]], [[eng-cabinet-self-serve-1010]], [[no-optout-phrases-rule]].

## eng-broad-audiences-assessment-1016
_2026-10-16 read-only assessment of porting VE2's 14–15.10 «audience_scope» (broader hypotheses) to the ENG cabinet; recommendation = stage 1 (~6–7 days, flag HE_ENG_BROAD_AUDIENCES, new projects only, no migration); awaiting owner answers_

What VE2 changed. The commits are 02b884f84, a6b2b1a7b and 314fc2cf5, plus migrations 20261015_0001 and 20261015_0002. Each hypothesis is now an audience_scope:
- any_of: alternatives, OR;
- required: only the client's or specialist's explicit conditions, AND;
- excluded.
There are no quotas, at most 5 sectors and 20 segments, and invented size/hiring/tech thresholds are banned. A snapshot of the audience is pinned per base. The source plan and the relevance checks use the snapshot. A cost_policy is recorded. The change is on for new VE2 projects; old projects are untouched. No measured yield yet; the only live datapoint is Profit Gateway fintech (narrow 99 → a broad sector added by hand, 338 in a day).

ENG today. It asks for 25–40 narrow «specific segment» hypotheses (≥8 tier-3) and clusters them into 4–12 markets. Step 2 auto-ticks the top 3 by the model's own score, with no size check. PDL can only filter by LinkedIn industry, size, country and a name word, so narrow markets end up empty (Franchise Brands: 6 of 2,000), junk, or a thin name slice. HE_PLAN_MAX_TASKS=4 per plan life, and widen/dry-stop are off. The ENG nightly refill has never run on prod.

Recommendation (workflow wf_1247cce1-f51, result in scratchpad broad-audiences-result.json):
- Stage 1, about 6–7 agent-days, no migration, behind flag HE_ENG_BROAD_AUDIENCES, new client projects only:
  - 6–12 broad audiences instead of 25–40 narrow hypotheses;
  - the market description is assembled by code;
  - multiple PDL industries per task;
  - an internal size estimate, so a market under 2,000 is never auto-ticked;
  - the gate is not made stricter;
  - a dry-run replay comparing old and new, with thresholds.
- Stage 2 later, about 18–20 days with a migration: market passport, honest «market exhausted», «find more markets». Only after 2–4 weeks of a real nightly refill.
Do NOT copy VE2 exactly: it gives up to 25 markets on step 2 and turns brief size into a hard filter. The old round 12 is superseded.
Also: Serper spend of ENG is not counted (HE_US_SERPER_USD_PER_1000 unset; Serper still shared with RU).

Related: [[ve2-broad-hypotheses-idea]], [[eng-port-coverage-1008]], [[eng-cabinet-self-serve-1010]].

## no-optout-phrases-rule
_Owner rule: cold letters never contain opt-out lines («дайте знать, и я больше не буду писать») — treated as a spam marker; don't propose them; 6 campaigns violated it (2026-10-08)_

Сергей (2026-10-08): фразы вида «Если тема неактуальна — просто дайте знать, и я больше не буду писать» / «…напишите, и я больше не буду отвлекать» у нас **запрещены** — это прямой признак спама. Наш аутрич — деловая переписка в холодную, а не рассылка; кнопок и строк отписки нет. Служебный заголовок отписки (`insert_unsubscribe_header`) выключен во всех 2 559 кампаниях Instantly.

**Why:** я предложил ставить такую строку в первое письмо пилота своих серверов (чтобы меньше жали «Спам»), и он резко это отверг.

**How to apply:** не предлагать строки отписки ни в письмах, ни в запросах хостерам; хостеру описывать как «персональные деловые письма компаниям, до 25 в день с ящика». Жалобы на своих IP снижать другим: проверенные базы, малый объём с ящика, релевантность.

Факт на 2026-10-08 (raw_emails, 14 дней, 393 824 письма): прямая фраза «дайте знать/напишите… и я больше не буду…» — 3 153 письма в 6 кампаниях (ИЗИ контроль 1 095, Информатика 930, Adapta 751, Азия Шадрин 216, Аврора 161); «больше не буду писать/отвлекать» без просьбы ответить — ещё ~15 тыс. писем, обычно последнее письмо цепочки. Сообщено Сергею. Связано: [[mailbox-cost-options-2026-10-06]].

## eng-wave3-done
_ENG wave 3 (transport, deadlines, honest errors) committed 659a9418b on claude/eng-port-20260925; not pushed/deployed; 4 rounds needed, 10 pre-deploy steps, 8 owner decisions_

Волна 3 порта VE2→ENG зафиксирована 2026-09-29 как `659a9418b` на ветке
`claude/eng-port-20260925` (worktree `codex-worktrees/eng-port`), 16 файлов,
+3122/−200. НЕ отправлено на Sergey, НЕ задеплоено, миграций не добавляла.
Ревью дало `ready_for_owner`, RU-инструмент безопасен, изоляция цела, остались
4 мелких. Шлюзы: typecheck 0, 289 наборов / 3201 тест / 2 skipped, миграции
8/64, архитектура 12/12, build:workers 0, `appendLeads.ts` побайтово равен HEAD.

Что закрыто: типизированные классы сбоя транспорта с Retry-After и одним сроком
на попытку; ОДИН признак живости (лог, прокси БД, ввод-вывод, слой модели)
кормит ОДИН сторож простоя, окно выводится как max(20 мин, 1,5 × срок попытки);
центральный страж в `handleJob` ловит abort, проглоченный стадией; пауза по 429
тратит попытку (потолок вернулся к 3 прогонам); идемпотентный повтор done-записи
с расходом до отказа; санитизация jsonb; постоянный отказ Serper терминален,
транзиентный — нет; полная авария поиска останавливает стадию до платного
вызова; `requireCompleteJson` только у `segmentClassify`, гейт релевантности
остался fail-open.

**Почему четыре раунда.** Каждый раунд закрывал находки и вносил новую регрессию
оплаты в соседнем месте — этот движок ловил баг «платим дважды» трижды до волны.
Что помогло: считать в каждом ревью «сколько полных платных прогонов стадии в
худшем случае, на HEAD и сейчас» по каждому классу сбоя, и требовать цитату
судимых строк в находке (ложный майор про «guard не написан» стоил раунда, guard
был на сто строк ниже объявлений).

**Оборванные потоки.** Третий раунд записал правки на диск и подвис, не вернув
отчёт: дерево компилировалось и тесты проходили, но в `brandCloud.ts` остался
докблок с объявлениями без самой защиты. После обрыва потока всегда искать
недописанную правку по mtime файлов, а не доверять зелёным шлюзам.

Сводки и решения владельца: `.wave3-reports/lane-review.md` и
`lane-g-recovered.md` в worktree. Связано: [[eng-port-delta-0925]],
[[eng-wave2-done]], [[sergey-release-rules]].

## eng-wave6a-cursor
_ENG wave 6a part 1 committed ca5897b2e (catalog bookmark outside he_bases, plan reuse, honest exhaustion, size thresholds); migration 20260930_0002 written, not applied_

Волна 6a (часть 1) порта VE2→ENG зафиксирована 2026-09-29 как `ca5897b2e`,
5 файлов, +1523/−128. НЕ отправлено, НЕ задеплоено. Миграция
`20260930_0002_he_catalog_cursor.sql` написана и НЕ применена.

**Три поправки к плану, каждая — суть пункта.** Закладка живёт ВНЕ `he_bases`
(в V1 каждый ночной добор создаёт новую базу с пустым `collect_info`, поэтому
закладка внутри задачи не имела бы ни писателя, ни читателя). Ключ по времени
вставки, а не по id: у `pdl_companies`/`funded_companies` id текстовые и с
порядком вставки не связаны, закладка по ним пропустила бы именно свежие
строки. План переиспользуется — иначе ключ по фильтрам бессмыслен, план это
платный вызов модели каждую ночь.

**Курсор двигается только по закрытому префиксу** — подряд идущим строкам, с
которыми у проекта покончено. Префикс и закладка пишутся одной записью; падать
только когда фиксировать нечего.

**Урок про мутабельные строки.** Ревью поймало: строки `eng_hiring_cache`
переписываются ингестом на месте (upsert по `(source, source_job_id)`, где ключ
схлопывает фид в одну строку на компанию), а `created_at` остаётся от первой
вставки. Закрывать префикс по несовпадению роли было нельзя: компания, у которой
сегодня «Account Executive», через месяц держит в той же строке «Head of Sales»
и навсегда осталась бы позади закладки. **Правило: закладке разрешено двигаться
только по тому, что закрыто НЕЗАВИСИМО от содержимого строки** (уже собрано
проектом, пустое имя). Перед keyset-закладкой всегда проверять, переписывается
ли строка источника на месте.

**Ключ переиспользования плана содержит ревизию кода** (`HE_SOURCE_PLAN_REVISION`):
вход промпта — не единственное, от чего зависит сохранённый план; правка самого
промпта или правила снятия порогов иначе выкатилась бы и не подействовала.

Связано: [[eng-wave5-done]], [[eng-port-delta-0925]], [[lead-sources-yandex-archive]].

## eng-wave6a-yield
_ENG wave 6a part 2 committed 6f01ebdf5 (contactable rows first per task, plan widening ladder, dry-vertical stop); migration 20260930_0003 written, not applied_

Волна 6a (часть 2) зафиксирована 2026-09-29 как `6f01ebdf5`, 13 файлов,
+1649/−80. НЕ отправлено, НЕ задеплоено. Миграция `20260930_0003_he_vertical_dry.sql`
написана и НЕ применена; в `20260930_0002` добавлена колонка `widen_failed_at`.

**Контактные строки вперёд — но только внутри задачи.** Межисточниковая
сортировка выбросила бы вертикаль, живущую только на сигнале найма, и убила бы
название вакансии как крючок персонализации; `interleaveTaskHarvests` стоит там
намеренно. Замер на реальном модуле: при limit 2000 и трёх задачах контактных
строк в базе 1301 → 2000, доли источников не изменились.

**Денег это НЕ экономит, и посылка плана опровергнута:** бесконтактная строка
конструктору ничего не стоит (find_emails и check_sites работают только по
строкам с url), гейт от порядка не дешевеет. Правка меняет НАЗНАЧЕНИЕ тех же
оплаченных слотов: 2000 компаний с контактом вместо 1301. Плюс перестаём
выжигать компании впустую — попавшая в не-failed базу компания исключается из
всех будущих сборок проекта навсегда, а срезанная капом нет.

**Лестница ослабления порога** обязана подчиняться тому же правилу, что и
снятие порога: ослаблять можно, только если срез сужает что-то ещё (индустрия
или имя; `countries` не считается — это рынок, а не срез). Ревью поймало, что
без этой проверки второй шаг лестницы обходил запрет и давал нефильтрованный
каталог.

**Безрезультатная платная покупка среза помнится у ПЛАНА**
(`he_catalog_cursors.widen_failed_at`, окно неделя), а не в `collect_info` базы:
базы ночные, отметка в одной базе следующую ночь ни от чего не удерживает.
Общий приём: **состояние, которое должно пережить ночь, кладите туда, что живёт
дольше ночи.**

**Сухая вертикаль** перестаёт брать ночной слот после N ночей без единого
добавленного контакта; прогоны `failed` в приговор не идут (это наша авария, а
не молчание рынка), пометка видна и снимается клиентом. Снятие пометок при
выключенном флаге идёт РАЗОМ ПО ПРОЕКТУ до цикла — внутри цикла до вертикали за
пределами ночного бюджета можно не дойти.

Связано: [[eng-wave6a-cursor]], [[eng-wave5-done]], [[ve2-yield-speed-2026-09-21]].

## eng-wave6b-done
_ENG wave 6b committed 4f5edef6b (atomic daily refill reservation, release-not-burn, durable capacity pause, skip-flag measurement); migrations 20260930_0004/0005 MUST be applied BEFORE the code_

Волна 6b порта VE2→ENG зафиксирована 2026-09-30 как `4f5edef6b`, 17 файлов,
+2768/−133. НЕ отправлено, НЕ задеплоено.

**Порядок выката здесь — условие, а не пожелание.** Бронь дневного бюджета
fail-closed: миграции `20260930_0004` (бронь) и `20260930_0005` (пауза по
ёмкости) применяются ДО кода. Код раньше миграции = ноль отправок при уже
оплаченном сборе, а со второй ночи по одной сожжённой базе на вертикаль.

**Урок волны: новый механизм безопасности сам стал способом терять деньги.**
Бронь дня без права перехвата превращала смерть воркера в потерянную ночь:
повтор той же базы получал «уже забронировано», не отправлял ничего, база шла в
`analyzed`, компании выжигались; мёртвая бронь держала счёт до конца суток, и
остальные вертикали ночи выжигали свои базы тоже (до 50 лидов и 600 строк за
ночь, на HEAD не терялось ничего). Лечение двухуровневое: та же база может
перехватить СВОЮ зависшую бронь (окно 2 часа — вчетверо больше самого долгого
законного молчания стадии), а ночь, отправившая ноль, обязана ОСВОБОДИТЬ
компании. Правило на будущее: **добавляя ограничитель, посчитай, что он делает
при смерти процесса посередине.**

**appendLeads.ts остался байт-в-байт.** Трассировка «лид → строка базы» прошла
через уже существующие необязательные поля; второго журнала не завели. Ключ
НЕ позиционный (нормализованное имя компании): `persistRefillBase` переписывает
`he_bases.data` целиком, и под тем же индексом завтра лежит другая компания.

**Решение владельца, сознательно не принятое:** построчный терминальный исход
доставки. Расширение общего `client_campaign_contact_ledger` оживило бы сейчас
мёртвые ветки отчётности платящего RU-клиента и изменило бы его цифры в тот же
день; альтернатива — свои таблицы и второй источник правды.

Связано: [[eng-wave6a-yield]], [[eng-wave5-done]], [[sergey-release-rules]].

## eng-wave7-gate-done
_ENG wave 7 part 1 committed db1ec2793 (gate target without the seller motive, no half answer accepted, batch split 50/10/1); no migration_

Волна 7 (часть 1, гейт релевантности) зафиксирована 2026-09-30 как `db1ec2793`,
3 файла, +719/−59. Миграции нет. НЕ отправлено, НЕ задеплоено.

**Почему гейт дороже, чем кажется.** В V1 помеченная строка не «уходит на
проверку», а ВЫРЕЗАЕТСЯ — из запуска и из ночного добора, состояния
`needs_review` нет. Значит лишняя пометка молча удаляет подходящую компанию, а
недостающая отправляет мусор, который бьёт баунсами по собственному домену
клиента. Поэтому каждое изменение промпта помечалось «строже» или «мягче» с
ценой направления, и это стоит повторять в любой правке гейта.

**Корень:** стадия сбора кладёт в цель отбора summary вертикали, а английский
промпт кластеризации ОБЯЗЫВАЕТ этот summary содержать «почему они покупают» —
мотив продавца внутри описания покупателя. Убрать summary из цели нельзя
(гейт станет мягче), поэтому лечение — закрытый перечень того, что строка
обязана доказать (вид деятельности и тип компании), и явное «пустое поле не
довод против строки».

**Строгость схемы — только английской ветке.** Снятие `.default([])` имеет
смысл вместе с указанием «ключ возвращай всегда», а его дописали лишь в
английское сообщение: RU-промпт обслуживает ежедневный инструмент и не
меняется. Строгая схема при неизменном промпте — не защита, а лишний повтор
(на чистом батче модель законно отвечает пустым объектом). Общий приём:
**ужесточая контракт ответа, ужесточай и промпт — в той же ветке.**

Опровергнуто по ходу: процитированная в плане защита «ответ без поля»
недостижима (её закрывал дефолт схемы); настоящая дверь — тот же дефолт плюс
ремонт усечённого JSON; уменьшение батча до 20 в V2 обслуживает другой промпт.

Связано: [[eng-wave6b-done]], [[eng-port-delta-0925]].

## eng-port-reaudit-0930
_Full re-audit of the ENG port (13 commits) — 101 of 115 findings confirmed even after per-wave reviews; fixed in 0c802b2a4 + 292033e6c; report and raw data in ~/.codex/handoffs/ve2-to-eng-port-20260920/audit-0930_

Повторный аудит всей ветки `claude/eng-port-20260925` (13 коммитов до
`db1ec2793`) сделан 2026-09-30…10-02 по просьбе пользователя «пройдись ещё раз по
всем волнам с перепроверкой». 19 аудиторов → 164 находки → 115 уникальных →
**101 подтверждена** независимой перепроверкой (10 важных, 91 мелкая), 14
опровергнуто. Исправлено в `0c802b2a4` (53 файла) и `292033e6c` (хвосты).
Отчёт: `~/.codex/handoffs/ve2-to-eng-port-20260920/audit-0930/report.md`,
сырые данные — `raw-result.json` там же.

**Главный вывод: поволновое ревью пропускает почти всё межволновое.** Каждая
волна прошла своё ревью с `ready_for_owner`, а сквозной аудит нашёл 101 дефект.
Типовые классы: поздняя волна тихо меняет поведение RU-инструмента (rate limit в
evidence перезапускал стадию с начала — до 3 оплат; новый поток гейта работал и
для RU); обещание волны верно только для первого раза (6b: «ночь без отправки не
сжигает компании» — только первая ночь подряд); закладка по времени вставки
теряет строки любых источников, переписываемых на месте, не только по роли.
**Перед единым пушем большой ветки сквозной аудит обязателен.**

**Приёмы, которые сработали.** Аудит на ОТДЕЛЬНОМ чистом checkout коммита
(параллельная волна правила рабочее дерево). Три независимых проверяющих на
каждую важную находку с разными линзами — воспроизвести по шагам / цена /
нет ли уже защиты; 17 «важных» понижены. Полоса правки обязана закончить каждую
находку в одном из трёх состояний (исправлено / доказано не дефект / владельцу).

**Грабли воркфлоу.** Длинный прогон (193 агента) подвис хвостом из-за
инфраструктуры — возобновлять по runId с ПРАВКОЙ скрипта: подвисший агент не
должен валить прогон, «не проверено» ≠ «опровергнуто». Субагенту запрещено
писать файл отчёта — синтез отдаёт текст, файл пишет главный. Скрипт для resume
должен лежать в рабочей директории.

Открыто для владельца (полный список в отчёте): кап 50 против порога сборки 100
компаний; окно свежести ленты найма 3 дня против расписания ингеста; алерт
команде на отказы биллинга (иначе клиенту нельзя писать «команда знает»);
поведение крона при затяжной перегрузке очереди конструктора.

Связано: [[eng-wave7-gate-done]], [[sergey-release-rules]], [[eng-port-delta-0925]].

## eng-port-coverage-1008
_2026-10-08 item-by-item check of the ORIGINAL ENG port roadmap vs HEAD 5e18b291b — 27 closed, 35 partly, 52 not done; 12-round plan; round 1 started_

The roadmap-v2 delta (09-25) listed only NEW items per wave, so from wave 3 on many ORIGINAL roadmap.md items were never done. Check of 114 original items at HEAD 5e18b291b: 24 done, 2 superseded, 1 refused by owner (opt-out line), 35 partly, 52 not done. Wave 8 (letters) and 9 (spend journal/ceiling) untouched.

Artifacts: ~/.codex/handoffs/ve2-to-eng-port-20260920/coverage-1008/coverage.json (per item status/evidence/missing) and plan-ru.txt (12 rounds in plain Russian + owner questions + dropped items).

Verified by hand before telling the owner: Cancel does not stop the nightly refill (autoPipeline reads configs.enabled only); "Hello {{firstName}}" in EN prompts while ENG bases have no first-name column and an unresolved operator does not block 'ready' → "Hello ,"; Re-run research → clustering deletes he_verticals → cascades to he_bases/he_templates.

Round order: 1 cancel+no double pay → 2 launch safety → 3 letter text → 4 spend journal/ceiling → 5 nightly refill → 6 relevance gate → 7 cabinet truth → 8 letter editor/approval → 9 research → 10 reliability → 11 cosmetics → 12 broad hypotheses (owner yes needed).

Round 1 committed 2026-10-09 as 96289f914 (cancel stops refill/autopilot/constructor jobs; CAS on every he_jobs transition; one template/analysis per base via 20261008_0001; research-rerun confirm; jsonb-safe writes). HE_AUTO_RESUME_TRANSIENT must stay off until a durable project cancel marker exists. Round 2 committed 1a299008c (operator gate + empty-cell stand-ins, US source allow-list, cross-base domain/email identity, segment hold with one retry, empty mailbox pool refused, US window on staff path). Round 3 committed c6db6ad29 (no invented materials, client words verbatim, EN number check, exactly 4 letters, critic rollback only on numbers/send gate, company-name cleanup deterministic, refill skips a night the letters would hold). Round 4 committed 0ff9895c0 (journal application_logs source he_provider_usage, staff cost route, ceiling env HE_US_PROJECT_SPEND_CAP_USD / HE_US_PROJECT_DAY_SPEND_CAP_USD rolling 24h, OFF by default, migration 20261009_0001 server-side sum). Round 5a committed bcf414bf8 (fair slot rotation, health-check dead-cron alert HEALTH_HE_REFILL_*, orphan collecting repair, he_projects.cancelled_at marker 20261009_0002 + auto-resume respects it, segment-aware refill with re-send to main on a dead segment campaign, late constructor import + staff revalidate route). Round 6+7 committed 4f7e9db08 (gate untrusted-data rule; hypothesis scope behind HE_GATE_HYPOTHESIS_SCOPE off; ICP frame on Brief; brief form fix; created-paused/attention/not-selected/market-fit; sent letters on Review; chain waits kept; editor ≥3 letters). Then owner pivot to SELF-SERVE (see [[eng-cabinet-self-serve-1010]]); S1 committed 8844e184e, owner limits 92db78f84, S2 sending-without-staff 8f54ba1f6 (27 local commits; pool he_sending_pool 3/project, Launch activates only with start_sending:true in the ENG route, staff account switch he_eng_sending_access, Pause/Resume/Start the rest, cached status+counts, auto refill config + client switch, migrations 20261011_0001/0002). Then landing 224e6dbe7 (deploy/static/outreachos.xyz, publish needs owner yes) and S2b 77643a1c2 (ENG Replies page from instantly_activity_events with foreign-mailbox filter, completed main auto-continues via startHeEngLaunchSending('refill'), pool workspace HE_US_POOL_WORKSPACE default account-2 and never main, ENG own-mailbox connect closed). 29 local commits. Open owner question: partner Mailganer /api/partner/activity pulls ALL events of account-2 (already RU outreachOS data; ENG would join). RU htmlToText quadratic fixed 2026-10-11 (6fe9ae7e7), rebased and PUSHED to Sergey 2026-10-13 as 612aab0b8 (owner «тоже в Sergey»): tag regexes run only up to the last '>', per-line space trim, anchor scan stops at the first <a> without '>'/</a>; byte-identical on ~216k fuzz inputs. Symlinked main node_modules lacks typescript-7 → use typecheck:strict there. S3 «path in a few clicks» built 2026-10-12 (wf_76af530c-092, UNCOMMITTED in eng-port, reports .s3-reports): 3-step wizard, recommended markets pre-ticked, project Launch → worker auto-launch tick (engAutoLaunch → runHeEngTemplateLaunch in engClientLaunch.ts, same as «Launch now»; kill switch HE_ENG_AUTO_LAUNCH=0), client emails (engClientMail, he_eng_client_emails), English auth, rewrite route; migrations 20261012_0001 (auto launch, BEFORE code) / 0002 (emails). Two fix rounds (wf_7a13b95d-42a, wf_5f6728aa-94c) → S3 COMMITTED f7e13f58d 2026-10-12 (30 local commits; gates green). Left for S3b: step-3 cards do not yet tell our-side (billing/config) stops apart; 12 minors in .s3-reports/fix2-*. S3b (full ban + /admin/eng-clients + «Launch N more markets» + S3 leftovers) COMMITTED 3fb8f80b1 2026-10-12 after build wf_0560f2cb-17f and 4 fix rounds (reports .s3b-reports/build-*, fix*-*); 31 local commits; migration 20261013_0001 before code; after deploy walk the «Бан без остановки» chip. Final design: block always turns Daily top-up off; unblock re-asserts the whole stop BEFORE lifting the ban (presses accumulate, unreachable campaigns named for a hand pause, known workspace without key holds); «Включить отправку» plain. 8 minors left (see wf_e285e139-898 synthesis).

Rounds 9–11 COMMITTED 2026-10-13 as bfb41c5eb (build wf_2bc1cca7-abd + fixes wf_608adb94-714, wf_8f0ef930-837; reports eng-port/.r9-11-reports): strict page fetch + SSRF per-hop guard + 3 MiB cap (enrich/publicAddress.ts createUsWebsiteFetchGuard, own servers 139.60.162.24/.12, 144.31.54.166, 89.19.209.252, ports 80/443 only for us), evidence free resume after progress + last-attempt drop, wishes never facts (profile + EN letters), provider/DB blip backoff 60/120 s, child timeouts, PDL labels, cabinet run-days/ready-to-send/top-ups. Constructor guard (owner task «Guard the base constructor's site fetches») COMMITTED 222987cb1: EN (locale en) find_emails + enrich_descriptions guarded/capped; find_emails allows https→http (no cert checks anyway); RU and other scrapeEmails callers byte-identical; also covers V2 us constructor jobs. 34 local commits. Open: quadratic EMAIL_REGEX (all callers), polzaOutreach findEmail without guard, proxy route no connect-time check.

**Why:** don't assume a wave is complete because its delta section is; always check the original roadmap too.
**How to apply:** continue round by round on claude/eng-port-20260925 (local commits, no push); reports in eng-port/.roundN-reports. Related: [[eng-port-reaudit-0930]], [[eng-owner-decisions-1004]], [[eng-v1-port-from-v2]].

## main-db-anon-exposure-1015
_2026-10-15 confirmed on prod and anon part hotfixed same night — public anon key reads/writes many main-DB tables and runs 25 SECURITY DEFINER functions (agent_query_readonly = arbitrary SELECT); clients see staff data via open policies; hotfix SQL + full lockdown in progress_

Found while doing the profiles lockdown (owner's task). Verified by read-only catalog queries plus one zero-row anon probe (client_tariffs 206 */25, client_instantly_access 206 */19, rpc agent_query_readonly('select 1') 200; profiles direct 401):
- Kong lets anon through /rest/v1; anon has ALL grants on ~241 public tables (Supabase default privileges of supabase_admin also grant anon on every NEW table/sequence/function).
- 59 public tables have RLS off; 180 permissive policies on 115 tables use true / auth.role()='authenticated' / auth.uid() IS NOT NULL — so any signed-in client (RU, self-serve ENG, demo) passes; misnamed «Service role full access … TO public USING (true)» policies open whole tables.
- 25 SECURITY DEFINER functions executable by anon (PUBLIC); agent_query_readonly runs any SELECT over public as superuser; cleanup_* delete tasks/notes/logs.
- profiles has prod-only policies «Public profiles are viewable by everyone.» and «Profiles are viewable by authenticated users».
- No app path uses anon for tables (public pages go through service-role API routes; health-check pings /rest/v1/ root only). Deliberate anon policies: reglament_documents, companies_directory, database_review_row_marks.

Artifacts in session scratchpad profiles-lockdown/: hotfix-rpc-anon.sql (+rollback, ACL snapshot rpc-acl-before.txt), hotfix-anon-tables.sql (+exact rollback from anon-acl-before.tsv), prod-exposure.tsv, preflight-prod.out, PGlite harness (real Postgres 18 WASM from ~/.codex/handoffs/ve2-final-letters-20260909/runtime). Profiles design: restrictive «own row or is_internal_staff()» policy, 181 harness checks (wf_c3cd1c1d-199). Full lockdown map/design wf_7f970b55-839. Worktree codex-worktrees/profiles-lockdown, branch claude/profiles-read-lockdown-20261014.

APPLIED 2026-10-14 ~21:50 UTC (00:50 MSK 10-15) with owner «да»: hotfix-rpc-anon.sql (anon/PUBLIC lose EXECUTE on the 25 definer fns; authenticated kept only copilot_dialog_stats + tg_outreach_swap_proxy) and hotfix-anon-tables.sql (anon loses all public table/sequence privileges except reglament_documents/companies_directory select, database_review_row_marks select+insert). Verified: anon 401 on client_tariffs/agent_query_readonly, companies_directory 200, no 401/403 among 28k Kong requests, no permission errors in workers. Rollback files (exact ACL snapshots) copied to codex-worktrees/profiles-lockdown/docs/security/2026-10-15-anon-hotfix/. NOT yet in repo migrations — Supabase default privileges still grant anon on NEW objects; authenticated-level (clients) exposure still open.

Forensics (nginx access.log on .24, starts 2026-09-05, not rotated, 17.7 GB): no external calls to any exposed RPC; external non-browser /rest/v1 traffic = sender nodes 84.21.173.12, 45.84.222.124, 45.84.222.95, 77.239.125.235 (service, still 200 after the hotfix) + 95.25.7.41 Python-urllib (our own debugging 09-08/09) + scanner curl to /rest/v1/ root (301). Browser traffic cannot be told apart. Lockdown migrations 0031–0036 designed (wf_7f970b55-839, result scratchpad profiles-lockdown/lockdown-map-result.json): RU client readable tables 238→18, staff unchanged in 16,720 checks; repo implementation wf_8d0560f3-355.

Lockdown series COMMITTED LOCALLY (NOT pushed — any Sergey→main deploy would auto-apply in Step 1.1 with workers running) on claude/profiles-read-lockdown-20261014 (worktree codex-worktrees/profiles-lockdown, base Sergey cfb8a1e32): e7b8fba4f migrations 0030–0036 + supabase/operator-sql rollbacks/preflights + docs/security/2026-10-15-anon-hotfix (README, verify.sql); 43b1f2757 code (Telegram agent staff-only, parse-pdf own-JWT, manual-scoring owner filter, ensureDatabase retries 40P01/57014); b7ce8d040 deploy restore scripts (fix-roles, reapply-privileges.sql, finish.sh). Apply plan: read-only preflight → rehearsal script (to write; all files in one tx + rollback) in a quiet window with ALL workers stopped → merge+deploy. Known gaps: Bench robot pdl_companies ilike becomes a full scan (switch to rpc search_pdl_companies); .semaphore select-deploy-targets lacks supabase/operator-sql → DEPLOY_ALL; 0036 LOCK on matviews (none today). Owner questions pending: window, secret rotation, 3 public tables, client job inserts → service role, staff writes on access tables, nick_ro login, migrationLint it() approval.

NIGHT PREP DONE (wf_50cae902-363, 2026-10-15 ~17:00 UTC): branch claude/profiles-read-lockdown-20261014 rebased onto main 7c3771c0f → 98e6d4efb/d3c7d7dd5/7b5dd9fb5 + 997e90c0b (0030 no (select) subqueries — prod's hand-made «Admins can update/insert profiles» policies caused 42P17 on every profile write; 0035 locks storage.objects, compares staff before/after) + e14fa56ad (Bench name search via rpc) + c34ed7030 (operator-sql apply.sh/rehearsal.sh/smoke.sql + docs/security/2026-10-15-lockdown-night-runbook.md). Migration sha256 prefixes 5cea3779 b80c70d9 d6352cdc 9f42d78d dec7a7ff fe1a0178 5227dcc2. Names share numbers with VE 20261015_0030_ve_*/0031_ve_* — tested fine, not renamed. Window 20:00–21:00 UTC (00:00–01:00 UTC+4), drain 19:50 UTC; steps in night-result.json synthesis.night_steps; start workers with docker start (not compose up — config-hash drift). Slips during prep: an agent printed the portal GITHUB_TOKEN and a PEM key from portal-worker-baseconstructor env into tool output (owner asked to rotate); a psql \o wrote temp files to main-postgres /tmp (removed). RU cost revert 2de6e569e local on push-1015 (needs «да» to push).

**Why:** the anon key is public; open signup means «authenticated» ≈ anyone.
**How to apply:** hotfixes need the owner's «да»; repo migrations 20261015_0030+ go through Sergey with his OK; don't re-open by restoring with deploy/main-db-prod/fix-roles.sql. Related: [[eng-release-state-1014]], [[portal-prod-db-access]].

## lockdown-night-1015
_Main-DB lockdown 0030–0036 APPLIED on prod 2026-10-15 19:55 UTC unattended (owner pre-approved); all checks clean; code pushed to Sergey ca1330d62_

Owner answer to «Как делаем с ночным применением?» = «Делай сам в 00:00». Scope of that «да»: stop the 55 portal-worker-* (compose stop -t 60), rehearsal, apply 0030–0036 (supabase/operator-sql/20261015_lockdown_apply.sh --yes), start the SAME containers with docker start, smoke/probes, 15-min watch. Runbook: codex-worktrees/profiles-lockdown/docs/security/2026-10-15-lockdown-night-runbook.md; ordered steps with expectations: scratchpad profiles-lockdown/night-result.json → synthesis.night_steps.

Auto rules agreed (owner away until morning):
- Any read-only pre-check off-baseline (hashes, fingerprint, ledger beyond the allowed 0040 deviation), or the 18:00 UTC backup not «Dump complete» by ~20:15 UTC → do not start; report in the morning.
- Rehearsal fails → do not apply; docker start the workers; report.
- Apply stops mid-way, or post-apply smoke/external probes fail, or 42501/42P17/RLS errors in portal/worker logs within the 15-min watch → full rollback (runbook §9 loop, reverse order, keep ledger rows), docker start workers, report.
- No merges/deploys expected 19:30–20:45 UTC; if main/prod moved, re-check per runbook before proceeding.
Owner also created a new Requesty key for ENG (HE_US_REQUESTY_API_KEY) — needs a safe hand-over (file on the Mac, never printed) and a recreate of portal + worker-hypothesis-engine with «да». Related: [[main-db-anon-exposure-1015]].

EXECUTED 2026-10-15 (UTC): pre-checks OK (hashes, fingerprint 3cd4a386, ledger only +0040 accepted, catalog 0|0|0, Instantly PASS, backup main-full 13.6 GB Dump complete 19:14, worker drift: 55 same). Drain 19:51–19:53 + compose stop -t 60; check passed. Rehearsal 19:54 PASS (files 3.5 s, wall 7.7 s). APPLY 19:55:26 — 7 files, 1 try each (0030 49 ms … 0033 897 ms, 0034 807 ms). Smoke after: 52 PASS, 0 FAIL, end state = rehearsal fingerprint (policies 1023, restrictive 306); Instantly PASS. Workers docker start 19:56 — same 55 containers/images, all running (background stopped ~4 min). External anon probes: profiles/rpc/projects/client_tariffs 401, companies_directory 200. First watch: no 42501/42P17/RLS errors in portal or workers, sender all 2xx (no 5xx). Logs: ~/lockdown-night-20261015 (watch.log). Watch +5/+15/+45 min clean (502s at the pre-window rate). Series rebased onto Sergey and PUSHED 2026-10-15 ~20:45 UTC (694d48fd8..ca1330d62, incl. docs/security/2026-10-15-lockdown-applied.md); migration bytes identical, ledger has all 7 rows so the deploy skips them; code (Telegram agent staff-only, parse-pdf, manual-scoring, Bench name search via rpc, ensureDatabase retries, restore scripts) ships with the owner's next deploy. Backup branch claude/lockdown-applied-backup-20261015 = pre-rebase HEAD.

## outreachos-pro-mail-auth
_Portal transactional mail (ENG email confirmation, password resets) goes via smtp.gmail.com as no-reply@outreachos.pro; until 2026-10-15 the domain had no SPF and no DKIM key in DNS while Google signed with DKIM → Gmail silently dropped mail; fixed via Reg.ru API_

Symptom 2026-10-15: ENG cabinet «Confirm your email» letters never arrived (not even in Spam), though SMTP accepted them (app_logs signup.eng_verification_sent / client.eng.verify_email.resent).

Cause: no-reply@outreachos.pro is a user in WS1 (polzaagency.ru Google Workspace). DKIM signing for outreachos.pro was already ON in Google Admin, but the google._domainkey TXT was never published, and the apex had no SPF. So DKIM failed and SPF was none, and Gmail dropped the mail.

Fix with the owner's «да»: via the Reg.ru API from the prod server (REGRU_USERNAME/PASSWORD in /home/Portal/prod/.env; the server IP is allowlisted), added:
- TXT google._domainkey = Google's 2048-bit key;
- TXT @ = «v=spf1 include:_spf.google.com ~all».

Both were visible on public DNS in ~6 min. A test letter to the owner's Gmail arrived. DMARC p=none already existed. outreachos.pro and outreachos.xyz DNS are both at Reg.ru (ns1/ns2.reg.ru) and editable through the same API. outreachos.xyz has no mail records.

Open:
- Consider sending ENG client mail from an English domain (outreachos.xyz) instead of the RU outreachos.pro.
- The owner's test ENG account wemd1337@gmail.com (user 1ca971f1-…) was marked verified by hand (he_eng_email_verifications.verified_at).

Related: [[eng-cabinet-self-serve-1010]].

## eng-outreach-landing-state
_outreachos.xyz EN landing PUBLISHED 2026-10-12 by hand (static /var/www/outreachos-xyz + nginx vhost + LE cert); app.outreachos.xyz = ENG cabinet; where RU landing source and EN translations live_

UPDATE 2026-10-12 (owner «сделай», session permission switched off auto mode): landing from eng-port commit 224e6dbe7 published on 139.60.162.24 — files /var/www/outreachos-xyz (8 files, index sha256 8d866066…), vhost /etc/nginx/sites-available/outreachos.xyz (symlinked; == repo deploy/nginx/outreachos.xyz.conf), cert certbot webroot /var/www/html with renew_hook «systemctl reload nginx», expires 2027-01-10. https 200, http→301. Test lead from the real form landed in demo_leads (email landing-test@outreachos.xyz, source «unknown» until the portal with eng_pilot is deployed; row left in place, marked TEST). Rollback: rm /etc/nginx/sites-enabled/outreachos.xyz && nginx -t && systemctl reload nginx. NOT in the deploy pipeline — landing updates are manual (scp to /var/www/outreachos-xyz). Server oddity seen, not touched: sites-enabled holds *.pre-ip-rewrite copies of app.outreachos.xyz and polza-portal.ru that nginx also loads («conflicting server name» warnings).

UTM 2026-10-13: branch claude/landing-utm (worktree codex-worktrees/landing-utm, off origin/Sergey 957993dd0): 115b12a07 = cherry-pick of the landing commit (eng-port 224e6dbe7 — identical patch, rebase of eng-port will drop it once this lands) + 103f2f79c UTM (landing script keeps utm_*/referrer/landing in sessionStorage + oos_utm cookie Domain=outreachos.xyz 30 days in the RU format; latest non-empty UTM wins; /api/demo-lead stores demo_leads.utm (migration 20261013_0001_demo_leads_utm, insert retries without it) and the TG alert shows «📈 UTM: src / medium / campaign (заход … МСК)»). PUSHED to Sergey 2026-10-13 (rebased: b39ef5e0d landing + 1636a38e4 UTM; owner: «коммит и пуш … в Sergey»). Release: portal via his Sergey→test→main path (the /api/demo-lead endpoint lives in the portal app); main-DB migration 20261013_0001_demo_leads_utm is NOT applied by the pipeline (only instantly-db has a migrator) — apply by hand with «да», until then UTM shows in TG but is not stored; re-publish /var/www/outreachos-xyz/index.html by hand (needs «да»); test with ?utm_source=test&utm_medium=manual&utm_campaign=check. Landing page and portal are on the SAME server 139.60.162.24 (static vhost vs app container); the RU landing outreachos.pro is the one on a separate Caddy server.

State verified 2026-09-19 (read-only): EN product = `app.outreachos.xyz` (ENG cabinet over hypothesisEngine v1, nginx vhost + cert on 139.60.162.24, self-signup open) — works. `outreachos.xyz` apex has DNS to the same server but NO vhost, NO cert: HTTP shows stock "Welcome to nginx!", HTTPS falls to app.outreachos.pro block (cert error, 307 /login). No real stub. `www.outreachos.xyz` has no DNS.

RU model: landing `outreachos.pro` = static repo `github.com/wemdio/outreachos-landing` on a separate Caddy server (92.246.76.92), client-side i18n `?lang=ru|en|es` with 178 EN keys generated by `app/scripts/generate-client-translations.mjs`; app = `app.outreachos.pro`. `polzaagency.com` (port 3355, `polza-site-eng`) is the agency's EN site, not the product landing. Local `landing/` dir in Portal is gitignored and stale vs GitHub; has early EN draft `index.legacy-en.html`.

**Why:** the user planned to continue the EN landing and remembered a stub on the domain; the stub is just nginx's default page.

**How to apply:** for EN landing work start from outreachos-landing (EN dictionary exists), point CTAs to app.outreachos.xyz, plan vhost+certbot for the apex only with explicit approval per [[sergey-release-rules]]. Full record: Portal `memory/sessions/portal/` session dated 2026-09-19 titled "ENG-продукт: app.outreachos.xyz работает, лендинга outreachos.xyz нет".

2026-10-15 ~20:05 MSK: RU+EN landing PUBLISHED by hand (owner «да»): /var/www/outreachos-xyz/{en,ru}/index.html + images/og-{en,ru}.png; old one-language /index.html left as fallback; vhost replaced (map blocks at http level in the same file: ?lang → cookie oos_lang → Accept-Language ru|uk|be|kk → ru else en; / and /index.html 302 with Vary+no-store; /en,/ru 301 to slash). Backups: /etc/nginx/sites-available/outreachos.xyz.bak-20261015-2001, /var/www/outreachos-xyz.bak-20261015-2001 (rollback = cp vhost back + nginx -t + reload). Source in Sergey 81b72843d (pages+conf), d3e7ec893 (demo-lead lang → TG «Язык страницы», needs portal release), 63b90edaa (deploy selector: deploy/static/* and supabase/operator-sql/* no-op — before it, landing commits turned a release into DEPLOY_ALL). RU copy review points in session scratchpad landing-ru/ru-copy.md (AI vs ИИ, Russian sample email, «зарубежные рынки» line not added). Preview gotcha: the app's preview runner cannot read ~/Desktop (python http.server getcwd EPERM) — serve a scratchpad copy with python -c and directory=…

## portal-prod-db-access
_Local .env DB endpoints are stale; prod Portal/Instantly DBs are reachable only via SSH to 139.60.162.24 + docker exec psql_

Checked 2026-09-21: the repo `.env` DB endpoints no longer work from this Mac.
`NEXT_PUBLIC_SUPABASE_URL` (gngsfwkvnrddfwhpqopr.supabase.co) returns
`401 Invalid API key`, and `INSTANTLY_SUPABASE_URL` / `DATABASE_URL` still point at
`139.60.162.12`, which times out (the host moved to `139.60.162.24`).

Working read path — SSH per [[../../../../Desktop/Portal-Mac-Transfer-2026-09-06-Updated/Portal/docs/ssh-access.md]] to `root@139.60.162.24`, then:

- main Portal DB: `docker exec main-postgres psql -U postgres -d postgres`
- Instantly operational DB: `docker exec instantly-postgres-prod psql -U instantly -d instantly`

**Why:** repeatedly re-testing the dead `.env` endpoints wastes a round trip on any
data question about prod.

**How to apply:** go straight to SSH + `docker exec psql` for prod reads. Do not
"fix" the `.env` endpoints — AGENTS.md requires DB endpoints be verified separately,
and writes still need explicit approval. In `project_period_instantly_campaigns`
join on `c.id::text = p.campaign_id` (uuid vs text).
