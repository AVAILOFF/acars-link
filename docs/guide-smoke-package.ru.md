# Как собрать пакет дыма для установщика (T104)

Гайд для человека с MSFS 2024 и SDK. Результат — папка `avail-acars-smoke`, которую приложение ставит в Community
по кнопке «Установить» (Расширенные настройки → «Пакет дыма для MSFS 2024»).

Чем отличается от [guide-smoke-rescue.ru.md](guide-smoke-rescue.ru.md), часть 2: там эффект делался **из копии
примера SimpleFX**. Такой пакет можно держать у себя, но распространять нельзя: лицензия SDK (`D:\MSFS 2024
SDK\Licenses\MSFS SDK EULA.pdf`, п. 1 b) разрешает образцы SDK только для внутреннего использования. Здесь всё
делается **с пустого**: новый проект, новый эффект, своя текстура из репозитория. Ничего из папки `Samples` не
копируется — ни файлы, ни узлы графа. Новый эффект из мастера сразу получает свои GUID, поэтому проблема T34
(дым не шёл из Community из-за GUID примера) здесь не возникает.

Пометка **[?]** — шаг, которого нет в документации SDK или который на этой связке ещё не проверен. Если на нём
что-то пошло не так, запишите дословно, что написал симулятор, и пришлите.

