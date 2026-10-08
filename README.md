# ACARS Handoff — с чего начать

Пакет для новой сессии Claude (Opus 5.5). Цель — создать **собственное** приложение-имитатор ACARS для авиасимуляторов (в первую очередь MSFS), вдохновлённое RealAcars 7.3.2, но с нормальной архитектурой, машиной фаз полёта, движком сценариев и большим разнообразием сообщений.

Кода проекта пока **нет**. Есть только результаты реверса чужого приложения и план.

## Порядок чтения

1. [CLAUDE.md](CLAUDE.md) — правила работы и инварианты (обязательно).
2. [docs/01-realacars-teardown.md](docs/01-realacars-teardown.md) — как устроен RealAcars: компоненты, поток данных, каталог сообщений и их триггеры, найденные баги.
3. [docs/02-product-vision.md](docs/02-product-vision.md) — что делаем, чем лучше оригинала, что вне рамок.
4. [docs/03-architecture.md](docs/03-architecture.md) — компоненты, стек (рекомендация), схема телеметрии.
5. [docs/04-flight-phase-fsm.md](docs/04-flight-phase-fsm.md) — машина фаз полёта.
6. [docs/05-scenario-engine.md](docs/05-scenario-engine.md) — формат сценариев, шаблоны, переменные.
7. [docs/06-integrations.md](docs/06-integrations.md) — Hoppie, SayIntentions, SimBrief, SimConnect, внешние данные.
8. [docs/07-roadmap-tasks.md](docs/07-roadmap-tasks.md) — карточки задач `T01…`.
9. [docs/08-risks-open-questions.md](docs/08-risks-open-questions.md) — риски и вопросы к пользователю.

Дополнительно:
- `reference/scenarios/` — примеры сценариев в целевом формате.
- `reference/telemetry.sample.json` — пример снимка телеметрии.
- `tools/extract-asar-sources.js` — восстановление исходников RealAcars из встроенного source map (только для справки).

## Статус

| Что | Состояние |
|---|---|
| Реверс RealAcars 7.3.2 | Готово (статический анализ, приложение не запускалось) |
| Продуктовое видение | Черновик, ждёт подтверждения пользователя |
| Стек | Рекомендация, **не утверждён** (см. 08 — открытые вопросы) |
| Код | Нет |

Дата подготовки: 2026-10-07.
