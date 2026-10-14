# VE2: ежедневный пост с production в 11:00 МСК

Пользователь попросил ежедневную публикацию в прежний общий Telegram-чат,
независимо от включённого ПК, в 11:00 МСК / 12:00 Самара. Проблемы — только
владельцу в его задаче, без публичного блока «Требуют внимания».

## Изменение

В `services/changelog-bot` добавлен самостоятельный deterministic VE2 digest:
cron 08:00 UTC, catchup/retry каждые пять минут, собственный PostgreSQL outbox,
read-only snapshot и CLI `--ve2-preview`. Существующий changelog в 09:00 МСК
сохраняет время и порядок startup catchup. Новые LLM/API расходы отсутствуют.

База сравнения — подтверждённый пост от 25.09, message 33349. Bootstrap сверён
с локальными publication receipt, selection, snapshot-1255 и prepublish из
`/Users/cybermart/.codex/handoffs/ve2-noon-post-20260925`:
102 выбранных базы, 90 уже готовых. Дальше сравнение только с последним
полностью подтверждённым постом сервиса, не с полуночью или деплоем.

Проверяются base/preparation/target/template/latest jobs. Завершённые ниже цели
входят в завершённые с пометкой. Ошибки остаются в закрытом snapshot/preview.
Числа контактов берутся из проверенного target progress, не row_count или
кандидатов. Нет суммирования разных баз как уникальных получателей.

Перед HTTP сохраняется sending; после успеха — message ID каждой части.
Уверенный 4xx повторяется, неоднозначный результат и потерянная запись receipt
блокируют канал до ручной сверки. PostgreSQL session lock + unique(channel,date)
и локальный lock предотвращают конкурентную публикацию. При прямом DB outage
до отправки новая попытка возможна без потери границы.

## Проверка

Артефакты: `/Users/cybermart/.codex/handoffs/ve2-server-digest-20260928`.

- Реальный readonly production SQL: 102 выбранные подготовки, 92 ready,
  10 issues; публичная дельта от baseline — стоматологии 3+ кресла 501 и
  ресторанные холдинги 502. Сейчас active/queue 0. Это проверочный снимок,
  не опубликованный пост; при отправке будет снят новый.
- Миграция и snapshot/outbox SQL реально выполнены в локальном PGlite.
  25 проверок: RLS/grants, чтение, ready vs partial/error, отправка, рестарт,
  известный/неизвестный результат, потеря receipt, многочастное сообщение,
  HTML/UTF-16, continuation vs queue, stale running. Telegram подменён.
- 11 проверок httpx MockTransport/расписания: receipt, 400/401/403/429,
  5xx, timeout, неправильный чат, битый JSON; секреты не попадают в ошибки.
- Отдельно оба startup пути (обычный/RUN_NOW), порядок старого catchup,
  две независимые cron-задачи. Python compile и CLI help успешны.
- Существующие migration guards: 2 suites, 5 checks passed. Постоянные тесты
  не добавлялись. Полный TypeScript suite не повторялся: его код не менялся.
- Production только читался; Telegram sendMessage, paid API, collection,
  migration и deploy не запускались. Docker build локально не выполнялся;
  зависимости установлены в изолированном локальном venv, entrypoint проверен.

## Релиз и контроль

Нужен обычный релиз кода + `20260928_0002_ve_daily_digests.sql` и нового образа
changelog-bot. CI уже строит образ по `services/changelog-bot/*`; deploy selector
выбирает бот и portal для миграции. Изменять compose или секреты не требуется.
Production проверен: CHANGELOG_CHAT_ID=-1001665607826, THREAD_ID=1 (общий топик),
DB — прямой main-postgres:35434. Старые локальные Codex публикации PAUSED,
их не включать одновременно с серверной.

После согласованного деплоя проверить read-only `python /app/main.py --ve2-preview`
и `/health.ve2_digest`. При запуске позже 11:00 отправит свежий пост сразу,
если сегодня ещё не отправлялся; раньше 11:00 ждёт расписания. Включено по
умолчанию, независимый выключатель `VE2_DIGEST_ENABLED=0` в серверном `.env`.
Не говорить, что расписание уже работает в production, пока релиз не проверен.

Эксплуатация/разбор uncertain описаны в `services/changelog-bot/VE2-DIGEST.md`.
У Telegram sendMessage нет гарантии exactly-once при сетевой неопределённости:
блокировка повторов сознательная, receipt сверяет владелец. Никаких автоматических
production исправлений этой неопределённости без отдельного разрешения.
