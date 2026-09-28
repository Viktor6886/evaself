# Свой сервер Telegram Bot API (docs/telegram-bot-api.md).
#
# Официальный сервер в локальном режиме отдаёт боту файлы любого размера —
# путём на своём диске. TDLib создаёт каталоги с правами 0700, а файлы с
# 0600: прочитать и удалить их может только пользователь процесса. Поэтому
# сервер работает под uid/gid 10002 — тем же, что у media-service, который
# забирает файл с общего тома и удаляет оригинал после чтения. Больше
# образ ничего не меняет.
ARG TELEGRAM_BOT_API_IMAGE=aiogram/telegram-bot-api
ARG TELEGRAM_BOT_API_VERSION=10.3
FROM ${TELEGRAM_BOT_API_IMAGE}:${TELEGRAM_BOT_API_VERSION}

# Рабочий и временный каталоги сервера принадлежали прежнему uid 101: без
# временного сервер не стартует вовсе («Can't create files in the directory»).
RUN sed -i 's/^telegram-bot-api:x:101:101:/telegram-bot-api:x:10002:10002:/' /etc/passwd \
 && sed -i 's/^telegram-bot-api:x:101:/telegram-bot-api:x:10002:/' /etc/group \
 && chown -R 10002:10002 /var/lib/telegram-bot-api /tmp/telegram-bot-api \
 && grep -q '^telegram-bot-api:x:10002:10002:' /etc/passwd
