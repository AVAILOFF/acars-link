// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { DEFAULT_RESCUE_FLIPPED, DEFAULT_RESCUE_TITLES, RESCUE_TITLE_GROUPS } from '@acars/core';
import { useEffect, useState } from 'react';
import type {
  Language,
  Settings,
  SimChoice,
  SmokePackageTarget,
  TransportChoice,
} from '../../shared/api.js';
import { activeSim } from '../../shared/api.js';
import { SourceCredit } from './AboutSection.js';
import { AerodataboxKeyForm, HoppieCodeForm, UsernameForm } from './SettingsAccounts.js';
import {
  Group,
  Hint,
  LanguageOptions,
  Row,
  SavedMark,
  SettingSwitch,
  TextRow,
  Title,
  useUpdate,
} from './SettingsControls.js';
import { SwitchInput } from './Switch.js';
import { playMessageSound } from './sound.js';
import { useStore } from './store.js';
import { useT } from './ui.js';

/** Choices for the gap between messages, seconds. */
const GAPS: readonly number[] = [0, 30, 60, 90, 120, 180];

/** The same rule as `main/settings.ts`, so a bad template is caught at the field. */
const STATION_RE = /^(?:[A-Z0-9]|\{flight\}|\{airline\})+$/i;

/**
 * Settings (T56): the basic ones first, the expert ones folded under "Advanced" (U-07). Every
 * setting saves at once and marks its own row "saved" (U-08); the ones a running flight does not
 * pick up carry a "next flight" tag (U-09).
 */
export function SettingsView() {
  const t = useT();
  const creds = useStore((s) => s.creds);
  const settings = useStore((s) => s.settings);
  const open = useStore((s) => s.advancedOpen);
  const setOpen = useStore((s) => s.setAdvancedOpen);
  const focusField = useStore((s) => s.focusField);

  // T70: a readiness item opened the page at its field.
  useEffect(() => {
    if (focusField === null) return;
    const el = document.getElementById(focusField);
    el?.scrollIntoView({ block: 'center' });
    el?.focus();
    useStore.getState().clearFocusField();
  }, [focusField]);

  if (creds === null || settings === null) return null;
  return (
    <section className="page" aria-labelledby="set-title">
      <h2 id="set-title" className="page-title">
        {t('tab.settings')}
      </h2>
      <Group id="acc" title={t('set.account')}>
        {!creds.secureStorage && <p className="sheet-note warn">{t('set.noSecure')}</p>}
        <UsernameForm initial={creds.simbriefUsername} />
        <HoppieCodeForm isSet={creds.hoppieCodeSet} />
        <AerodataboxKeyForm isSet={creds.aerodataboxKeySet} />
      </Group>
      <BasicSettings s={settings} />
      <details className="advanced" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary>
          <span className="advanced-title">{t('set.advanced')}</span>
          <span className="advanced-hint">{t('set.advancedHint')}</span>
        </summary>
        <AdvancedSettings s={settings} />
      </details>
    </section>
  );
}

