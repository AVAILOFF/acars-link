# CLAUDE.md

Имитатор ACARS для авиасимуляторов: читает телеметрию симулятора и план SimBrief, определяет фазу полёта и по сценариям присылает в кабину реалистичные сообщения «авиакомпании» (лоадшиты, отчёты, гейт, задержки, нестандартные ситуации) через сеть Hoppie ACARS / SayIntentions. Пилот может отвечать и запрашивать данные.

## Документы (источник истины)

- `docs/02-product-vision.md` — что делаем и чего не делаем.
- `docs/03-architecture.md` — архитектура, стек, схема телеметрии.
- `docs/04-flight-phase-fsm.md` — машина фаз полёта.
- `docs/05-scenario-engine.md` — формат сценариев.
- `docs/06-integrations.md` — внешние протоколы и API.
- `docs/07-roadmap-tasks.md` — **карточки задач. Работай строго по карточке, которую назвал пользователь.**
- `docs/01-realacars-teardown.md` — справка по оригиналу (идеи, не код).
- Если код расходится с документом — остановись и спроси. Не правь документ молча.

## Инварианты — нарушать нельзя

1. **Код RealAcars не копируется.** Его лицензия не позволяет переиспользование (MIT в его `package.json` относится к шаблону ERWT). Из реверса берём только идеи, списки SimVar, тайминги и форматы сообщений.
2. **Никаких секретов в клиенте.** Ключи LLM/RapidAPI/прочего — только на бэкенде или в пользовательских настройках (ввод пользователем, хранение в OS keychain). Никаких ключей в репозитории, логах, коде. `.env*` — в `.gitignore`.
3. **Ядро (`packages/core`) — чистый TypeScript.** Не импортирует Electron/Tauri, DOM, Node API, сеть. Вход — снимки телеметрии и время, выход — команды «отправить сообщение». Это делает его детерминированно тестируемым.
4. **Время и случайность инъектируются.** В ядре нет `Date.now()` и `Math.random()` напрямую — только через переданные `Clock` и seeded `Rng`. Один и тот же (OFP, запись телеметрии, seed) → одни и те же сообщения.
5. **Логика не на таймерах UI.** Никаких `setTimeout` в React-компонентах для бизнес-логики (главная ошибка оригинала). Всё через FSM + планировщик в ядре.
6. **Уважение к сети Hoppie.** Ограничение частоты запросов (poll не чаще рекомендованного, см. `06-integrations.md`), очередь отправки с rate limit, никаких повторов в цикле без backoff.
7. **Транспорт только через адаптер** (`Transport` интерфейс). Hoppie, SayIntentions и mock — взаимозаменяемы.
8. **LLM не генерирует числа.** Веса, топливо, время, ВПП, гейт — только из данных/детерминированной логики. LLM допускается лишь для «оживления» свободного текста поверх шаблона, с валидацией (длина строки, только A–Z0–9 и разрешённые символы) и фолбэком на шаблон.
9. **Сообщения проходят форматирование под профиль дисплея** (ширина строки, верхний регистр, запрещённые символы). Ни одно сообщение не отправляется в обход форматтера.
10. Нет HTTP без TLS к собственным серверам. Локальный мост к симулятору слушает **только 127.0.0.1**.

## Как работать

