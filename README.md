# ACARS Link

Имитатор ACARS авиакомпании для авиасимуляторов (MSFS 2024, X-Plane 12; MSFS 2020 не поддерживается — решение 2026-11-01, T84). Читает телеметрию симулятора и OFP SimBrief, определяет фазу полёта и по сценариям присылает в кабину через сеть Hoppie ACARS сообщения «авиакомпании»: лоадшиты, слоты, гейт, погоду, нестандартные ситуации. Пилот отвечает и запрашивает данные telex-командами. Есть имитация станции УВД XATC (CPDLC-логон, DCL/PDC, запросы эшелона, океанический клиренс).

Идеи взяты из RealAcars 7.3.2, код написан с нуля (CLAUDE.md, инвариант 1).

## Статус

| Что | Состояние |
|---|---|
| Ядро: FSM фаз, движок сценариев, форматтер | готово (T01–T07, T39–T40) |
| Сценарии | 91: базовые 17, команды пилота 21, внешние данные 17, нестандартные 34, эффекты в симуляторе 2 |
| Мост | C# / .NET 10 LTS (T79): SimConnect (MSFS) и X-Plane 12 Web API, автовыбор симулятора (T08, T18, T59) |
| Транспорт | Hoppie; SayIntentions — не сделан (T17) |
| Приложение | Electron, интерфейс EN, RU, DE, FR, ES, JA (DE/FR/ES/JA — машинный перевод, T86, T87), установщик Windows без подписи (T10, T19, T56, T57, T-UI) |
| Распространение | бесплатно, некоммерческое использование; публичный установщик можно давать другим (решение T83, `08`); лицензия проприетарная |

Открытые карточки — `docs/07-roadmap-tasks.md` (T15, T16, T17, T20, T35–T37, T84).

## Структура

```
apps/desktop             Electron-приложение (main / preload / renderer)
packages/core            ядро: чистый TS, без Node/DOM/сети; время и случайность инъектируются
packages/scenarios       сценарии YAML (base, commands, external, irregular, sim) и их схема
packages/data-sources    внешние данные: METAR/TAF, VATSIM, EONET, OurAirports, AeroDataBox и др.
packages/transport       транспорт Hoppie и mock за интерфейсом Transport
tools/replay             формат записи полёта (JSONL) и CLI прогона через ядро
bridge/msfs              мост к симулятору (C#), слушает только 127.0.0.1
docs/                    документы — источник истины
reference/               примеры сценариев, телеметрии, обезличенные OFP
```

## Быстрый старт

Нужны Node ≥ 24 и pnpm 12; для моста — .NET 10 SDK.

```
pnpm install
pnpm check          # typecheck + lint + spdx + test
pnpm bridge:test    # тесты моста (.NET)
pnpm desktop:dev    # приложение с HMR; мост в dev запускается вручную — bridge/msfs/README.md
pnpm desktop:dist   # установщик: apps/desktop/release/ACARS-Link-Setup-<версия>.exe
```

Полный список команд и правила работы — [CLAUDE.md](CLAUDE.md).

## Репозиторий и проверка

Удалённая копия — приватный репозиторий GitHub `AVAILOFF/acars-link` (T63). Клонировать: `gh repo clone AVAILOFF/acars-link`.

Проверка — GitHub Actions, [.github/workflows/check.yml](.github/workflows/check.yml): на каждый push в любую ветку и на pull request, `windows-latest`, `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm bridge:test`. MSFS SDK в CI нет — мост собирается без SimConnect. Результат — вкладка Actions репозитория или `gh run list`; вручную — `gh workflow run check --ref <ветка>`.

Уязвимости зависимостей (T81) — [.github/workflows/audit.yml](.github/workflows/audit.yml): по понедельникам и вручную (`gh workflow run audit`), не на push — новая запись в базе уязвимостей не роняет проверку кода. `pnpm audit --prod --audit-level=moderate` (дерево бандла) и `dotnet list bridge/msfs package --vulnerable --include-transitive`.

## Выпуски

Версии — SemVer, до публичного выпуска 0.x (T77). Выпуск — аннотированный тег `vX.Y.Z` на коммите `master`; точка отсчёта — `v0.1.0`. Версия записана в двух местах — `apps/desktop/package.json` и `<Version>` в `bridge/msfs/src/AcarsBridge/AcarsBridge.csproj`, тест `tools/release/test` проверяет, что они совпадают. В приложении она видна в «О программе» и пишется в заголовок каждой записи полёта (`appVersion`).

```
pnpm release 1.0.0   # на master, рабочая копия чистая
```

[tools/release/release.mjs](tools/release/release.mjs): проверяет ветку `master`, чистую рабочую копию, что тега ещё нет и версия больше текущей; пишет версию в оба файла и раздел [CHANGELOG.md](CHANGELOG.md) (по-английски) из коммитов `Merge task/… into …: <заголовок>` с прошлого тега; запускает `pnpm check` и `pnpm bridge:test` — при ошибке файлы возвращаются как были, ничего не коммитится; затем коммит «Release vX.Y.Z», тег и `pnpm desktop:dist` (публичный установщик `apps/desktop/release/ACARS-Link-Setup-<версия>.exe`) и рядом `ACARS-Link-Setup-<версия>.exe.sha256` — SHA-256 в формате `sha256sum` (T84). `--no-dist` — без установщика, `--any-branch` — попробовать на другой ветке (копии). Собирается локально, не в CI: в CI нет MSFS SDK, без него мост собирается без SimConnect. CI на push тега только проверяет (`check.yml` срабатывает на любой push).

Ничего не отправляется само: `git push origin master vX.Y.Z` — вручную, по решению владельца. Установщики для других людей — в отдельном публичном репозитории только с установщиками и заметками к выпускам (например, `AVAILOFF/acars-link-releases`, решение 2026-10-31; создание и публикация — по отдельной просьбе). Обновлений в приложении нет: ни уведомления, ни автообновления (решение 2026-10-31).

Заметки к выпуску для людей (EN/RU: что нового, требования, проверка SHA-256 через `Get-FileHash`, SmartScreen у установщика без подписи — «Подробнее → Выполнить в любом случае») — по шаблону [tools/release/RELEASE-NOTES.template.md](tools/release/RELEASE-NOTES.template.md), заполняются вручную и кладутся рядом с установщиком.

## Документы

1. [CLAUDE.md](CLAUDE.md) — инварианты и порядок работы (обязательно).
2. [docs/02-product-vision.md](docs/02-product-vision.md) — что делаем и чего не делаем.
3. [docs/03-architecture.md](docs/03-architecture.md) — компоненты, стек, схема телеметрии.
4. [docs/04-flight-phase-fsm.md](docs/04-flight-phase-fsm.md) — машина фаз полёта.
5. [docs/05-scenario-engine.md](docs/05-scenario-engine.md) — формат сценариев.
6. [docs/06-integrations.md](docs/06-integrations.md) — Hoppie, SimBrief, SimConnect, X-Plane, внешние API.
7. [docs/07-roadmap-tasks.md](docs/07-roadmap-tasks.md) — карточки задач.
8. [docs/08-risks-open-questions.md](docs/08-risks-open-questions.md) — решения, риски, отложенное до релиза.
9. [docs/01-realacars-teardown.md](docs/01-realacars-teardown.md) — справка по оригиналу (идеи, не код).
