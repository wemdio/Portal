FROM postgres:17-alpine

# Клиент MinIO (mc) — им бэкапы уезжают в S3.
#
# 22.09.2026 сборка молча положила сюда не бинарник, а текст ошибки: адрес
# dl.min.io/client/mc/release/linux-amd64/mc начал отдавать HTTP 410 Gone.
# Виноват был не поставщик, а `curl -sSL` без `-f`: ответ с ошибкой curl
# ошибкой не считает — он сохраняет ТЕЛО ответа в файл и выходит с нулевым
# кодом. Дальше chmod +x делал «исполняемым» текстовый файл, образ собирался
# зелёным, и ломалось всё только ночью, в проде:
#   /usr/local/bin/mc: line 1: 410: not found
#   /usr/local/bin/mc: line 3: syntax error: unexpected "("
# Бэкапы при этом не уезжали вовсе.
#
# Отсюда три правила ниже, каждое закрывает свою часть той аварии:
#   -f             — ответ с ошибкой валит команду, а не пишется в файл;
#   перебор ссылок — один умерший адрес больше не останавливает сборку;
#   mc --version   — последнее слово за самим бинарником: не запустился —
#                    образа не будет. Проверка в том же слое, иначе она
#                    проверяла бы кэш предыдущей сборки.
RUN apk add --no-cache curl ca-certificates \
    && set -eux \
    && for url in \
         "https://dl.min.io/client/mc/release/linux-amd64/mc" \
         "https://dl.minio.io/client/mc/release/linux-amd64/mc" \
         "https://github.com/minio/mc/releases/latest/download/mc-linux-amd64" \
       ; do \
         echo "[mc] trying $url"; \
         if curl -fsSL --retry 3 --retry-delay 2 -o /usr/local/bin/mc "$url"; then break; fi; \
         echo "[mc] failed: $url"; \
       done \
    && chmod +x /usr/local/bin/mc \
    && mc --version

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
