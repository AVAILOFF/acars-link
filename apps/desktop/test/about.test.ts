// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppController } from '../src/main/controller.js';
import { legalFile } from '../src/main/legal.js';
import { BASE_SCENARIOS } from '../src/main/scenario-sources.js';
import { SecretStore } from '../src/main/secrets.js';
import { defaultSettings, SettingsStore } from '../src/main/settings.js';
import { MESSAGES } from '../src/renderer/src/i18n.js';
import { LEGAL_DOCS, type LegalDoc } from '../src/shared/api.js';
import { SOURCES, sourceById, sourcesFor } from '../src/shared/sources.js';
import { FakeCipher, FakeTimers, simbriefOk, socketFactory, tempDir } from './support.js';

/** T74: "About", the list of data sources and the licence files. */

const root = resolve(import.meta.dirname, '../../..');

/** First column of every row of the two source tables of THIRD-PARTY-NOTICES.md. */
function noticeRows(): { first: string; row: string }[] {
  const text = readFileSync(join(root, 'THIRD-PARTY-NOTICES.md'), 'utf8').replaceAll('\r\n', '\n');
  const from = text.indexOf('## Bundled in the installer');
  expect(from).toBeGreaterThan(0);
  return text
    .slice(from)
    .split('\n')
    .filter((l) => l.startsWith('| ') && !l.startsWith('| Component') && !l.startsWith('| Service'))
    .map((row) => ({ row, first: row.slice(2).split(' | ')[0] ?? '' }));
}

describe('the list of sources and THIRD-PARTY-NOTICES.md', () => {
  const rows = noticeRows();

  it('every row of the file is in the list, once', () => {
    expect(rows.length).toBeGreaterThan(20);
    for (const { first } of rows) {
      const found = SOURCES.filter((s) => first.startsWith(s.notice));
      expect(
        found.map((s) => s.id),
        `row "${first.slice(0, 50)}"`,
      ).toHaveLength(1);
    }
  });

  it('every source of the list has its row in the file, once', () => {
    for (const s of SOURCES) {
      const found = rows.filter((r) => r.first.startsWith(s.notice));
      expect(found, s.id).toHaveLength(1);
    }
  });

  it('the file marks the rows of the personal build as such, and only those', () => {
    for (const s of SOURCES) {
      const row = rows.find((r) => r.first.startsWith(s.notice))?.row ?? '';
      expect(row.includes('personal build only'), s.id).toBe(s.build === 'personal');
    }
  });

  it('ids are unique, every text is given in both languages', () => {
    expect(new Set(SOURCES.map((s) => s.id)).size).toBe(SOURCES.length);
    for (const s of SOURCES) {
      for (const text of [s.what, s.license]) {
        expect(MESSAGES.en[text], s.id).not.toBe('');
        expect(MESSAGES.ru[text], s.id).not.toBe('');
      }
    }
  });
});

