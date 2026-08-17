# Архив прежнего roadmap

Здесь лежит roadmap, по которому Evaself развивалась до перехода на
Letta-native архитектуру. **Заданием он не является.** Читать — только как
историю: что уже сделано и с каким намерением.

Почему он архивирован: batch 18–33 строились вокруг подсистем, которых в
репозитории больше нет — графовой и temporal памяти, Memory Curator, Memory
Doctor, Hybrid Retrieval, Deep Recall, SkillRouter, ToolGateway. Всё это
удалено в PR #188, потому что дублировало и заслоняло штатный runtime Letta.
Возобновить эти шаги как написано — значит нарушить инвариант 3 в `CLAUDE.md`.

Выполненные batch 1–17 остаются в силе как история реализации: продуктовый
слой, tenancy, жизненный цикл хода, доставка, административная панель и
наблюдаемость из них живы. Разбор каждого — `docs/PROGRESS_HISTORY.md`.

Второй слой продукта (`docs/EVASELF_LAYER2_PLAN.md`) в прежнем виде тоже
неприменим: его модель данных опирается на удалённую память. Прежде чем брать
из него что-либо, его нужно переписать под границу Letta и Evaself.

## Прежняя таблица batch

| Batch | Шаги | Блок | Статус на момент архивации | PR |
|---|---|---|---|---|
| 1 | 00 | P0 | выполнен | [#102](https://github.com/Viktor6886/evaself/pull/102) |
| 2 | 01–02 | P0 | выполнен | [#103](https://github.com/Viktor6886/evaself/pull/103), [#124](https://github.com/Viktor6886/evaself/pull/124) |
| 3 | 03–04 | P0 | выполнен | [#128](https://github.com/Viktor6886/evaself/pull/128), [#130](https://github.com/Viktor6886/evaself/pull/130) |
| 4 | 05 | P1 | выполнен | [#132](https://github.com/Viktor6886/evaself/pull/132) |
| 5 | 06 | P1 | выполнен | [#135](https://github.com/Viktor6886/evaself/pull/135) |
| 6 | 07 | P1 | выполнен | [#143](https://github.com/Viktor6886/evaself/pull/143) |
| 7 | 08 | P1 | выполнен | [#144](https://github.com/Viktor6886/evaself/pull/144) |
| 8 | 09–10 | P1 | выполнен | [#145](https://github.com/Viktor6886/evaself/pull/145) |
| 9 | 11 | P1 | выполнен | [#146](https://github.com/Viktor6886/evaself/pull/146) |
| 10 | 12–13 | P1 | выполнен | [#148](https://github.com/Viktor6886/evaself/pull/148) |
| 11 | 14 | P2 | выполнен | [#149](https://github.com/Viktor6886/evaself/pull/149) |
| 12 | 15–16 | P2 | выполнен | [#150](https://github.com/Viktor6886/evaself/pull/150) |
| 13 | 17–18 | P2 | выполнен | [#153](https://github.com/Viktor6886/evaself/pull/153) |
| 14 | 19–20 | P2 | выполнен | [#161](https://github.com/Viktor6886/evaself/pull/161) |
| 15 | 21–22 | P2 | выполнен | [#168](https://github.com/Viktor6886/evaself/pull/168) |
| 16 | 23–24 | P3 | выполнен | [#170](https://github.com/Viktor6886/evaself/pull/170) |
| 17 | 25–26 | P3 | выполнен | [#175](https://github.com/Viktor6886/evaself/pull/175) |
| 18–20 | 27–30 | P3 | не начат — отменён переходом на Letta-native | — |
| 21–23 | 31–33 | P4 | не начат — только по отдельной команде | — |
| 24–33 | 34–67 | P5–P14 | не начат — второй слой, требует переписывания | — |

## Что из прежнего плана осталось осмысленным

Продуктовые темы шагов 27–30 сами по себе не отменены: наблюдаемость,
приёмка релиза, эксплуатационные сценарии. Отменён способ, которым они были
расписаны, — через подсистемы удалённого cognitive stack. Если человек
вернётся к этим темам, задание пишется заново от текущего `main`.
