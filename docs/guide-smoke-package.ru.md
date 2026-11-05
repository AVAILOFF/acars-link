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
   Итог должен быть ровно такой: `D:\msfs-projectscars-smoke\PackageSources\MaterialLibscars-smoke-materiallib\Texturescars_smoke.png`
   — `Textures` **внутри** папки группы, рядом с файлом `.material`. Если положить `Textures` уровнем выше
   (`MaterialLibs\Textures`), Load Texture выдаст «is not relative to the package source dir».
4. Откроется **Material Editor**. Если нет — выделите в Project Editor группу `acars-smoke-materiallib` → в Project
   Inspector **Load in Editor** (как у группы эффекта).
5. Material Editor → **File → New**. Появится выбор **контекста** (где будет использоваться материал) —
   выберите **VFX Editor**. Откроется **Material Inspector**.
6. В Material Inspector сверху вниз:

   **Material Data**

   | Поле | Значение |
   |---|---|
   | Context | `VFX Editor` (уже выбран) |
   | Information | должен показывать пакет `avail-acars-smoke` / группу `acars-smoke-materiallib` — проверьте, что материал попадёт в наш пакет |
   | Name | `AcarsSmoke` |
   | Tag | не трогать |
   | Type | `CODE_DIFFUSE` |

   **Textures** — наведите мышь на первый слот текстуры (Albedo / Diffuse) → появится кнопка **Load Texture** →
   выберите `Textures\acars_smoke.png` из шага 3. Остальные слоты — пустые.

   **Extra Settings → VFX Settings**

   | Поле | Значение | Зачем |
   |---|---|---|
   | UV Offset / UV Scale / UV Rotation | `0` / `1` / `0` (по умолчанию) | |
   | Opacity | `1` | прозрачность задаёт сама текстура и эффект |
   | Metalness, Roughness | `0` | |
   | Diffuse Colour | белый | цвет дыма задаёт эффект |
   | Emissive Colour | чёрный | иначе дым светится ночью |
   | **Blend Mode** | **`Alpha Blend`** | у текстуры обычная (не умноженная) прозрачность; `Additive` даст светящийся дым, `Opaque` — квадраты |
   | Two-Sided, Flip Backface | по умолчанию | |

7. Внизу Material Inspector — **Save**. Материал появится в списке Material Editor.
8. Проверка: Material Editor → меню **Debug → Diagnostics**. В консоли не должно быть ошибок про
   `acars_smoke.png` (файл не найден, не степень двойки).

> **[?] Материал в том же пакете.** В примере SDK материал лежит в отдельном пакете, а приложение ставит
> только одну папку `avail-acars-smoke`. Обязательно ли разделение, документация не говорит. Если сборка
> ругается на материал или в симуляторе дым есть, но с другой текстурой (раздел 7), — напишите: тогда я
> научу приложение ставить второй пакет.

## 4. Граф эффекта

### 4.1. Как работать с графом

- Открыть эффект: Project Editor → группа `VisualEffectLib` → Project Inspector → **Load in Editor**, затем
  щёлкнуть эффект в списке Visual Effects Editor. Граф — в окне **Node Graph**.
- **Новый узел:** правый клик на пустом месте Node Graph → поиск по имени (или перетащить из окна **Node List**).
- **Поля узла:** выделите узел — его поля в **Inspector** (окно VFX-редактора; если закрыто — меню **View**).
- **Связь:** тянуть мышью от выхода узла (точка справа, `OutputValue`) к кружку слева от поля другого узла.
  Подключённое поле берёт значение из связи, число в поле игнорируется.
- **Кривая** (узел **GetBezierCurve**): вход `FXTime` — время, поле `Curve` — точки. Ниже точки записаны как
  `(x; y)`, где x — доля жизни частицы от 0 до 1, y — значение. Ставьте точки в редакторе кривой в Inspector
  узла **[?]** (как добавить точку — пришлите скриншот Inspector, если не получится).
- Сохраняйте почаще: Visual Effects Editor → **File → Save**.

Ниже — ваш эффект T34 (дым проверен в LEBL 2026-10-16), разобранный по узлам. Это наши числа; узлы ставьте
новые, не копируйте из старого проекта.

### 4.2. Цепочка блоков

Мастер уже создал **VisualEffect → Emitter**. Если **Init**, **Update** и **Output** нет — добавьте их и
соедините сверху вниз: Emitter → Init → Update → Output.

**Emitter**

| Поле | Значение |
|---|---|
| `Rate` | `8` |
| `Capacity` | `800` |
| `MaxDistanceEmission` | `80000` |
| остальное | по умолчанию (в T34 не менялось) |

**Init**

