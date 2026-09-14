# Собственный email sender вместо Instantly — handoff и план MVP

**Дата аудита:** 14 сентября 2026  
**Проект:** Portal  
**Цель:** построить собственный email sequencer/sender для работы с Google Workspace, Maildoso и ZapMail и постепенно отказаться от отправки через Instantly.

---

## 1. Краткий вывод

В Portal уже существует технический прототип собственного sender. Начинать с нуля не нужно.

Он уже умеет:

- подключать SMTP/IMAP-ящики;
- подключать Google и Яндекс по OAuth;
- шифровать почтовые credentials;
- ставить исходящие письма в очередь;
- отправлять письма через SMTP;
- учитывать простой дневной лимит ящика;
- читать входящие ответы через IMAP;
- показывать простую одношаговую кампанию и ответы в интерфейсе.

На production уже подняты два воркера:

- `portal-worker-byo-send`;
- `portal-worker-byo-replies`.

Таблицы также существуют:

- `client_mailbox_accounts`;
- `client_byo_messages`;
- `client_byo_replies`.

Однако на момент проверки во всех трёх таблицах было по нулям записей. Значит, контур развёрнут, но реального пилота на подключённых ящиках ещё не проходил.

Главная рекомендация для MVP:

> Portal должен стать собственным интерфейсом, планировщиком, очередью, sequencer и системой обработки ответов, но физическая доставка должна идти через SMTP или API существующих почтовых ящиков. Собственный SMTP-сервер, MTA и IP-пулы на первом этапе поднимать не нужно.

---

## 2. Что уже реализовано в Portal

### 2.1. Основные файлы

- `app/src/lib/byoMailbox/smtp.ts` — SMTP-подключение, проверка credentials и отправка.
- `app/src/lib/byoMailbox/sender.ts` — чтение очереди и отправка писем.
- `app/src/lib/byoMailbox/imap.ts` — чтение новых входящих сообщений через IMAP.
- `app/src/lib/byoMailbox/repliesSync.ts` — сохранение ответов и простое сопоставление с отправками.
- `app/src/lib/byoMailbox/credentials.ts` — шифрование паролей и OAuth refresh token.
- `app/src/lib/byoMailbox/netGuard.ts` — SSRF-защита SMTP-подключений.
- `app/src/lib/byoMailbox/providers.ts` — SMTP/IMAP-пресеты провайдеров.
- `app/src/app/api/client/mailboxes/route.ts` — подключение и проверка ящиков.
- `app/src/app/api/client/byo-campaigns/route.ts` — постановка писем кампании в очередь.
- `app/src/app/client/mailboxes/page.tsx` — интерфейс подключения ящиков.
- `app/src/app/client/byo-campaigns/page.tsx` — интерфейс простейшей кампании.
- `app/worker/byoSend.ts` — отдельный воркер отправки.
- `app/worker/byoReplies.ts` — отдельный воркер чтения ответов.

### 2.2. Миграции

- `supabase/migrations/20260604_0001_client_mailbox_accounts.sql` — реестр подключённых ящиков.
- `supabase/migrations/20260607_0001_byo_mailbox_oauth.sql` — OAuth-поля.
- `supabase/migrations/20260610_0002_client_byo_messages.sql` — очередь и журнал исходящих писем.
- `supabase/migrations/20260610_0003_client_byo_replies.sql` — входящие ответы и IMAP-курсоры.
- `supabase/migrations/20260610_0004_byo_auth_type_yandex.sql` — OAuth Яндекса.

### 2.3. История реализации

Основные коммиты существующего прототипа:

- `e88a08da0` — первоначальное подключение собственных SMTP-ящиков;
- `d941d6dca` — Google OAuth;
- `04b22cf5e` — запрет SMTP port 25;
- `d75fbf8b7` — реальная отправка кампаний через собственный SMTP-движок;
- `4e5908546` — deployment воркеров и чтение ответов через IMAP;
- `2a65fd2f1` — Yandex OAuth;
- `9e11b790f` — обработка умерших OAuth-токенов.

В более свежих ветках и `main` есть коммит `dcda75cf2` с модулем `sendingProvider.ts`. Он передаёт подключённые ящики в Instantly и проверяет их через Instantly API. Это переходная интеграция, а не развитие собственного sender. При реализации выхода из Instantly этот модуль нельзя принимать за целевую архитектуру.

### 2.4. Текущее production-состояние

Read-only проверка production показала:

