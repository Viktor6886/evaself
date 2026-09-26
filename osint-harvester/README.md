# osint-harvester

[theHarvester](https://github.com/laramies/theHarvester) 4.11.1
(GPL-2.0-only) за HTTP-обёрткой. GPL-компонент живёт в отдельном
контейнере, Evaself обращается к нему только по HTTP. Обёртка
`app/main.py` вызывает theHarvester как библиотеку и распространяется под
той же лицензией GPL-2.0-only.

## Что разрешено

- Только пассивные источники без ключей: certspotter, commoncrawl, crtsh,
  hackertarget, otx, rapiddns, robtex, subdomaincenter, thc, urlscan,
  waybackarchive. Список закрыт в коде, стадия `test` образа проверяет, что
  все они есть в закреплённой версии.
- Запрещены утечки и базы взломов (haveibeenpwned, dehashed, leakix,
  leaklookup, intelx, hudsonrock), поиск людей (linkedin, hunter,
  rocketreach, tomba), выдача поисковиков и источники с ключами.
- Активные режимы (перебор DNS, сканирование API, проверка захвата
  поддоменов, скриншоты, прокси, запись файлов) выключены параметрами
  вызова.
- Вывод theHarvester перехватывается: найденное не попадает в журнал
  контейнера. Кэш theHarvester удаляется после каждого запроса.

## API

`POST /v1/domain/harvest` `{domain, sources?}` с заголовком `X-Osint-Key`
(`OSINT_WORKER_TOKEN`) → `{status, hosts, ips, emails, asns}`: только хосты
и почта внутри домена, только публичные адреса.

```
docker build --target test osint-harvester    # ruff + pytest + проверка источников
```
