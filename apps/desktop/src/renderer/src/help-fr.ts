// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

/**
 * The "Help" tab in French (France) (T86/T87): machine translation by `pnpm i18n translate` (tools/i18n,
 * glossary docs/glossary-i18n.md), not yet checked by a native speaker. Hand edits are kept on the next run.
 */

import type { HelpSection } from './help.js';

export const fr: readonly HelpSection[] = [
  {
    id: 'start',
    title: 'Mise en route',
    items: [
      {
        id: 'what',
        q: 'À quoi sert ACARS Link ?',
        a: [
          'Le centre des opérations de votre compagnie aérienne prend le relais. Pendant que vous volez, il lit les données du simulateur et de votre plan de vol SimBrief, suit la phase de vol et envoie des messages ACARS au cockpit via Hoppie ACARS : devis de masse et centrage, informations sur les créneaux horaires et les portes d’embarquement, retards, situations irrégulières, prochaine étape. Vous pouvez répondre et envoyer des demandes depuis le FMS de l’avion.',
          'Les messages ACARS sont toujours en anglais, comme lors des opérations réelles. L’interface de l’application est disponible en plusieurs langues (Paramètres → Langue).',
        ],
      },
      {
        id: 'ui',
        q: 'Où se trouvent les différentes fonctionnalités dans l’application ?',
        a: [
          {
            list: [
              'Messages : les messages de la compagnie aérienne et vos réponses, la fiche de vol (chargement de l’OFP, début et fin du vol) et l’écran FMS avec le message sélectionné tel qu’il s’affiche dans le cockpit. Avant le premier vol, la fiche de vol répertorie les éléments manquants, avec la mention « Configuration » à côté de chaque élément.',
              'Scénarios : quels messages et situations peuvent se produire lors d’un vol, et leur probabilité.',
              'Paramètres : comptes (SimBrief, Hoppie), langue, mode d’envoi des messages ; le reste se trouve sous « Paramètres avancés ».',
              'Aide : ce manuel.',
            ],
          },
          'La barre supérieure affiche l’UTC, le vol et l’état du simulateur (SIM), du réseau (NET) et de la station XATC (CPDLC). La barre d’état en bas affiche la passerelle, le simulateur et le réseau, ainsi que les actions requises de votre part.',
          '« Afficher à nouveau la page d’accueil » et « Faire le tour de l’interface », en haut de cette page, vous permettent de revoir l’introduction.',
        ],
      },
      {
        id: 'install',
        q: 'Windows affiche un avertissement concernant le programme d’installation',
        a: [
          'Le programme d’installation n’est pas signé numériquement ; SmartScreen affiche donc le message « Windows a protégé votre PC ». Cliquez sur « Plus d’informations », puis sur « Exécuter quand même ».',
        ],
      },
      {
        id: 'first',
        q: 'Premier vol, étape par étape',
        a: [
          {
            list: [
              'Paramètres → Comptes : saisissez votre nom d’utilisateur SimBrief et cliquez sur « Vérifier ».',
              'Saisissez votre code d’logon code Hoppie et cliquez sur « Enregistrer ». Vous n’avez pas encore de code ? Inscrivez-vous sur Hoppie (lien ci-dessous) ; le code vous sera envoyé par e-mail. Si vous n’avez pas de code, réglez « Envoyer des messages via » sur « Hors ligne (application uniquement) » : les messages n’apparaîtront alors que dans cette fenêtre.',
              "Créez un plan de vol dans SimBrief, puis, dans l'onglet Messages, cliquez sur « Charger l'OFP depuis SimBrief ».",
              'Lancez MSFS ou X-Plane 12 et chargez l’avion à la porte d’embarquement. L’application installée démarre automatiquement la passerelle de simulation, et celle-ci détecte le simulateur en cours d’exécution (Paramètres → Connexion → « Simulateur » : « Automatique ») ; la barre d’état indique que « Passerelle de simulation » et « Simulateur » sont « connecté », ainsi que le nom du simulateur concerné.',
              'Dans le FMS/MCDU de l’avion (page INIT ou ATC COMM), saisissez le numéro de vol indiqué sur la fiche de vol, puis connectez-vous à ACARS / Hoppie dans l’avion.',
              'Appuyez sur « Démarrer le vol ». Des messages proviennent de la station de la compagnie aérienne : OPS + numéro de vol par défaut.',
            ],
            ordered: true,
          },
          {
            link: 'SimBrief Régulation des vols',
            href: 'https://dispatch.simbrief.com/',
          },
          {
            link: 'Enregistrement Hoppie ACARS',
            href: 'https://www.hoppie.nl/acars/system/register.html',
          },
        ],
      },
      {
        id: 'inibuilds',
        q: 'iniBuilds A350 / A380 ne reçoivent pas de messages',
        a: [
          'Ces avions ne commencent à capter les télex qu’après une F-PLN REQUEST (INIT REQUEST) dans le FMS. Effectuez cette opération après avoir chargé le vol.',
        ],
      },
    ],
  },
  {
    id: 'flight',
    title: 'Pendant le vol',
    items: [
      {
        id: 'reply',
        q: 'Comment répondre à un message ?',
        a: [
          'Certains messages vous demandent de prendre une décision et énumèrent les options possibles. Envoyez un télex en texte libre à la station de la compagnie aérienne en indiquant l’option choisie comme premier mot, depuis le FMS de l’avion. Lorsque la fonction « Aides aux messages » est activée (Paramètres), l’onglet « Messages » affiche, sous l’écran du FMS, la signification du message, les réponses attendues et celle qui sera retenue si vous ne répondez pas.',
          'Les messages en attente d’une réponse sont signalés par la mention « En attente de réponse » ; ceux qui nécessitent une intervention de votre part restent affichés dans la barre d’état jusqu’à ce qu’ils soient traités.',
        ],
      },
      {
        id: 'commands',
        q: 'Quelles commandes puis-je envoyer à la compagnie aérienne ?',
        a: [
          'Envoyez-les sous forme de télex en texte libre à la station de la compagnie aérienne :',
          {
            list: [
              'HELP : la liste des commandes comprises par OPS.',
              'REQ WX [ICAO] : METAR (et TAF avec données en direct) d’un aéroport ; la case vide désigne la destination.',
              'REQ ATIS [ICAO] : l’ATIS en ligne sur VATSIM ; à défaut, le dernier METAR.',
              'REQ GATE : la porte d’arrivée ou le poste de stationnement prévu, le tapis à bagages et le STA.',
              'REQ GATE CHANGE [porte] [motif] : demandez une autre porte d’arrivée.',
              'REQ LOADSHEET : le dernier devis de masse et centrage du vol s’affiche à nouveau.',
              'DELAY <MIN> <MOTIF> : signalez un retard au départ ; OPS répond en indiquant le nouvel EOBT.',
              'ETA : heure d’arrivée estimée par rapport à l’horaire, à la porte d’embarquement et aux passagers en correspondance.',
              'RDY : prêt à décoller avant le créneau (CTOT), transmis au contrôle de flux.',
              'DIVERT <ICAO> : déroutement ; OPS avertit le personnel au sol sur place et demande la raison.',
              'MEDICAL <texte> : un cas médical à bord ; OPS se connecte à MedLink.',
            ],
          },
          'En l’absence de FMS de l’avion, utilisez « Demande de la compagnie aérienne… » dans l’onglet Messages : la demande est transmise à la compagnie aérienne simulée comme si votre avion l’avait envoyée, et la réponse vous parvient comme d’habitude.',
        ],
      },
      {
        id: 'xatc',
        q: 'Qu’est-ce que l’XATC ?',
        a: [
          'Une station CPDLC simulée pour votre propre aéronef, à raison d’une par FIR (Paramètres → Station XATC (CPDLC)). Connectez-vous à X + le code FIR (EDGG → XDGG) ; à la limite de la FIR, la station vous transfère à la station suivante. Au sol, demandez l’autorisation de départ (DCL / PDC) par télex à X + l’aéroport de départ (EDDF → XDDF). Des données en temps réel sont nécessaires. Lorsque l’option « Rendement en temps réel VATSIM ATC » est activée, XATC cède la place lorsqu’un contrôleur réel est en ligne dans la FIR.',
        ],
      },
      {
        id: 'sim-time',
        q: 'Accélération du temps, pause et départ tardif',
        a: [
          'Les messages suivent la phase de vol et non des minuteries fixes ; ainsi, les pauses et la vitesse de simulation ne perturbent pas l’ordre des événements. Si vous démarrez le vol après l’heure de départ prévue, celui-ci est considéré comme retardé et les documents reprennent la nouvelle heure de départ.',
          '« Temps de simulation » (paramètres avancés) exécute le vol selon l’horloge UTC du simulateur plutôt que selon l’horloge du PC. Il est synchronisé une seule fois au début du vol.',
        ],
      },
      {
        id: 'end',
        q: 'Que se passe-t-il après l’atterrissage ?',
        a: [
          "À la position de stationnement, l’onglet « Messages » vous demande quelle est la prochaine étape. L’option « Effectuer l'étape suivante » attend les messages restants, puis charge le prochain OFP (créez-le d’abord dans SimBrief). L’option « Plus aucun vol » clôt le vol une fois les messages restants envoyés ; l’option « Fermer maintenant » le clôt immédiatement.",
          '« Arrêter le vol », cela met fin au vol à tout moment ; les messages non encore envoyés sont ignorés.',
        ],
      },
    ],
  },
  {
    id: 'settings',
    title: 'Scénarios et paramètres',
    items: [
      {
        id: 'scenarios',
        q: 'Puis-je choisir les messages que je souhaite recevoir ?',
        a: [
          'Oui, dans l’onglet « Scénarios » : activez ou désactivez des scénarios individuels ou des catégories entières, et modifiez la probabilité des événements aléatoires. Les modifications s’appliquent dès le prochain vol. Les commandes pilote ne comportent pas de commutateurs : ce sont les demandes qui en nécessitent.',
        ],
      },
      {
        id: 'gap',
        q: 'Les messages arrivent par lots',
        a: [
          'L’avion récupère les télex environ une fois par minute ; ainsi, les messages envoyés plus fréquemment arrivent en même temps. L’« Intervalle entre les messages » (Paramètres) permet de les espacer ; les réponses à vos demandes sont toujours traitées en priorité.',
        ],
      },
      {
        id: 'live',
        q: 'Que sont les données en direct ?',
        a: [
          'Données météorologiques réelles (METAR/TAF), contrôleurs VATSIM, phénomènes naturels, lancements de fusées et autres événements utilisés dans les messages. Désactivez-les (« Données en direct ») si la date dans le simulateur est très éloignée de la date du jour. En cas de défaillance d’une source, les messages se rabattent sur le plan de vol.',
        ],
      },
      {
        id: 'secrets',
        q: 'Où sont stockés mon logon code et mes clés ?',
        a: [
          'Chiffrés par le système d’exploitation (Windows DPAPI). Ils ne s’affichent plus jamais après l’enregistrement et ne sont pas consignés dans les enregistrements ni les journaux. La commande « Supprimer », à côté d’un champ, permet de les supprimer.',
        ],
      },
      {
        id: 'memory',
        q: 'Qu’est-ce que la « mémoire de la compagnie aérienne » ?',
        a: [
          'Quels événements irréguliers sont reportés aux vols suivants : éléments MEL en suspens, passagers figurant sur la liste noire, temps de repos de l’équipage après une prolongation. Effacez-les dans les paramètres avancés.',
        ],
      },
      {
        id: 'records',
        q: 'Enregistrements de vol',
        a: [
          'Lorsque l’option « Enregistrer les vols » est activée, la télémétrie et les messages de chaque vol sont enregistrés dans un fichier ; les 20 derniers vols sont conservés. L’option « Ouvrir le dossier des enregistrements » permet de les afficher, ce qui est utile pour signaler un problème.',
        ],
      },
      {
        id: 'logs',
        q: 'Journaux et diagnostics',
        a: [
          'L’application conserve les journaux relatifs à son propre fonctionnement et à la passerelle du simulateur dans le dossier « logs » situé à côté des paramètres (%APPDATA%\\ACARS Link\\logs) : démarrages, connexions, état de Hoppie et erreurs, soit cinq fichiers de 5 MB chacun. Votre logon code, vos clés et votre nom SimBrief sont remplacés par ***.',
          'Paramètres avancés → Diagnostics → « Exporter… » : cette option enregistre les journaux, les versions et les paramètres dans un fichier .zip unique à joindre à un rapport de problème. L’enregistrement de vol le plus récent n’est ajouté que lorsque vous activez cette option.',
        ],
      },
    ],
  },
  {
    id: 'trouble',
    title: 'Dépannage',
    items: [
      {
        id: 'no-msg',
        q: 'Les messages ne parviennent pas à bord de l’avion',
        a: [
          {
            list: [
              'Le numéro de vol dans l’FMS doit correspondre exactement à celui de la fiche de vol.',
              'La mention NET dans la barre supérieure doit indiquer « Hoppie: OK » et non « hors ligne ».',
              'ACARS / Hoppie doit être activé à bord de l’avion (sur certains appareils, il s’agit d’une option de l’EFB ou du MCDU, avec son propre champ de logon code).',
              'iniBuilds A350 / A380 : veuillez d’abord effectuer une F-PLN REQUEST.',
              'Attendez un instant : l’avion récupère les télex selon son propre calendrier.',
            ],
          },
        ],
      },
      {
        id: 'halted',
        q: '« Hoppie a cessé d’envoyer des messages »',
        a: [
          'Hoppie a refusé le logon code. Vérifiez-le dans les Paramètres (il s’agit du code figurant dans l’e-mail de Hoppie, et non de votre mot de passe), puis arrêtez et relancez le vol : le vol en cours conserve l’ancien code.',
        ],
      },
      {
        id: 'no-sim',
        q: 'Le simulateur affiche « pas de passerelle » ou « déconnecté »',
        a: [
          {
            list: [
              'Lancez MSFS et attendez que le menu principal s’affiche ; la connexion s’établit automatiquement via la passerelle.',
              'X-Plane 12 : l’option « Simulateur » dans les Paramètres doit être réglée sur « Automatique » ou « X-Plane 12 », X-Plane doit être en version 12.1.1 ou ultérieure, et l’option Paramètres > Réseau dans X-Plane doit autoriser le trafic entrant. Le simulateur affiche « connecté » une fois le vol chargé.',
              'Assurez-vous qu’aucun autre programme n’utilise le port indiqué dans « Port de la passerelle SIM » (paramètres avancés). L’application installée redémarre la passerelle lorsque celle-ci change. Le message « Port occupé » dans la barre supérieure signifie qu’un autre programme (une autre passerelle, lancée manuellement) occupe le port : fermez-le ou changez de port.',
              'Si la passerelle s’arrête de lui-même, l’application installée la redémarre au bout de quelques secondes (une ligne dans le fil des messages l’indique, le vol se poursuit). Le message « Ne démarre pas » signifie qu’elle s’est arrêtée 6 fois en 5 minutes : redémarrez l’application ou modifiez le port de la passerelle, puis envoyez les diagnostics (Paramètres → Diagnostics) décrivant le problème.',
              'La passerelle n’écoute que sur l’adresse 127.0.0.1 : l’application et le simulateur doivent fonctionner sur le même PC.',
            ],
          },
        ],
      },
      {
        id: 'lost',
        q: '« Perte de télémétrie » ou « Saut de position » dans le fil des messages',
        a: [
          'En cas de perte de télémétrie (simulateur fermé, écran de chargement), les scénarios sont mis en pause et reprennent dès le rétablissement de la connexion. Un saut de position correspond à un pivotement ou à une téléportation ; il est signalé mais n’interrompt pas le vol.',
        ],
      },
      {
        id: 'close',
        q: 'Puis-je fermer la fenêtre pendant un vol ?',
        a: [
          'Oui. L’enregistrement du vol se fait au fur et à mesure : après la fermeture de l’application, ou en cas de plantage de l’application ou de l’PC, le prochain démarrage (dans les 24 heures) vous propose de reprendre le vol — la phase de vol, le fil des messages et les réponses attendues réapparaissent, et les messages qui n’ont pas atteint le réseau sont renvoyés. Tant que l’application est fermée, aucun message n’arrive dans l’avion ; ceux qui auraient dû être reçus entre-temps s’affichent les uns après les autres après le redémarrage. L’application vous demande toujours votre confirmation avant de se fermer.',
        ],
      },
    ],
  },
];