- оба BYO-воркера запущены;
- ключ шифрования почтовых credentials настроен;
- pilot allowlist настроен;
- Google OAuth client ID и client secret в приложении и BYO-воркерах не настроены;
- реальных подключённых ящиков и отправок пока нет.

Перед любыми миграциями или началом пилота это состояние необходимо проверить повторно: нулевые таблицы на дату аудита не означают, что они останутся пустыми навсегда.

---

## 3. Что именно мы строим

Instantly совмещает несколько самостоятельных продуктов:

1. подключение и проверку почтовых ящиков;
2. управление кампаниями и последовательностями;
3. очередь, расписание и ротацию отправителей;
4. отправку писем;
5. чтение ответов и bounce;
6. остановку follow-up после ответа;
7. warmup;
8. deliverability-мониторинг;
9. аналитику и интерфейс.

Собственный sender для MVP должен заменить пункты 1–6 и дать минимальную операционную аналитику. Собственный warmup, IP-инфраструктура и полный аналог Instantly в первый MVP не входят.

Целевая схема:

```text
Maildoso/ZapMail CSV или ручное подключение
                    │
                    ▼
             Реестр ящиков
                    │
                    ▼
           Кампания и её шаги
                    │
                    ▼
              Планировщик
                    │
                    ▼
       Атомарная очередь исходящих писем
                    │
          ┌─────────┼─────────┐
          ▼         ▼         ▼
        SMTP    Gmail API   Microsoft Graph
          │
          ▼
 Google Workspace / Maildoso / ZapMail

 IMAP или Provider API
          │
          ▼
 Ответы и bounce → stop follow-up → suppression
```

Для первого MVP реально нужен только SMTP/IMAP-адаптер. Gmail API и Microsoft Graph добавляются позднее.

---

## 4. Почему не надо поднимать собственный SMTP-сервер

Собственный SMTP-сервер — это другой по масштабу проект. Он потребует:

- выделенных IP или управляемого IP-пула;
- настройки PTR/rDNS;
- контроля SPF, DKIM, DMARC и envelope sender;
- управления репутацией IP;
- обработки feedback loops и abuse-жалоб;
- очереди MTA и повторных доставок;
- работы с блоклистами;
- обработки bounce на уровне SMTP;
- контроля исходящего port 25;
- регулярной ротации и прогрева инфраструктуры.

Это существенно дороже и рискованнее, чем отправка через уже купленные почтовые ящики. В MVP наш сервер должен выступать как обычный авторизованный почтовый клиент и подключаться к submission SMTP провайдера на портах 465 или 587.

Преимущества такого решения:

- не нужны собственные IP;
- не нужен MTA;
- сохраняется DKIM-подпись почтового провайдера;
- репутацией серверной инфраструктуры управляет Google, Maildoso или ZapMail;
- можно переиспользовать существующий код Portal;
- стоимость MVP в основном состоит из разработки и уже оплачиваемых ящиков.

---

## 5. Поддержка Google Workspace, Maildoso и ZapMail

Предполагается, что под названием «MailDosa» имеется в виду Maildoso.

### 5.1. Матрица совместимости

| Источник ящика | Подключение в MVP | Статус |
|---|---|---|
| Собственный Google Workspace | SMTP+IMAP с app password | Включить в MVP |
| Maildoso SMTP mailbox | Credentials из CSV, SMTP+IMAP | Включить в MVP |
| Maildoso Google Workspace | Отдельная проверка credentials/API | Spike перед включением |
| ZapMail Google Workspace | App password и SMTP/IMAP из экспорта | Включить в MVP |
| ZapMail Microsoft 365 | Microsoft OAuth/Graph | Исключить из первого MVP |

### 5.2. Собственный Google Workspace

Самый быстрый путь для MVP:

- включить 2-Step Verification;
- создать app password;
- использовать `smtp.gmail.com` на 465 SSL или 587 STARTTLS;
- использовать `imap.gmail.com` на 993 TLS;
- хранить app password только в зашифрованном виде.

Google Workspace также предлагает `smtp-relay.gmail.com`, но он требует настройки каждого Workspace tenant и не решает чтение ответов. Для первого пилота app passwords проще.

Google указывает, что `smtp.gmail.com` с app password остаётся поддерживаемым вариантом для устройств и приложений при включённой 2FA. При этом лимит Gmail значительно выше безопасного лимита холодного outreach, поэтому технический максимум Google нельзя использовать как campaign limit. Ссылка: <https://support.google.com/a/answer/176600>

### 5.3. Maildoso SMTP

Maildoso позволяет экспортировать credentials в CSV.

