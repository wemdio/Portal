FROM postgres:17-alpine

# Заливкой в S3 занимается rclone из пакетов Alpine, а не клиент MinIO.
#
# 22.09.2026 бэкапы встали: mc в контейнере оказался не бинарником, а текстом
# ошибки.
#   /usr/local/bin/mc: line 1: 410: not found
#   /usr/local/bin/mc: line 3: syntax error: unexpected "("
# 410 — это HTTP 410 Gone. Проверено в тот же день: прямые ссылки на бинарник
# закрыты все (dl.min.io, dl.minio.io, latest-релиз на GitHub), а образ
# minio/mc на Docker Hub отвечает «pull access denied … insufficient_scope».
# То есть MinIO закрыл свободную раздачу клиента целиком, и починить это
# сменой ссылки нельзя — надо было уходить с него.
#
# rclone умеет ровно те три операции, ради которых здесь держали mc: проверить
# доступ, положить файл, удалить старее N дней. Ставится из репозитория Alpine
# — тем же apk, что и всё остальное в этом образе, без скачиваний со стороны.
#
# Первопричина той аварии, ради памяти: `curl -sSL` без `-f` ответ с ошибкой
# ошибкой не считает — он сохраняет ТЕЛО ответа в файл и выходит с нулевым
# кодом. Дальше chmod +x делал «исполняемым» текстовый файл, образ собирался
# зелёным, и ломалось всё ночью, в проде. Проверка `rclone version` ниже стоит
# ровно поэтому: образ без рабочего клиента не должен собираться.
RUN apk add --no-cache curl ca-certificates rclone \
    && rclone version

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
