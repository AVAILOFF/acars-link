// Manual Hoppie check (T09 «Проверка человеком»): sends one formatted telex from a station
// callsign to an aircraft, then polls the station for replies for a while.
//
//   $env:HOPPIE_LOGON = '<your logon code>'      # PowerShell; never pass it as an argument
//   pnpm hoppie:telex --to DLH4 [--from OPSDLH4] [--text "..."] [--profile b77x] [--listen 180]
//   pnpm hoppie:telex --ping "DLH4 DLH4A"      # which of these callsigns Hoppie sees online
//
// The logon code is read from the environment only and is never printed.
import { parseArgs } from 'node:util';
import { BUILTIN_PROFILES, createRng, DEFAULT_PROFILE, formatMessage } from '@acars/core';
import {
  buildRequest,
  fetchHttpClient,
  HOPPIE_ENDPOINT,
  HoppieTransport,
  isValidCallsign,
  parsePing,
  parseResponse,
  SERVER_CALLSIGN,
} from '@acars/transport';

const { values } = parseArgs({
  options: {
    to: { type: 'string' },
    from: { type: 'string' },
    text: { type: 'string' },
    profile: { type: 'string', default: DEFAULT_PROFILE.id },
    listen: { type: 'string', default: '180' },
    ping: { type: 'string' },
  },
});

const logon = process.env.HOPPIE_LOGON ?? '';
if (logon.trim() === '') fail('set HOPPIE_LOGON in the environment (not on the command line)');
if (values.ping !== undefined) await ping(values.ping);
const to = (values.to ?? '').toUpperCase();
if (to === '') fail('--to <aircraft callsign> is required');
const from = (values.from ?? `OPS${to}`).toUpperCase();
const listenMs = Number(values.listen) * 1000;
if (!Number.isFinite(listenMs) || listenMs < 0) fail('--listen must be seconds ≥ 0');
const profile = [DEFAULT_PROFILE, ...BUILTIN_PROFILES].find((p) => p.id === values.profile);
if (profile === undefined) fail(`unknown --profile ${values.profile}`);

const text =
  values.text ??
  `ACARS LINK TEST\n---\nTELEX FROM ${from} TO ${to}\nIF YOU READ THIS, T09 WORKS.\nREPLY WITH ANY TELEX TO ${from}\n...\nEND`;
const message = formatMessage(text, profile);
console.log(`profile ${profile.id}, ${message.lines.length} lines:\n${message.text}\n`);

const clock = { now: () => Date.now() };
const transport = new HoppieTransport({
  logon,
  http: fetchHttpClient(),
  clock,
  rng: createRng(Date.now() >>> 0),
});
const id = transport.send({ from, to, message });
let sentAt = null;
let done = false;

const timer = setInterval(() => {
  transport.tick();
  for (const e of transport.takeEvents()) {
    const at = new Date(e.t).toISOString().slice(11, 19);
    if (e.type === 'SENT') {
      sentAt = e.t;
      transport.expectReply(Math.min(listenMs, 180_000));
      console.log(`${at} SENT ${e.id} ${from} → ${to}; polling ${from} for ${listenMs / 1000} s`);
    } else if (e.type === 'INBOUND') {
      const m = e.message;
      console.log(`${at} INBOUND ${m.type} from ${m.from}:\n${m.packet}\n`);
    } else if (e.type === 'SEND_RETRY') {
      console.log(
        `${at} RETRY #${e.attempt} (${e.reason}), next at ${new Date(e.nextAt).toISOString().slice(11, 19)}`,
      );
    } else if (e.type === 'SEND_FAILED') {
      console.log(`${at} FAILED ${e.id}: ${e.reason}`);
      done = true;
    } else {
      console.log(`${at} STATUS ${e.status}${e.reason === undefined ? '' : ` (${e.reason})`}`);
      if (e.status === 'halted') done = true;
    }
  }
  if (sentAt !== null && clock.now() - sentAt >= listenMs) done = true;
  if (done) {
    clearInterval(timer);
    void transport.idle().then(() => {
      console.log(transport.pending === 0 && sentAt !== null ? 'done' : `not sent (${id})`);
      process.exitCode = sentAt === null ? 1 : 0;
    });
  }
}, 1_000);

/** One ping (does not lock callsigns or fetch messages), then exit. */
async function ping(list) {
  const callsigns = list.toUpperCase().split(/\s+/).filter(Boolean);
  const bad = callsigns.filter((cs) => !isValidCallsign(cs));
  if (callsigns.length === 0 || bad.length > 0) fail(`--ping needs callsigns A-Z0-9: ${bad}`);
  const req = buildRequest(
    HOPPIE_ENDPOINT,
    { logon, from: 'OPSPING', to: SERVER_CALLSIGN, type: 'ping', packet: callsigns.join(' ') },
    15_000,
  );
  const res = await fetchHttpClient().request(req);
  const r = parseResponse(res.body);
  if (!r.ok) fail(`error: ${r.reason}`);
  const online = parsePing(r.content);
  for (const cs of callsigns) console.log(`${cs}: ${online.includes(cs) ? 'ONLINE' : 'not seen'}`);
  process.exit(0);
}

function fail(msg) {
  console.error(msg);
  process.exit(2);
}
