# Signals RU — read-only доступ к заявкам

Signals RU (`outreachos-ru`) хранит данные в SQLite (`/app/data/signals_ru.db`
в volume `outreachos-signals-ru_outreachos-ru-data`). У SQLite нет ролей, а
долгое чтение живого файла блокирует запись приложения, поэтому доступ
устроен через копию:

```
signals_ru.db (mode=ro, backup API) ──cron */15──▶ sync.py ──▶ Postgres signals-ru-readonly
                                                                 127.0.0.1:35440, БД signals_ru
читатель ──SSH-туннель (пользователь signals-ro, только проброс)──┘ роль signals_ro: SELECT
```

Копируются `users_ru`, `wizard_sessions_ru`, `wizard_jobs_ru` со всеми колонками.
`*_json` и `detected_icp` — `jsonb`, `*_at`/`*_until` — `timestamptz` (UTC), если
все значения разбираются; иначе `text`. Время последнего обновления — в `_sync_info`.
Таблицы пересоздаются целиком каждые 15 минут: свои объекты читатель создавать не может.

## Файлы на сервере

| Где | Что |
|---|---|
| `/opt/signals-ru-readonly/` | `docker-compose.yml`, `sync.py`, `setup.sh`, cron-файл |
| `/etc/signals-ru-readonly/` | `postgres.env`, `signals_ro.password`, `signals_ro.pub` (0600, не в git) |
| `/etc/cron.d/signals-ru-readonly` | запуск `sync.py` каждые 15 минут |
| `/var/log/signals-ru-readonly-sync.log` | лог синхронизаций |
| `~signals-ro/.ssh/authorized_keys` | ключ читателя, только `permitopen=127.0.0.1:35440` |

## Установка

```bash
scp deploy/signals-ru-readonly/* root@139.60.162.24:/opt/signals-ru-readonly/
scp signals_ro_ed25519.pub root@139.60.162.24:/etc/signals-ru-readonly/signals_ro.pub
ssh root@139.60.162.24 'bash /opt/signals-ru-readonly/setup.sh'
```

`setup.sh` повторяем без вреда: пароли не перегенерирует, ключ перезапишет.

## Подключение (DBeaver)

Новое соединение → PostgreSQL.

- **Main:** Host `127.0.0.1`, Port `35440`, Database `signals_ru`, User `signals_ro`, пароль — из `/etc/signals-ru-readonly/signals_ro.password`.
- **SSH:** Use SSH Tunnel, Host `139.60.162.24`, Port `22`, User `signals-ro`, Authentication `Public Key`, ключ `signals_ro_ed25519`.

Из терминала: `ssh -N -L 35440:127.0.0.1:35440 -i signals_ro_ed25519 signals-ro@139.60.162.24`,
затем `psql "postgresql://signals_ro@127.0.0.1:35440/signals_ru"`.

## Обслуживание

- Свежесть: `SELECT * FROM _sync_info;`
- Лог: `tail /var/log/signals-ru-readonly-sync.log`
- Отозвать доступ: `rm ~signals-ro/.ssh/authorized_keys` и
  `ALTER ROLE signals_ro NOLOGIN;` в контейнере.
- Убрать целиком: удалить `/etc/cron.d/signals-ru-readonly`, затем
  `docker compose -p signals-ru-readonly -f /opt/signals-ru-readonly/docker-compose.yml down -v`,
  затем `userdel -r signals-ro` и `rm -rf /opt/signals-ru-readonly /etc/signals-ru-readonly /var/lib/signals-ru-readonly`.
