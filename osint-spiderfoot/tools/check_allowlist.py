"""Разрешённые модули и типы событий существуют в закреплённой версии SpiderFoot.

Переименованный в новой версии модуль молча выпал бы из сбора, а
переименованный тип события — из фильтра. Запускается в стадии `test`
образа: python tools/check_allowlist.py /opt/spiderfoot
"""

import os
import sys

root = sys.argv[1] if len(sys.argv) > 1 else "/opt/spiderfoot"
sys.path.insert(0, root)

from spiderfoot.db import SpiderFootDb  # noqa: E402

from app.main import ALLOWED_MODULES, EVENT_KINDS  # noqa: E402

missing = [name for name in ALLOWED_MODULES if not os.path.exists(os.path.join(root, "modules", f"{name}.py"))]
known = {row[1] for row in SpiderFootDb.eventDetails}
unknown = [name for name in EVENT_KINDS if name not in known]
if missing or unknown:
    sys.exit(f"missing modules: {missing}; unknown event types: {unknown}")
print(f"allowlist ok: {len(ALLOWED_MODULES)} modules, {len(EVENT_KINDS)} event types")
