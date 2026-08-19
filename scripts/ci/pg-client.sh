#!/usr/bin/env bash
# Клиент PostgreSQL из образа, а не из apt.
#
# Клиент обязан быть не старше сервера: `pg_dump` 16 против сервера 17
# отказывается снимать дамп вовсе. Раньше нужная версия ставилась из
# pgdg — через apt и через `curl` за ключом репозитория. Оба шага
# зависали молча: apt ждал чужую блокировку фонового обновления раннера,
# а у `curl` таймаута не было вовсе, и job снимался по пределу времени,
# ни разу не дойдя до самих миграций.
#
# Нужная версия уже лежит на раннере — внутри образа, которым поднят сам
# сервис PostgreSQL. Обёртки зовут её оттуда: ни сети, ни apt, ни
# ожидания чужих блокировок.
set -euo pipefail

IMAGE="${1:?не назван образ PostgreSQL}"
BIN_DIR="${PG_CLIENT_BIN_DIR:-/usr/local/bin}"

SUDO=""
if [ ! -w "$BIN_DIR" ]; then
  SUDO="sudo"
fi

for tool in psql pg_dump; do
  # `--network host`: сервис опубликован на localhost раннера.
  # Каталог задания и /tmp видны внутри, поэтому `-f путь/к.sql`
  # работает так же, как у клиента, поставленного пакетом.
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'workspace="${GITHUB_WORKSPACE:-$PWD}"' \
    'exec docker run --rm -i --network host \' \
    '  -e PGPASSWORD -e PGHOST -e PGPORT -e PGUSER -e PGDATABASE \' \
    '  -v "$workspace":"$workspace" -v /tmp:/tmp -w "$PWD" \' \
    "  $IMAGE $tool \"\$@\"" \
  | $SUDO install -m 0755 /dev/stdin "$BIN_DIR/$tool"
done