function BasicSettings({ s }: { s: Settings }) {
  const t = useT();
  const { off, update } = useUpdate();
  return (
    <>
      <Group id="general" title={t('set.group.general')}>
        <Row htmlFor="lang" title={t('set.language')}>
          <select
            id="lang"
            value={s.language}
            disabled={off}
            onChange={(e) => void update({ language: e.currentTarget.value as Language })}
          >
            <LanguageOptions current={s.language} />
          </select>
          <SavedMark field="language" />
        </Row>
        <Row htmlFor="transport" title={<Title text={t('set.transport')} next />}>
          <select
            id="transport"
            value={s.transport}
            disabled={off}
            onChange={(e) => void update({ transport: e.currentTarget.value as TransportChoice })}
          >
            <option value="hoppie">{t('set.transport.hoppie')}</option>
            <option value="offline">{t('set.transport.offline')}</option>
          </select>
          <SavedMark field="transport" />
        </Row>
        <Row htmlFor="sound" title={t('set.sound')} hint={<Hint text={t('set.soundHint')} />}>
          <button type="button" className="btn" onClick={() => playMessageSound()}>
            {t('set.soundTest')}
          </button>
          <SwitchInput
            id="sound"
            checked={s.soundOnMessage}
            disabled={off}
            onChange={(v) => void update({ soundOnMessage: v })}
          />
          <SavedMark field="soundOnMessage" />
        </Row>
        <SettingSwitch s={s} k="messageHints" title={t('set.hints')} hint={t('set.hintsHint')} />
        <SettingSwitch
          s={s}
          k="askFlightKind"
          title={t('set.askKind')}
          hint={t('set.askKindHint')}
        />
      </Group>

      <Group id="messages" title={t('set.group.messages')}>
        <Row
          htmlFor="gap"
          title={<Title text={t('set.gap')} next />}
          hint={<Hint text={t('set.gapHint')} />}
        >
          <select
            id="gap"
            value={s.messageGapSec}
            disabled={off}
            onChange={(e) => void update({ messageGapSec: Number(e.currentTarget.value) })}
          >
            {GAPS.includes(s.messageGapSec) ? null : (
              <option value={s.messageGapSec}>{s.messageGapSec}</option>
            )}
            {GAPS.map((g) => (
              <option key={g} value={g}>
                {g === 0 ? t('set.gapNone') : t('set.gapSec', { s: g })}
              </option>
            ))}
          </select>
          <SavedMark field="messageGapSec" />
        </Row>
        <SettingSwitch
          s={s}
          k="turnaround"
          title={t('set.turnaround')}
          hint={t('set.turnaroundHint')}
          next
        />
        <SourceCredit id="openflights" label="credit.openflights" />
      </Group>

      <Group id="data" title={t('set.group.data')}>
        <SettingSwitch
          s={s}
          k="liveData"
          title={t('set.liveData')}
          hint={t('set.liveDataHint')}
          next
        />
        <SourceCredit id="osm" label="credit.osm" />
        <p className="sheet-note">
          <strong>{t('set.special')}</strong> {t('set.specialHint')}
        </p>
        {(['specialSport', 'specialAviation', 'specialOther'] as const).map((key) => (
          <SettingSwitch key={key} s={s} k={key} title={t(`set.${key}`)} next />
        ))}
      </Group>

      <Group id="xatc" title={t('set.group.xatc')}>
        <SettingSwitch s={s} k="xatc" title={t('set.xatc')} hint={t('set.xatcHint')} next />
        <SettingSwitch
          s={s}
          k="xatcStandAside"
          title={t('set.xatcStandAside')}
          hint={t('set.xatcStandAsideHint')}
          next
          disabled={!s.xatc}
          offHint={t('set.offXatc')}
        />
        <SettingSwitch
          s={s}
          k="xatcRandomDirects"
          title={t('set.xatcRandomDirects')}
          hint={t('set.xatcRandomDirectsHint')}
          next
          disabled={!s.xatc}
          offHint={t('set.offXatc')}
        />
        <SourceCredit id="vatspy" label="credit.vatspy" />
      </Group>
    </>
  );
}

