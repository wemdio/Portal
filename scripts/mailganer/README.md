# Локальная диагностика read-only коллектора

Срез 22 октября 2026, Asia/Tbilisi. Пользователь разрешил подготовить диагностику **без повторного запуска**. Эти библиотеки не являются transport/execution adapter: в них нет SSH, SQL, worker, SMTP, S3, provider или CLI-запускателя. Автоматизация остаётся PAUSED. Причина прежнего `NEW_COMPANY_COLLECTOR_ABORT` по-прежнему неизвестна.

## Контракт

`collector-diagnostics.py`: `run_diagnosed(controller_main, payload, helpers, binding_sha256, emit)` оборачивает одну явно переданную функцию и временно заменяет callbacks только в переданном словаре. Словарь восстанавливается на любом выходе. Сам `controller_main` и callbacks могут делать I/O — подключать реальные транспорты этим изменением **не разрешено**.

Диагностика выдаёт fixed-shape JSON frames с общей SHA-binding, последовательностью, числовым stage/query phase, начатыми запросами и подтверждёнными COMMIT. COMMIT учитывается только после возврата `commit_acknowledged is True`; ранний progress marker и пропущенный пустой запрос не являются ACK. Старый `emit_progress` заменяется тем же связанным протоколом, без голых JSON-строк.

Stages: `0 prepare`, `1 query`, `2 node start`, `3 send`, `4 receive`, `5 finish`, `6 cleanup`, `7 completed`. Контекст первой ошибки сохраняется через cleanup; её класс не заменяется классом ошибки `close`. Вне обёрнутой операции stage обозначает последний инструментированный контекст, а не доказательство успешности промежуточных проверок.

Node stderr продолжает вычитываться до EOF, но не сохраняется. Классификация ограничена первым MiB, счётчик насыщается, scratch ограничен 128 байтами. Сохраняется только подсказка из конечного списка JS-классов в начале строки; это не установленная причина. Drain completion без подтверждения Event остаётся false, ожидание при cleanup не больше 0,1 секунды.

`collector-failure-receipt.mjs`: `finishCollectorAttempt(alreadyFinishedResult, {sessionDirectory, bindingSha256}, verifyEnvelope)` принимает уже полученный результат, но ничего не запускает. При ошибке транспорта или sync/async envelope verification он сохраняет очищенный private receipt **до** фиксированного исключения. Сохранение — только `wx`, `0600`, в существующий принадлежащий пользователю приватный каталог без symlink. Повторное использование receipt запрещено. Неудача сохранения имеет отдельный фиксированный код без исходного текста.

Принимаются только точные поля/allowlists/binding/seq и непротиворечивый terminal. Невалидная или неполная диагностика даёт unknown counters (`null`), а не ноль. Candidate counts всегда `null`: failure receipt не является manifest/checkpoint, резервом или разрешением на enqueue. Хешируется только каноническая очищенная последовательность frames; raw stderr, exception messages, traceback, SQL, адреса, домены, ИНН и raw-stream digests не сохраняются. Сериализуется заново собранный plain-data receipt, не caller `toJSON`.

## Что ещё нужно перед реальным применением

Отдельный проверенный адаптер должен связать уникальную новую попытку с точными hashes controller/helper/payload и diagnostic code, проверить frozen assets **до** вызова и не переписывать старую неудачную сессию. Remote entrypoint обязан ловить исключение без вывода traceback, писать только safe frames в stderr, а source envelope — отдельно в stdout. Нельзя просто подставить новый pin в прежний runner.

После успешного terminal обязательна прежняя независимая проверка полного source envelope. Ни диагностический completed, ни успешный exit code сами по себе не разрешают scoring/SMTP/append. Live-интеграция, новая read-only попытка и возобновление пилота требуют отдельного решения пользователя.

## Выполненная проверка

Проверки выполнены только на синтетических данных; новые project/CI tests не добавлены. Private harnesses находятся вне Git.

- Python: 210 проверок, включая фактическое тело frozen `run_psql` с полностью подменёнными pipes/processes/timers/threads, ACK-only учёт, cleanup, bounded drain и восстановление callbacks; audit запретил socket/process/write. Перехват ошибки внутри caller не может превратить уже замеченный сбой операции в completed.
- JS: 31 проверка с hard-deny network/child calls; только три заранее разрешённых synthetic private receipts. Проверены malformed/conflicting frames, unknown counters, sync/async verifier failures, `wx`/`0600` и запрет повторного receipt.
- Независимое JS-ревью: 104 pure in-memory проверки, в том числе `toJSON`-утечка, некорректный spawn status, соответствие конечных Python/JS allowlists и фиксированная ошибка при отказе записи.
- Независимое Python-ревью: 59 pure checks; подтверждены запрет false completed после подавленной ошибки, сохранение primary/cleanup, ACK-only, bounded stderr и отсутствие raw canary.
- Прямая synthetic Python → JS связка: сохранены один подтверждённый COMMIT, первичная `BrokenPipeError` на stage 3 и отдельная cleanup `ValueError`; исходный canary не вышел в receipt.

Frozen controller, runner и payload прежней попытки не изменились. Реальных collector/SSH/SQL/S3/scoring/SMTP/provider вызовов и production-записей в этой доработке не было.
