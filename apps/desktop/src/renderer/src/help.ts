// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import type { Language } from '../../shared/api.js';

/**
 * The "Help" tab: a short manual and FAQ, EN + RU. Names of buttons and settings are quoted as the
 * UI shows them (i18n.ts); keep them in step when those strings change.
 */

/** A paragraph, a list, or an external https link (opened in the browser by the main process). */
export type HelpBlock =
  | string
  | { readonly list: readonly string[]; readonly ordered?: boolean }
  | { readonly link: string; readonly href: string };

export interface HelpItem {
  readonly id: string;
  readonly q: string;
  readonly a: readonly HelpBlock[];
}

export interface HelpSection {
  readonly id: string;
  readonly title: string;
  readonly items: readonly HelpItem[];
}

const SIMBRIEF = 'https://dispatch.simbrief.com/';
const HOPPIE = 'https://www.hoppie.nl/acars/system/register.html';

const COMMANDS_EN = [
  'HELP: the list of commands OPS understands.',
  'REQ WX [ICAO]: METAR (and TAF with live data) of an airport; empty means the destination.',
  'REQ ATIS [ICAO]: the ATIS on air on VATSIM; without one, the latest METAR.',
  'REQ GATE: the expected arrival gate or stand, baggage belt and STA.',
  'REQ GATE CHANGE [gate] [reason]: ask for another arrival gate.',
  'REQ LOADSHEET: the latest loadsheet of the flight once more.',
  'DELAY <min> <reason>: report a departure delay; OPS replies with the new EOBT.',
  'ETA: estimated arrival against the schedule, gate and transfer passengers.',
  'RDY: ready to depart before the slot (CTOT), passed on to flow control.',
  'DIVERT <ICAO>: diversion; OPS warns handling there and asks for the reason.',
  'MEDICAL <text>: a medical case on board; OPS connects MedLink.',
];

const COMMANDS_RU = [
  'HELP — список команд, которые понимает OPS.',
  'REQ WX [ICAO] — METAR (и TAF при живых данных) аэропорта; пусто — назначения.',
  'REQ ATIS [ICAO] — ATIS, который сейчас в эфире на VATSIM; если его нет — последний METAR.',
  'REQ GATE — ожидаемый гейт или стоянка прилёта, лента багажа и STA.',
  'REQ GATE CHANGE [гейт] [причина] — попросить другой гейт прилёта.',
  'REQ LOADSHEET — последняя загрузочная ведомость рейса ещё раз.',
  'DELAY <мин> <причина> — сообщить о задержке вылета; OPS ответит новым EOBT.',
  'ETA — расчётное время прилёта против расписания, гейт и пассажиры на пересадку.',
  'RDY — готовы вылететь раньше слота (CTOT); OPS передаст в службу потоков.',
  'DIVERT <ICAO> — уход на запасной; OPS предупредит хендлинг и спросит причину.',
  'MEDICAL <текст> — медицинский случай на борту; OPS подключит MedLink.',
];

