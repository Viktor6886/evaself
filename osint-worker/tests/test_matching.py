import pytest

from app.matching import InvalidEntity, compare


def _features(result):
    return {feature["name"]: feature["score"] for feature in result["features"]}


def test_transliterated_names_match_and_birth_date_agrees():
    result = compare(
        {"schema": "Person", "id": "a", "properties": {"name": ["Иванов Иван Сергеевич"], "birthDate": ["1990-05-01"]}},
        {"schema": "Person", "id": "b", "properties": {"name": ["Ivan Ivanov"], "birthDate": ["1990-05-01"]}},
    )
    features = _features(result)
    assert result["algorithm"] == "logic-v2"
    assert features["name_match"] > 0.5
    assert features["dob_day_disjoint"] == 0


def test_disjoint_birth_dates_are_reported_as_a_feature():
    result = compare(
        {"schema": "Person", "id": "a", "properties": {"name": ["Иванов Иван"], "birthDate": ["1990-05-01"]}},
        {"schema": "Person", "id": "b", "properties": {"name": ["Иванов Иван"], "birthDate": ["1985-01-01"]}},
    )
    assert _features(result)["dob_year_disjoint"] > 0


def test_same_inn_is_reported():
    result = compare(
        {"schema": "Company", "id": "a", "properties": {"name": ["ООО Ромашка"], "innCode": ["7707083893"]}},
        {"schema": "Company", "id": "b", "properties": {"name": ["Romashka LLC"], "innCode": ["7707083893"]}},
    )
    assert _features(result)["inn_code_match"] > 0


@pytest.mark.parametrize(
    "payload",
    [
        {"schema": "Vessel", "properties": {}},
        {"schema": "Person", "properties": {"notAProperty": ["x"]}},
        {"schema": "Person", "properties": "name"},
    ],
)
def test_unknown_schema_or_property_is_rejected(payload):
    with pytest.raises(InvalidEntity):
        compare(payload, {"schema": "Person", "properties": {"name": ["x"]}})


def test_caller_ids_do_not_leak_cached_features_between_comparisons():
    # nomenklatura кэширует признаки по id сущности: одинаковые id из разных
    # запросов не должны давать чужой результат.
    compare(
        {"schema": "Company", "id": "a", "properties": {"name": ["ООО Ромашка"]}},
        {"schema": "Company", "id": "b", "properties": {"name": ["ООО Ромашка"]}},
    )
    result = compare(
        {"schema": "Company", "id": "a", "properties": {"name": ["ООО Ромашка"], "innCode": ["7707083893"]}},
        {"schema": "Company", "id": "b", "properties": {"name": ["ООО Ромашка"], "innCode": ["7707083893"]}},
    )
    assert _features(result)["inn_code_match"] == 1.0