Текущие официальные параметры:

- SMTP host: `smtp.maildoso.com`;
- SMTP port: `587`;
- encryption: STARTTLS;
- username: полный email;
- IMAP port: `993`;
- IMAP encryption: SSL/TLS;
- IMAP host индивидуален для конкретного сервера или ящика и должен браться из свежего CSV.

Нельзя подставлять один IMAP-хост для всех Maildoso-ящиков. Нельзя использовать IMAP-host в качестве SMTP-host, даже если сервер отвечает на соединение.

Официальные ссылки:

- <https://intercom.help/maildoso/en/articles/15421658-connecting-your-mailbox-to-lemlist-and-other-sequencers>
- <https://intercom.help/maildoso/en/articles/16231432-why-was-my-email-accepted-but-never-delivered-with-no-bounce>

На дату аудита Maildoso рекомендует:

- прогревать новый ящик около двух недель;
- держать warmup включённым после запуска кампаний;
- ограничивать campaign emails примерно 15 письмами в день на ящик, включая follow-up;
- не превышать общий hard cap около 100 писем в день с учётом warmup, outreach и ответов.

Эти числа должны храниться как provider policy и configuration override, а не быть универсальными лимитами для всех почтовых систем.

Официальная ссылка: <https://intercom.help/maildoso/en/articles/15435524-how-warmup-works-and-how-to-start-it>

У Maildoso SMTP relay может удалять заголовки `List-Unsubscribe`, поэтому видимый способ отказаться от писем должен присутствовать в самом тексте письма. Ссылка: <https://intercom.help/maildoso/en/articles/14166572-how-to-level-up-my-deliverability>

### 5.4. Maildoso Google Workspace

Google Workspace mailboxes, купленные через Maildoso, нельзя автоматически считать обычными Maildoso SMTP mailboxes.

Maildoso указывает, что:

- такие ящики не используют `smtp.maildoso.com`;
- у них нет тех же фиксированных SMTP/IMAP credentials, что в Maildoso SMTP CSV;
- подключение может требовать данных из карточки ящика, OTP, app password, OAuth или API Maildoso.

До начала разработки нужно взять два реальных Maildoso Google Workspace ящика и провести отдельный compatibility spike:

1. получить доступные export fields;
2. проверить создание app password;
3. проверить SMTP send;
4. проверить IMAP read;
5. выяснить, можно ли автоматизировать подготовку через Maildoso API.

Если стабильный app password получить нельзя, этот тип надо временно исключить из v1 либо подключать через отдельный OAuth-процесс.

Maildoso имеет REST API и MCP для управления доменами, ящиками и экспортами, но интегрировать provisioning API в самый первый MVP необязательно. Сначала достаточно поддержать их CSV.

Официальные ссылки:

- <https://intercom.help/maildoso/en/articles/16440105-how-can-i-access-mailbox-credentials-in-maildoso>
- <https://intercom.help/maildoso/en/articles/16306972-do-you-have-an-api-or-mcp-server-connecting-maildoso-to-claude-desktop-and-other-ai-agents>

### 5.5. ZapMail Google Workspace

ZapMail позволяет выгружать:

- mailbox credentials;
- app passwords;
- SMTP/IMAP details.

Следовательно, ZapMail Google можно подключать тем же универсальным SMTP/IMAP-адаптером, что и собственный Google Workspace.

Для MVP лучше поддержать импорт ZapMail XLS/CSV либо привести экспорт к нашему универсальному CSV-формату.

Официальная ссылка: <https://help.zapmail.ai/en/articles/10460716-how-to-export-mailbox-credentials-in-zapmail>

ZapMail также предоставляет API для mailbox management и custom OAuth. Это полезно для v2, когда понадобится автоматическое подключение без ручной выгрузки CSV.

Официальные ссылки:

- <https://docs.zapmail.ai/>
- <https://docs.zapmail.ai/custom-oauth-23834066e0>

### 5.6. ZapMail Microsoft 365

ZapMail официально не предоставляет для Microsoft 365:

- SMTP/IMAP credentials;
- app passwords;
- прямые mailbox credentials, пригодные для generic SMTP import.

Для этих ящиков понадобится отдельный адаптер:

- Microsoft OAuth;
- Microsoft Graph `Mail.Send`;
- Graph subscriptions или polling для ответов;
- безопасное хранение refresh token;
- consent и tenant-specific policy handling.

Поэтому Microsoft 365 следует исключить из первого MVP, если он не составляет значительную часть текущих ящиков.

---

## 6. Google OAuth и верификация

