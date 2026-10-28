// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

// Licence and copyright header of every source file (T62). Pure functions; the CLI is check.mjs.

export const LICENSE_ID = 'LicenseRef-ACARS-Link-Proprietary';
export const COPYRIGHT = 'Copyright (c) 2026 AVAILOFF';

/** Source extensions that carry a header → line comment marker. */
const COMMENT = { ts: '//', tsx: '//', js: '//', mjs: '//', cjs: '//', cs: '//', py: '#' };

/**
 * Files whose header differs from ours: data under someone else's licence. OpenFlights data is
 * ODbL 1.0 and a derived table stays under the ODbL (THIRD-PARTY-NOTICES.md).
 */
const OVERRIDES = {
  'packages/core/src/ext/openflights.ts': [
    'SPDX-License-Identifier: ODbL-1.0',
    'Data: OpenFlights.org, Open Database License 1.0; see THIRD-PARTY-NOTICES.md',
  ],
};

/** Header lines for a repo-relative path, or null when the file type carries none. */
export function expectedHeader(path) {
  const ext = path.slice(path.lastIndexOf('.') + 1);
  const mark = COMMENT[ext];
  if (mark === undefined) return null;
  const lines = OVERRIDES[path] ?? [`SPDX-License-Identifier: ${LICENSE_ID}`, COPYRIGHT];
  return lines.map((l) => `${mark} ${l}`);
}

function split(text) {
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(nl);
  const shebang = lines[0]?.startsWith('#!') ? 1 : 0;
  return { nl, lines, shebang };
}

/** True when the file starts (after a shebang) with exactly its expected header. */
export function hasHeader(path, text) {
  const header = expectedHeader(path);
  if (header === null) return true;
  const { lines, shebang } = split(text);
  return header.every((h, i) => lines[shebang + i] === h);
}

/**
 * Text with the header added after a possible shebang. Any existing SPDX/copyright lines at that
 * place are replaced, so running it twice changes nothing.
 */
export function withHeader(path, text) {
  const header = expectedHeader(path);
  if (header === null || hasHeader(path, text)) return text;
  const { nl, lines, shebang } = split(text);
  let rest = shebang;
  const mark = header[0].slice(0, header[0].indexOf(' '));
  while (
    rest < lines.length &&
    /^(SPDX-License-Identifier:|Copyright \(c\)|Data: )/.test(
      lines[rest].startsWith(`${mark} `) ? lines[rest].slice(mark.length + 1) : '',
    )
  ) {
    rest += 1;
  }
  const body = lines.slice(rest);
  const gap = body[0] === '' ? [] : [''];
  return [...lines.slice(0, shebang), ...header, ...gap, ...body].join(nl);
}
