# SMTP-прокси: EAI_AGAIN на всех пробах — умер хостеровский DNS на 144.31.54.166 (24.07.2026)

Хост `144.31.54.166` (utility, бывший DB) держит два Node-инстанса smtp-proxy
(контейнеры `smtp-proxy` :3100 и `smtp-proxy-b` :3101, egress 31.76.79.220).
Третий инстанс — Python-standalone на `89.19.209.252` (Timeweb).

## Симптом

После рутинного передеплоя smtp-proxy (rebuild + recreate контейнеров)
контрольная проба `postmaster@gmail.com` на ОБОИХ инстансах вернула:

```json
{"code":0,"exists":null,"isCatchAll":null,"greylist":false,
 "error":"getaddrinfo EAI_AGAIN gmail-smtp-in.l.google.com"}
```

`/health` при этом отвечал `{"status":"ok"}` — сервис жив, но все пробы мёртвы.

## Диагностика (как отличить «мы сломали деплоем» от «инфра хоста»)

1. `getent hosts gmail-smtp-in.l.google.com` **на самом хосте** → FAIL.
   Значит, проблема вне Docker и вне нашего кода.
2. `cat /etc/resolv.conf` → единственный resolver `169.254.2.3`
   (link-local DNS хостера, прописан dhclient-script).
3. `nslookup gmail-smtp-in.l.google.com 169.254.2.3` → `communications error…
   timed out`, `no servers could be reached` — resolver хостера мёртв.
4. `nslookup gmail-smtp-in.l.google.com 8.8.8.8` → резолвится (A и AAAA).
   Исходящий UDP/53 с хоста в порядке — умер именно хостеровский DNS.

Вывод: **аутейдж DNS у хостера**, совпавший по времени с деплоем. Деплой был
ни при чём, но проверка «проба после recreate» это сразу вскрыла — рабочий
паттерн: всегда гонять живую пробу, а не только /health.

## Импакт

Оба Node-инстанса на этом хосте бесполезны до починки DNS. Трафик проб
держал Python-инстанс на 89.19.209.252 (failover по SMTP_PROXY_URLS —
именно для этого несколько egress-точек и существуют).

## Фикс (сделан сразу, временный)

`/etc/resolv.conf` (бэкап рядом `/etc/resolv.conf.bak-*`):

```
nameserver 8.8.8.8
nameserver 1.1.1.1
nameserver 169.254.2.3   # хостерский — как fallback
```

Затем `docker compose restart smtp-proxy smtp-proxy-b` — **контейнеры копируют
host resolv.conf при СТАРТЕ**, без рестарта они продолжают ходить на мёртвый
resolver (частая ловушка: на хосте DNS уже починен, в контейнерах всё ещё нет).

После: `C3100-DNS-OK`, `C3101-DNS-OK`, пробы на обоих портах
`{code:250, exists:true, isCatchAll:false}`.

## ⚠️ Каверт: фикс может слететь

`dhclient-script` перезаписывает `/etc/resolv.conf` при DHCP-renew. Если
аутейдж хостерского DNS повторится и resolv.conf «сам откатился» — это он.
Постоянные варианты (НЕ сделаны, на усмотрение инфры):
- netplan / `/etc/dhcp/dhclient.conf`: `supersede domain-name-servers …`
  или `prepend domain-name-servers 8.8.8.8, 1.1.1.1;`
- `/etc/docker/daemon.json`: `{ "dns": ["8.8.8.8", "1.1.1.1"] }` — резолвер
  для контейнеров независимо от хостового (требует restart dockerd).

## Что уже зашито в код (этот же релиз, ветка Sergey, 3ae8e8c66)

Инцидент — ровно тот класс сбоя, что гасится в коде валидатора:

- `isInconclusiveTransport` (`app/src/lib/emailValidation/validator.ts`)
  теперь матчит `getaddrinfo|eai_again|enotfound`: DNS-сбой на стороне
  прокси → **failover на следующий egress**, а не «конклюзивный» unknown
  (раньше: терминальный unknown после одной попытки на ВСЕХ адресах доменов
  этого MX — один чих DNS на VPS отравлял целый джоб).
- `lookupMX` после исчерпания пиннутых резолверов (8.8.8.8/1.1.1.1) делает
  одну попытку через ОС-резолвер воркера.
- `smtp_proxy.py`: мусорный `SMTP_CHECK_DEADLINE_MS` больше не роняет процесс
  на импорте (safe-parse с дефолтом 21s).

## Сигналы для мониторинга (если захотим)

- Доля ответов прокси с `error ~ getaddrinfo|EAI_AGAIN` > 0 за 5 мин —
  DNS хоста умер (health при этом зелёный!).
- Джобы валидации с аномальным ростом `unknown` на step='unknown' +
  текст `getaddrinfo` в `email_validation_queue.last_error`.
- Проба из воркера: `postmaster@gmail.com` через каждый URL из
  `SMTP_PROXY_URLS` раз в N минут (сейчас такого нет, ловим глазами).