- Одна сессия = одна карточка `Txx`. Найденное за рамками — в раздел «Замечания» отчёта.
- Ветка на задачу: `task/Txx-short-name`. Коммит в конце после зелёных проверок. Push/merge/релиз — только по просьбе пользователя.
- Перед «готово»: `pnpm check` (= `pnpm typecheck && pnpm lint && pnpm spdx && pnpm test`). Те же проверки и `pnpm bridge:test` запускает GitHub Actions на каждый push (`.github/workflows/check.yml`, T63; тесты — в 3 параллельных задачах `vitest --shard`, T76; удалённый репозиторий — приватный `AVAILOFF/acars-link`). `testTimeout` — 20 с локально, 60 с при `CI` (`vitest.config.ts`). Уязвимости зависимостей (npm `--prod` и NuGet моста) — `.github/workflows/audit.yml`, раз в неделю и вручную (T81); всё дерево npm с инструментами сборки — там же, только предупреждение (T84).
- **Реализм и проверка данных** (обязательно для этапа 5 в `07`, желательно везде): данные и форматы — только из проверенных источников с датой сверки и лицензией; не угадывать. Любое допущение (упрощение, эвристика, синтетические данные) — сначала описать пользователю и получить явное одобрение, потом реализовывать; одобренное записать в карточку. Подробно — `07`, «Правило реализма».

## Команды

Node ≥ 24, pnpm 12. Стек: TypeScript 7 (strict), Biome 2, Vitest 5.

```
pnpm install
pnpm check            # typecheck + lint + spdx + test — перед «готово» и перед коммитом
pnpm spdx             # у каждого исходника (ts/tsx/js/mjs/cjs/cs/py) заголовок SPDX и копирайт (T62); --write — проставить в новые файлы
pnpm typecheck        # tsc по всем пакетам: src (без Node/DOM типов) и тесты отдельно
pnpm lint             # biome check .
pnpm lint:fix         # biome check --write .
pnpm test             # vitest run (проекты packages/*)
pnpm build            # tsc → packages/*/dist
pnpm -F @acars/core test   # тесты одного пакета
pnpm desktop:dev      # Electron-приложение (apps/desktop) с HMR renderer
pnpm desktop          # сборка apps/desktop/out и запуск
pnpm hoppie:telex --to <АВИА> [--from OPS…] [--text …] [--listen 180]   # ручной telex в Hoppie; код — только из env HOPPIE_LOGON
pnpm replay run <запись.jsonl> [--scenarios <yaml|папка>] [--only id,…] [--check] [--pilot "<мин>=<текст>"]   # прогон записи через ядро (tools/replay); --pilot — сообщения пилота
pnpm replay synth --ofp <simbrief.json> --out <файл.jsonl>   # синтетический полёт как запись; pnpm replay --help
pnpm replay summary <запись.jsonl> [--json] [--check]   # сводка рейса T69 из записи; --check — сверка со строкой summary приложения
pnpm desktop:dist     # установщик Windows, ПУБЛИЧНЫЙ вариант (T72): без таблиц сквоков EUROCONTROL CAL / ICAO APAC eANP и без natTrak; apps/desktop/release/ACARS-Link-Setup-<версия>.exe (NSIS, без подписи; мост — в resources/bridge); после сборки tools/release/verify-public.mjs проверяет out/ и app.asar
pnpm release <X.Y.Z> [--no-dist] [--any-branch]   # выпуск (T77): на master, чистая копия; версия в apps/desktop/package.json и .csproj моста, раздел CHANGELOG.md из `Merge task/…` с прошлого тега, pnpm check + bridge:test (ошибка — файлы назад), коммит «Release vX.Y.Z», тег vX.Y.Z, desktop:dist и `ACARS-Link-Setup-<версия>.exe.sha256` (T84); заметки к выпуску — по `tools/release/RELEASE-NOTES.template.md`; push — только по просьбе пользователя; README.md, «Выпуски»
pnpm i18n translate --lang de,fr,es,ja [--only msg,help,scn] [--dry] [--force]   # машинный перевод интерфейса (T86/T87, tools/i18n): DeepL (ключ — DEEPL_AUTH_KEY в env или в .env.local) с глоссарием docs/glossary-i18n.md, запасной — Ollama (--engine ollama, OLLAMA_MODEL); переводит только новое (память tools/i18n/memory), ручные правки в messages-/help-<lang>.ts и locales/<lang>.yaml сохраняет; pnpm i18n status — сколько переведено
pnpm desktop:dist:personal   # то же, ЛИЧНЫЙ вариант (всё включено), ACARS-Link-Setup-personal-<версия>.exe; вариант выбирает ACARS_BUILD=public|personal для electron-vite (tools/release/build.mjs), заглушки — apps/desktop/variants/public
pnpm run licenses     # (именно `run`: `pnpm licenses` — встроенная команда pnpm) тексты лицензий npm-пакетов бандла и .NET → apps/desktop/build/third-party-licenses.txt (часть desktop:dist)
pnpm icon             # иконка приложения: design/logo/*.svg → apps/desktop/build/icon.{ico,png} (рендер через Electron)
pnpm bridge:publish   # мост самодостаточной папкой с exe (.NET не нужен, рантайм .NET 10 внутри, T79; обрезан — PublishTrimmed, JSON только через source-gen `BridgeJson`, T82; `.pdb` → bridge/msfs/symbols) → bridge/msfs/publish (папка очищается перед публикацией); в ней `acars_simconnect.dll` и нет `SimConnect.dll` / `Microsoft.FlightSimulator.SimConnect.dll` (T73; csproj удаляет их из папки, `tools/release/verify-bridge.mjs` проверяет)
pnpm bridge:build     # dotnet build bridge/msfs (C# мост, .NET 10; SimConnect (T73): если найден официальный MSFS SDK (-p:MsfsSdk="C:\MSFS 2024 SDK", `bridge/msfs/Local.props`, MSFS2024_SDK) и Visual Studio Build Tools 2022 с C++ x64, собирается `acars_simconnect.dll` из bridge/msfs/native со статическим SimConnect.lib; без SDK мост собирается без SimConnect — так и в CI); по умолчанию мост сам находит MSFS или X-Plane 12 (--source auto, T59); вручную — --source simconnect | xplane
pnpm bridge:test      # dotnet test bridge/msfs — при изменениях в bridge/ тоже перед «готово»
pnpm bridge:smoke     # дымовая проверка ОПУБЛИКОВАННОГО моста (bridge/msfs/publish, обрезан — T82): fake, replay, занятый порт → 4, --parent-pid; часть desktop:dist
```

