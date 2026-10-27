# Сервер 139: шесть срочных пунктов (27.10.2026)

Пошагово, для того, кто сам заходит на сервер. Команды копировать целиком, блоками.
Сначала только смотрим — это ничего не меняет. Потом меняем по одному пункту и сразу проверяем.
Если в ответе что-то не так, как написано, — остановиться и прислать вывод в чат.

## Что уже проверено снаружи (27.10, 19:50 МСК)

| Пункт | Состояние |
|---|---|
| 1. Остатки «Удалённого рабочего стола» | снаружи не открывается; живы ли контейнеры — видно только на сервере |
| 2. База Instantly на порту 35401 | **открыта в интернет без пароля** |
| 3. Вебхук LinkedIn | **без секрета** |
| 4. Подпись Telegram-ботов | снаружи не видно |
| 5. Права на хранилище файлов | снаружи не видно |
| 6. Вход в базы под главными ролями | снаружи не видно |

---

## Шаг 0. Зайти на сервер

В терминале Мака:

```bash
ssh -i /Users/cybermart/.ssh/portal_hostkey_mac_ed25519 -o IdentitiesOnly=yes root@139.60.162.24
```

Сразу сделать копию настроек портала — из неё всё можно вернуть:

```bash
cp /home/Portal/prod/.env /home/Portal/prod/.env.bak-20261027
```

## Шаг 1. Посмотреть, ничего не меняя

Вставить блок целиком и **прислать весь вывод в чат**. Паролей и ключей в выводе нет — только
«задан / не задан», имена и адреса.

```bash
echo '=== 1. Удалённый рабочий стол: контейнеры, nginx, настройки'
docker ps -a --format '{{.Names}} {{.Status}}' | grep -Ei 'rdp|guacd' || echo 'контейнеров нет'
grep -ln 'rdp-ws' /etc/nginx/sites-enabled/* /etc/nginx/conf.d/* 2>/dev/null || echo 'в nginx нет'
grep -E '^RDP_' /home/Portal/prod/.env | sed -E 's/=.+/=<задан>/' || true

echo '=== 2. Кто сейчас подключён к базе Instantly (порт 35401)'
ss -tn state established '( sport = :35401 )'

echo '=== 3-4. Секреты вебхуков'
grep -E '^(LI_OUTREACH_WEBHOOK_SECRET|TELEGRAM_WEBHOOK_SECRET_ENFORCED)=' /home/Portal/prod/.env | sed -E 's/=.+/=<задан>/' || echo 'ни одного не задано'

echo '=== 5. Хранилище файлов'
docker exec -i main-postgres psql -X -U postgres -d postgres -A -F' | ' <<'SQL'
select id, public from storage.buckets order by id;
select policyname, roles::text, cmd, qual, with_check from pg_policies where schemaname = 'storage' order by policyname;
select grantee, string_agg(privilege_type, ',') from information_schema.role_table_grants
 where table_schema = 'storage' and table_name = 'objects' group by grantee;
SQL

echo '=== 6а. Основная база: правила входа и кто подключён не изнутри сервера'
docker exec -i main-postgres psql -X -U postgres -d postgres -A -F' | ' <<'SQL'
select line_number, type, database, user_name, address, auth_method from pg_hba_file_rules;
select rolname from pg_roles where rolsuper and rolcanlogin;
select usename, client_addr, count(*) from pg_stat_activity
 where client_addr is not null and host(client_addr) !~ '^(172\.|127\.)' group by 1, 2;
SQL

echo '=== 6б. База датасета Instantly: то же самое'
docker exec -i instantly-postgres-prod sh -c 'psql -X -U "$POSTGRES_USER" -d "${POSTGRES_DB:-postgres}" -A -F" | "' <<'SQL'
select line_number, type, database, user_name, address, auth_method from pg_hba_file_rules;
select rolname from pg_roles where rolsuper and rolcanlogin;
select usename, client_addr, count(*) from pg_stat_activity
 where client_addr is not null and host(client_addr) !~ '^(172\.|127\.)' group by 1, 2;
SQL
```

По этому выводу станет ясно, что делать в шагах 2, 5 и 6. Шаги ниже можно начинать, не дожидаясь ответа.

---

## Шаг 2. Убрать остатки «Удалённого рабочего стола» (пункт 1)

**Зачем.** Функцию удалили 27.10, но на сервере могли остаться её контейнеры. Ссылки на вход были
бессрочными и попадали в логи — пока контейнер жив, по старой ссылке можно зайти на машину студии.

**Если в шаге 1 под «=== 1» написано «контейнеров нет», «в nginx нет» и нет строк RDP — пропустить.**

Иначе — удалить то, что нашлось:

```bash
docker rm -f portal-rdp-ws portal-guacd
sed -i '/^RDP_/d' /home/Portal/prod/.env
```

Если nginx показал файл — открыть его (`nano <путь к файлу>`), удалить блок, начинающийся с
`location /rdp-ws {` и до его закрывающей `}`, сохранить (Ctrl+O, Enter, Ctrl+X) и применить:

```bash
nginx -t && systemctl reload nginx
```

`nginx -t` должен ответить `syntax is ok` и `test is successful`. Если ругается — не перезагружать,
прислать вывод.

**Если контейнер был жив** — сменить пароль RDP на самой машине, к которой он подключал.

**Проверка:** `docker ps -a | grep -Ei 'rdp|guacd'` — пусто; портал открывается.

## Шаг 3. Закрыть базу Instantly от интернета (пункт 2)

**Зачем.** Сейчас любой человек из интернета читает базу Instantly (кампании, лиды) без пароля и
может её менять. Портал ходит к ней изнутри сервера — ему закрытие не мешает.