Существующий Portal OAuth-код запрашивает scope:

```text
https://mail.google.com/
```

Этот scope нужен для SMTP/IMAP XOAUTH2, но является restricted scope.

Google прямо указывает:

- публичное приложение с IMAP/SMTP должно проходить verification;
- использование полного `mail.google.com` только ради SMTP sending нарушает принцип минимальных scopes;
- для sending-only интеграции следует использовать Gmail API и scope `gmail.send`;
- для чтения содержимого почты потребуются более широкие scopes;
- если restricted Gmail data проходит через наш сервер или хранится у нас, может потребоваться ежегодная независимая security assessment.

Официальные ссылки:

- <https://support.google.com/cloud/answer/13463817>
- <https://support.google.com/cloud/answer/13464321>
- <https://developers.google.com/workspace/gmail/api/auth/scopes>
- <https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification>

Ориентировочные сроки из документации Google:

- brand verification: несколько рабочих дней;
- sensitive scope verification: около 10 рабочих дней;
- restricted scope review: несколько недель;
- security assessment выполняется внешним утверждённым аудитором и повторяется ежегодно.

Поэтому рекомендуемый порядок:

1. MVP — SMTP/IMAP через app passwords;
2. v2 — Gmail API `gmail.send` для отправки;
3. отдельно решить, действительно ли нужен доступ к входящим через Gmail API;
4. по возможности собирать ответы через forwarding/master inbox, чтобы не запрашивать широкий Gmail read scope;
5. не выпускать текущий OAuth-flow `mail.google.com` как массовое публичное подключение без отдельного policy review.

---

## 7. Что должно войти в MVP

### 7.1. Массовое подключение ящиков

Нужно поддержать:

- универсальный CSV;
- Maildoso CSV;
- ZapMail Google CSV/XLS;
- ручное подключение одного ящика для диагностики;
- dry run импорта;
- построчный результат импорта;
- автоматическое распознавание колонок;
- нормализацию TLS mode;
- SMTP verify;
- IMAP verify;
- шифрование credentials;
- повторную проверку без повторного ввода credentials;
- отключение и переподключение ящика.

Нормализованная модель ящика должна включать как минимум:

```text
id
client_user_id / tenant_id
provider
provider_mailbox_id
email
display_name
auth_type
smtp_host
smtp_port
smtp_tls_mode
imap_host
imap_port
encrypted_secret
status
daily_campaign_limit
daily_total_limit
timezone
warmup_status
last_health_at
last_error
created_at
updated_at
```

`smtp_tls_mode` лучше хранить как явное значение:

- `implicit_tls` для 465;
- `starttls` для 587.

Одного boolean `smtp_secure` недостаточно для понятной диагностики и обязательного `requireTLS`.

### 7.2. Кампании и последовательности

Минимальная модель:

- `campaigns` — кампания и её настройки;
- `campaign_steps` — первый email и follow-up;
- `campaign_recipients` — состояние каждого лида;
- `messages/outbox` — конкретные запланированные отправки;
- `message_events` — accepted, failed, bounced, replied, unsubscribed;
- `suppressions` — адреса, которым нельзя писать.

В первой версии достаточно:

- первого письма;
- одного или двух follow-up;
- задержки в днях между шагами;
- переменных `first_name`, `name`, `company` и пользовательских полей;
- рабочего timezone;
- разрешённых дней недели;
- окна отправки;
- паузы и продолжения кампании;
- отмены будущих сообщений;
- preview нескольких персонализированных писем перед запуском.

### 7.3. Пул отправителей

Текущий прототип использует один выбранный ящик на кампанию. Для реальной замены Instantly нужен пул.

Требования:

- кампания выбирает несколько ящиков;
- один лид закрепляется за одним ящиком на всю цепочку;
- follow-up отправляются с того же адреса;
- нагрузка распределяется равномерно;
- отключённые или сломанные ящики исключаются;
- отправки перераспределяются только до первого письма;
- provider-specific limit имеет приоритет над общим campaign limit;
- warmup traffic, ручные письма и ответы должны учитываться в total limit, если эти данные доступны.

### 7.4. Планировщик и pacing

Требования:

- отправлять только в разрешённые часы;
- учитывать timezone кампании или получателя;
- добавлять случайный интервал между письмами;
- не выпускать всю дневную норму одним пакетом;
- поддержать provider cooldown после временных ошибок;
- переносить неиспользованный дневной объём только по явному правилу, а не автоматически;
- не делать резких скачков объёма на новых ящиках.

