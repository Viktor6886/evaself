"""Описание полей формы провайдера — источник истины для панели.

Панель не знает ни одного параметра Deepgram или Google. Она получает
GET /stt/provider-schemas и рисует форму по ответу. Из этого следуют два
свойства, ради которых всё и затевалось:

  * новая модель провайдера не требует правки frontend-кода;
  * валидация в панели и валидация на сервере не могут разойтись,
    потому что это одно и то же описание.

Модель всегда допускает ручной ввод: список пресетов — подсказка, а не
ограничение. Провайдеры выпускают модели чаще, чем обновляется этот
файл, и упереться в устаревший select — худшее, что может случиться с
администратором.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

FieldKind = Literal[
    "text", "password", "number", "boolean", "select", "multiselect",
    "string_list", "json", "file",
]


@dataclass(frozen=True)
class Option:
    value: str
    label: str
    hint: str = ""

    def as_dict(self) -> dict:
        out = {"value": self.value, "label": self.label}
        if self.hint:
            out["hint"] = self.hint
        return out


@dataclass(frozen=True)
class Field:
    """Одно поле формы.

    section — вкладка редактора из постановки: basic, model, formatting,
    features, secret, advanced.
    """

    name: str
    kind: FieldKind
    label: str
    section: str = "basic"
    hint: str = ""
    required: bool = False
    default: Any = None
    options: tuple[Option, ...] = ()
    minimum: float | None = None
    maximum: float | None = None
    placeholder: str = ""
    allow_custom: bool = False
    # Поле показывается, только если названная возможность включена в
    # capabilities адаптера. Так интерфейс не предлагает interim_results
    # там, где потокового режима нет.
    requires_capability: str = ""
    # Поле показывается только в этом режиме ('batch' | 'streaming').
    only_mode: str = ""

    def as_dict(self) -> dict:
        out: dict = {
            "name": self.name,
            "kind": self.kind,
            "label": self.label,
            "section": self.section,
            "required": self.required,
        }
        if self.hint:
            out["hint"] = self.hint
        if self.default is not None:
            out["default"] = self.default
        if self.options:
            out["options"] = [option.as_dict() for option in self.options]
        if self.minimum is not None:
            out["minimum"] = self.minimum
        if self.maximum is not None:
            out["maximum"] = self.maximum
        if self.placeholder:
            out["placeholder"] = self.placeholder
        if self.allow_custom:
            out["allow_custom"] = True
        if self.requires_capability:
            out["requires_capability"] = self.requires_capability
        if self.only_mode:
            out["only_mode"] = self.only_mode
        return out


@dataclass(frozen=True)
class ProviderSchema:
    """Полное описание провайдера для панели."""

    provider: str
    label: str
    # Разные base URL для batch и streaming: у Deepgram это https:// и
    # wss://, и одно поле на оба режима заставило бы администратора
    # переписывать адрес при смене режима.
    default_base_url: str
    default_streaming_base_url: str = ""
    docs_url: str = ""
    summary: str = ""
    fields: tuple[Field, ...] = ()
    model_presets: tuple[Option, ...] = ()
    # Дата, на которую параметры сверялись с официальной документацией.
    # Требование постановки: список моделей не вечен, и читатель должен
    # видеть, насколько он свежий.
    verified_on: str = ""

    def as_dict(self, capabilities: dict) -> dict:
        return {
            "provider": self.provider,
            "label": self.label,
            "summary": self.summary,
            "docs_url": self.docs_url,
            "default_base_url": self.default_base_url,
            "default_streaming_base_url": self.default_streaming_base_url,
            "verified_on": self.verified_on,
            "capabilities": capabilities,
            "model_presets": [preset.as_dict() for preset in self.model_presets],
            "fields": [item.as_dict() for item in self.fields],
        }


# ---------------------------------------------------------------------
# Валидация значений по описанию
# ---------------------------------------------------------------------
def validate_params(
    schema: ProviderSchema,
    params: dict,
    capabilities: dict,
    mode: str,
) -> tuple[dict, list[str], list[str]]:
    """Сверяет присланные параметры с описанием полей.

    Возвращает (очищенные значения, ошибки, предупреждения).

    Неизвестные ключи не проходят молча: параметр, который панель не
    показывала, попал в запрос либо по ошибке, либо в обход интерфейса.
    Передавать такое провайдеру автоматически постановка прямо
    запрещает.
    """
    known = {item.name: item for item in schema.fields}
    cleaned: dict = {}
    errors: list[str] = []
    warnings: list[str] = []

    for key, value in params.items():
        spec = known.get(key)
        if spec is None:
            errors.append(f"неизвестный параметр «{key}» для провайдера {schema.provider}")
            continue
        if value is None or value == "":
            continue

        if spec.requires_capability and not capabilities.get(spec.requires_capability):
            errors.append(
                f"{schema.label} не поддерживает «{spec.label}» "
                f"({spec.requires_capability})"
            )
            continue
        if spec.only_mode and spec.only_mode != mode:
            errors.append(
                f"параметр «{spec.label}» доступен только в режиме {spec.only_mode}"
            )
            continue

        ok, coerced, problem = _coerce(spec, value)
        if not ok:
            errors.append(f"{spec.label}: {problem}")
            continue
        cleaned[key] = coerced

    for spec in schema.fields:
        if spec.required and spec.name not in cleaned and spec.default is None:
            errors.append(f"поле «{spec.label}» обязательно")

    return cleaned, errors, warnings


def _coerce(spec: Field, value: Any) -> tuple[bool, Any, str]:
    """Приводит значение к типу поля. Ошибка вместо тихого приведения."""
    if spec.kind == "boolean":
        if isinstance(value, bool):
            return True, value, ""
        if isinstance(value, str) and value.lower() in ("true", "false"):
            return True, value.lower() == "true", ""
        return False, None, "ожидается true или false"

    if spec.kind == "number":
        try:
            number = float(value)
        except (TypeError, ValueError):
            return False, None, "ожидается число"
        if spec.minimum is not None and number < spec.minimum:
            return False, None, f"не меньше {spec.minimum:g}"
        if spec.maximum is not None and number > spec.maximum:
            return False, None, f"не больше {spec.maximum:g}"
        return True, int(number) if number.is_integer() else number, ""

    if spec.kind in ("string_list", "multiselect"):
        if isinstance(value, str):
            items = [part.strip() for part in value.split(",")]
        elif isinstance(value, (list, tuple)):
            items = [str(part).strip() for part in value]
        else:
            return False, None, "ожидается список строк"
        items = [item for item in items if item]
        if spec.options:
            allowed = {option.value for option in spec.options}
            unknown = [item for item in items if item not in allowed]
            if unknown:
                return False, None, f"недопустимые значения: {', '.join(unknown)}"
        return True, items, ""

    if spec.kind == "select":
        text = str(value).strip()
        if spec.options and not spec.allow_custom:
            allowed = {option.value for option in spec.options}
            if text not in allowed:
                return False, None, f"допустимо одно из: {', '.join(sorted(allowed))}"
        return True, text, ""

    if spec.kind == "json":
        if isinstance(value, dict):
            return True, value, ""
        if isinstance(value, str):
            import json

            try:
                parsed = json.loads(value)
            except ValueError as exc:
                return False, None, f"не разбирается как JSON ({exc})"
            if not isinstance(parsed, dict):
                return False, None, "ожидается JSON-объект"
            return True, parsed, ""
        return False, None, "ожидается JSON-объект"

    text = str(value).strip()
    if not text:
        return False, None, "пустое значение"
    return True, text, ""
