<!--
Release notes for people (T84). Copy next to the installer as RELEASE-NOTES-<X.Y.Z>.md (or into the
release page), fill the {{…}} fields, delete this comment. {{changes}}: the CHANGELOG.md section of
the version in plain words (what a pilot notices, not task numbers). {{sha256}}: the hash from
ACARS-Link-Setup-<X.Y.Z>.exe.sha256. Requirements change only by a decision recorded in docs/07.
-->

# ACARS Link {{version}} — {{date}}

## English

### What's new

{{changes}}

### Requirements

- Windows 10 or 11, 64-bit.
- Microsoft Flight Simulator 2024 or X-Plane 12. **MSFS 2020 is not supported.**
- An aircraft that receives Hoppie ACARS telex (for example Fenix A320, PMDG 737/777, iniBuilds A350/A380).
- A Hoppie ACARS logon code (hoppie.nl) and a SimBrief account.

### Install

1. Download `ACARS-Link-Setup-{{version}}.exe` and `ACARS-Link-Setup-{{version}}.exe.sha256`.
2. Check the file (optional, recommended). In PowerShell, in the download folder:

   ```
   (Get-FileHash .\ACARS-Link-Setup-{{version}}.exe -Algorithm SHA256).Hash
   ```

   The result must match the hash below and the first word of the `.sha256` file (letter case does
   not matter). If it does not match, do not run the installer.

   SHA-256: `{{sha256}}`
3. Run the installer. It is not code-signed, so Windows SmartScreen shows "Windows protected your
   PC": click **More info**, then **Run anyway**.
4. An earlier version is updated in place; settings, flight recordings and the logbook are kept.
   There are no automatic updates: new versions come as a new installer.

ACARS Link is free for non-commercial flight simulation (licence agreement in the installer).
Messages are simulated and must never be used for real flight.

## Русский

### Что нового

{{changes}}

### Требования

- Windows 10 или 11, 64-разрядная.
- Microsoft Flight Simulator 2024 или X-Plane 12. **MSFS 2020 не поддерживается.**
- Самолёт, принимающий telex Hoppie ACARS (например, Fenix A320, PMDG 737/777, iniBuilds A350/A380).
- Logon-код Hoppie ACARS (hoppie.nl) и учётная запись SimBrief.

### Установка

1. Скачайте `ACARS-Link-Setup-{{version}}.exe` и `ACARS-Link-Setup-{{version}}.exe.sha256`.
2. Проверьте файл (по желанию, рекомендуется). В PowerShell, в папке загрузки:

   ```
   (Get-FileHash .\ACARS-Link-Setup-{{version}}.exe -Algorithm SHA256).Hash
   ```

   Результат должен совпасть с суммой ниже и с первым словом файла `.sha256` (регистр букв не
   важен). Не совпадает — не запускайте установщик.

   SHA-256: `{{sha256}}`
3. Запустите установщик. Он без цифровой подписи, поэтому Windows SmartScreen покажет «Система
   Windows защитила ваш компьютер»: нажмите **Подробнее**, затем **Выполнить в любом случае**.
4. Предыдущая версия обновляется на месте; настройки, записи полётов и журнал рейсов сохраняются.
   Автообновления нет: новая версия — новый установщик.

ACARS Link бесплатен для некоммерческих авиасимуляторов (лицензионное соглашение — в установщике).
Сообщения имитируются, для реальных полётов их использовать нельзя.