function AdvancedSettings({ s }: { s: Settings }) {
  const t = useT();
  const { off, update } = useUpdate();
  const openRecordings = useStore((st) => st.openRecordings);
  const clearMemory = useStore((st) => st.clearMemory);
  const exportDiagnostics = useStore((st) => st.exportDiagnostics);
  const exported = useStore((st) => st.saved === 'diagnostics');
  // T67 decision 3: the recording (callsign, route, AeroDataBox data) only when ticked, off by default.
  const [withRecording, setWithRecording] = useState(false);
  // T59: what X-Plane lacks is greyed out by the connected sim, not by the setting.
  const source = useStore((st) => st.app?.bridge.source ?? null);
  const xplane = activeSim(s.simChoice, { source }) === 'xplane';
  const memory = useStore((st) => st.app?.memory ?? []);
  const running = useStore((st) => st.app?.session === 'running');
  const titles = (v: string) =>
    v
      .split('\n')
      .map((x) => x.trim())
      .filter((x) => x !== '');
  return (
    <>
      <Group id="time" title={t('set.group.time')}>
        <SettingSwitch
          s={s}
          k="simTime"
          title={t('set.simTime')}
          hint={t('set.simTimeHint')}
          next
          disabled={xplane}
          offHint={t('set.offXplane')}
        />
        <TextRow
          id="hub-icao"
          field="hubIcao"
          title={<Title text={t('set.hubIcao')} next />}
          hint={<Hint text={t('set.hubIcaoHint')} />}
          className="caps short"
          maxLength={4}
          value={s.hubIcao}
          normalize={(v) => v.trim().toUpperCase()}
          check={(v) => (/^(?:[A-Z]{4})?$/.test(v) ? null : t('set.badHub'))}
          save={(v) => void update({ hubIcao: v })}
          disabled={off}
        />
      </Group>

      <Group id="datalink" title={t('set.group.datalink')}>
        <SettingSwitch
          s={s}
          k="datalink"
          title={t('set.datalink')}
          hint={t('set.datalinkHint')}
          next
        />
        <SettingSwitch
          s={s}
          k="datalinkSatcom"
          title={t('set.datalinkSatcom')}
          next
          disabled={!s.datalink}
          offHint={t('set.offDatalink')}
        />
        <SettingSwitch
          s={s}
          k="datalinkHeaderInText"
          title={t('set.datalinkHeaderInText')}
          next
          disabled={!s.datalink}
          offHint={t('set.offDatalink')}
        />
        <TextRow
          id="icao-hex"
          field="aircraftIcaoHex"
          title={<Title text={t('set.aircraftIcaoHex')} next />}
          hint={
            <Hint
              text={t('set.aircraftIcaoHexHint')}
              off={s.datalink ? undefined : t('set.offDatalink')}
            />
          }
          off={!s.datalink}
          className="caps short"
          maxLength={6}
          value={s.aircraftIcaoHex}
          normalize={(v) => v.trim().toUpperCase()}
          check={(v) => (/^(?:[0-9A-F]{6})?$/.test(v) ? null : t('set.badHex'))}
          save={(v) => void update({ aircraftIcaoHex: v })}
          disabled={off || !s.datalink}
        />
      </Group>

      <SmokePackageGroup />

      <Group id="rescue" title={t('set.group.rescue')}>
        <SettingSwitch
          s={s}
          k="rescue"
          title={t('set.rescue')}
          hint={t('set.rescueHint')}
          disabled={xplane}
          offHint={t('set.offXplane')}
        />
        <p className={s.rescue ? 'sheet-note' : 'sheet-note off'}>
          {s.rescue ? t('set.rescueTitlesHint') : t('set.offRescue')}
        </p>
        {RESCUE_TITLE_GROUPS.map((g) => (
          <Row key={g} htmlFor={`rescue-${g}`} title={t(`set.rescue.${g}`)} off={!s.rescue}>
            <textarea
              id={`rescue-${g}`}
              rows={2}
              spellCheck={false}
              // A new key after a save or a reset puts the stored list back in the field.
              key={s.rescueTitles[g].join('\n')}
              defaultValue={s.rescueTitles[g].join('\n')}
              disabled={off || !s.rescue}
              onBlur={(e) => {
                const list = titles(e.currentTarget.value);
                if (list.join('\n') !== s.rescueTitles[g].join('\n')) {
                  void update({ rescueTitles: { ...s.rescueTitles, [g]: list } }, `rescue-${g}`);
                }
              }}
            />
            <SavedMark field={`rescue-${g}`} />
          </Row>
        ))}
        <Row
          htmlFor="rescue-flipped"
          title={t('set.rescueFlipped')}
          hint={<Hint text={t('set.rescueFlippedHint')} />}
          off={!s.rescue}
        >
          <textarea
            id="rescue-flipped"
            rows={2}
            spellCheck={false}
            key={s.rescueFlipped.join('\n')}
            defaultValue={s.rescueFlipped.join('\n')}
            disabled={off || !s.rescue}
            onBlur={(e) => {
              const list = titles(e.currentTarget.value);
              if (list.join('\n') !== s.rescueFlipped.join('\n')) {
                void update({ rescueFlipped: list });
              }
            }}
          />
          <SavedMark field="rescueFlipped" />
        </Row>
        <Row title={t('set.rescueDefaults')} off={!s.rescue}>
          <button
            type="button"
            className="btn"
            disabled={off || !s.rescue}
            onClick={() =>
              void update(
                { rescueTitles: DEFAULT_RESCUE_TITLES, rescueFlipped: DEFAULT_RESCUE_FLIPPED },
                'rescueReset',
              )
            }
          >
            {t('set.rescueReset')}
          </button>
          <SavedMark field="rescueReset" />
        </Row>
      </Group>

      <Group id="records" title={t('set.group.records')}>
        <Row
          htmlFor="record"
          title={<Title text={t('set.record')} next />}
          hint={<Hint text={t('set.recordHint')} />}
        >
          <button
            type="button"
            className="btn"
            disabled={off}
            onClick={() => void openRecordings()}
          >
            {t('set.openRecordings')}
          </button>
          <SwitchInput
            id="record"
            checked={s.recordFlights}
            disabled={off}
            onChange={(v) => void update({ recordFlights: v })}
          />
          <SavedMark field="recordFlights" />
        </Row>
        <Row
          title={
            memory.length === 0
              ? t('set.memoryEmpty')
              : t('set.memory', { names: memory.join(', ') })
          }
          hint={<Hint text={t('set.memoryHint')} />}
        >
          <button
            type="button"
            className="btn danger"
            disabled={off || running || memory.length === 0}
            title={running ? t('why.stop_flight_first') : undefined}
            onClick={() => {
              if (window.confirm(t('set.clearMemoryConfirm', { names: memory.join(', ') }))) {
                void clearMemory();
              }
            }}
          >
            {t('set.clearMemory')}
          </button>
        </Row>
      </Group>

      <Group id="conn" title={t('set.group.connection')}>
        <Row
          htmlFor="sim-choice"
          title={t('set.simulator')}
          hint={<Hint text={t('set.simulatorHint')} />}
        >
          <select
            id="sim-choice"
            value={s.simChoice}
            disabled={off}
            onChange={(e) => void update({ simChoice: e.currentTarget.value as SimChoice })}
          >
            <option value="auto">{t('set.simulator.auto')}</option>
            <option value="msfs">{t('set.simulator.msfs')}</option>
            <option value="xplane">{t('set.simulator.xplane')}</option>
          </select>
          <SavedMark field="simChoice" />
        </Row>
        <TextRow
          id="station"
          field="stationTemplate"
          title={<Title text={t('set.station')} next />}
          hint={<Hint text={t('set.stationHint')} />}
          maxLength={32}
          value={s.stationTemplate}
          check={(v) => (v !== '' && STATION_RE.test(v) ? null : t('set.badStation'))}
          save={(v) => void update({ stationTemplate: v })}
          disabled={off}
        />
        <TextRow
          id="port"
          field="bridgePort"
          title={t('set.bridgePort')}
          className="short"
          maxLength={5}
          inputMode="numeric"
          value={String(s.bridgePort)}
          check={(v) => {
            const n = Number(v);
            return /^\d+$/.test(v) && n >= 1024 && n <= 65535 ? null : t('set.badPort');
          }}
          save={(v) => void update({ bridgePort: Number(v) })}
          disabled={off}
        />
      </Group>

      <Group id="diagnostics" title={t('set.group.diagnostics')}>
        <Row htmlFor="diag-recording" title={t('set.diagRecording')}>
          <SwitchInput
            id="diag-recording"
            checked={withRecording}
            disabled={off}
            onChange={setWithRecording}
          />
        </Row>
        <Row title={t('set.diagExport')} hint={<Hint text={t('set.diagExportHint')} />}>
          {exported && (
            <span className="saved" role="status">
              ✓ {t('set.diagSaved')}
            </span>
          )}
          <button
            type="button"
            className="btn"
            disabled={off}
            onClick={() => void exportDiagnostics(withRecording)}
          >
            {t('set.diagExportButton')}
          </button>
        </Row>
      </Group>
    </>
  );
}

