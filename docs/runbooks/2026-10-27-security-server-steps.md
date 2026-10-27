# Сервер 139: шесть срочных пунктов аудита (27.10.2026)

Для того, у кого есть SSH на `root@139.60.162.24` (ключ — `docs/ssh-access.md`). Все команды —
на 139, если не сказано иное. В каждом пункте: посмотреть → изменить → проверить → откат.
Перед изменениями сделать копию `.env`:

```bash
cp /home/Portal/prod/.env /home/Portal/prod/.env.bak-20261027
```

## Что видно снаружи на 27.10.2026, 19:50 МСК

| Пункт | Снаружи |
|---|---|
| 1. «Удалённый рабочий стол» | `/rdp-ws` — nginx сам отвечает 404, порт 8082 закрыт: снаружи не достать |
| 2. PostgREST Instantly `:35401` | **200 без ключа — открыт** |
| 3. Вебхук LinkedIn | битое тело → 400: **секрет не задан** |
| 4. Подпись Telegram-вебхуков | снаружи не видно |
| 5. Права хранилища файлов | снаружи не проверяли |
| 6. Postgres `35432`, `35434` | открыты (так и нужно для аналитиков), кто может войти — не видно |

Открыты также `35480`, `8081`, `8090`, `8095` — не в этой инструкции.

## 1. Остатки «Удалённого рабочего стола»

Удалён из кода 27.10 (`2642b575a`), но контейнеры снимаются только при выкладке с `--remove-orphans`.

Посмотреть:
```bash
docker ps -a --format '{{.Names}} {{.Status}} {{.Ports}}' | grep -Ei 'rdp|guacd'
grep -n 'rdp-ws' /etc/nginx/sites-enabled/* /etc/nginx/conf.d/* 2>/dev/null
grep -nE '^RDP_' /home/Portal/prod/.env | sed -E 's/=.+/=<задан>/'
```

Изменить (только то, что нашлось):
```bash
docker rm -f portal-rdp-ws portal-guacd
# в найденном файле nginx удалить блок `location /rdp-ws { ... }`, затем:
nginx -t && systemctl reload nginx
sed -i '/^RDP_/d' /home/Portal/prod/.env
```
Если контейнер `portal-rdp-ws` был жив — сменить пароль RDP на самой машине, к которой он подключал
(ссылки-пропуска были бессрочными и попадали в логи nginx).

Проверить: `docker ps -a | grep -Ei 'rdp|guacd'` — пусто; с внешнего компьютера
`curl -s -o /dev/null -w '%{http_code}' https://polza-portal.ru/rdp-ws` — 404.

Откат не нужен: функции в портале больше нет.

## 2. Закрыть PostgREST Instantly `:35401` от интернета

Это шаг A из `docs/runbooks/2026-10-24-security-urgent.md`, повтор с проверкой.

Посмотреть, кто подключён снаружи (не `172.*` и не `127.*`):
```bash
ss -tn state established '( sport = :35401 )'
```

Изменить:
```bash
iptables -I DOCKER-USER -p tcp -m conntrack --ctorigdstport 35401 --ctdir ORIGINAL ! -s 172.16.0.0/12 -j DROP
# для каждого нужного внешнего адреса из ss (например, хосты «Рассылки»), ПОСЛЕ правила выше:
iptables -I DOCKER-USER -p tcp -m conntrack --ctorigdstport 35401 --ctdir ORIGINAL -s <адрес> -j RETURN
netfilter-persistent save
```

Проверить: с внешнего компьютера `curl -m 5 http://139.60.162.24:35401/` — таймаут; в портале
«Автоотчёты» → список кампаний и кабинет клиента → «Кампании» грузятся.

Откат: те же команды с `-D` вместо `-I`, затем `netfilter-persistent save`.

## 3. Секрет вебхука LinkedIn (Unipile)

Секрет передаётся в адресе вебхука: `?secret=…` (`app/src/app/api/tools/li-outreach/webhook/route.ts`).
Порядок: сначала Unipile, потом портал — пока секрет в портале не задан, адрес с `?secret=` тоже принимается.

1. Сгенерировать: `openssl rand -hex 24`.
2. В кабинете Unipile у вебхука на `https://polza-portal.ru/api/tools/li-outreach/webhook` дописать
   `?secret=<значение>`.
3. Добавить в `/home/Portal/prod/.env` строку `LI_OUTREACH_WEBHOOK_SECRET=<значение>` и пересоздать портал:
   ```bash
   cd /home/Portal/prod && docker compose -p portal -f docker-compose.prod.yml up -d --force-recreate --no-deps portal
   ```

