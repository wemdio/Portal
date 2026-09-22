# Клиент MinIO (mc) — им бэкапы уезжают в S3. Берём его из официального образа
# MinIO, а не качаем по ссылке.
#
# 22.09.2026 бэкапы встали: mc в контейнере оказался не бинарником, а текстом
# ошибки.
#   /usr/local/bin/mc: line 1: 410: not found
#   /usr/local/bin/mc: line 3: syntax error: unexpected "("
# 410 — это HTTP 410 Gone: MinIO закрыл прямые ссылки на бинарник. Проверено в
# тот же день, отвечают ошибкой все три известных адреса — и dl.min.io, и
# dl.minio.io, и latest-релиз на GitHub. То есть чинить ссылку бесполезно, надо
# менять способ доставки.
#
# Но первопричина была не в ссылке. `curl -sSL` без `-f` ответ с ошибкой
# ошибкой не считает: он сохраняет ТЕЛО ответа в файл и выходит с нулевым
# кодом. Дальше chmod +x делал «исполняемым» текстовый файл, образ собирался
# зелёным, и ломалось всё ночью, в проде, когда бэкап пытался этот текст
# запустить. Копии в S3 не уезжали вовсе.
#
# Копирование из образа закрывает обе беды разом: качать нечего, а если слоя с
# бинарником в образе не окажется, сборка упадёт прямо на COPY. Проверка
# `mc --version` ниже — последнее слово за самим бинарником.
FROM minio/mc:latest AS mc

FROM postgres:17-alpine

RUN apk add --no-cache curl ca-certificates
COPY --from=mc /usr/bin/mc /usr/local/bin/mc
RUN chmod +x /usr/local/bin/mc && mc --version

COPY backup.sh /backup.sh
COPY entrypoint.sh /entrypoint.sh
COPY restore-bundle.sh /restore-bundle.sh
COPY dump_env.awk /usr/local/bin/dump_env.awk
RUN chmod +x /backup.sh /entrypoint.sh /restore-bundle.sh

COPY crontab /etc/crontabs/root

RUN mkdir -p /backups /var/log && touch /var/log/cron.log

# entrypoint.sh снапшотит env контейнера в /etc/backup.env при каждом старте
# и потом запускает crond. cron-job в /etc/crontabs/root сначала делает
# `. /etc/backup.env`, чтобы /backup.sh получил актуальные BACKUP_S3_* / MAIN_S3_*
# / TELEGRAM_HEALTH_* — иначе он работает в пустом cron-окружении (BusyBox crond
# наследует только то, что было у него на момент старта).
CMD ["/entrypoint.sh"]
