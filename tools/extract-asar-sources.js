// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

// Восстановление исходников RealAcars из source map, встроенного в webpack-бандл.
// Только для справки при чтении (см. CLAUDE.md, инвариант 1: код не копировать).
//
// 1) npx -y @electron/asar extract "%LOCALAPPDATA%\RealAcars\app-<ver>\resources\app.asar" ./asar
// 2) node extract-asar-sources.js ./asar/.webpack/renderer/app_window/index.js ./src_out
//
// Внимание: восстановленный код содержит чужие захардкоженные API-ключи — не коммитить и не публиковать.
const fs = require('fs');
const path = require('path');

const [, , bundlePath, outDir] = process.argv;
if (!bundlePath || !outDir) {
  console.error('usage: node extract-asar-sources.js <bundle.js> <outDir>');
  process.exit(1);
}

const js = fs.readFileSync(bundlePath, 'utf8');
const m = js.match(/sourceMappingURL=data:application\/json;charset=utf-8;base64,([A-Za-z0-9+/=]+)\s*$/);
if (!m) {
  console.error('inline source map not found');
  process.exit(1);
}
const map = JSON.parse(Buffer.from(m[1], 'base64').toString());

let written = 0;
map.sources.forEach((src, i) => {
  if (/node_modules|webpack\/(runtime|bootstrap)|external /.test(src)) return;
  const content = map.sourcesContent && map.sourcesContent[i];
  if (!content) return;
  const rel = src.replace(/^webpack:\/\/[^/]*\//, '').replace(/[?:*"<>|]/g, '_');
  const out = path.join(outDir, rel);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, content);
  written++;
});
console.log(`sources: ${map.sources.length}, written: ${written}`);