Для пилота разумно начать с консервативных значений:

- 10–15 campaign emails в день на новый или Maildoso SMTP ящик;
- случайный интервал порядка нескольких минут;
- business-hours only;
- постепенное повышение лимита только после оценки bounce/reply/placement.

Числа должны быть конфигурацией, а не захардкоженной универсальной истиной.

### 7.5. Надёжная очередь

Сейчас воркер делает обычный `SELECT status='pending'`, после чего отправляет письма. При запуске двух воркеров оба могут получить одну и ту же строку и отправить дубликат.

Нужен атомарный механизм claim/lease, например Postgres function с:

```sql
FOR UPDATE SKIP LOCKED
```

У сообщения должны появиться поля:

```text
status
leased_at
lease_until
worker_id
attempts
next_attempt_at
provider_message_id
message_id
accepted_at
last_error_code
last_error_detail
```

Рекомендуемые состояния:

```text
scheduled
leased
sending
accepted
retry_wait
unknown
failed
canceled
replied
bounced
```

Важно: SMTP `250 OK` означает только то, что провайдер принял письмо. Это не доказательство доставки в inbox и даже не окончательная доставка получателю. В интерфейсе это состояние лучше называть `accepted` или «принято почтовым провайдером».

SMTP не даёт абсолютной exactly-once гарантии. Если соединение оборвалось после передачи DATA, письмо могло быть принято, хотя клиент не увидел ответ. В таком случае безопаснее помечать письмо как `unknown` и отправлять на ручную проверку, а не немедленно повторять и создавать дубликат.

### 7.6. Retry policy

Нельзя повторять все SMTP-ошибки одинаково каждые 15 секунд.

Нужно различать:

- invalid credentials — отключить ящик и запросить переподключение;
- quota/rate limit — pause до следующего окна;
- temporary 4xx — exponential backoff;
- hard recipient error 5xx — hard bounce и suppression;
- DNS/network timeout до передачи письма — retry;
- ambiguous timeout после DATA — `unknown`, без автоматического немедленного повтора;
- provider block/abuse response — pause mailbox или domain и alert.

### 7.7. Message-ID и threading

Сейчас отправка не сохраняет сгенерированный исходящий `Message-ID`, а ответы в основном сопоставляются по email отправителя.

Нужно:

- создавать детерминированный `Message-ID` до отправки;
- сохранять его в outbox;
- передавать его в SMTP message headers;
- сохранять provider response/message ID;
- сохранять `In-Reply-To` и `References` у входящих;
- сначала сопоставлять по thread headers;
- использовать совпадение email+mailbox как fallback;
- хранить thread ID на уровне campaign recipient.

Follow-up желательно отправлять в той же переписке, добавляя корректные `In-Reply-To` и `References`.

### 7.8. Ответы и автоматическая остановка

При получении реального ответа система должна:

1. сопоставить письмо с отправкой и получателем кампании;
2. пометить recipient как `replied`;
3. отменить все его будущие follow-up;
4. показать ответ в интерфейсе;
5. сохранить сырой источник или необходимые диагностические headers в ограниченном безопасном виде;
6. не считать warmup, auto-reply и bounce реальным ответом лида.

В MVP не требуется AI-классификация ответа. Достаточно корректно отличать:

- human reply;
- automatic reply/out-of-office;
- bounce/DSN;
- warmup message;
- системное уведомление.

### 7.9. Bounce и suppression

Нужно распознавать:

- `multipart/report; report-type=delivery-status`;
- MIME-part `message/delivery-status`;
- `Final-Recipient`;
- `Original-Recipient`;
- SMTP status/enhanced status code;
- типичных отправителей `MAILER-DAEMON` и `postmaster`;
- provider-specific bounce messages.

Результат:

- hard bounce — адрес немедленно попадает в suppression;
- soft bounce — ограниченный retry или pause;
- mailbox full — временная ошибка;
- policy/spam rejection — отдельный сигнал репутационного риска;
- domain-wide pattern — автоматическая остановка affected mailbox/domain и alert.

Suppression должен проверяться до создания каждого нового outbox message, а не только при импорте базы.

### 7.10. Отписки

Минимум:

- глобальный suppression по email;
- suppression в пределах клиента;
- ручная кнопка «не писать»;
- распознавание прямого текстового отказа вручную оператором;
- видимая инструкция отказаться от сообщений в теле письма;
- невозможность повторно импортировать suppressed address в активную рассылку без явного административного действия.

