#!/usr/bin/env bash
# ffmpeg и ffprobe для job media-service.
#
# apt на раннере — лотерея: рядом идёт фоновое обновление, и установка
# то занимает восемь минут, то не заканчивается вовсе. Один такой заход
# уже снял job по двадцатиминутному пределу, не начав проверок.
#
# Поэтому у apt здесь жёсткий срок, а за ним — тот же приём, что и с
# клиентом PostgreSQL: инструмент берётся из образа. Docker Hub CI и так
# нужен, а чужая блокировка dpkg на него не влияет.
set -euo pipefail

IMAGE="${FFMPEG_IMAGE:-linuxserver/ffmpeg:latest}"
BIN_DIR="${FFMPEG_BIN_DIR:-/usr/local/bin}"
APT_BUDGET_SECONDS="${FFMPEG_APT_BUDGET:-300}"

SUDO=""
if [ ! -w "$BIN_DIR" ]; then
  SUDO="sudo"
fi

if command -v ffmpeg >/dev/null 2>&1 && command -v ffprobe >/dev/null 2>&1; then
  echo "==> ffmpeg уже установлен"
  ffmpeg -version | head -1
  exit 0
fi

# Срок общий на ожидание блокировки и обе команды apt: превышение
# означает, что раннер занят надолго, и ждать его бессмысленно.
if [ "${FFMPEG_SKIP_APT:-}" != "1" ] && \
   sudo timeout -k 10 "$APT_BUDGET_SECONDS" bash -c '
     "$0/scripts/ci/apt-wait.sh"
     apt-get update -qq
     apt-get install -y -qq ffmpeg
   ' "${GITHUB_WORKSPACE:-$PWD}"; then
  echo "==> ffmpeg поставлен пакетом"
  ffmpeg -version | head -1
  exit 0
fi

echo "==> apt не уложился в $APT_BUDGET_SECONDS с; берём ffmpeg из образа $IMAGE"
docker pull -q "$IMAGE"

for tool in ffmpeg ffprobe; do
  # Рабочий каталог задания и /tmp видны внутри: обе программы работают
  # с файлами по абсолютным путям, а вывод идёт в stdout.
  printf '%s\n' \
    '#!/usr/bin/env bash' \
    'workspace="${GITHUB_WORKSPACE:-$PWD}"' \
    'exec docker run --rm -i \' \
    '  -v "$workspace":"$workspace" -v /tmp:/tmp -w "$PWD" \' \
    "  --entrypoint $tool $IMAGE \"\$@\"" \
  | $SUDO install -m 0755 /dev/stdin "$BIN_DIR/$tool"
done
ffmpeg -version | head -1
ffprobe -version | head -1
