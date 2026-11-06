// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

/**
 * The "Help" tab in Spanish (Spain) (T86/T87): machine translation by `pnpm i18n translate` (tools/i18n,
 * glossary docs/glossary-i18n.md), not yet checked by a native speaker. Hand edits are kept on the next run.
 */

import type { HelpSection } from './help.js';

export const es: readonly HelpSection[] = [
  {
    id: 'start',
    title: 'Primeros pasos',
    items: [
      {
        id: 'what',
        q: '¿Para qué sirve ACARS Link?',
        a: [
          'Simula el centro de operaciones de su aerolínea. Mientras vuela, lee los datos del simulador y su plan de vuelo de SimBrief, sigue la fase de vuelo y envía mensajes ACARS a la cabina a través de Hoppie ACARS: hojas de carga, información sobre franjas horarias y puertas de embarque, retrasos, situaciones irregulares y el siguiente tramo. Puede responder y enviar solicitudes desde el FMS de la aeronave.',
          'Los mensajes de ACARS siempre están en inglés, al igual que en las operaciones reales. La interfaz de la aplicación está disponible en varios idiomas (Ajustes → Idioma).',
        ],
      },
      {
        id: 'ui',
        q: 'Qué se encuentra en cada sección de la aplicación',
        a: [
          {
            list: [
              'Mensajes: los mensajes de la aerolínea y sus respuestas, la ficha de vuelo (cargar el OFP, iniciar y finalizar el vuelo) y la pantalla del FMS con el mensaje seleccionado tal y como se muestra en la cabina. Antes del primer vuelo, la ficha de vuelo enumera lo que aún falta, con «Configuración» junto a cada elemento.',
              'Escenarios: qué mensajes y situaciones pueden darse durante un vuelo, y su probabilidad de ocurrencia.',
              'Ajustes: cuentas (SimBrief, Hoppie), idioma, forma de envío de los mensajes; el resto se encuentra en «Configuración avanzada».',
              'Ayuda: este manual.',
            ],
          },
          'La barra superior muestra la hora UTC, el vuelo y el estado del simulador (SIM), la red (NET) y la estación XATC (CPDLC). La barra de estado de la parte inferior muestra el puente, el simulador y la red, así como lo que requiere su intervención.',
          '«Volver a mostrar la pantalla de bienvenida» y «Hacer el recorrido por la interfaz», en la parte superior de esta página, repiten la introducción.',
        ],
      },
      {
        id: 'install',
        q: 'Windows le advierte sobre el instalador',
        a: [
          'El instalador no está firmado digitalmente, por lo que SmartScreen muestra el mensaje «Windows ha protegido su PC». Haga clic en «Más información» y, a continuación, en «Ejecutar de todos modos».',
        ],
      },
      {
        id: 'first',
        q: 'Primer vuelo, paso a paso',
        a: [
          {
            list: [
              'Ajustes → Cuentas: introduzca su nombre de usuario de SimBrief y pulse «Comprobar».',
              'Introduzca su código de logon code de Hoppie y pulse «Guardar». ¿Aún no dispone de código? Regístrese en Hoppie (enlace más abajo); recibirá el código por correo electrónico. Si no dispone de código, configure «Enviar mensajes a través de» en «Sin conexión (solo en la aplicación)»: de este modo, los mensajes solo aparecerán en esta ventana.',
              'Cree un plan de vuelo en SimBrief y, a continuación, en la pestaña «Mensajes», pulse «Cargar el OFP desde SimBrief».',
              'Inicie MSFS o X-Plane 12 y cargue la aeronave en la puerta de embarque. La aplicación instalada inicia automáticamente el puente del simulador, y este detecta el simulador en ejecución (Ajustes → Conexión → «Simulador»: «Automático»); la barra de estado muestra «Puente del simulador» y «Simulador» como «conectado», indicando de qué simulador se trata.',
              'En el FMS/MCDU de la aeronave (página INIT o ATC COMM), introduzca el número de vuelo que figura en la ficha de vuelo y conecte ACARS/Hoppie en la aeronave.',
              'Pulse «Iniciar vuelo». Se reciben mensajes de la estación de la aerolínea; por defecto, se reciben mensajes de OPS, junto con el número de vuelo.',
            ],
            ordered: true,
          },
          {
            link: 'Despacho de SimBrief',
            href: 'https://dispatch.simbrief.com/',
          },
          {
            link: 'Hoppie: registro en ACARS',
            href: 'https://www.hoppie.nl/acars/system/register.html',
          },
        ],
      },
      {
        id: 'inibuilds',
        q: 'iniBuilds: los modelos A350/A380 no reciben mensajes',
        a: [
          'Estas aeronaves solo comienzan a recibir télex tras una F-PLN REQUEST (INIT REQUEST) en el FMS. Hágalo tras cargar el vuelo.',
        ],
      },
    ],
  },
  {
    id: 'flight',
    title: 'Durante el vuelo',
    items: [
      {
        id: 'reply',
        q: '¿Cómo respondo a un mensaje?',
        a: [
          'Algunos mensajes solicitan una decisión y enumeran las opciones. Envíe un télex de texto libre a la estación de la aerolínea indicando la opción como primera palabra, desde el FMS de la aeronave. Con «Ayudas de mensajes» activadas (Configuración), la pestaña «Mensajes» muestra, debajo de la pantalla del FMS, el significado del mensaje, las respuestas esperadas y cuál se tomará si no responde.',
          'Los mensajes que esperan una respuesta se marcan como «A la espera de respuesta»; aquellos que requieran su intervención permanecen en la barra de estado hasta que se resuelvan.',
        ],
      },
      {
        id: 'commands',
        q: '¿Qué órdenes puede enviar a la aerolínea?',
        a: [
          'Envíelos como un télex de texto libre a la estación de la aerolínea:',
          {
            list: [
              'HELP: la lista de comandos que entiende OPS.',
              'REQ WX [ICAO]: METAR (y TAF con datos en vivo) de un aeropuerto; si está en blanco, se refiere al destino.',
              'REQ ATIS [ICAO]: el ATIS en emisión en VATSIM; en su defecto, el último METAR.',
              'REQ GATE: la puerta o el puesto de llegada previsto, la cinta de equipajes y el STA.',
              'REQ GATE CHANGE [puerta] [motivo]: solicita otra puerta de llegada.',
              'REQ LOADSHEET: se muestra de nuevo la última hoja de carga del vuelo.',
              'DELAY <MIN> <MOTIVO>: notifique un retraso en la salida; OPS responde con el nuevo EOBT.',
              'la ETA: hora estimada de llegada según el horario, la puerta de embarque y los pasajeros en tránsito.',
              'RDY: listo para partir antes de la franja horaria (CTOT), se transmite al control de flujo.',
              'DIVERT <ICAO>: desvío; OPS avisa al personal de tierra y solicita el motivo.',
              'MEDICAL <texto>: un caso médico a bordo; OPS se conecta a MedLink.',
            ],
          },
          'Sin el FMS de la aeronave, utilice «Solicitud de la aerolínea…» en la pestaña «Mensajes»: la solicitud se envía a la aerolínea simulada como si la hubiera enviado su aeronave, y la respuesta llega como de costumbre.',
        ],
      },
      {
        id: 'xatc',
        q: '¿Qué es XATC?',
        a: [
          'Una estación CPDLC simulada para su propia aeronave, una por cada FIR (Configuración → Estación XATC (CPDLC)). Inicie sesión en X + el código FIR (EDGG → XDGG); en el límite del FIR, le transfiere a la siguiente estación. En tierra, solicite la autorización de salida (DCL / PDC) por télex a X + el aeropuerto de salida (EDDF → XDDF). Se necesitan datos en tiempo real. Con la opción «Rendimiento en tiempo real de VATSIM ATC» activada, XATC cede el paso cuando un controlador real está conectado en el FIR.',
        ],
      },
      {
        id: 'sim-time',
        q: 'Aceleración del tiempo, pausa y inicio tardío',
        a: [
          'Los mensajes siguen la fase de vuelo, no temporizadores fijos, por lo que las pausas y la velocidad de simulación no alteran el orden. Si inicia el vuelo más tarde de la hora de salida programada, el vuelo se considerará con retraso y los documentos utilizarán la nueva hora de salida.',
          '«Tiempo de simulación» (ajustes avanzados) ejecuta el vuelo según el reloj UTC del simulador, en lugar del reloj del PC. Se sincroniza una vez al inicio del vuelo.',
        ],
      },
      {
        id: 'end',
        q: '¿Qué ocurre tras el aterrizaje?',
        a: [
          'En el puesto de estacionamiento, la pestaña «Mensajes» le pregunta qué desea hacer a continuación. «Volar el siguiente tramo» espera a que se reciban los mensajes restantes y, a continuación, carga el siguiente OFP (cree este primero en SimBrief). «No hay más vuelos» cierra el vuelo una vez enviados los mensajes restantes; «Cerrar ahora» lo cierra de inmediato.',
          '«Detener el vuelo», este finaliza en cualquier momento; los mensajes que aún no se hayan enviado se descartan.',
        ],
      },
    ],
  },
  {
    id: 'settings',
    title: 'Escenarios y ajustes',
    items: [
      {
        id: 'scenarios',
        q: '¿Puedo elegir qué mensajes recibo?',
        a: [
          'Sí, en la pestaña «Escenarios»: active o desactive escenarios individuales o categorías completas y modifique la probabilidad de que se produzcan eventos aleatorios. Los cambios se aplican a partir del siguiente vuelo. Los comandos del piloto no tienen interruptores: las solicitudes sí los necesitan.',
          'Para desactivar un tipo de mensaje, escriba una palabra del mismo en el campo de búsqueda de la pestaña «Escenarios»: «CTOT» localiza los tres escenarios con mensajes de franja horaria. En la lista de mensajes, el asunto de un mensaje es el nombre de su escenario.',
        ],
      },
      {
        id: 'gap',
        q: 'Los mensajes llegan en un lote',
        a: [
          'La aeronave recupera los mensajes de télex aproximadamente una vez por minuto, por lo que los mensajes enviados con mayor frecuencia llegan juntos. La opción «Intervalo entre mensajes» (Configuración) espacia dichos mensajes; las respuestas a sus solicitudes siempre se muestran en primer lugar.',
        ],
      },
      {
        id: 'live',
        q: '¿Qué son los datos en vivo?',
        a: [
          'Datos de meteorología reales (METAR/TAF), controladores de VATSIM, fenómenos naturales, lanzamientos de cohetes y otros eventos utilizados en los mensajes. Desactívelos («Datos en vivo») si la fecha en el simulador está muy alejada de la actual. Cuando falla una fuente, los mensajes recurren al plan de vuelo.',
        ],
      },
      {
        id: 'secrets',
        q: '¿Dónde se almacenan mi «logon code» y mis claves?',
        a: [
          'Cifrados por el sistema operativo (Windows DPAPI). No vuelven a mostrarse tras guardarlos y no se escriben en las grabaciones ni en los registros. La opción «Eliminar», situada junto a un campo, los elimina.',
        ],
      },
      {
        id: 'memory',
        q: '¿Qué es la «memoria de la aerolínea»?',
        a: [
          'Qué incidencias pueden afectar a los próximos vuelos: elementos MEL pendientes, pasajeros en lista negra, descanso de la tripulación tras una prórroga. Elimínelas en la configuración avanzada.',
        ],
      },
      {
        id: 'records',
        q: 'Grabaciones de vuelo',
        a: [
          'Con la opción «Registrar vuelos» activada, la telemetría y los mensajes de cada vuelo se guardan en un archivo; se conservan los últimos 20 vuelos. La opción «Abrir la carpeta de grabaciones» permite visualizarlos, lo que resulta útil a la hora de informar de un problema.',
        ],
      },
      {
        id: 'logs',
        q: 'Registros y diagnóstico',
        a: [
          'La aplicación guarda registros de su propio funcionamiento y del puente del simulador en la carpeta «logs», situada junto a la configuración (%APPDATA%\\ACARS Link\\logs): arranques, conexiones, estado de Hoppie y errores, cinco archivos de 5 MB cada uno. Su logon code, claves y nombre de SimBrief se sustituyen por ***.',
          'Configuración avanzada → Diagnóstico → «Exportar…»: guarda los registros, las versiones y la configuración en un único archivo .zip para adjuntarlo a un informe de incidencias. La última grabación de vuelo solo se añade cuando se activa esta función.',
        ],
      },
    ],
  },
  {
    id: 'trouble',
    title: 'Solución de problemas',
    items: [
      {
        id: 'no-msg',
        q: 'Los mensajes no llegan al avión',
        a: [
          {
            list: [
              'El número de vuelo en el FMS debe coincidir exactamente con el de la ficha de vuelo.',
              'En la barra superior, en NET debería aparecer «Hoppie: OK», no «sin conexión».',
              'ACARS/Hoppie debe estar activado en la aeronave (en algunas aeronaves es una opción del EFB o del MCDU, con su propio campo de logon code).',
              'iniBuilds A350 / A380: solicite primero F-PLN REQUEST.',
              'Un momento: la aeronave recupera los mensajes de télex según su propio horario.',
            ],
          },
        ],
      },
      {
        id: 'halted',
        q: '«Hoppie ha dejado de enviar mensajes»',
        a: [
          'Hoppie ha rechazado el logon code. Compruébelo en «Ajustes» (se trata del código del correo electrónico de Hoppie, no de su contraseña) y, a continuación, detenga y reinicie el vuelo: el vuelo en curso conserva el código anterior.',
        ],
      },
      {
        id: 'no-sim',
        q: 'El simulador muestra «sin puente» o «desconectado»',
        a: [
          {
            list: [
              'Inicie MSFS y espere a que aparezca el menú principal; el puente se conecta automáticamente.',
              'X-Plane 12: la opción «Simulador» en «Configuración» debe estar en «Automático» o «X-Plane 12»; X-Plane debe ser la versión 12.1.1 o posterior, y en X-Plane, en «Configuración» > «Red», debe permitirse el tráfico entrante. El simulador muestra «conectado» una vez que se ha cargado el vuelo.',
              'Asegúrese de que ningún otro programa utilice el puerto indicado en «Puerto del puente SIM» (ajustes avanzados). La aplicación instalada reinicia el puente cuando se produce un cambio. El mensaje «Puerto ocupado» en la barra superior significa que otro programa (otro puente, iniciado manualmente) espera el puerto: ciérrelo o cambie el puerto.',
              'Si el puente se detiene por sí solo, la aplicación instalada lo reinicia al cabo de unos segundos (una línea en la lista de mensajes lo indica, y el vuelo continúa). «No se inicia» significa que se ha detenido 6 veces en 5 minutos: reinicie la aplicación o cambie el puerto del puente, y envíe el informe de diagnóstico (Ajustes → Diagnóstico) indicando el problema.',
              'El puente solo escucha en 127.0.0.1: la aplicación y el simulador deben ejecutarse en el mismo PC.',
            ],
          },
        ],
      },
      {
        id: 'lost',
        q: '«Pérdida de telemetría» o «Salto de posición» en la lista de mensajes',
        a: [
          'Cuando se pierde la telemetría (simulador cerrado, pantalla de carga), los escenarios se pausan y se reanudan cuando se restablece. Un salto de posición implica un giro brusco o un teletransporte; se notifica, pero no detiene el vuelo.',
        ],
      },
      {
        id: 'close',
        q: '¿Puedo cerrar la ventana durante un vuelo?',
        a: [
          'Sí. La grabación del vuelo se realiza a medida que avanza: tras cerrar la aplicación, o si la aplicación o el PC se bloquean, al reiniciar la aplicación (en un plazo de 24 horas) se le ofrecerá la posibilidad de continuar: se recuperarán la fase de vuelo, la lista de mensajes y las respuestas esperadas, y los mensajes que no llegaron a la red se volverán a enviar. Mientras la aplicación está cerrada, no llegan mensajes a la aeronave; los que se hayan generado entretanto se mostrarán uno tras otro tras el reinicio. La aplicación sigue preguntando antes de cerrarse.',
        ],
      },
    ],
  },
];