/** T104: the smoke package for MSFS 2024: where it is, install / update / remove on the button only. */
function SmokePackageGroup() {
  const t = useT();
  const { off } = useUpdate();
  const pkg = useStore((st) => st.smokePackage);
  const load = useStore((st) => st.loadSmokePackage);
  const install = useStore((st) => st.installSmokePackage);
  const remove = useStore((st) => st.removeSmokePackage);
  const done = useStore((st) => st.saved === 'smokePackage');
  useEffect(() => {
    void load();
  }, [load]);
  if (pkg === null) return null;
  const bundled = pkg.bundled;
  const needs = (x: SmokePackageTarget) =>
    !x.foreign && bundled !== null && (x.installed === null || x.installed !== bundled);
  const status = (x: SmokePackageTarget): string =>
    x.foreign
      ? t('set.smokePkgForeign')
      : x.installed === null
        ? t('set.smokePkgMissing')
        : x.installed === bundled || bundled === null
          ? t('set.smokePkgInstalled', { version: x.installed })
          : t('set.smokePkgOld', { version: x.installed, bundled });
  return (
    <Group id="smokepkg" title={t('set.group.smokePkg')}>
      <Row title={t('set.smokePkg')} hint={<Hint text={t('set.smokePkgHint')} />}>
        {done && (
          <span className="saved" role="status">
            ✓ {t('set.smokePkgDone')}
          </span>
        )}
        <button
          type="button"
          className="btn"
          disabled={off || !pkg.targets.some(needs)}
          onClick={() => void install()}
        >
          {pkg.targets.some((x) => needs(x) && x.installed !== null)
            ? t('set.smokePkgUpdate')
            : t('set.smokePkgInstall')}
        </button>
        <button
          type="button"
          className="btn"
          disabled={off || !pkg.targets.some((x) => !x.foreign && x.installed !== null)}
          onClick={() => void remove()}
        >
          {t('set.smokePkgRemove')}
        </button>
      </Row>
      <p className="sheet-note">
        {bundled === null
          ? t('set.smokePkgNotBundled')
          : pkg.targets.length === 0
            ? t('set.smokePkgNoSim')
            : pkg.targets.map((x) => `${t(`set.smokePkg.${x.install}`)}: ${status(x)}`).join(' · ')}
      </p>
    </Group>
  );
}