Open/click tracking и redirect links лучше не добавлять в MVP: они усложняют deliverability, доменную инфраструктуру и аналитику, не являясь обязательными для первого рабочего sender.

### 7.11. Health checks

Для каждого ящика нужно проверять:

- DNS resolution;
- SMTP connection;
- SMTP authentication;
- IMAP connection;
- IMAP authentication;
- срок последней успешной отправки;
- срок последней успешной проверки входящих;
- временные и постоянные provider errors;
- превышение лимитов;
- отключение/истечение app password или OAuth token.

Health check не должен отправлять тестовое письмо при каждом запуске. Отдельная test-send операция запускается вручную или при первичном подключении.

### 7.12. Мониторинг

Минимальные показатели:

- количество активных/ошибочных ящиков;
- очередь по возрасту;
- количество scheduled/leased/accepted/retry/failed;
- send rate по ящику и провайдеру;
- bounce rate;
- reply rate;
- suppression count;
- время последнего успешного SMTP/IMAP действия;
- количество `unknown` отправок;
- количество отменённых follow-up после ответа;
- lease timeouts и повторные claims.

Нужны alerts хотя бы на:

- массовую SMTP authentication failure;
- рост bounce rate;
- очередь старше допустимого времени;
- отсутствие успешных send операций при непустой очереди;
- отсутствие IMAP polling;
- provider-wide network failure;
- ошибку расшифровки credentials.

---

## 8. Обязательные исправления существующего прототипа

Перед использованием на реальных контактах необходимо исправить следующие проблемы.

### P0 — до первой реальной отправки

1. **Атомарный claim очереди.** Сейчас возможна двойная отправка двумя воркерами.
2. **IMAP SSRF guard.** SMTP target проверяется, пользовательский IMAP host — нет.
3. **Bulk import.** Подключать десятки или сотни ящиков по одному непрактично.
4. **Provider-specific limits.** Нельзя использовать один `daily_limit=30` для всех.
5. **Message-ID и threading.** Без этого нельзя надёжно останавливать follow-up.
6. **Bounce/DSN parsing.** Сейчас bounce не становится suppression автоматически.
7. **Stop-on-reply.** Будущие письма должны отменяться атомарно.
8. **Retry/backoff.** Нельзя повторять все ошибки через короткий одинаковый интервал.
9. **Ограничение размера кампании.** API сейчас может принять неограниченный массив recipients.
10. **Корректная email validation и deduplication.** Проверки `includes('@')` недостаточно.

### P1 — до расширения пилота

1. multi-mailbox pool;
2. steps/follow-up;
3. business hours и timezone;
4. pause/resume/cancel;
5. mailbox health UI;
6. suppression UI;
7. warmup/system-message filtering;
8. campaign-level статистика;
9. audit log действий;
10. секреты через версионируемый key ID или внешний secret manager.

### P2 — после подтверждения MVP

1. Gmail API adapter;
2. Microsoft Graph adapter;
3. Maildoso API provisioning;
4. ZapMail API provisioning/custom OAuth;
5. webhooks и интеграции с CRM;
6. reply classification;
7. placement monitoring;
8. A/B tests;
9. более глубокая аналитика;
10. собственная warmup-система, только если её экономика отдельно обоснована.

---

## 9. Что сознательно не входит в первый MVP

- собственный SMTP/MTA;
- собственные sending IP и IP rotation;
- port 25 delivery напрямую на MX получателя;
- собственный warmup pool;
- автоматическая покупка доменов;
- автоматическая настройка DNS;
- ZapMail Microsoft 365;
- публичный Google OAuth с `mail.google.com`;
- HTML-конструктор;
- open tracking pixel;
- click tracking redirects;
- AI-генерация писем;
- AI-классификация ответов;
- полный аналог Instantly analytics;
- автоматическая работа с blacklist delisting.

---

## 10. Warmup — отдельный продукт

Собственный sender не заменяет warmup автоматически.

Maildoso прямо указывает, что:

- новые SMTP mailboxes не приходят прогретыми;
- warmup выполняется через сторонний sequencer/warmup service;
- после запуска реальных кампаний warmup рекомендуется продолжать.

Поэтому существует три варианта:

### Вариант A — рекомендуемый для перехода

- реальные кампании отправлять через Portal;
- Instantly или другой внешний сервис временно оставить только для warmup;
- после стабильного пилота выбрать постоянный отдельный warmup service.

### Вариант B — использовать warmup провайдера

- для ZapMail использовать включённый в выбранный план warmup, если он доступен;
- для Maildoso проверить доступные текущему аккаунту интеграции и warmup status API.

