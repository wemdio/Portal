# nginx на прод-сервере (139.60.162.12)

**Источник правды — сервер**: `/etc/nginx/sites-available/` (симлинки в `sites-enabled/`).
Здесь лежат снапшоты для ревью и disaster recovery. Автодеплоя нет — после правок
на сервере обновляйте снапшот руками.

> После DB cutover 22.07.2026 боевой nginx проксирует Supabase API в Kong на
> production-хосте `139.60.162.12:35480`. Трекаемые ниже `.conf` — снапшоты до
> переезда и всё ещё содержат старый upstream; не разворачивайте их без синхронизации
> с `/etc/nginx/sites-available/` на сервере.

| Файл | Назначение |
|---|---|
| `polza-portal.ru.conf` | Основной портал. В боевой конфигурации проксирует `/auth\|rest\|storage\|realtime/v1/` → Kong на production-хосте :35480, остальное → portal app :3000. |
| `outreachos.pro.conf` | Тот же app под white-label доменом, конфиг зеркальный. |
| `50x.html` | Страница ошибки 502/503/504. На сервере живёт в `/var/www/html/50x.html` (и в `/home/Portal/prod/`). |

`polzaagency.ru` (лендинг → :3344) не трекаем.

## Снапшот от 10.06.2026 — что внесено

1. `proxy_buffer_size 32k; proxy_buffers 8 32k; proxy_busy_buffers_size 64k;` —
   ответы Kong/PostgREST не влезали в дефолтные 4k → `502 upstream sent too big header`
   (150–500/день). После фикса — 0.
2. `large_client_header_buffers 4 32k;` — запас под крупные supabase-куки.
3. В `location ^~ /realtime/v1/`: `proxy_set_header Cookie "";` — куки realtime не
   нужны (auth через apikey+token), а раздутые куки давали `431` на websocket
   (25k случаев с апреля — realtime у клиентов молча не работал).
4. `/var/www/html/50x.html` создан (раньше `error_page` указывал в пустоту).

## Как применять изменения на сервере

```bash
cp -a /etc/nginx/sites-available/polza-portal.ru{,.bak-$(date +%Y%m%d)}
# ... правки ...
nginx -t && systemctl reload nginx   # graceful, без даунтайма
```

Откат: `cp -a <файл>.bak-YYYYMMDD <файл> && nginx -t && systemctl reload nginx`.
Бэкапы от 10.06.2026: `*.bak-20260610` там же.
