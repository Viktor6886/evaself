#!/usr/bin/env bash
# Ждёт, пока apt раннера освободится, и настраивает его на ожидание.
#
# На раннере GitHub параллельно работает своё фоновое обновление
# (`unattended-upgrades`, таймеры `apt-daily`). Наш `apt-get` по
# умолчанию не ждёт освобождения: он либо падает с «Could not get lock»,
# либо молча стоит в очереди, пока job не снимут по времени. Оба исхода
# выглядят как отказ проверки, хотя к коду отношения не имеют.
#
# Ожидание проверяется через `fuser`, а не `flock`: apt держит
# POSIX-блокировку (fcntl), и `flock` на том же файле берётся мгновенно,
# ничего не дожидаясь.
set -euo pipefail

sudo systemctl stop unattended-upgrades apt-daily.service \
  apt-daily-upgrade.service apt-daily.timer apt-daily-upgrade.timer \
  2>/dev/null || true

# Десять минут — верхняя оценка фонового обновления раннера. Если оно не
# закончилось и за это время, ждать дальше бессмысленно: пусть apt сам
# скажет, что занято.
waited=0
for _ in $(seq 1 120); do
  sudo fuser /var/lib/apt/lists/lock /var/lib/dpkg/lock-frontend \
    /var/lib/dpkg/lock >/dev/null 2>&1 || break
  # Молчаливое ожидание неотличимо от зависшего шага: именно так
  # десятиминутная очередь и выглядела в журнале — пустотой.
  if [ "$((waited % 60))" -eq 0 ]; then
    echo "apt занят другим процессом; ждём ($waited с)"
  fi
  sleep 5
  waited=$((waited + 5))
done
if [ "$waited" -gt 0 ]; then
  echo "ожидание apt заняло $waited с"
fi

# На случай, если блокировку взяли прямо сейчас: apt подождёт сам.
#
# И главное — таймауты загрузки. По умолчанию apt ждёт зависшее
# соединение практически бесконечно: шаг «установить shellcheck»
# двадцать минут молчал на `apt-get update`, пока job не сняли по
# времени, и в журнале не было ни строки. Пятнадцать секунд на
# соединение и три попытки превращают недоступное зеркало в быстрый
# отказ, который видно.
sudo tee /etc/apt/apt.conf.d/99evaself-ci >/dev/null <<'CONF'
DPkg::Lock::Timeout "600";
Acquire::Retries "3";
Acquire::http::Timeout "15";
Acquire::https::Timeout "15";
CONF
