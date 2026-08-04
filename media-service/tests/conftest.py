"""Общие предусловия тестов media-service.

Сервис отказывается стартовать в production с пустым MEDIA_SERVICE_TOKEN
(app/main.py). Набор тестов — это среда разработки, поэтому EVA_ENV
задаётся здесь, до импорта app.main любым тестовым модулем.

Тесты, которые проверяют само production-поведение, выставляют EVA_ENV
явно и перезагружают модуль — см. test_auth.py.
"""

import os

os.environ.setdefault("EVA_ENV", "development")
