# pg_dump-клиент >= server-версии. Серверы:
#   - Supabase managed PG 15.x
#   - Instantly local PG 16-alpine
# Берём 17, чтобы покрыть оба + запас на апгрейды.
FROM postgres:17-alpine

# curl для upload в Supabase Storage и Telegram-алертов
RUN apk add --no-cache curl

COPY backup.sh /backup.sh
RUN chmod +x /backup.sh

COPY crontab /etc/crontabs/root

RUN mkdir -p /backups /var/log && touch /var/log/cron.log

CMD ["sh", "-c", "crond -f -l 2 & tail -f /var/log/cron.log"]
