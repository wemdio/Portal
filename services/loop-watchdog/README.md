# loop-watchdog

Защищает prod-сервер (139) от exit-loop контейнеров, которые дважды роняли сервер:
`postgrest` healthcheck loop 22.07.2026 (15 ч до hang) и `leads-report-bot` exit
loop 23.07.2026 21:00 MSK (10 мин до hang).

Слушает `docker events`, считает die-события в скользящем окне и при превышении
порога принудительно останавливает виновника + шлёт TG-алерт в тот же чат, что и
`health-check`.

## Env

| Переменная | Дефолт | Смысл |
|---|---|---|
| `WATCHDOG_WINDOW_SEC` | `600` | Ширина окна наблюдения, сек |
| `WATCHDOG_THRESHOLD` | `5` | Порог: сколько exit'ов в окне = «loop» |
| `WATCHDOG_SELF_NAME` | `portal-loop-watchdog` | Имя своего контейнера — исключается из мониторинга |
| `TELEGRAM_HEALTH_BOT_TOKEN` / `TELEGRAM_HEALTH_CHAT_ID` | — | Куда слать алерт (те же креды, что у `health-check`) |

## Как реагирует

При обнаружении loop'а:
1. `docker update --restart=no <name>` — снимает автостарт.
2. `docker stop <name>` — гасит контейнер.
3. Шлёт TG-сообщение с именем контейнера, счётчиком и командой восстановления.

Восстановить руками после починки:
```bash
docker update --restart=unless-stopped <name>
docker start <name>
```

## Что не трогает

- Собственный контейнер (`WATCHDOG_SELF_NAME`).
- Контейнеры, вышедшие с `exitCode=0` (штатное завершение).

## Требует

Read-write доступ к docker socket:
```yaml
volumes:
  - /var/run/docker.sock:/var/run/docker.sock
```