const en: readonly HelpSection[] = [
  {
    id: 'start',
    title: 'Getting started',
    items: [
      {
        id: 'what',
        q: 'What does ACARS Link do?',
        a: [
          'It plays your airline’s operations centre. While you fly, it reads the simulator and your SimBrief flight plan, follows the phase of flight and sends ACARS messages to the cockpit over Hoppie ACARS: loadsheets, slot and gate information, delays, irregular situations, the next leg. You can reply and send requests from the aircraft FMS.',
          'ACARS messages are always in English, as in real operations. The app interface is in English or Russian (Settings → Language).',
        ],
      },
      {
        id: 'ui',
        q: 'What is where in the app',
        a: [
          {
            list: [
              'Messages: the airline messages and your replies, the flight card (load the OFP, start and end the flight) and the FMS screen with the selected message as the cockpit shows it. Before the first flight the flight card lists what is still missing, with “Set up” next to each item.',
              'Scenarios: which messages and situations may happen on a flight, and their chances.',
              'Settings: accounts (SimBrief, Hoppie), language, how messages are sent; the rest is under “Advanced settings”.',
              'Help: this manual.',
            ],
          },
          'The top bar shows UTC, the flight and the state of the simulator (SIM), the network (NET) and the XATC station (CPDLC). The status bar at the bottom shows the bridge, the simulator and the network, and what needs your action.',
          '“Show the welcome again” and “Take the interface tour” at the top of this page repeat the introduction.',
        ],
      },
      {
        id: 'install',
        q: 'Windows warns about the installer',
        a: [
          'The installer is not code-signed, so SmartScreen shows “Windows protected your PC”. Click “More info”, then “Run anyway”.',
        ],
      },
      {
        id: 'first',
        q: 'First flight, step by step',
        a: [
          {
            ordered: true,
            list: [
              'Settings → Accounts: enter your SimBrief username and press “Check”.',
              'Enter your Hoppie logon code and press “Save”. No code yet? Register at Hoppie (link below); the code comes by email. Without a code, set “Send messages via” to “Offline (app only)”: messages then appear only in this window.',
              'Create a flight plan in SimBrief, then on the Messages tab press “Load OFP from SimBrief”.',
              'Start MSFS or X-Plane 12 and load the aircraft at the gate. The installed app starts the simulator bridge itself, and the bridge finds the running simulator (Settings → Connection → “Simulator”: “Automatic”); the status bar shows “Sim bridge” and “Simulator” as “connected” and which simulator it is.',
              'In the aircraft FMS/MCDU (INIT or ATC COMM page) enter the flight number shown on the flight card, and connect ACARS / Hoppie in the aircraft.',
              'Press “Start flight”. Messages come from the airline station, OPS + flight number by default.',
            ],
          },
          { link: 'SimBrief Dispatch', href: SIMBRIEF },
          { link: 'Hoppie ACARS registration', href: HOPPIE },
        ],
      },
      {
        id: 'inibuilds',
        q: 'iniBuilds A350 / A380 do not receive messages',
        a: [
          'These aircraft only start picking up telex after an F-PLN REQUEST (INIT REQUEST) in the FMS. Do it after loading the flight.',
        ],
      },
    ],
  },
  {
    id: 'flight',
    title: 'During the flight',
    items: [
      {
        id: 'reply',
        q: 'How do I answer a message?',
        a: [
          'Some messages ask for a decision and list the options. Send a free-text telex to the airline station with the option as the first word, from the aircraft FMS. With “Message hints” on (Settings), the Messages tab shows under the FMS screen what the message means, which answers are expected and which one is taken if you do not reply.',
          'Messages waiting for a reply are marked “Awaiting reply”; what needs your action stays in the status bar until it is settled.',
        ],
      },
      {
        id: 'commands',
        q: 'Which commands can I send to the airline?',
        a: [
          'Send them as a free-text telex to the airline station:',
          { list: COMMANDS_EN },
          'Without the aircraft FMS, use “Airline request…” on the Messages tab: the request goes to the simulated airline as if your aircraft had sent it, and the reply arrives as usual.',
        ],
      },
      {
        id: 'xatc',
        q: 'What is XATC?',
        a: [
          'A simulated CPDLC station for your own aircraft, one per FIR (Settings → XATC station (CPDLC)). Log on to X + the FIR code (EDGG → XDGG); at the FIR boundary it hands you over to the next station. On the ground, request the departure clearance (DCL / PDC) by telex to X + the departure airport (EDDF → XDDF). It needs live data. With “Yield to live VATSIM ATC” on, XATC gives way when a real controller is online in the FIR.',
        ],
      },
      {
        id: 'sim-time',
        q: 'Time acceleration, pause and starting late',
        a: [
          'Messages follow the phase of flight, not fixed timers, so pause and simulation rate do not break the order. If you start the flight later than the scheduled departure, the flight counts as delayed and the documents use the new departure time.',
          '“Sim time” (advanced settings) runs the flight by the simulator UTC clock instead of the PC clock. It is synchronised once at the start of the flight.',
        ],
      },
      {
        id: 'end',
        q: 'What happens after landing?',
        a: [
          'At the stand the Messages tab asks what next. “Fly next leg” waits for the remaining messages, then loads the next OFP (create it in SimBrief first). “No more flights” closes the flight once the remaining messages are sent; “Close now” closes it at once.',
          '“Stop flight” ends it at any moment; messages not yet sent are dropped.',
        ],
      },
    ],
  },
  {
    id: 'settings',
    title: 'Scenarios and settings',
    items: [
      {
        id: 'scenarios',
        q: 'Can I choose which messages arrive?',
        a: [
          'Yes, on the Scenarios tab: turn single scenarios or whole categories on and off and change the chance of random events. Changes apply from the next flight. Pilot commands have no switches: requests need them.',
        ],
      },
      {
        id: 'gap',
        q: 'Messages arrive in a batch',
        a: [
          'The aircraft fetches telex about once a minute, so messages sent more often arrive together. “Gap between messages” (Settings) spaces them out; answers to your requests always go first.',
        ],
      },
      {
        id: 'live',
        q: 'What are live data?',
        a: [
          'Real weather (METAR/TAF), VATSIM controllers, natural events, rocket launches and other events used in messages. Turn them off (“Live data”) if the date in the simulator is far from today. When a source fails, messages fall back to the flight plan.',
        ],
      },
      {
        id: 'secrets',
        q: 'Where are my logon code and keys stored?',
        a: [
          'Encrypted by the operating system (Windows DPAPI). They are never shown again after saving and are not written to recordings or logs. “Remove” next to a field removes them.',
        ],
      },
      {
        id: 'memory',
        q: 'What is “airline memory”?',
        a: [
          'What irregular events leave to the next flights: open MEL items, blacklisted passengers, crew rest after an extension. Clear it in the advanced settings.',
        ],
      },
      {
        id: 'records',
        q: 'Flight recordings',
        a: [
          'With “Record flights” on, the telemetry and messages of each flight are saved to a file; the last 20 flights are kept. “Open recordings folder” shows them, which helps when reporting a problem.',
        ],
      },
      {
        id: 'logs',
        q: 'Logs and diagnostics',
        a: [
          'The app keeps logs of its own work and of the simulator bridge in the “logs” folder next to the settings (%APPDATA%\\ACARS Link\\logs): starts, connections, Hoppie status and errors, five files of 5 MB each. Your logon code, keys and SimBrief name are replaced with ***.',
          'Advanced settings → Diagnostics → “Export…” saves the logs, versions and settings as one .zip to attach to a problem report. The latest flight recording is added only when you switch it on.',
        ],
      },
    ],
  },
  {
    id: 'trouble',
    title: 'Troubleshooting',
    items: [
      {
        id: 'no-msg',
        q: 'Messages do not reach the aircraft',
        a: [
          {
            list: [
              'The flight number in the FMS must match the flight card exactly.',
              'NET in the top bar should read “Hoppie: OK”, not “offline”.',
              'ACARS / Hoppie must be enabled in the aircraft (in some aircraft it is an EFB or MCDU option, with its own logon code field).',
              'iniBuilds A350 / A380: F-PLN REQUEST first.',
              'Wait a minute: the aircraft fetches telex on its own schedule.',
            ],
          },
        ],
      },
      {
        id: 'halted',
        q: '“Hoppie stopped sending”',
        a: [
          'Hoppie refused the logon code. Check it in Settings (it is the code from the Hoppie email, not your password), then stop and start the flight again: the running flight keeps the old code.',
        ],
      },
      {
        id: 'no-sim',
        q: 'The simulator shows “no bridge” or “disconnected”',
        a: [
          {
            list: [
              'Start MSFS and wait for the main menu; the bridge connects on its own.',
              'X-Plane 12: “Simulator” in Settings must be “Automatic” or “X-Plane 12”, X-Plane must be 12.1.1 or later, and Settings > Network in X-Plane must allow incoming traffic. The simulator shows “connected” once a flight is loaded.',
              'Make sure nothing else uses the port from “Sim bridge port” (advanced settings). The installed app restarts the bridge when it changes. “Port busy” in the top bar means another program (another bridge, started by hand) holds the port: close it or change the port.',
              'If the bridge stops by itself, the installed app starts it again after a few seconds (a line in the feed says so, the flight goes on). “Does not start” means it stopped 6 times in 5 minutes: restart the app or change the bridge port, and send the diagnostics (Settings → Diagnostics) with the problem.',
              'The bridge only listens on 127.0.0.1: the app and the simulator must run on the same PC.',
            ],
          },
        ],
      },
      {
        id: 'lost',
        q: '“Telemetry lost” or “Position jump” in the feed',
        a: [
          'While telemetry is lost (simulator closed, loading screen) scenarios pause and resume when it is back. A position jump means slew or teleport; it is reported but does not stop the flight.',
        ],
      },
      {
        id: 'close',
        q: 'Can I close the window during a flight?',
        a: [
          'Yes. The flight is recorded as it goes: after closing the app, or if the app or the PC crashed, the next start (within 24 hours) offers to continue it — the phase, the feed and the replies waited for come back, and messages that did not reach the network are sent again. While the app is closed no messages arrive in the aircraft; those due meanwhile come one after another after the restart. The app still asks before closing.',
        ],
      },
    ],
  },
];

