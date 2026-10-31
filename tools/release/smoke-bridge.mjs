// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

// Smoke test of a PUBLISHED bridge (T82): the publish is trimmed, and `pnpm bridge:test` runs the
// untrimmed build, so this starts the real exe from the folder: --source fake (hello v2, status,
// telemetry, ack of `ping`), --replay of reference/telemetry.sample.json (JSON read back), a second
// bridge on the same port (exit code 4), --parent-pid (exit 0 when the parent is gone). Every bridge
// it starts it stops by its own PID. Part of tools/release/build.mjs.
//   node tools/release/smoke-bridge.mjs <bridge folder>
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const dir = process.argv[2];
if (dir === undefined) {
  console.error('usage: node tools/release/smoke-bridge.mjs <bridge folder>');
  process.exit(2);
}
const exe = join(dir, 'acars-msfs-bridge.exe');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const exited = (p, ms) =>
  Promise.race([
    new Promise((r) => p.on('exit', (code) => r(code))),
    wait(ms).then(() => 'timeout'),
  ]);
const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: ${detail}`}`);
  if (!ok) failures.push(name);
};

const port = await new Promise((r) => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => r(port));
  });
});
const started = [];
const start = (args) => {
  const p = spawn(exe, ['--port', String(port), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  p.log = '';
  p.stdout.on('data', (d) => (p.log += d));
  p.stderr.on('data', (d) => (p.log += d));
  started.push(p);
  return p;
};

async function frames(label) {
  let ws;
  for (let i = 0; i < 40 && ws === undefined; i++) {
    await wait(250);
    const s = new WebSocket(`ws://127.0.0.1:${port}/?protocol=2`);
    ws = await new Promise((r) => {
      s.onopen = () => r(s);
      s.onerror = () => r(undefined);
    });
  }
  if (ws === undefined) {
    check(`${label}: connect`, false, `nothing on port ${port}`);
    return [];
  }
  const got = [];
  ws.onmessage = (e) => got.push(JSON.parse(e.data));
  ws.send(JSON.stringify({ type: 'command', id: 's1', command: 'ping' }));
  for (let i = 0; i < 40 && !got.some((f) => f.type === 'telemetry'); i++) await wait(100);
  ws.close();
  const hello = got[0];
  check(
    `${label}: hello v2`,
    hello?.type === 'hello' && hello.protocol === 2,
    JSON.stringify(hello),
  );
  const st = got.find((f) => f.type === 'status' && f.sim === 'connected');
  check(`${label}: status connected`, st !== undefined, JSON.stringify(got.map((f) => f.type)));
  const ack = got.find((f) => f.type === 'ack');
  check(`${label}: ack of ping`, ack?.id === 's1' && ack.ok === true, JSON.stringify(ack));
  const t = got.find((f) => f.type === 'telemetry');
  check(`${label}: telemetry v1`, t?.data?.v === 1, JSON.stringify(t));
  return got;
}

const tmp = mkdtempSync(join(tmpdir(), 'smoke-bridge-'));
try {
  const fake = start(['--source', 'fake']);
  await frames('fake');
  const second = start(['--source', 'fake']);
  const code = await exited(second, 15_000);
  check('second bridge on the same port: exit 4', code === 4, `exit ${code}`);
  fake.kill();
  await exited(fake, 5_000);

  const sample = JSON.parse(readFileSync(join(root, 'reference/telemetry.sample.json'), 'utf8'));
  const replay = join(tmp, 'replay.jsonl');
  writeFileSync(replay, `${JSON.stringify(sample)}\n`);
  const rp = start(['--source', 'fake', '--replay', replay]);
  const got = await frames('replay');
  const t = got.find((f) => f.type === 'telemetry');
  check(
    'replay: snapshot read back',
    t?.data?.aircraftTitle === sample.aircraftTitle,
    `${t?.data?.aircraftTitle} ≠ ${sample.aircraftTitle}`,
  );
  rp.kill();
  await exited(rp, 5_000);

  const parent = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1500)']);
  const child = start(['--source', 'fake', '--parent-pid', String(parent.pid)]);
  const childCode = await exited(child, 15_000);
  check('--parent-pid: exit 0 after the parent', childCode === 0, `exit ${childCode}`);
} finally {
  for (const p of started) if (p.exitCode === null) p.kill();
  rmSync(tmp, { recursive: true, force: true });
}
if (failures.length > 0) {
  console.error(`bridge smoke test: ${failures.length} failed (${exe})`);
  process.exit(1);
}
console.log(`bridge smoke test: ${exe} ok`);