`apps/desktop` — Electron 44 + electron-vite 5 (Vite 7: electron-vite не поддерживает Vite 8) + React 19 + Zustand. Main-процесс собирает пакеты воркспейса в один бандл; preload — один CJS-файл (sandbox). Renderer не импортирует Node/Electron/транспорт (правило Biome) и общается с main только через `window.acars`. Логика без Electron — `src/main/controller.ts`, тесты в `apps/desktop/test`. Бинарник Electron скачивается при первом запуске.

`packages/data-sources` (`@acars/data-sources`) — адаптеры внешних данных (T13): METAR/TAF, VATSIM, EONET, стоянки OSM, пуски ракет TheSpaceDevs (T28), особые события T29 (NOAA SWPC, SIGMET VA, USGS, Nager.Date, Jolpica F1, NHL — по группам «Спорт»/«Авиация»/«Другое» из настроек), стыковочные рейсы T30 (AeroDataBox через RapidAPI, ключ вводит пользователь — `SecretStore` `aerodataboxKey`; выбор рейса — `packages/core/src/ext/connex.ts`; данные старше 7 дней вычищаются из записей — `tools/replay/src/purge.ts`), следующий рейс по данным AeroDataBox T55 (вылеты с `aircraft.model` и статистика маршрутов, кэш на диске до 7 дней; таблица «model → семейство» — `packages/core/src/ext/aircraft-models.ts`, выбор — `packages/core/src/scenario/ops-data.ts`, `nextLegVersion: 3`); без Node API, HTTP через инъекцию. Ядро получает данные только как вход `CoreInput.data` (пишется в запись полёта). Сценарии на живых данных — `packages/scenarios/external/`, нестандартные (T14, `set`, флаги между рейсами — «память авиакомпании» в `<userData>/airline-memory.json`) — `packages/scenarios/irregular/`, эффекты в симуляторе (T22, шаг `vdgs:` → файл GSX `%APPDATA%\Virtuali\GSX\VGDS\acars-sim.json`) — `packages/scenarios/sim/`; табло вылета T102 (`vdgs_departure`: TOBT авиакомпании вместо `flight_information` GSX) — только в аэропортах A-CDM из `packages/core/src/ext/acdm-airports.ts`; в остальных — `vdgs_departure_etd` (T103, ETD, выключен по умолчанию, не реальное табло).