describe('the sources of a build', () => {
  it('the public build has no CAL, eANP and natTrak; the personal one has all', () => {
    const publicIds = sourcesFor('public').map((s) => s.id);
    for (const id of ['eur-cal', 'icao-apac', 'nattrak']) {
      expect(publicIds).not.toContain(id);
      expect(sourcesFor('personal').map((s) => s.id)).toContain(id);
    }
    expect(sourcesFor('personal')).toHaveLength(SOURCES.length);
    expect(publicIds).toHaveLength(SOURCES.length - 3);
  });

  it('the credits the terms require are worded as the sources ask', () => {
    expect(sourceById('osm').credit).toBe('© OpenStreetMap contributors');
    expect(sourceById('vatspy').credit).toBe('VATSpy Data Project, CC BY-SA 4.0');
    expect(sourceById('openflights').credit).toContain('OpenFlights');
    expect(sourceById('openflights').credit).toContain('ODbL');
    expect(sourceById('eclipses').credit).toBe('F. Espenak and J. Meeus, NASA');
    expect(sourceById('usgs').credit).toBe('U.S. Geological Survey');
    expect(() => sourceById('nope')).toThrow();
  });

  it('only https links', () => {
    for (const s of SOURCES) if (s.url !== undefined) expect(s.url).toMatch(/^https:\/\//);
  });

  it('the settings page shows the credits of OSM, VATSpy and OpenFlights', () => {
    const view = readFileSync(join(root, 'apps/desktop/src/renderer/src/SettingsView.tsx'), 'utf8');
    for (const id of ['osm', 'vatspy', 'openflights']) {
      expect(view).toContain(`<SourceCredit id="${id}"`);
    }
  });
});

describe('licence files', () => {
  const packaged = {
    packaged: true,
    resourcesPath: join('C:', 'App', 'resources'),
    desktopDir: '',
  };
  const dev = { packaged: false, resourcesPath: '', desktopDir: join(root, 'apps/desktop') };

  it('installed: next to the application, in resources', () => {
    expect(legalFile('eula', packaged)).toBe(join('C:', 'App', 'resources', 'EULA.txt'));
    expect(legalFile('notices', packaged)).toBe(
      join('C:', 'App', 'resources', 'THIRD-PARTY-NOTICES.md'),
    );
    expect(legalFile('licenses', packaged)).toBe(
      join('C:', 'App', 'resources', 'THIRD-PARTY-LICENSES.txt'),
    );
  });

  it('from the sources: the files of the repository', () => {
    expect(legalFile('eula', dev)).toBe(join(root, 'apps/desktop/build/license.txt'));
    expect(readFileSync(legalFile('eula', dev), 'utf8')).toContain('End User Licence Agreement');
    expect(readFileSync(legalFile('notices', dev), 'utf8')).toContain('Third-party notices');
  });

  it('the installer puts exactly these files into resources', () => {
    const yml = readFileSync(join(root, 'apps/desktop/electron-builder.yml'), 'utf8');
    for (const doc of LEGAL_DOCS) {
      const name = legalFile(doc, packaged).split(/[\\/]/).pop() ?? '';
      expect(yml, doc).toMatch(new RegExp(`to: ${name.replace('.', '\\.')}\\s`));
    }
  });
});

async function controller(open?: (doc: LegalDoc) => Promise<void>) {
  const dir = await tempDir();
  const app = new AppController({
    secrets: new SecretStore(join(dir, 'secrets.json'), new FakeCipher()),
    settings: new SettingsStore(join(dir, 'settings.json'), defaultSettings('en')),
    scenarioSources: BASE_SCENARIOS,
    http: await simbriefOk(),
    createTransport: () => {
      throw new Error('no transport expected');
    },
    createSocket: socketFactory().create,
    timers: new FakeTimers(),
    now: () => 0,
    openRecording: null,
    revealRecordings: async () => {},
    onChange: () => {},
    ...(open === undefined
      ? {}
      : {
          openLegal: open,
          about: () => ({
            version: '1.2.3',
            dev: false,
            electron: '44.10.0',
            chrome: '1',
            variant: 'public' as const,
          }),
        }),
  });
  await app.init();
  return app;
}

describe('About in the controller', () => {
  it('gives the versions and the build it was given', async () => {
    const app = await controller(async () => {});
    expect(app.getAbout()).toEqual({
      version: '1.2.3',
      dev: false,
      electron: '44.10.0',
      chrome: '1',
      variant: 'public',
    });
    expect(app.state().bridge.version).toBeNull();
  });

  it('opens one of the three licence files; anything else is refused', async () => {
    const opened: LegalDoc[] = [];
    const app = await controller(async (d) => {
      opened.push(d);
    });
    for (const doc of LEGAL_DOCS) expect(await app.openLegal(doc)).toBeNull();
    expect(opened).toEqual([...LEGAL_DOCS]);
    for (const bad of ['../secrets.json', '', 7, null, undefined]) {
      await expect(app.openLegal(bad)).rejects.toMatchObject({ code: 'invalid_input' });
    }
    expect(opened).toHaveLength(LEGAL_DOCS.length);
  });

  it('a file that cannot be opened is an error, not a crash', async () => {
    const app = await controller(async () => {
      throw new Error('file not found: EULA.txt');
    });
    await expect(app.openLegal('eula')).rejects.toMatchObject({
      code: 'internal',
      detail: 'file not found: EULA.txt',
    });
    expect(
      await (await controller()).openLegal('eula').catch((e: { code: string }) => e.code),
    ).toBe('internal');
  });
});
