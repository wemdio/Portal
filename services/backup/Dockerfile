FROM postgres:17-alpine

RUN apk add --no-cache curl ca-certificates \
    && curl -sSL -o /usr/local/bin/mc https://dl.min.io/client/mc/release/linux-amd64/mc \
    && chmod +x /usr/local/bin/mc

COPY backup.sh /backup.sh
COPY entrypoint.sh /entrypoint.sh
COPY dump_env.awk /usr/local/bin/dump_env.awk
RUN chmod +x /backup.sh /entrypoint.sh

COPY crontab /etc/crontabs/root

RUN mkdir -p /backups /var/log && touch /var/log/cron.log

# entrypoint.sh снапшотит env контейнера в /etc/backup.env при каждом старте
# и потом запускает crond. cron-job в /etc/crontabs/root сначала делает
# `. /etc/backup.env`, чтобы /backup.sh получил актуальные BACKUP_S3_* / MAIN_S3_*
# / TELEGRAM_HEALTH_* — иначе он работает в пустом cron-окружении (BusyBox crond
# наследует только то, что было у него на момент старта).
CMD ["/entrypoint.sh"]