### Вариант C — строить собственный warmup

Не включать в MVP. Для этого понадобится отдельная сеть seed-ящиков у разных провайдеров, планировщик взаимных писем, ответы, перенос из Spam в Inbox, фильтры warmup-трафика и контроль provider policies. Это отдельный проект с собственными рисками и экономикой.

Переходный план может означать уход от Instantly как sender раньше, чем полный уход от него как warmup-инструмента.

---

## 11. План реализации

### Этап 0. Compatibility spike — 2–3 дня

Подготовить минимум:

- 2 собственных Google Workspace ящика;
- 2 Maildoso SMTP ящика;
- 2 Maildoso Google Workspace ящика, если этот тип используется;
- 2 ZapMail Google ящика;
- 2 ZapMail Microsoft ящика только для фиксации границы v1.

Для каждого типа проверить:

- какие данные реально доступны в export;
- SMTP authentication;
- отправку на внутренний seed-list;
- IMAP authentication;
- чтение ответа;
- получение bounce;
- provider throttling;
- поведение после смены/отзыва пароля;
- наличие warmup messages и способов их фильтрации.

Результат — проверенная compatibility matrix с реальными примерами заголовков CSV, но без сохранения credentials в Git.

### Этап 1. Mailbox foundation — около недели

- нормализовать mailbox model;
- добавить `smtp_tls_mode`;
- добавить IMAP network guard;
- реализовать bulk CSV import;
- добавить provider presets для Maildoso и ZapMail Google;
- SMTP+IMAP verification;
- health-check scheduler;
- понятный per-row import report;
- тесты шифрования, парсинга и network guard.

### Этап 2. Надёжная очередь — около недели

- атомарный Postgres claim/lease;
- retries и exponential backoff;
- provider error classification;
- deterministic Message-ID;
- состояния `accepted`, `retry_wait`, `unknown`;
- worker concurrency tests;
- recovery после падения worker;
- базовые метрики и alerts.

### Этап 3. Sequencer — 1–2 недели

- `campaigns`;
- `campaign_steps`;
- `campaign_recipients`;
- генерация outbox;
- первый email и 1–2 follow-up;
- business hours;
- timezone;
- pause/resume/cancel;
- multi-mailbox assignment;
- дневные provider limits;
- предварительный preview персонализации.

### Этап 4. Replies, bounce и suppression — около недели

- Message-ID threading;
- stop-on-reply;
- DSN parser;
- hard/soft bounce;
- suppression list;
- unsubscribe handling;
- auto-reply/warmup filtering;
- интерфейс ответов и причин остановки.

### Этап 5. Контролируемый пилот — около недели

- только внутренний allowlist;
- 5–10 доменов;
- ограниченный набор ящиков;
- только проверенный seed-list и затем небольшой B2B pilot list;
- консервативные лимиты;
- ежедневная проверка ошибок, bounce и reply;
- сравнение результатов с контрольной кампанией;
- отсутствие автоматического повышения объёма.

Оценка для одного сильного backend/full-stack специалиста — примерно 4–6 недель до контролируемого MVP. Для специалиста без опыта SMTP желательно предусмотреть техническое ревью очереди, MIME/DSN и security до реального пилота.

---

## 12. Критерии готовности MVP

MVP считается готовым к ограниченному пилоту, когда выполнены все условия:

### Подключение

- успешно импортируются Google Workspace, Maildoso SMTP и ZapMail Google;
- каждый ящик проходит SMTP и IMAP verification;
- credentials не появляются в UI, логах и ошибках;
- невалидные строки CSV не блокируют импорт валидных;
- повторный импорт идемпотентен.

### Отправка

- кампания содержит первое письмо и минимум один follow-up;
- используется пул ящиков;
- один lead закрепляется за одним отправителем;
- соблюдаются daily limit, business hours и pacing;
- два параллельных воркера не отправляют одну строку одновременно;
- рестарт до начала SMTP send не создаёт дубликат и не теряет письмо;
- ambiguous SMTP result становится `unknown`, а не бесконтрольным retry;
- `Message-ID` известен до отправки и сохраняется.

### Ответы

- обычный ответ появляется в Portal;
- future follow-up отменяется после ответа;
- bounce не отображается как человеческий ответ;
- hard bounce добавляет адрес в suppression;
- suppressed address нельзя повторно поставить в очередь;
- auto-reply не считается полноценным reply без отдельного правила;
- warmup traffic не засоряет рабочий inbox.

### Операционная готовность