Источники: страницы SDK MSFS 2024 [The Visual Effects Editor](https://docs.flightsimulator.com/msfs2024/retail/devmode/editors/vfx-editor/the-visual-effects-editor/index.md),
[Output](https://docs.flightsimulator.com/msfs2024/retail/devmode/editors/vfx-editor/nodes/output/index.md),
[The Material Editor](https://docs.flightsimulator.com/msfs2024/retail/devmode/editors/material-editor/the-material-editor/index.md)
(сверено 2026-11-05); типы групп ассетов — из вашего рабочего проекта T34 `D:\msfs-projects\acars-smoke\acars-smoke\SimpleFX` (проверен
в симуляторе 2026-10-17).

---

## 0. Перед началом

1. MSFS 2024, **Developer Mode** включён (Options → General Options → Developers).
2. **Начните любой полёт.** Редакторы DevMode в главном меню не работают.
3. **Уберите старые пакеты из Community.** Переместите (не удаляйте) `D:\MSFS2024\Community\mycompany-simple-fx`
   и `mycompany-simplefx-materiallib` куда-нибудь вне Community, например в `D:\msfs-projects\old-community\`.
   В старом пакете тоже есть объект с названием `ACARS Smoke`: если оставить оба, неизвестно, какой
   создаст мост, и проверка ничего не покажет. Перезапустите MSFS.
4. Откройте рядом старый проект `D:\msfs-projects\acars-smoke\acars-smoke\SimpleFX` только **для сверки чисел** (раздел 4).
   Копировать из него узлы, файлы эффекта или материал нельзя.

## 1. Новый проект

1. DevMode → **File → New Project** **[?]** (на странице VFX Editor сказано только «создайте или откройте проект
   в Project Editor»; если пункт называется иначе — выберите создание проекта).
2. Папка: `D:\msfs-projects\acars-smoke` (вне репозитория), файл проекта `acars-smoke.xml`.
3. Откроется окно **Add Package** (у нового проекта оно открывается само; иначе — кнопка **Add Package** внизу
   Project Editor).

## 2. Пакет и эффект

1. В **Add Package** выберите **Visual Effect**.
2. Имя пакета: **`acars-smoke`** → **Create**. Project Editor сам добавит к нему компанию по умолчанию
   (поле Default company name) — получится **`avail-acars-smoke`**. Так и нужно: приложение ищет в Community
   папку с этим именем. Не переименовывайте пакет.
3. Откроется **Visual Effects Wizard**. Имя эффекта — любое, например `acars-smoke` (объект находит эффект
   по InstanceId, не по имени). **Create Visual Effect**.
   Откроется Visual Effects Editor со стартовыми узлами.
4. Project Editor → меню **Project → Save**.
5. Проверьте путь эффекта: в Project Editor раскройте пакет → группа **VisualEffectsLib** → поле **Asset
   Directory**. Должно быть **два уровня** после `VisualEffectLibs`: `PackageSources\VisualEffectLibs\<компания>\<группа>\`.
   Эффект с одним уровнем симулятор из Community не находит (Asobo, DevSupport, тема 15309). Если уровень
   один — пришлите, что там написано.

## 3. Материал со своей текстурой

1. Project Editor → выделите пакет `avail-acars-smoke` → внизу Project Inspector, в разделе Asset groups — **Add
   Asset Group**.
2. В Package Wizard: **Custom** → **Next**. Имя: `acars-smoke-materiallib`, тип **MaterialLib** → **Create**.
3. В Project Inspector найдите **AssetDir** группы материала → **Show In Explorer**. Создайте там папку
   `Textures` и скопируйте в неё файл из репозитория:
   `bridge\msfs\package\PackageSources\MaterialLibs\acars-smoke-materiallib\Textures\acars_smoke.png`
   (512×512, сделан скриптом `tools/smoke-texture`, своя работа — распространять можно).
4. Откроется Material Editor (если нет — меню **Tools**). **File → New** → контекст **VFX Editor**.
5. В Material Inspector:

   | Поле | Значение |
   |---|---|
   | имя | `AcarsSmoke` |
   | тип | `CODE_DIFFUSE` |
   | Albedo | наведите на слот → **Load Texture** → `Textures\acars_smoke.png` |
   | Diffuse Colour | белый (цвет дыма задаёт эффект) |
   | Additive | **выкл.** (иначе дым светится) |

6. **Save** внизу Material Inspector. Материал появится в списке.

> **[?] Материал в том же пакете.** В примере SDK материал лежит в отдельном пакете, а приложение ставит
> только одну папку `avail-acars-smoke`. Обязательно ли разделение, документация не говорит. Если на шаге 6 сборка
> ругается на материал или в симуляторе дым есть, но с другой текстурой (раздел 7), — напишите: тогда я
> научу приложение ставить второй пакет.

## 4. Граф эффекта

Откройте эффект: Visual Effects Editor → ваш эффект в списке эффектов (или Project Editor →
VisualEffectsLib → **Load In Editor**). Цепочка сверху вниз: **VisualEffect → Emitter → Init → Update →
Output**. Поля узла — в **Inspector** справа, когда узел выделен. Новый узел — правый клик на пустом месте
графа, поиск по имени. Связь — тянуть мышью от выхода узла к входу поля.

Числа ниже — из вашей настройки T34 (2026-10-16, дым проверен в LEBL). Это наши числа, их можно повторять;
сверяйте со старым проектом глазами, но узлы стройте заново.

### Emitter

| Поле | Значение |
|---|---|
| `Rate` | `8` (частиц в секунду) |
| `Capacity` | `800` |
| `MaxDistanceEmission` | `80000` (метры; объект создаётся за 40 NM ≈ 74 км) |
| `TimeEmission` | `-1` (без конца; объект убирает мост) |
| `EmitInLocalSpace` | выкл. |

### Init

| Поле | Значение |
|---|---|
| `Lifetime` | `90` (секунды) |
| `Size` | `9` (метры) |
| `Velocity` | `0, 0, 0` — скорость задаётся в Update |

### Update

- **Размер** (`Size`) = `(9 + 90 × кривая) × случайное 0.75–1.25`.
  Кривая — **GetBezierCurve** от **GetParticleAttribute (AgeOverLifetime)**: от 0 к 1.
  Случайное — **RandomValue** `0.75…1.25`. Собирается узлами **Multiply** и **Add**.
- **Скорость** (`Velocity`) = `разлёт + подъём (+ ветер)`:
  - разлёт: **LocalDirection** с `x`, `z` из двух **RandomValue** `−0.9…0.9`, умножить на кривую от возраста
    `0.3 → 5` (клубы расходятся со временем);
  - подъём: **GravityVector**, `GravityScale = −1.5` (минус — вверх);
  - ветер: **WindDirection** (`Raw`, ft/s) × **Vector3** `(0.305, 0.305, 0.305)` × кривая `0.15 → 1`.
    В T34 вклад ветра был почти нулевым — оставьте узел, наклон дыма проверим в разделе 7.
  Сложите всё узлами **Add** и подайте в `Velocity` узла Update.

### Output

1. **Материал.** В Inspector узла Output раздел **Material** — кнопка с именем текущего материала.
   **Перетащите** материал `AcarsSmoke` из Material Editor на эту кнопку. После этого на кнопке должно быть
   написано `AcarsSmoke`.

   > Важно. В XML старого эффекта ссылки на материал нет совсем, то есть он, скорее всего, рисовался
   > материалом по умолчанию из пакетов Asobo, а не текстурой SimpleFX. Поэтому проверьте надпись на кнопке:
   > должно быть `AcarsSmoke`.

2. **Color (RGBA) (+)** — добавит вход цвета. Подайте **Vector4**:
   - `x`, `y`, `z` (серый) = кривая от возраста `0.02 → 0.11` × **RandomValue** `0.7…1.2`;
   - `w` (прозрачность) = кривая от возраста `0 → 0.9 (на 2 % жизни) → 0.85 → 0.6 → 0`.

### Сохранить

Visual Effects Editor → **File → Save**, затем Project Editor → **Project → Save**.

## 5. Объект ACARS Smoke

1. **InstanceId эффекта.** Откройте в блокноте XML эффекта в Asset Directory из шага 2.5 и найдите
   `<VisualEffect.VisualEffect InstanceId="{…}">`. Скопируйте значение целиком, с фигурными скобками.
2. Скопируйте из репозитория папку
   `bridge\msfs\package\PackageSources\SimObjects\Landmarks\ACARS_Smoke`
   в проект: `D:\msfs-projects\acars-smoke\PackageSources\SimObjects\Landmarks\ACARS_Smoke`.
   Папку `bridge\msfs\package\PackageSources\VisualEffectLibs` **не копируйте**.
3. В **скопированном** `model\ACARS_Smoke.xml` замените в `<FX_GUID>` нули на InstanceId из пункта 1.
4. `sim.cfg`: строка `title=ACARS Smoke` — **не меняйте**, это название ищет мост.
5. Project Editor → пакет `avail-acars-smoke` → **Add Asset Group**. Тип **SimObject** (так работает в вашем
   проекте T34), источник — `PackageSources\SimObjects\Landmarks\ACARS_Smoke\`, выход —
   `SimObjects\Landmarks\ACARS_Smoke\`.

## 6. Свойства пакета и сборка

1. Project Editor → выделите пакет `avail-acars-smoke` → Project Inspector:

   | Поле | Значение |
   |---|---|
   | Title | `ACARS Smoke` |
   | Creator | `AVAILOFF` |
   | версия пакета | `1.0.0` |

   **Title не меняйте в следующих версиях.** По нему приложение отличает наш пакет от чужой папки с тем же
   именем. Версию **повышайте** при каждой новой сборке — иначе «Обновить» не появится.
2. **Build All In Project**. В консоли — без красных ошибок.
3. Результат — `D:\msfs-projects\acars-smoke\Packages\avail-acars-smoke\`. Откройте в нём `manifest.json`:
   должны быть `"title": "ACARS Smoke"` и `"package_version": "1.0.0"`. Без них приложение пакет не увидит.

## 7. Проверка через приложение

1. Скопируйте `Packages\avail-acars-smoke` в репозиторий: `bridge\msfs\package\dist\avail-acars-smoke`.
2. **Закройте MSFS.** `pnpm desktop:dev` → Расширенные настройки → «Пакет дыма для MSFS 2024»:
   «MSFS 2024 (Steam): не установлен», кнопка **Установить** активна. Нажмите — «Готово — перезапустите MSFS»,
   в `D:\MSFS2024\Community\avail-acars-smoke` появился пакет.
3. Запустите MSFS, начните полёт. DevMode → **Tools → SimObject Spawner** → фильтр **Packages** = `avail-acars-smoke`
   → в списке `ACARS Smoke` → **Spawn**. Должен пойти дым.
4. Полная проверка: LEBL, на стоянке, приложение подключено, Сценарии → `dep_fire` → «Запустить сейчас».
   Через ~1 мин — столб дыма у ВПП 24L, с той стороны, что в телексе.
5. Что посмотреть:
   - **текстура:** клубы мягкие, без квадратных краёв частиц;
   - **высота и плотность:** как у старого дыма (если хуже — пришлите скриншот, подберём числа);
   - **ветер:** поставьте в погоде ветер 15–25 узлов; дым должен уходить **по ветру** (ветер с запада — дым на
     восток). Если столб вертикальный — запишите, будем отдельно разбираться с ветром;
   - **FPS:** заметно ли проседает рядом с дымом.
6. Проверьте «Удалить»: MSFS закрыт → «Удалить» → папки `avail-acars-smoke` в Community нет.

## 8. Что прислать

- всё ли прошло, и на каких шагах с **[?]** пришлось делать иначе (дословно, что выбрали);
- скриншот дыма издалека и вблизи.

После этого я закоммичу `bridge/msfs/package/dist/avail-acars-smoke` (собранный пакет; исходники проекта — тоже:
`D:\msfs-projects\acars-smoke` без `_PackageInt`, `Packages` и старой подпапки `acars-smoke\SimpleFX`), и он попадёт в установщик.