const ru: readonly HelpSection[] = [
  {
    id: 'start',
    title: 'Начало работы',
    items: [
      {
        id: 'what',
        q: 'Что делает ACARS Link?',
        a: [
          'Приложение играет роль центра управления полётами вашей авиакомпании. Во время полёта оно читает симулятор и план SimBrief, следит за фазой полёта и присылает в кабину сообщения ACARS через Hoppie ACARS: загрузочные ведомости, слот и гейт, задержки, нестандартные ситуации, следующий рейс. Вы можете отвечать и отправлять запросы из FMS самолёта.',
          'Сами сообщения ACARS всегда на английском, как в реальной эксплуатации. Интерфейс — на русском или английском (Настройки → Язык).',
        ],
      },
      {
        id: 'ui',
        q: 'Что где в приложении',
        a: [
          {
            list: [
              'Сообщения — сообщения авиакомпании и ваши ответы, карточка рейса (загрузить OFP, начать и завершить рейс) и экран FMS с выбранным сообщением, как его покажет кабина. До первого рейса карточка рейса показывает, чего не хватает, у каждого пункта — «Настроить».',
              'Сценарии — какие сообщения и ситуации могут случиться в рейсе и с какой вероятностью.',
              'Настройки — учётные записи (SimBrief, Hoppie), язык, способ отправки сообщений; остальное — в «Расширенных настройках».',
              'Справка — это руководство.',
            ],
          },
          'Верхняя панель — время UTC, рейс и состояние симулятора (SIM), сети (NET) и станции XATC (CPDLC). Строка состояния внизу — мост, симулятор, сеть и то, что требует вашего действия.',
          '«Показать приветствие снова» и «Пройти обзор интерфейса» вверху этой страницы повторяют знакомство с приложением.',
        ],
      },
      {
        id: 'install',
        q: 'Windows предупреждает об установщике',
        a: [
          'Установщик не подписан, поэтому SmartScreen показывает «Система Windows защитила ваш компьютер». Нажмите «Подробнее», затем «Выполнить в любом случае».',
        ],
      },
      {
        id: 'first',
        q: 'Первый рейс по шагам',
        a: [
          {
            ordered: true,
            list: [
              'Настройки → Учётные записи: введите имя пользователя SimBrief и нажмите «Проверить».',
              'Введите Hoppie logon code и нажмите «Сохранить». Кода нет — зарегистрируйтесь на Hoppie (ссылка ниже), код придёт на почту. Без кода выберите «Отправлять сообщения через» → «Офлайн (только в приложении)»: сообщения будут видны только в этом окне.',
              'Создайте план полёта в SimBrief, затем на вкладке «Сообщения» нажмите «Загрузить OFP из SimBrief».',
              'Запустите MSFS или X-Plane 12 и загрузите самолёт на стоянке. Установленное приложение само запускает мост симулятора, а мост сам находит запущенный симулятор (Настройки → Подключение → «Симулятор»: «Автоматически»); в строке состояния «Мост симулятора» и «Симулятор» — подключён, и видно, какой симулятор.',
              'В FMS/MCDU самолёта (страница INIT или ATC COMM) введите тот же номер рейса, что в карточке рейса, и подключите ACARS / Hoppie в самолёте.',
              'Нажмите «Начать рейс». Сообщения приходят от станции авиакомпании — по умолчанию OPS + номер рейса.',
            ],
          },
          { link: 'SimBrief Dispatch', href: SIMBRIEF },
          { link: 'Регистрация в Hoppie ACARS', href: HOPPIE },
        ],
      },
      {
        id: 'inibuilds',
        q: 'iniBuilds A350 / A380 не получают сообщения',
        a: [
          'Эти самолёты начинают забирать telex только после F-PLN REQUEST (INIT REQUEST) в FMS. Выполните его после загрузки рейса.',
        ],
      },
    ],
  },
  {
    id: 'flight',
    title: 'Во время рейса',
    items: [
      {
        id: 'reply',
        q: 'Как ответить на сообщение?',
        a: [
          'Некоторые сообщения просят решения и перечисляют варианты. Отправьте telex свободным текстом на станцию авиакомпании из FMS самолёта, вариант — первым словом. Если включены «Подсказки к сообщениям» (Настройки), под экраном FMS на вкладке «Сообщения» видно, что значит сообщение, какие ответы ждут и какой вариант будет принят без ответа.',
          'Сообщения, которые ждут ответа, помечены «Ждёт ответа»; то, что требует вашего действия, остаётся в строке состояния, пока не решено.',
        ],
      },
      {
        id: 'commands',
        q: 'Какие команды можно отправить авиакомпании?',
        a: [
          'Отправляйте их telex свободным текстом на станцию авиакомпании:',
          { list: COMMANDS_RU },
          'Без FMS самолёта — кнопка «Запрос в авиакомпанию…» на вкладке «Сообщения»: запрос уходит имитируемой авиакомпании, как будто его отправил самолёт, ответ приходит как обычно.',
        ],
      },
      {
        id: 'xatc',
        q: 'Что такое XATC?',
        a: [
          'Имитация станции CPDLC для вашего самолёта, своя в каждом FIR (Настройки → Станция УВД XATC (CPDLC)). Логон — на X + код FIR (EDGG → XDGG); на границе FIR станция передаёт вас следующей. На земле разрешение на вылет (DCL / PDC) запрашивается telex на X + аэропорт вылета (EDDF → XDDF). Нужны живые данные. С настройкой «Уступать живым диспетчерам VATSIM» XATC не мешает настоящему диспетчеру в FIR.',
        ],
      },
      {
        id: 'sim-time',
        q: 'Ускорение времени, пауза и поздний старт',
        a: [
          'Сообщения привязаны к фазе полёта, а не к таймерам, поэтому пауза и ускорение не ломают порядок. Если рейс начат позже времени вылета по расписанию, он считается задержанным, и документы идут по новому времени вылета.',
          '«Время из симулятора» (расширенные настройки) ведёт рейс по часам симулятора (UTC), а не ПК. Время синхронизируется один раз в начале рейса.',
        ],
      },
      {
        id: 'end',
        q: 'Что происходит после посадки?',
        a: [
          'На стоянке вкладка «Сообщения» спрашивает, что дальше. «Лечу следующий рейс» дожидается оставшихся сообщений и загружает следующий OFP (сначала создайте его в SimBrief). «Больше не лечу» закрывает рейс, когда уйдут оставшиеся сообщения; «Закрыть сейчас» — сразу.',
          '«Остановить рейс» завершает его в любой момент; неотправленные сообщения отбрасываются.',
        ],
      },
    ],
  },
  {
    id: 'settings',
    title: 'Сценарии и настройки',
    items: [
      {
        id: 'scenarios',
        q: 'Можно выбрать, какие сообщения приходят?',
        a: [
          'Да, на вкладке «Сценарии»: включайте и выключайте отдельные сценарии или целые категории, меняйте вероятность случайных событий. Изменения действуют со следующего рейса. У команд пилота переключателей нет — они нужны для запросов.',
        ],
      },
      {
        id: 'gap',
        q: 'Сообщения приходят пачкой',
        a: [
          'Самолёт забирает telex примерно раз в минуту, поэтому сообщения, отправленные чаще, приходят вместе. «Интервал между сообщениями» (Настройки) разносит их; ответы на ваши запросы всегда идут первыми.',
        ],
      },
      {
        id: 'live',
        q: 'Что такое живые данные?',
        a: [
          'Реальная погода (METAR/TAF), диспетчеры VATSIM, природные события, пуски ракет и другие события, которые попадают в сообщения. Выключите их («Живые данные»), если дата в симуляторе далека от сегодняшней. Если источник недоступен, сообщения строятся по плану полёта.',
        ],
      },
      {
        id: 'secrets',
        q: 'Где хранятся logon code и ключи?',
        a: [
          'В зашифрованном виде средствами операционной системы (Windows DPAPI). После сохранения они больше не показываются и не попадают в записи и журналы. Кнопка «Удалить» рядом с полем стирает их.',
        ],
      },
      {
        id: 'memory',
        q: 'Что такое «память авиакомпании»?',
        a: [
          'То, что нестандартные события оставляют следующим рейсам: открытые пункты MEL, пассажиров в чёрном списке, отдых экипажа после продления. Очистить её можно в расширенных настройках.',
        ],
      },
      {
        id: 'records',
        q: 'Записи полётов',
        a: [
          'С настройкой «Записывать полёты» телеметрия и сообщения каждого рейса сохраняются в файл; хранятся последние 20 рейсов. «Открыть папку записей» покажет их — запись полезно приложить к сообщению о проблеме.',
        ],
      },
      {
        id: 'logs',
        q: 'Журналы и диагностика',
        a: [
          'Приложение ведёт журналы своей работы и моста к симулятору в папке «logs» рядом с настройками (%APPDATA%\\ACARS Link\\logs): запуски, подключения, состояние Hoppie и ошибки, пять файлов по 5 МБ. Logon-код, ключи и имя SimBrief заменяются на ***.',
          'Расширенные настройки → Диагностика → «Экспорт…» сохраняет журналы, версии и настройки одним .zip-файлом, чтобы приложить его к сообщению о проблеме. Последняя запись полёта добавляется, только если её включить.',
        ],
      },
    ],
  },
  {
    id: 'trouble',
    title: 'Если что-то не работает',
    items: [
      {
        id: 'no-msg',
        q: 'Сообщения не доходят до самолёта',
        a: [
          {
            list: [
              'Номер рейса в FMS должен точно совпадать с карточкой рейса.',
              'NET в верхней строке — «Hoppie: OK», а не «офлайн».',
              'ACARS / Hoppie должен быть включён в самолёте (в некоторых — опция EFB или MCDU со своим полем для logon code).',
              'iniBuilds A350 / A380: сначала F-PLN REQUEST.',
              'Подождите минуту: самолёт забирает telex по своему расписанию.',
            ],
          },
        ],
      },
      {
        id: 'halted',
        q: '«Hoppie остановил отправку»',
        a: [
          'Hoppie не принял logon code. Проверьте его в настройках (это код из письма Hoppie, а не пароль), затем остановите и снова начните рейс: идущий рейс держит старый код.',
        ],
      },
      {
        id: 'no-sim',
        q: 'Симулятор: «нет моста» или «не подключён»',
        a: [
          {
            list: [
              'Запустите MSFS и дождитесь главного меню — мост подключится сам.',
              'X-Plane 12: в настройках «Симулятор» должен быть «Автоматически» или «X-Plane 12», версия X-Plane — 12.1.1 или новее, а в X-Plane в Settings > Network должен быть разрешён входящий трафик. «Подключён» появится, когда загружен полёт.',
              'Проверьте, что порт из «Порт моста симулятора» (расширенные настройки) не занят другой программой. Установленное приложение перезапускает мост при смене порта. «Порт занят» в верхней строке значит, что порт держит другая программа (другой мост, запущенный вручную): закройте её или смените порт.',
              'Если мост остановился сам, установленное приложение запустит его снова через несколько секунд (в ленте будет строка об этом, рейс продолжается). «Не запускается» — он остановился 6 раз за 5 минут: перезапустите приложение или смените порт моста и приложите диагностику (Настройки → Диагностика) к описанию проблемы.',
              'Мост слушает только 127.0.0.1: приложение и симулятор должны работать на одном ПК.',
            ],
          },
        ],
      },
      {
        id: 'lost',
        q: 'В ленте «Телеметрия потеряна» или «Скачок позиции»',
        a: [
          'Пока телеметрии нет (симулятор закрыт, экран загрузки), сценарии стоят на паузе и продолжаются, когда она вернётся. Скачок позиции — это slew или телепорт; он отмечается в ленте, но рейс не останавливает.',
        ],
      },
      {
        id: 'close',
        q: 'Можно закрыть окно во время рейса?',
        a: [
          'Да. Рейс записывается по ходу полёта: после закрытия приложения или падения приложения или ПК следующий запуск (в течение 24 часов) предложит его продолжить — фаза, лента и ожидаемые ответы восстановятся, сообщения, не успевшие уйти в сеть, отправятся снова. Пока приложение закрыто, сообщения в самолёт не приходят; те, чьё время наступило, придут по очереди после перезапуска. Перед закрытием приложение всё равно спросит.',
        ],
      },
    ],
  },
];

export const HELP: Readonly<Record<Language, readonly HelpSection[]>> = { en, ru };

/** The text of a block, for the search box. */
function blockText(b: HelpBlock): string {
  if (typeof b === 'string') return b;
  return 'list' in b ? b.list.join(' ') : b.link;
}

/** Sections with only the items whose question or answer contains the query; empty sections go. */
export function searchHelp(sections: readonly HelpSection[], query: string): HelpSection[] {
  const q = query.trim().toLowerCase();
  return sections
    .map((s) => ({
      ...s,
      items:
        q === ''
          ? s.items
          : s.items.filter((i) => [i.q, ...i.a.map(blockText)].join(' ').toLowerCase().includes(q)),
    }))
    .filter((s) => s.items.length > 0);
}