| Поле | Значение |
|---|---|
| `Lifetime` | `90` |
| `Size` | `9` |
| `Velocity` | `0, 0, 0` (скорость — в Update) |

### 4.3. Общие узлы

Их выходы нужны многим узлам ниже. Поставьте слева от графа:

| Узел | Поле | Значение | Дальше называется |
|---|---|---|---|
| **GetParticleAttribute** | `ParticleAttributeType` | `AgeOverLifetime` | **Возраст** (0 → 1 за жизнь частицы) |
| **GetParticleAttribute** | `ParticleAttributeType` | `id` | **Номер** (чтобы случайное число у частицы не менялось каждый кадр) |

Каждый **RandomValue** ниже: вход `RandIndex` ← **Номер**; `RandSeed` — разный у каждого (числа в таблицах).

### 4.4. Размер частицы → Update `Size`

`Size = (Кривая А × 90 + 9) × случайное 0.75…1.25` — клуб растёт с 9 до ~100 м за жизнь.

| № | Узел | Входы |
|---|---|---|
| 1 | **GetBezierCurve** «Кривая А» | `FXTime` ← Возраст; `Curve`: (0; 0), (0.1; 0.12), (0.3; 0.3), (0.6; 0.65), (1; 1) |
| 2 | **Float** | `x = 90` |
| 3 | **Multiply** | `x` ← узел 1, `y` ← узел 2 |
| 4 | **Float** | `x = 9` |
| 5 | **Add** | `x` ← узел 3, `y` ← узел 4 |
| 6 | **RandomValue** | `Min 0.75`, `Max 1.25`, `RandSeed 2048` |
| 7 | **Multiply** | `x` ← узел 5, `y` ← узел 6 → выход в **Update `Size`** |

### 4.5. Скорость → Update `Velocity`

`Velocity = разлёт + подъём + ветер` — три ветки, потом два **Add**.

**Ветка «разлёт»** — клубы расходятся вбок, всё сильнее к концу жизни:

| № | Узел | Входы |
|---|---|---|
| 1 | **RandomValue** | `Min −0.9`, `Max 0.9`, `RandSeed 512` |
| 2 | **RandomValue** | `Min −0.9`, `Max 0.9`, `RandSeed 1024` |
| 3 | **LocalDirection** | `x` ← узел 1, `z` ← узел 2 (`y` пустой) |
| 4 | **GetBezierCurve** «Кривая Б» | `FXTime` ← Возраст; `Curve`: (0; 0.3), (0.3; 1), (0.6; 3), (1; 5) |
| 5 | **Vector3** | `x`, `y`, `z` ← все три от узла 4 |
| 6 | **Multiply** | `x` ← узел 3, `y` ← узел 5 |

**Ветка «подъём»** — быстро вверх в начале, медленнее потом:

| № | Узел | Входы |
|---|---|---|
| 7 | **GetBezierCurve** «Кривая В» | `FXTime` ← Возраст; `Curve`: (0; 1), (0.1; 0.7), (0.25; 0.5), (0.5; 0.35), (1; 0.25) |
| 8 | **Float** | `x = −16` |
| 9 | **Multiply** | `x` ← узел 7, `y` ← узел 8 |
| 10 | **RandomValue** | `Min 0.75`, `Max 1.25`, `RandSeed 8192` |
| 11 | **Multiply** | `x` ← узел 9, `y` ← узел 10 |
| 12 | **GravityVector** | `GravityScale` ← узел 11 (минус — значит вверх) |

**Ветка «ветер»:**

| № | Узел | Входы |
|---|---|---|
| 13 | **WindDirection** | поля по умолчанию (в T34 не менялись) |
| 14 | **Vector3** | `x = y = z = 0.305` (футы → метры; **не** вписывайте 0.305 числом в Multiply — умножится одна ось) |
| 15 | **Multiply** | `x` ← узел 13, `y` ← узел 14 |
| 16 | **GetBezierCurve** «Кривая Г» | `FXTime` ← Возраст; `Curve`: (0; 0.15), (0.2; 0.4), (0.5; 0.8), (1; 1) |
| 17 | **Vector3** | `x`, `y`, `z` ← все три от узла 16 |
| 18 | **Multiply** | `x` ← узел 15, `y` ← узел 17 |

**Сложить:**

| № | Узел | Входы |
|---|---|---|
| 19 | **Add** | `x` ← узел 6 (разлёт), `y` ← узел 12 (подъём) |
| 20 | **Add** | `x` ← узел 19, `y` ← узел 18 (ветер) → выход в **Update `Velocity`** |

### 4.6. Цвет и прозрачность → Output

1. Выделите **Output** → в Inspector нажмите **Color (RGBA) (+)**. У Output появится вход цвета.
2. Узлы:

