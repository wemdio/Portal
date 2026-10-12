# Одноразовый приоритет существующего №24

Это подготовленный код, не выполненная операция. Не запускает новый прогон,
не возвращает failed/processing в pending, не создаёт кампании. Деплой,
изменение production-конфигурации и перезапуск сейчас не разрешены.

## Выключено по умолчанию

`MANUAL_SCORING_RUN24_PRIORITY_ONCE` отсутствует или `0` — прежний selector
`pending → started_at ASC → LIMIT 1`, прежний runner и startup cleanup.
`1` — одноразовый адресный выбор только
`15bf0bce-a13c-4401-99e2-e2e4aabe2973`, client
`0a6d90e1-91d0-404e-b508-6b031bda7cfd`, файл
`no-email-retry-216fbc888469-0024-20261010.txt`.

Для будущего включения нужен уже настроенный URL основной operational БД:
`DATABASE_URL`, `SUPABASE_DB_URL` или `POSTGRES_URL`. Нет URL — запуск opt-in
закрывается с ошибкой. Креды, значения URL и `.env` в Git не сохраняются.
Устаревший endpoint `144.31.54.166` не принимается. Никаких новых env-настроек
в compose или production этот commit сам не добавляет. Миграций нет.

## Предусловия и ограничение single worker

Требуется **единственный существующий daemon** manual-scoring. Дождаться
завершения активного пакета перед отдельно одобренным обновлением. Не запускать
второй executor, прямой `processManualRun`, upload API или enqueue SQL.
`stop_grace_period` текущего compose — 30 секунд; обычный restart во время
длинного пакета может оборвать его, несмотря на обработчик SIGTERM.

В отдельной короткой Postgres-транзакции helper:

1. Берёт transaction advisory lock для этого адресного claim и row lock только
   №24. Проверяет точные client/file, `unique_count=100`, оба retry/routing flags.
2. Уже processing/completed/failed не переоткрывает; запрос считается исчерпанным,
   затем selector возвращается к прежнему пути. Отсутствующий run — ошибка,
   а не свидетельство завершения.
3. При другом processing-прогоне или занятом advisory lock ждёт следующий poll,
   без fallback и без mutation.
4. Блокирует только 100 собственных child rows. Требует 88 исходных IDs
   `7990..8075,8077,8078`, прежний UTC MD5
   `14d3f5aea6d2b17ea37b99064183bdae`, ровно 12 `bucket IS NULL`, ошибок строк 0.
   Сверяет checksum только исходных 88, не будущих 100.
5. Требует отсутствие собственных snapshots, append batches и ledger events.
   При частичных receipts это уже другой recovery-сценарий: автоматического
   долива без отдельной сверки нет.
6. Меняет **только status №24 pending → processing**, требует ровно одну строку
   `RETURNING`, делает COMMIT и передаёт run тому же последовательному runner.
   Ручных изменений timestamps, counters, результатов или других runs нет.

Claim и guard выполняются одной транзакцией. Advisory/row locks не защищают
от постороннего handler, игнорирующего этот протокол: одиночный daemon —
предусловие, а не обещание exactly-once для любого числа процессов. Receipt
таблицы с текстовым source_run_id не защищаются FK-lock родительской строки.
Семантика блокировок: [документация PostgreSQL](https://www.postgresql.org/docs/current/explicit-locking.html).

После успешного claim запрос потребляется **до** вызова runner. Возврат ошибки
runner не запускает №24 повторно. После рестарта durable processing/completed/
failed также не переоткрываются. Ошибка или неизвестный исход COMMIT не вызывает
handler; следующий poll снова проверяет durable status. Ошибка guard/БД не
пропускает проверку через обычный selector: до устранения причины/отключения
режима worker не берёт следующий пакет. Startup cleanup в opt-in отключён,
чтобы не удалить чужие истёкшие runs.

## Обработка и проверка после отдельно разрешённого включения

Штатный runner выбирает только 12 NULL-bucket строк. Исходные 88 scoring/email/
validation/processed_at не пересчитываются; company_name при reconciliation
штатно может уточняться. Настройки кампаний, ready-only фильтрация, исключения,
блокировки, тарифы и provider `skipIfInCampaign=true` остаются прежними.
Штатная маршрутизация охватывает подходящие контакты всего этого run, не только
новых 12 результатов. Accepted — добавление в кампанию, не отправка письма.

Read-only postflight: 100 обработанных rows, исходный MD5 88, 100 durable
snapshots с retry marker, scored_at равен соответствующему processed_at
(старому для 88, новому для 12), completed identity-complete append batches,
совпадение totals/identities с ledger, отсутствие duplicate accepted и routed
без accepted. Missing batch/неизвестный исход не заменять нулём. При частичной
ошибке не переоткрывать №24 автоматически — сначала сверить receipts.

Между claim и внешним append нет общей распределённой транзакции: окончательный
исход подтверждается receipts, а не самим фактом выбора приоритетного run.
