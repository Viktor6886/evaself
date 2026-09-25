"""Сравнение двух сущностей FollowTheMoney средствами nomenklatura.

nomenklatura считает признаки: насколько похожи имена (с транслитерацией
«Иванов» ↔ «Ivanov»), совпадает ли ИНН или ОГРН, расходятся ли даты
рождения, страны, пол. Решение «одно лицо или нет» здесь не выносится:
признаки уходят в `eva-agent-service`, и итог по фиксированным порогам
выносит детерминированный `src/osint/resolver.ts`. Так порог и его тесты
живут в одном месте, а не в двух языках.
"""

from __future__ import annotations

from typing import Any
from uuid import uuid4

ALLOWED_SCHEMATA = frozenset({"Person", "Organization", "Company", "LegalEntity", "PublicBody", "UserAccount"})
MAX_VALUES_PER_PROPERTY = 20


class InvalidEntity(ValueError):
    pass


def make_entity(payload: dict[str, Any]):
    from followthemoney import model

    schema = payload.get("schema")
    if schema not in ALLOWED_SCHEMATA:
        raise InvalidEntity(f"schema {schema!r} is not allowed")
    entity = model.make_entity(schema)
    # id вызывающей стороны не используется: nomenklatura кэширует признаки
    # по хэшу сущности, а хэш — это id. Одинаковые id из разных запросов
    # («a», «b») получили бы чужой результат из кэша.
    entity.id = uuid4().hex
    properties = payload.get("properties") or {}
    if not isinstance(properties, dict):
        raise InvalidEntity("properties must be an object")
    for name, values in properties.items():
        if name not in entity.schema.properties:
            raise InvalidEntity(f"property {name!r} is not defined for {schema}")
        for value in (values if isinstance(values, list) else [values])[:MAX_VALUES_PER_PROPERTY]:
            entity.add(name, str(value))
    return entity


def compare(left: dict[str, Any], right: dict[str, Any]) -> dict[str, Any]:
    from nomenklatura.matching import LogicV2

    result = LogicV2.compare(make_entity(left), make_entity(right), LogicV2.default_config())
    features = []
    for name, explanation in result.explanations.items():
        score = float(getattr(explanation, "score", 0.0) or 0.0)
        detail = getattr(explanation, "detail", None)
        features.append({"name": name, "score": round(score, 4), "detail": str(detail) if detail else None})
    return {"algorithm": LogicV2.NAME, "score": round(float(result.score), 4), "features": features}