| № | Узел | Входы |
|---|---|---|
| 1 | **GetBezierCurve** «Кривая Д» (темнота) | `FXTime` ← Возраст; `Curve`: (0; 0.02), (0.25; 0.045), (0.6; 0.08), (1; 0.11) — почти чёрный, к концу светлеет |
| 2 | **RandomValue** | `Min 0.7`, `Max 1.2`, `RandSeed 4096` |
| 3 | **Multiply** | `x` ← узел 1, `y` ← узел 2 |
| 4 | **GetBezierCurve** «Кривая Е» (прозрачность) | `FXTime` ← Возраст; `Curve`: (0; 0), (0.02; 0.9), (0.5; 0.85), (0.85; 0.6), (1; 0) — быстро появляется, плавно тает |
| 5 | **Vector4** | `x`, `y`, `z` ← узел 3; `w` ← узел 4 → выход во **вход цвета Output** |

3. **Материал.** В Inspector узла Output раздел **Material** — кнопка с именем текущего материала (или
   пустая). Откройте Material Editor рядом и **перетащите** `AcarsSmoke` из списка материалов на эту кнопку.
   На кнопке должно стать `AcarsSmoke`.

   > В XML старого эффекта ссылки на материал нет: он, скорее всего, рисовался материалом Asobo по умолчанию,
   > а не текстурой SimpleFX. Поэтому новый дым может выглядеть иначе — это и проверяем в разделе 7.

### 4.7. Проверить на месте и сохранить

1. Visual Effects Editor → **File → Save**, Project Editor → **Project → Save**.
2. Visual Effects Editor → **View → Template/Instance Debugger** → вкладка **Spawner** → свой самолёт →
   любой Contact Point → **Spawn**. У самолёта должен пойти тёмный столб с мягкими клубами (не квадратами).
3. Если что-то не так — скриншот графа и Inspector выделенного узла.

## 5. Объект ACARS Smoke

1. **InstanceId эффекта.** Откройте в блокноте XML эффекта (AssetDir из шага 2.5):
   `D:\msfs-projects\acars-smoke\PackageSources\VisualEffectLibs\acars-smoke\VisualEffectLib\acars-smoke.xml`
   (не файл `…_edition.xml`). Найдите строку `<VisualEffect.VisualEffect InstanceId="{…}">` — она одна.
   Скопируйте значение целиком, с фигурными скобками.
2. Скопируйте из репозитория папку
   `bridge\msfs\package\PackageSources\SimObjects\Landmarks\ACARS_Smoke`
   в проект: `D:\msfs-projects\acars-smoke\PackageSources\SimObjects\Landmarks\ACARS_Smoke`.
   Папку `bridge\msfs\package\PackageSources\VisualEffectLibs` **не копируйте**.
3. В **скопированном** `model\ACARS_Smoke.xml` замените в `<FX_GUID>` нули на InstanceId из пункта 1.
4. `sim.cfg`: строка `title=ACARS Smoke` — **не меняйте**, это название ищет мост.
5. Project Editor → щёлкните пакет `avail-acars-smoke` → Project Inspector → **Add Asset Group** → Package
   Wizard: **Custom** → **Next** → имя `ACARS_Smoke`, тип **SimObject** → **Create** (тип — как в вашем
   проекте T34, там он работает).
6. Выделите новую группу `ACARS_Smoke` → в Project Inspector проверьте пути (как у группы эффекта на шаге 2.5):

   | Поле | Значение |
   |---|---|
   | Asset Group Type | `SimObject` |
   | AssetDir | `PackageSources\SimObjects\Landmarks\ACARS_Smoke\` |
   | OutputDir | `SimObjects\Landmarks\ACARS_Smoke\` |

   Если мастер поставил другие пути — впишите эти (или выберите папку кнопкой с папкой справа от поля).
7. Project Editor → **Project → Save**.

## 6. Свойства пакета и сборка

1. Project Editor → выделите пакет `avail-acars-smoke` → Project Inspector, свойства пакета (точные подписи
   полей в документации не описаны **[?]** — ищите похожие):

   | Поле | Значение |
   |---|---|
   | Title | `ACARS Smoke` |
   | Creator | `avail` (как Default creator name; можно `AVAILOFF`) |
   | версия пакета (Version) | `1.0.0` |

   Project Editor → **Project → Save**.

   **Title не меняйте в следующих версиях.** По нему приложение отличает наш пакет от чужой папки с тем же
   именем. Версию **повышайте** при каждой новой сборке — иначе «Обновить» не появится.
2. **Build All in project** (кнопка вверху Project Editor). Ход и ошибки — в окне Console (DevMode → Debug → Console **[?]**); красных ошибок быть не должно, у пакета пропадёт пометка `Outdated`.
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