Проверить с внешнего компьютера:
`curl -s -o /dev/null -w '%{http_code}' -X POST --data x https://polza-portal.ru/api/tools/li-outreach/webhook`
— теперь 200 вместо 400: запрос без секрета тихо отбрасывается до разбора тела.
В LinkedIn Outreach новое входящее сообщение по-прежнему появляется.

Откат: убрать строку из `.env`, пересоздать портал.

## 4. Подпись вебхуков Telegram-агента и бота ответов

Шаг B из `docs/runbooks/2026-10-24-security-urgent.md` без изменений. Порядок важен: сначала
перерегистрировать вебхуки (из консоли браузера сотрудником), потом `TELEGRAM_WEBHOOK_SECRET_ENFORCED=1`
в `.env` и пересоздание портала. Наоборот — боты перестанут отвечать.

Посмотреть, включён ли уже:
```bash
grep -nE '^TELEGRAM_WEBHOOK_SECRET_ENFORCED=' /home/Portal/prod/.env
```

## 5. Права хранилища файлов (только посмотреть)

В хранилище лежат сессии TG-аккаунтов (`tg-outreach-sessions`) — утечка = захват аккаунтов.
В репозитории для части бакетов политик нет, а на проде, по комментарию миграции 0035, есть ручные.

```bash
docker exec -i main-postgres psql -X -U postgres -d postgres -A -F' | ' <<'SQL'
select id, public from storage.buckets order by id;
select policyname, roles::text, cmd, qual, with_check from pg_policies where schemaname = 'storage' order by policyname;
select grantee, string_agg(privilege_type, ',') from information_schema.role_table_grants
 where table_schema = 'storage' and table_name = 'objects' group by grantee;
SQL
```

Вывод прислать в чат — по нему будет миграция. Опасно, если у бакета `public = t` или есть политика
для `anon`/`authenticated` с `qual` = `true` или без проверки `auth.uid()`/сотрудника.

## 6. Postgres снаружи: суперпользователей не пускать

Порты `35434` (основная база) и `35432` (датасет Instantly) **не закрывать** — через них ходят
аналитики. Закрываем только вход суперпользователей не из Docker и не с localhost.

Посмотреть (для каждой базы: `main-postgres` и `instantly-postgres-prod`):
```bash
docker exec -i main-postgres psql -X -U postgres -d postgres -A <<'SQL'
show hba_file;
select line_number, type, database, user_name, address, auth_method from pg_hba_file_rules;
select rolname from pg_roles where rolsuper and rolcanlogin;
select usename, client_addr, count(*) from pg_stat_activity
 where client_addr is not null and host(client_addr) !~ '^(172\.|127\.)' group by 1, 2;
SQL
```
Последний запрос — кто сейчас подключён снаружи. Если там суперпользователь — сначала выяснить, чей это
скрипт.

**Основная база (`main-postgres`).** Аналитики входят ролью `readonly`. В файл из `show hba_file`
**первыми строками** добавить (подставить суперпользователей из запроса выше):
```
host  all  postgres,supabase_admin  172.16.0.0/12  scram-sha-256
host  all  postgres,supabase_admin  127.0.0.1/32   scram-sha-256
host  all  postgres,supabase_admin  0.0.0.0/0      reject
host  all  postgres,supabase_admin  ::/0           reject
```
Метод в первых двух строках — тот же, что в действующих строках файла (если там `md5`, писать `md5`).
Применить и проверить:
```bash
docker exec -i main-postgres psql -X -U postgres -d postgres -c "select pg_reload_conf();"
docker exec -i main-postgres psql -X -U postgres -d postgres -c "select line_number, error from pg_hba_file_rules where error is not null;"
```
Второй запрос должен вернуть 0 строк. Перезагрузка конфигурации текущие подключения не рвёт.
Затем: портал открывается, ночной бэкап и синк датасета проходят, коннектор «Portal DB» у аналитиков работает.

Откат: удалить четыре строки, снова `select pg_reload_conf();`.

**Датасет Instantly (`instantly-postgres-prod`).** Аналитики сейчас входят ролью `instantly` — это
владелец всей базы, её снаружи отрезать нельзя, пока у них нет другой роли. Порядок:
1. завести роль только на чтение для `instantly_dataset` и раздать её аналитикам;
2. после того как все переключились — те же строки `reject` для `instantly` и суперпользователей.
Шаг 1 — отдельной задачей, SQL роли подготовим по запросу.

## После всего

С внешнего компьютера повторить проверки из таблицы вверху и прислать результат — обновим аудит.
