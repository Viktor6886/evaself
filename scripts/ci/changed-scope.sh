#!/usr/bin/env bash
# Определяет, что затронул pull request, чтобы дорогие проверки не
# выполнялись там, где им нечего проверять.
#
# Почему решение применяется к ШАГАМ, а не отключает job целиком: job,
# пропущенная через `if:` на своём уровне, репортится как `skipped`, а не
# `success`. Обязательная проверка в защите ветки `main` такой результат
# не засчитывает, и pull request перестаёт мержиться совсем. Поэтому все
# семь job запускаются всегда, а внутри них шаги закрыты условием: job
# отрабатывает за секунды и честно отдаёт success.
#
# Границы намеренно осторожные. Пропускается только то, что физически не
# может сломаться от изменения: сборка образов и смоук-стенд — при правке
# одной документации; браузерные тесты admin-ui и webapp и тесты
# media-service — когда их каталог не тронут. Любая правка кода, схемы,
# compose или самого CI прогоняет всё.
#
# На push в main и на ручном запуске фильтр не применяется: там нужна
# полная картина.
#
# Использование: changed-scope.sh <base-sha> [head-sha]
# Печатает строки `имя=true|false` для $GITHUB_OUTPUT.
set -euo pipefail

BASE="${1:-}"
HEAD="${2:-HEAD}"

emit() { printf '%s=%s\n' "$1" "$2"; }

everything() {
	emit docs_only false
	emit media true
	emit adminui true
	emit webapp true
}

# Без доступной базы сравнивать не с чем — выполняется всё.
if [ -z "$BASE" ] || ! git rev-parse --verify --quiet "$BASE^{commit}" >/dev/null; then
	echo "база '$BASE' недоступна: выполняются все проверки" >&2
	everything
	exit 0
fi

FILES="$(git diff --name-only "$BASE" "$HEAD")"

if [ -z "$FILES" ]; then
	echo "изменений нет: выполняются все проверки" >&2
	everything
	exit 0
fi

echo "изменённых файлов: $(printf '%s\n' "$FILES" | wc -l)" >&2

# Правка самого CI отменяет любую экономию: изменившаяся проверка обязана
# прогнаться целиком, иначе её поломка обнаружится на следующем PR.
if printf '%s\n' "$FILES" | grep -qE '^\.github/workflows/'; then
	echo "изменён сам CI: выполняются все проверки" >&2
	everything
	exit 0
fi

# Документацией считаются только markdown в корне, в docs/ верхнего уровня,
# и задания шагов. Всё остальное, включая docs/openapi, — код.
CODE="$(printf '%s\n' "$FILES" \
	| grep -vE '^[^/]+\.md$' \
	| grep -vE '^docs/[^/]+\.md$' \
	| grep -vE '^prompts/[^/]+\.md$' \
	|| true)"

if [ -z "$CODE" ]; then
	echo "изменена только документация: сборка образов и смоук-стенд пропускаются" >&2
	emit docs_only true
else
	emit docs_only false
fi

if printf '%s\n' "$FILES" | grep -qE '^media-service/'; then
	emit media true
else
	emit media false
fi

if printf '%s\n' "$FILES" | grep -qE '^admin-ui/'; then
	emit adminui true
else
	emit adminui false
fi

if printf '%s\n' "$FILES" | grep -qE '^webapp/'; then
	emit webapp true
else
	emit webapp false
fi