**Перед командой** посмотреть в выводе шага 1 под «=== 2»: если там есть адреса **не** на `172.` и
**не** на `127.` — прислать их в чат и подождать ответа (это может быть «Рассылка» на другом сервере).
Если таких адресов нет:

```bash
iptables -I DOCKER-USER -p tcp -m conntrack --ctorigdstport 35401 --ctdir ORIGINAL ! -s 172.16.0.0/12 -j DROP
netfilter-persistent save
```

Если `netfilter-persistent` не найден — правило уже работает, но пропадёт после перезагрузки
сервера; написать в чат.

**Проверка:**
1. С обычного компьютера (не с сервера): `curl -m 5 http://139.60.162.24:35401/` — должна быть
   пауза 5 секунд и ошибка времени ожидания, а не список таблиц.
2. В портале «Автоотчёты» → список кампаний и кабинет клиента → «Кампании» загружаются.

**Если что-то сломалось** — вернуть как было:
```bash
iptables -D DOCKER-USER -p tcp -m conntrack --ctorigdstport 35401 --ctdir ORIGINAL ! -s 172.16.0.0/12 -j DROP
netfilter-persistent save
```

## Шаг 4. Секрет для вебхука LinkedIn (пункт 3)

**Зачем.** Сейчас кто угодно может прислать порталу поддельное «пришло сообщение в LinkedIn» или
«приняли заявку», и портал обработает это от имени наших аккаунтов.

Порядок важен: **сначала кабинет Unipile, потом сервер**. Наоборот — потеряются настоящие события.
Строку в настройки добавляем через `printf` с переводом строки в начале: если последняя строка файла
без перевода, `echo` склеил бы её с новой (так 27.08 сломалась чистка бэкапов).

1. На сервере придумать секрет:
   ```bash
   openssl rand -hex 24
   ```
   Скопировать строку, которую он выдаст.
2. В кабинете Unipile у вебхука `https://polza-portal.ru/api/tools/li-outreach/webhook` дописать в
   конец адреса `?secret=` и эту строку.
3. На сервере вписать её в настройки и перезапустить портал (вместо `ВАШ_СЕКРЕТ` — та же строка):
   ```bash
   printf '\nLI_OUTREACH_WEBHOOK_SECRET=ВАШ_СЕКРЕТ\n' >> /home/Portal/prod/.env
   cd /home/Portal/prod && docker compose -p portal -f docker-compose.prod.yml up -d --force-recreate --no-deps portal
   ```
   Портал перезапускается около минуты.

**Проверка** с обычного компьютера:
```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST --data x https://polza-portal.ru/api/tools/li-outreach/webhook
```
Было `400`, должно стать `200` — значит, запрос без секрета теперь отбрасывается.

**Вернуть как было:** удалить строку `LI_OUTREACH_WEBHOOK_SECRET=…` из `/home/Portal/prod/.env`
(`nano /home/Portal/prod/.env`) и снова выполнить команду перезапуска из п. 3.

## Шаг 5. Подпись Telegram-ботов портала (пункт 4)

**Зачем.** Без подписи можно прислать Telegram-агенту поддельное сообщение «от админа», и агент
выполнит запрос к базе и ответит злоумышленнику.

**Если в шаге 1 под «=== 3-4» уже есть `TELEGRAM_WEBHOOK_SECRET_ENFORCED=<задан>` — пропустить.**

Порядок важен: сначала перерегистрировать ботов, потом включить проверку. Наоборот — боты замолчат.

1. Открыть портал в браузере под своим входом, нажать F12 → вкладка «Console», вставить и нажать Enter:
   ```js
   const k = Object.keys(localStorage).find((x) => x.endsWith('-auth-token'));
   const t = JSON.parse(localStorage[k]).access_token;
   for (const p of ['/api/telegram/agent/register', '/api/telegram/client-replies/register']) {
     console.log(p, await (await fetch(p, { method: 'POST', headers: { Authorization: 'Bearer ' + t } })).json());
   }
   ```
   В обоих ответах должно быть `ok: true`. Если нет — остановиться и прислать ответ.
2. На сервере:
   ```bash
   printf '\nTELEGRAM_WEBHOOK_SECRET_ENFORCED=1\n' >> /home/Portal/prod/.env
   cd /home/Portal/prod && docker compose -p portal -f docker-compose.prod.yml up -d --force-recreate --no-deps portal
   ```

**Проверка:** написать Telegram-агенту и боту ответов клиентам — оба отвечают.

**Вернуть как было:** удалить строку `TELEGRAM_WEBHOOK_SECRET_ENFORCED=1` из `.env` и перезапустить
портал той же командой.

Шаги 4 и 5 можно сделать вместе: вписать обе строки и перезапустить портал один раз.

## Шаг 6. Хранилище файлов (пункт 5)

Ничего не делать — только прислать вывод шага 1 под «=== 5». Там видно, кто может читать файлы, в
том числе сессии TG-аккаунтов (их утечка — это угон аккаунтов). По выводу будет готова миграция.

## Шаг 7. Главные роли баз — только изнутри сервера (пункт 6)

**Зачем.** Порты баз 35434 и 35432 открыты, и так нужно: через них ходят аналитики. Но войти
снаружи может и главная роль с полными правами — злоумышленнику остаётся только подобрать пароль.
Закрываем вход главным ролям снаружи, аналитиков не трогаем.

Ничего не делать — только прислать вывод шага 1 под «=== 6а» и «=== 6б». По нему будут точные
строки для вставки и порядок проверки. У датасета Instantly аналитики входят главной ролью
`instantly`, поэтому там сначала нужно выдать им отдельную роль только на чтение — иначе у них
пропадёт доступ.

---

## После всего

С обычного компьютера повторить проверки из шагов 3 и 4 и написать в чат, что получилось —
обновим аудит.