Языки интерфейса (T85): список `LANGUAGES` в `apps/desktop/src/shared/api.ts` (самоназвание, `ready` — показывать в списке, `machine` — пометка «машинный перевод»); строки — `apps/desktop/src/renderer/src/messages-<lang>.ts` (английский — все ключи, русский обязателен, остальные могут отставать — тогда английский), справка — `help-<lang>.ts`, тексты сценариев — `packages/scenarios/locales/<lang>.yaml` (в YAML сценариев только английский; у шагов с подсказкой `id`), строки main (диалог закрытия, подсказки XATC, подписи источников) — тоже в `messages-<lang>.ts` (`close.*`, `hint.atc.*`, `src.*`; в main — `translator` / `catalogText` из `i18n.ts`). Языки DE/FR/ES/JA — машинный перевод (T86, T87), глоссарий — `docs/glossary-i18n.md`; японский — системные шрифты Windows (`--font-ui`), переносы `:lang(ja)` в `styles.css`, поиск по справке — NFKC (`help.ts`). ACARS-сообщения не переводятся.

Станция УВД XATC (T23) — `packages/core/src/atc/` (пакеты CPDLC Hoppie, FIR, станция `X`+FIR), границы FIR и центры VATSIM — `packages/data-sources/src/vatspy.ts`, в приложении — настройка «Станция УВД XATC». DCL/PDC (T24) — `packages/core/src/atc/dcl.ts` (станция `X`+аэропорт вылета), таблицы сквоков — `packages/core/src/atc/squawk/` (сгенерированы, не править вручную), частоты — `packages/data-sources/src/ourairports.ts`. Запросы пилота станции XATC (T25: эшелон, скорость, Direct To) — `packages/core/src/atc/requests.ts`, таблица эшелонов и правила государств — `levels.ts`, потолки и VMO/MMO по TCDS — `performance.ts`; автоматические Direct To, step climb и снижение (T26) — `auto.ts`; океанический клиренс NAT (T27: RCL, CLX Shanwick, CLA) — `oceanic.ts`, треки NAT — `packages/data-sources/src/nattrak.ts`.

Аварийные службы (T54): шаг `rescue` → команда ядра `rescue`, правила машин — `packages/core/src/sim/rescue.ts`, ВПП и `large_airport` — `packages/data-sources/src/ourairports.ts`, мосту `rescue_start` / `rescue_stop` из `controller.ts`, логика в мосте — `bridge/msfs/src/AcarsBridge/RescueController.cs`.

Особые события (T29): переменные — `packages/core/src/scenario/special-vars.ts`, затмения/авиашоу/история авиации — таблицы `packages/core/src/ext/{eclipses,airshows,aviation-history}.ts` (`eclipses.ts` генерируется `node tools/eclipse-table/generate.mjs <besselian.csv>`, не править вручную; у авиашоу и фактов — источник и дата сверки). Ночные запреты аэропортов назначения (T42, сценарий `curfew_dest`) — таблица `packages/core/src/ext/curfews.ts` (только настоящие запреты посадок, у каждой записи источник и дата сверки; нет записи — нет сообщения).