- виден статус каждого mailbox;
- видна причина permanent failure;
- виден queue lag;
- есть pause кампании и mailbox;
- есть безопасное ручное переподключение;
- есть alert на остановку send/reply worker;
- есть инструкция по аварийной остановке кампаний без удаления данных.

### Минимальный end-to-end тест

Необходимо провести полный цикл:

```text
CSV import
→ SMTP/IMAP verify
→ создание кампании
→ scheduled send
→ accepted provider response
→ входящий reply или bounce
→ правильное сопоставление
→ автоматическая отмена follow-up
→ обновление suppression/statistics
```

Тест должен пройти минимум на двух ящиках каждого поддерживаемого типа.

---

## 13. Первые вопросы, которые специалист должен закрыть

1. Под Maildoso используются SMTP mailboxes, Google Workspace mailboxes или оба типа?
2. Какова доля ZapMail Google и ZapMail Microsoft?
3. Сколько одновременно активных ящиков ожидается в MVP?
4. Сколько campaign emails в день нужно отправлять суммарно?
5. Нужны ли клиентские multi-tenant кабинеты сразу или пилот будет только внутренним?
6. Где сейчас работает warmup каждого типа ящиков?
7. Можно ли временно оставить Instantly только для warmup?
8. Должны ли ответы только отображаться в Portal или из Portal также нужно отвечать?
9. Нужна ли интеграция sender с текущим ENG/Vertical Engine launch flow в первом MVP?
10. Требуется ли перенос исторических кампаний и reply history из Instantly или новая система начинает с чистого состояния?

Ответы на вопросы 1–4 могут изменить порядок адаптеров и оценку пропускной способности. Остальные вопросы влияют на границы интерфейса и миграции.

---

## 14. Готовая постановка задачи специалисту

> Сделать MVP собственного email sequencer в Portal, используя существующий контур `byoMailbox` как основу. Доставка должна идти через SMTP/IMAP существующих почтовых ящиков; собственный MTA и sending IP не строим. В первой версии поддержать собственный Google Workspace через app passwords, Maildoso SMTP и ZapMail Google через bulk CSV import. Maildoso Google сначала проверить отдельным compatibility spike. ZapMail Microsoft, публичный Google OAuth и собственный warmup исключить из v1.
>
> Реализовать bulk mailbox import, SMTP/IMAP verification, provider-specific limits, multi-mailbox campaigns, первое письмо и 1–2 follow-up, business-hour scheduling, атомарный queue lease, безопасные retries, deterministic Message-ID, threading, stop-on-reply, DSN/bounce processing, suppression list, mailbox health и базовые операционные метрики.
>
> Не использовать `sendingProvider.ts` как основу собственного sender: этот слой регистрирует ящики в Instantly. Перед началом разработки взять свежий `origin/main`, создать отдельную рабочую ветку и повторно проверить состояние production-таблиц. Любые production migrations, deployment и включение реальных отправок выполнять только после отдельного согласования.

---

## 15. Рекомендуемая первая задача

Первая задача специалиста не должна звучать как «сделать весь sender».

Нужно выдать ему ограниченный spike:

> На локальной или тестовой среде подключить по два ящика: собственный Google Workspace, Maildoso SMTP и ZapMail Google. Для каждого выполнить SMTP verify, тестовую отправку, IMAP verify, получение обычного ответа и bounce. Зафиксировать точный формат credentials/export, TLS settings, provider errors и ограничения. Не отправлять письма реальным лидам. По итогам подготовить compatibility matrix и список необходимых изменений существующего `byoMailbox` без production deployment.

После этого spike можно уверенно начинать основной MVP, не проектируя систему на предположениях о провайдерах.

---

## 16. Итоговое решение

Самый рациональный путь:

1. переиспользовать существующий BYO SMTP/IMAP-контур Portal;
2. не строить собственный почтовый сервер;
3. начать с app passwords и bulk credentials import;
4. поддержать Maildoso SMTP, Google Workspace и ZapMail Google;
5. отложить Microsoft и массовый Google OAuth;
6. построить над текущим SMTP-слоем надёжный sequencer;
7. оставить warmup внешним на переходный период;
8. запускать сначала только на небольшом внутреннем пилоте;
9. переходить с Instantly по частям: сначала campaign sending, затем остальные функции.

Таким образом, существующие наработки сокращают стартовую работу, но перед реальной эксплуатацией требуется серьёзно усилить очередь, provider limits, multi-mailbox scheduling, threading, bounce processing, suppression и безопасность IMAP-подключений.
