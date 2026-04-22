FROM postgres:17-alpine

RUN apk add --no-cache curl ca-certificates \
    && curl -sSL -o /usr/local/bin/mc https://dl.min.io/client/mc/release/linux-amd64/mc \
    && chmod +x /usr/local/bin/mc

COPY backup.sh /backup.sh
RUN chmod +x /backup.sh

COPY crontab /etc/crontabs/root

RUN mkdir -p /backups /var/log && touch /var/log/cron.log

CMD ["sh", "-c", "crond -f -l 2 & tail -f /var/log/cron.log"]