`tools/replay` (`@acars/replay`) — формат записи полёта (JSONL: заголовок с OFP и опциями ядра, затем входы ядра по порядку), прогон через ядро, CLI. Приложение пишет запись каждого полёта в `<userData>/recordings` (настройка «Записывать полёты», хранятся последние 20; выключена — временная запись в `<userData>/flight-temp`, удаляется с рейсом). Восстановление рейса после закрытия или падения (T64) — из этой записи: `apps/desktop/src/main/recording.ts` (`fileResume`, 24 ч), `FlightSession` с `resume` (`session.ts`), опции ядра из заголовка — `recordedCoreOptions` (`tools/replay/src/run.ts`); строки `sent` и `resume` — docs/03, `tools/replay/README.md`.

Логи (T67): `<userData>/logs/main.log` (main-процесс) и `bridge.log` (stdout/stderr моста), по 5 файлов × 5 МБ, время UTC — `apps/desktop/src/main/log.ts`; каждая строка проходит `Redactor` (logon-код, ключ RapidAPI, имя SimBrief, токен моста → `***`; секреты он узнаёт из `SecretStore`). «Экспорт диагностики» (Расширенные настройки → Диагностика) — один .zip: логи, версии, настройки без секретов, по галочке — последняя запись полёта (`diagnostics.ts`, свой zip — `zip.ts`).

Сводка рейса (T69): расчёт — `packages/core/src/summary/report.ts` (`AcarsCore.report()`, только цифры данных, без оценок; аэропорт посадки — ближайший в пределах 5 NM), снимается при закрытии рейса у гейта (`FlightSession.endFlight`), пишется строкой `summary` после `end` в запись и в журнал рейсов `<userData>/logbook.json` (`main/logbook.ts`, без ограничения); в UI — `ReportPanel.tsx` до загрузки следующего OFP, «Сохранить в JSON» — `AppController.exportReport`.

Вид рейса (T89): `classifyFlight` — `packages/core/src/scenario/flight-kind.ts` (поля 8b и 18 FPL, `freight_added` — `ofp/parse.ts`), поле сценария `operations`, переменная `flight.kind`, опция и вход ядра `flightKind` (до OUT; в заголовке записи и строке `tick`), вопрос после загрузки OFP и выбор — `controller.ts` (`setFlightKind`, `AppState.flightKind`, настройка `askFlightKind`), в UI — `KindBlock` в `FlightView.tsx`. Пакеты по видам (T90–T92): `packages/scenarios/cargo/` (грузовые), `charter/`, `ferry/`, `bizav/` (бизнес-авиация; таблица типов — `BIZAV_FAMILIES` в `scenario/aircraft.ts`; подключаются в `scenario-sources.ts`, `tools/replay/src/cli.ts`, `tools/i18n/translate.mjs`), LMC по виду — `buildFlightData(…, kind)`, строки о пассажирах — `~…{flight.if_pax}`.

Пакеты воркспейса импортируют друг друга из исходников: условие экспорта `source` (`customConditions` в `tsconfig.base.json`, `resolve.conditions` в `vitest.config.ts`), сборка для тестов не нужна. `pnpm -F <pkg> test` запускает корневой конфиг Vitest с `--project`.

Чистота `packages/core` (инварианты 3–4) проверяется трижды: tsconfig без Node/DOM типов, правила Biome в `biome.json` (overrides), тест `packages/core/test/purity.test.ts`.
(Обновляй этот раздел, если меняешь скрипты.)
- SimConnect, Hoppie, SimBrief, MSFS SDK меняются. Если не уверен в имени SimVar, единицах, параметре API — открой официальную документацию. Не угадывай. Места, помеченные в документах `[ПРОВЕРИТЬ]`, проверь перед использованием.
- Ты не видишь симулятор и самолёты. Всё, что требует MSFS/конкретного аддона, оформляй как шаг «Проверка человеком» с точной инструкцией (самолёт, фаза, что должно появиться на экране).

## Шаблон отчёта

```
## Txx — <название>
Сделано: …
Файлы: …
Проверки: typecheck ✓/✗, lint ✓/✗, test ✓/✗ (N тестов)
Проверка человеком: 1) … 2) …
Замечания (вне рамок): …
Открытые вопросы: …
```
