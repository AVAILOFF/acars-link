// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

/**
 * Machine translation of the UI (T86, T87): `pnpm i18n translate --lang de,fr,es,ja`.
 *
 * Sources (English): `messages-en.ts`, `help-en.ts`, the scenario files. Outputs: `messages-<lang>.ts`,
 * `help-<lang>.ts`, `packages/scenarios/locales/<lang>.yaml`. Engines: DeepL API (key only from the
 * environment or the git-ignored `.env.local`, `DEEPL_AUTH_KEY`; never printed) with a glossary from `docs/glossary-i18n.md`, and a local
 * Ollama model as the fallback (`OLLAMA_MODEL`, `--engine ollama`).
 *
 * What must not change is closed off from the engine: `{placeholders}`, the terms of the glossary's
 * "not translated" list, words in capitals (`REQ WX`, `EDDF`), paths and file names. A label quoted in the
 * help (“Advanced settings”) that is a UI string is replaced by that string of the target language.
 *
 * Memory: `tools/i18n/memory/<lang>.json` — the prepared English text each translation was made from;
 * only new or changed texts are sent. A translation edited by hand in an output file is kept (`manual`).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const UI = join(ROOT, 'apps/desktop/src/renderer/src');
const SCN = join(ROOT, 'packages/scenarios');
const MEMORY = join(ROOT, 'tools/i18n/memory');
const YAML = createRequire(join(SCN, 'package.json'))('yaml');

/** Target languages: DeepL code, quotes for UI labels in the help. */
const TARGETS = {
  de: { deepl: 'DE', name: 'German', open: '„', close: '“' },
  fr: { deepl: 'FR', name: 'French (France)', open: '« ', close: ' »' },
  es: { deepl: 'ES', name: 'Spanish (Spain)', open: '«', close: '»' },
  ja: { deepl: 'JA', name: 'Japanese', open: '「', close: '」' },
};

const CONTEXT =
  'User interface of ACARS Link, a desktop app for flight simulator pilots (MSFS, X-Plane) that sends ' +
  'realistic airline ACARS messages. Readers are hobby pilots. Keep the tone short and practical.';

const HELP_TEXT = `Usage: pnpm i18n translate --lang de,fr,es [options]
       pnpm i18n status [--lang …]

  --lang <list>       target languages (${Object.keys(TARGETS).join(', ')})
  --engine <name>     deepl (default when DEEPL_AUTH_KEY is set) | ollama
  --model <name>      Ollama model (default: OLLAMA_MODEL or gemma3:12b)
  --only <list>       msg, help, scn (default: all)
  --no-fallback       do not switch to Ollama when the DeepL quota is used up
  --force             translate again what did not change (hand edits are still kept)
  --dry               count what would be sent, send nothing
  --show <text>       with --dry: print the prepared texts whose id contains <text>
`;

// ---------------------------------------------------------------------------------------------
// Glossary (docs/glossary-i18n.md)

function readGlossary() {
  const md = readFileSync(join(ROOT, 'docs/glossary-i18n.md'), 'utf8');
  const section = (title) => {
    const start = md.indexOf(`## ${title}`);
    if (start < 0) throw new Error(`docs/glossary-i18n.md: no section "${title}"`);
    const end = md.indexOf('\n## ', start + 3);
    return md.slice(start, end < 0 ? md.length : end);
  };
  const keep = [...section('Do not translate').matchAll(/`([^`]+)`/g)]
    .map((m) => m[1])
    .filter((t) => !t.includes('{') && !t.includes('%') && !t.includes('…'));
  const rows = section('Terms')
    .split('\n')
    .filter((l) => l.startsWith('|') && !l.startsWith('|---') && !l.startsWith('| EN'));
  const terms = rows.map((l) => {
    const [en, de, fr, es, ja] = l
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    return { en, de, fr, es, ja };
  });
  return { keep: [...new Set(keep)].sort((a, b) => b.length - a.length), terms };
}

// ---------------------------------------------------------------------------------------------
// Sources

async function importTs(file) {
  return import(pathToFileURL(file).href);
}

/** One text to translate: `id` is stable across runs; `ctx` helps the engine. */
async function sources(only) {
  const units = [];
  if (only.has('msg')) {
    const { en } = await importTs(join(UI, 'messages-en.ts'));
    for (const [k, v] of Object.entries(en)) units.push({ id: `msg:${k}`, kind: 'msg', text: v });
  }
  if (only.has('help')) {
    const { en } = await importTs(join(UI, 'help-en.ts'));
    walkHelp(en, (id, text) => units.push({ id: `help:${id}`, kind: 'help', text }));
  }
  if (only.has('scn')) {
    for (const s of await loadScenarioList()) {
      walkScenario(s, (id, text) => units.push({ id: `scn:${id}`, kind: 'scn', text }));
    }
  }
  return units;
}

function walkHelp(sections, f) {
  for (const s of sections) {
    f(`${s.id}.title`, s.title);
    for (const i of s.items) {
      f(`${s.id}.${i.id}.q`, i.q);
      for (const [n, b] of i.a.entries()) {
        if (typeof b === 'string') f(`${s.id}.${i.id}.a${n}`, b);
        else if ('list' in b) {
          for (const [m, x] of b.list.entries()) f(`${s.id}.${i.id}.a${n}.${m}`, x);
        } else f(`${s.id}.${i.id}.a${n}.link`, b.link);
      }
    }
  }
}

/** The help of a language from translations by id (the English structure, hrefs as they are). */
function buildHelp(sections, tr) {
  return sections.map((s) => ({
    id: s.id,
    title: tr(`${s.id}.title`),
    items: s.items.map((i) => ({
      id: i.id,
      q: tr(`${s.id}.${i.id}.q`),
      a: i.a.map((b, n) => {
        if (typeof b === 'string') return tr(`${s.id}.${i.id}.a${n}`);
        if ('list' in b) {
          return {
            list: b.list.map((_, m) => tr(`${s.id}.${i.id}.a${n}.${m}`)),
            ...(b.ordered === undefined ? {} : { ordered: b.ordered }),
          };
        }
        return { link: tr(`${s.id}.${i.id}.a${n}.link`), href: b.href };
      }),
    })),
  }));
}

async function loadScenarioList() {
  const { loadScenarios } = await importTs(join(SCN, 'src/index.ts'));
  const files = [
    'base',
    'commands',
    'external',
    'irregular',
    'sim',
    'cargo',
    'charter',
    'ferry',
    'bizav',
  ].flatMap((d) =>
    readdirSync(join(SCN, d))
      .filter((f) => f.endsWith('.yaml'))
      .sort()
      .map((f) => ({ file: `${d}/${f}`, source: readFileSync(join(SCN, d, f), 'utf8') })),
  );
  return loadScenarios(files);
}

function walkScenario(s, f) {
  f(`${s.id}.title`, s.texts.title.en);
  if (s.texts.description !== null) f(`${s.id}.description`, s.texts.description.en);
  if (s.texts.hint !== null) f(`${s.id}.hint`, s.texts.hint.en);
  for (const step of s.steps) {
    if (step.kind === 'send' && step.hint !== null)
      f(`${s.id}.steps.${step.id}.hint`, step.hint.en);
    if (step.kind === 'wait_reply' && step.hints !== null) {
      for (const [o, h] of Object.entries(step.hints)) {
        f(`${s.id}.steps.${step.id}.reply_hints.${o}`, h.en);
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Existing outputs (hand edits are kept)

async function existing(lang) {
  const out = new Map();
  const msg = join(UI, `messages-${lang}.ts`);
  if (existsSync(msg)) {
    const mod = await importTs(msg);
    for (const [k, v] of Object.entries(mod[lang] ?? {})) out.set(`msg:${k}`, v);
  }
  const help = join(UI, `help-${lang}.ts`);
  if (existsSync(help)) {
    const mod = await importTs(help);
    walkHelp(mod[lang] ?? [], (id, text) => out.set(`help:${id}`, text));
  }
  const loc = join(SCN, 'locales', `${lang}.yaml`);
  if (existsSync(loc)) {
    const data = YAML.parse(readFileSync(loc, 'utf8')) ?? {};
    for (const [sid, t] of Object.entries(data)) {
      for (const k of ['title', 'description', 'hint'])
        if (t[k] !== undefined) out.set(`scn:${sid}.${k}`, t[k]);
      for (const [step, v] of Object.entries(t.steps ?? {})) {
        if (v.hint !== undefined) out.set(`scn:${sid}.steps.${step}.hint`, v.hint);
        for (const [o, h] of Object.entries(v.reply_hints ?? {})) {
          out.set(`scn:${sid}.steps.${step}.reply_hints.${o}`, h);
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Protection: <x>…</x> spans the engine must not touch

const xml = (s) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const unxml = (s) => s.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function protector(glossary) {
  const terms = glossary.keep.map(escapeRe).join('|');
  const caps = String.raw`\b[A-Z0-9][A-Z0-9/-]*[A-Z][A-Z0-9/-]*\b|\b[A-Z][A-Z0-9/-]*[0-9][A-Z0-9/-]*\b`;
  const parts = [
    String.raw`\{\w+\}`, // placeholders
    String.raw`%[A-Z]+%[^\s,;)'"]*`, // %APPDATA%\…
    String.raw`https?://\S+`,
    String.raw`[\w.-]+\.(?:jsonl?|zip|log|exe|yaml|txt|sha256)\b`,
    `(?<![\\w-])(?:${terms})(?![\\w-])`,
    `(?:${caps})(?:[ ](?:${caps}))*`,
  ];
  const re = new RegExp(parts.join('|'), 'g');
  /** `labels`: quoted UI labels already replaced by the caller. Returns the engine text and the spans. */
  return (text, labels = []) => {
    const spans = [];
    let out = '';
    let at = 0;
    const segments = [];
    // Quoted labels first: they are whole spans.
    let rest = text;
    for (const l of labels)
      rest = rest.split(l.from).join(`\uE000${segments.push(l.to) - 1}\uE000`);
    for (const m of rest.matchAll(re)) {
      out += plain(rest.slice(at, m.index));
      spans.push(m[0]);
      out += `<x>${xml(m[0])}</x>`;
      at = m.index + m[0].length;
    }
    out += plain(rest.slice(at));
    return { text: out, spans };
    function plain(s) {
      return s
        .split(/\uE000(\d+)\uE000/)
        .map((p, i) => {
          if (i % 2 === 0) return xml(p);
          spans.push(segments[Number(p)]);
          return `<x>${xml(segments[Number(p)])}</x>`;
        })
        .join('');
    }
  };
}

/** The engine's answer back to plain text; null when a span got lost or changed. */
function restore(answer, spans) {
  // Every protected text is there and nothing else; a repeated term may be said once ("default DIVERT").
  const got = new Set([...answer.matchAll(/<x>(.*?)<\/x>/gs)].map((m) => unxml(m[1])));
  const want = new Set(spans);
  if (got.size !== want.size || ![...want].every((s) => got.has(s))) return null;
  const text = unxml(answer.replace(/<x>(.*?)<\/x>/gs, (_, s) => `\uE001${s}\uE001`)).replaceAll(
    '\uE001',
    '',
  );
  if (/<\/?x>/.test(text)) return null;
  return text.trim();
}

// ---------------------------------------------------------------------------------------------
// Engines

class QuotaError extends Error {}

function deepl(key) {
  const base = key.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
  const call = async (path, init) => {
    const r = await fetch(`${base}${path}`, {
      ...init,
      headers: { Authorization: `DeepL-Auth-Key ${key}`, 'Content-Type': 'application/json' },
    });
    if (r.status === 456) throw new QuotaError('DeepL: quota exceeded');
    if (!r.ok) throw new Error(`DeepL ${path}: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
    return r.status === 204 ? null : r.json();
  };
  let quality = true;
  return {
    name: 'deepl',
    async usage() {
      return call('/v2/usage', { method: 'GET' });
    },
    async glossary(lang, entries) {
      if (entries.length === 0) return null;
      const tsv = entries.map(([a, b]) => `${a}\t${b}`).join('\n');
      const g = await call('/v2/glossaries', {
        method: 'POST',
        body: JSON.stringify({
          name: `acars-link-${lang}`,
          source_lang: 'en',
          target_lang: lang,
          entries: tsv,
          entries_format: 'tsv',
        }),
      });
      return g.glossary_id;
    },
    async dropGlossary(id) {
      if (id !== null) await call(`/v2/glossaries/${id}`, { method: 'DELETE' });
    },
    /** `plain`: buttons and menu items — in Japanese the dictionary form, not the polite request (T87). */
    async translate(texts, lang, glossaryId, context, plain = false) {
      const body = {
        text: texts,
        source_lang: 'EN',
        target_lang: TARGETS[lang].deepl,
        formality: plain && lang === 'ja' ? 'prefer_less' : 'prefer_more',
        tag_handling: 'xml',
        ignore_tags: ['x'],
        split_sentences: 'nonewlines',
        preserve_formatting: true,
        context,
        ...(glossaryId === null ? {} : { glossary_id: glossaryId }),
      };
      try {
        if (quality) {
          const r = await call('/v2/translate', {
            method: 'POST',
            body: JSON.stringify({ ...body, model_type: 'prefer_quality_optimized' }),
          });
          return r.translations.map((t) => t.text);
        }
      } catch (e) {
        if (e instanceof QuotaError || /Tag handling/.test(e.message)) throw e;
        quality = false; // the plan or the language may not have the newer model
        console.warn(
          `  DeepL: quality_optimized not available, standard model (${e.message.slice(0, 80)})`,
        );
      }
      const r = await call('/v2/translate', { method: 'POST', body: JSON.stringify(body) });
      return r.translations.map((t) => t.text);
    },
  };
}

function ollama(model) {
  const url = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';
  return {
    name: `ollama:${model}`,
    async check() {
      const r = await fetch(`${url}/api/tags`);
      const { models } = await r.json();
      if (!models.some((m) => m.name === model || m.name === `${model}:latest`)) {
        throw new Error(`Ollama: model ${model} is not pulled (ollama pull ${model})`);
      }
    },
    async translateOne(text, lang, terms, context) {
      const glossary = terms.map(([a, b]) => `- ${a} → ${b}`).join('\n');
      const system = [
        `You are a professional software localizer. Translate from English into ${TARGETS[lang].name}.`,
        context,
        'Use the polite form (German Sie, French vous, Spanish usted, Japanese です・ます).',
        'Keep every <x>…</x> element exactly as it is, in place, unchanged: tags and content.',
        'Keep &amp; &lt; &gt; entities as they are. Keep the meaning, no additions, no explanations.',
        'Answer with the translation only.',
        glossary === '' ? '' : `Use these terms:\n${glossary}`,
      ].join('\n');
      const r = await fetch(`${url}/api/chat`, {
        method: 'POST',
        body: JSON.stringify({
          model,
          stream: false,
          options: { temperature: 0 },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: text },
          ],
        }),
      });
      if (!r.ok) throw new Error(`Ollama: HTTP ${r.status}`);
      const j = await r.json();
      return j.message.content.replace(/<think>.*?<\/think>/gs, '').trim();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Writers

function header(lang, what) {
  return `// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

/**
 * ${what} in ${TARGETS[lang].name} (T86/T87): machine translation by \`pnpm i18n translate\` (tools/i18n,
 * glossary docs/glossary-i18n.md), not yet checked by a native speaker. Hand edits are kept on the next run.
 */
`;
}

function writeMessages(lang, keys, tr) {
  const entries = keys
    .filter((k) => tr(`msg:${k}`) !== undefined)
    .map((k) => `  ${JSON.stringify(k)}: ${JSON.stringify(tr(`msg:${k}`))},`);
  const file = join(UI, `messages-${lang}.ts`);
  writeFileSync(
    file,
    `${header(lang, 'UI strings')}
import type { MessageKey } from './messages-en.js';

export const ${lang}: Readonly<Partial<Record<MessageKey, string>>> = {
${entries.join('\n')}
};
`,
  );
  return file;
}

function writeHelp(lang, sections) {
  const file = join(UI, `help-${lang}.ts`);
  writeFileSync(
    file,
    `${header(lang, 'The "Help" tab')}
import type { HelpSection } from './help.js';

export const ${lang}: readonly HelpSection[] = ${JSON.stringify(sections, null, 2)};
`,
  );
  return file;
}

function writeLocale(lang, scenarios, tr) {
  const data = {};
  for (const s of [...scenarios].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const e = {};
    const put = (o, k, id) => {
      const v = tr(`scn:${s.id}.${id}`);
      if (v !== undefined) o[k] = v;
    };
    put(e, 'title', 'title');
    put(e, 'description', 'description');
    put(e, 'hint', 'hint');
    const steps = {};
    for (const step of s.steps) {
      if (step.kind === 'send' && step.hint !== null) {
        const v = tr(`scn:${s.id}.steps.${step.id}.hint`);
        if (v !== undefined) steps[step.id] = { ...steps[step.id], hint: v };
      }
      if (step.kind === 'wait_reply' && step.hints !== null) {
        const rh = {};
        for (const o of Object.keys(step.hints)) {
          const v = tr(`scn:${s.id}.steps.${step.id}.reply_hints.${o}`);
          if (v !== undefined) rh[o] = v;
        }
        // A reply's hints are all or nothing (loadScenarios checks one line per option).
        if (Object.keys(rh).length === Object.keys(step.hints).length)
          steps[step.id] = { ...steps[step.id], reply_hints: rh };
      }
    }
    if (Object.keys(steps).length > 0) e.steps = steps;
    if (Object.keys(e).length > 0) data[s.id] = e;
  }
  const file = join(SCN, 'locales', `${lang}.yaml`);
  writeFileSync(
    file,
    `# ${TARGETS[lang].name} UI texts of the scenarios (T86/T87): machine translation by \`pnpm i18n translate\`
# (tools/i18n), not yet checked by a native speaker. Hand edits are kept on the next run. Telexes are never translated.
${YAML.stringify(data, { lineWidth: 0 })}`,
  );
  return file;
}

// ---------------------------------------------------------------------------------------------

async function run() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      lang: { type: 'string' },
      engine: { type: 'string' },
      model: { type: 'string' },
      only: { type: 'string' },
      'no-fallback': { type: 'boolean' },
      dry: { type: 'boolean' },
      show: { type: 'string' },
      force: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  const cmd = positionals[0];
  if (values.help || (cmd !== 'translate' && cmd !== 'status')) {
    console.log(HELP_TEXT);
    process.exit(values.help ? 0 : 2);
  }
  const langs = (values.lang ?? Object.keys(TARGETS).join(',')).split(',').map((l) => l.trim());
  for (const l of langs) if (!(l in TARGETS)) throw new Error(`unknown language ${l}`);
  const only = new Set((values.only ?? 'msg,help,scn').split(','));
  // Help labels need the UI strings: messages are read even with --only help.
  const units = await sources(new Set([...only, 'msg']));
  const glossary = readGlossary();
  const protect = protector(glossary);
  const { en: messagesEn } = await importTs(join(UI, 'messages-en.ts'));
  const { en: helpEn } = await importTs(join(UI, 'help-en.ts'));
  const scenarios = only.has('scn') ? await loadScenarioList() : [];

  if (cmd === 'status') {
    for (const lang of langs) {
      const have = await existing(lang);
      const by = (k) => units.filter((u) => u.kind === k);
      const line = ['msg', 'help', 'scn']
        .map((k) => `${k} ${by(k).filter((u) => have.has(u.id)).length}/${by(k).length}`)
        .join(', ');
      console.log(`${lang}: ${line}`);
    }
    return;
  }

  const key = process.env.DEEPL_AUTH_KEY ?? envFile('DEEPL_AUTH_KEY');
  const engineName = values.engine ?? (key ? 'deepl' : 'ollama');
  const model = values.model ?? process.env.OLLAMA_MODEL ?? 'gemma3:12b';
  let primary = engineName === 'deepl' ? (key ? deepl(key) : null) : ollama(model);
  if (primary === null) throw new Error('DEEPL_AUTH_KEY is not set (or use --engine ollama)');
  const fallback = engineName === 'deepl' && !values['no-fallback'] ? ollama(model) : null;

  if (primary.name === 'deepl' && !values.dry) {
    const u = await primary.usage();
    console.log(`DeepL usage: ${u.character_count} / ${u.character_limit} characters this period`);
  }

  for (const lang of langs) {
    const memFile = join(MEMORY, `${lang}.json`);
    const memory = existsSync(memFile) ? JSON.parse(readFileSync(memFile, 'utf8')) : {};
    const have = await existing(lang);
    const terms = glossary.terms.filter((t) => t[lang]);
    const termPairs = terms.flatMap((t) => {
      const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
      return [
        [t.en, t[lang]],
        [cap(t.en), lang === 'ja' ? t[lang] : cap(t[lang])],
      ];
    });
    const out = new Map();
    /** The translated UI string of an English label, for the help quotes. */
    const labelFor = new Map();
    for (const [k, v] of Object.entries(messagesEn)) if (!labelFor.has(v)) labelFor.set(v, k);

    const todo = [];
    const stats = { cached: 0, manual: 0, sent: 0, chars: 0, failed: [] };
    /** `quoted`: only the texts with (true) or without (false) a “quoted label”; undefined = all. */
    const plan = (kinds, quoted) => {
      const pick = (x) =>
        kinds.includes(x.kind) &&
        only.has(x.kind) &&
        (quoted === undefined || x.text.includes('“') === quoted);
      for (const u of units.filter(pick)) {
        const labels = [];
        if (u.kind !== 'scn') {
          for (const m of u.text.matchAll(/“([^”]+)”/g)) {
            const k = labelFor.get(m[1]);
            const tr = k === undefined ? undefined : (out.get(`msg:${k}`) ?? have.get(`msg:${k}`));
            if (tr !== undefined)
              labels.push({ from: m[0], to: `${TARGETS[lang].open}${tr}${TARGETS[lang].close}` });
          }
        }
        const prepared = protect(u.text, labels);
        const mem = memory[u.id];
        const current = have.get(u.id);
        if (mem !== undefined && current !== undefined && current !== mem.out) {
          memory[u.id] = { ...mem, out: current, engine: 'manual' }; // edited by hand: keep
          out.set(u.id, current);
          stats.manual++;
        } else if (
          !values.force &&
          mem !== undefined &&
          mem.src === prepared.text &&
          current !== undefined
        ) {
          out.set(u.id, current);
          stats.cached++;
        } else {
          todo.push({ u, prepared });
        }
      }
    };

    const send = async (batch) => {
      if (values.dry) {
        for (const t of batch) {
          stats.chars += t.prepared.text.length;
          if (values.show !== undefined && t.u.id.includes(values.show))
            console.log(`${t.u.id}
  ${t.prepared.text}`);
        }
        return;
      }
      // One request per group (a key prefix, a help section, a scenario): the group's English texts go
      // along as context (not billed), so short labels get the meaning of their neighbours.
      // Short UI strings without sentence punctuation are buttons, tabs and menu items: their own group.
      const isLabel = (u) => u.kind === 'msg' && u.text.length <= 40 && !/[.?!:;,]/.test(u.text);
      const groups = Object.groupBy(
        batch,
        (t) => `${t.u.id.split('.')[0]}${isLabel(t.u) ? '+label' : ''}`,
      );
      for (const list of Object.values(groups)) {
        const kind = list[0].u.kind;
        const label = isLabel(list[0].u);
        const group = list[0].u.id.split('.')[0];
        const related = units
          .filter((u) => u.id.split('.')[0] === group)
          .map((u) => u.text)
          .join(' | ')
          .slice(0, 2500);
        const about = label
          ? 'These are button, tab and menu labels. Translate them as software UI labels: infinitive or noun ' +
            'form (German "Flug starten", French "Démarrer le vol", Spanish "Iniciar el vuelo", Japanese "フライトを開始"), never a polite imperative sentence.'
          : kind === 'msg'
            ? 'These are short UI labels, buttons and status texts of one screen area.'
            : kind === 'help'
              ? 'This is a section of the built-in help manual.'
              : 'These explain one airline message scenario to the pilot (who sent it, what it means, what to answer).';
        // DeepL reads the context as XML too (tag_handling).
        const context = xml(`${CONTEXT} ${about} Texts of this group: ${related}`);
        for (let i = 0; i < list.length; i += 40) {
          const chunk = list.slice(i, i + 40);
          let answers = null;
          if (primary.name === 'deepl') {
            try {
              glossaryId ??= await primary.glossary(lang, termPairs);
              answers = await primary.translate(
                chunk.map((t) => t.prepared.text),
                lang,
                glossaryId,
                context,
                label,
              );
              stats.chars += chunk.reduce((n, t) => n + t.prepared.text.length, 0);
            } catch (e) {
              if (!(e instanceof QuotaError) || fallback === null) throw e;
              console.warn(`  ${e.message}: the rest goes to ${fallback.name}`);
              await fallback.check();
              primary = fallback;
            }
          }
          for (const [n, t] of chunk.entries()) {
            let text = answers === null ? null : restore(answers[n], t.prepared.spans);
            let engine = primary.name;
            if (text === null && primary.name === 'deepl') {
              // Alone, without context; then sentence by sentence (DeepL sometimes drops a part).
              const one = async (x) =>
                (await primary.translate([x], lang, glossaryId, undefined, label))[0];
              text = restore(await one(t.prepared.text), t.prepared.spans);
              if (text === null && /<\/x>\s+<x>/.test(t.prepared.text)) {
                // Neighbouring spans as one ("Hoppie logon code"): DeepL sometimes moves into them.
                const merged = t.prepared.text.replace(/<\/x>(\s+)<x>/g, '$1');
                const spans = [...merged.matchAll(/<x>(.*?)<\/x>/gs)].map((m) => unxml(m[1]));
                text = restore(await one(merged), spans);
              }
              const parts = t.prepared.text.split(/(?<=[.:;])\s+(?=[A-Z<])/);
              if (text === null && parts.length > 1) {
                const done = [];
                for (const x of parts) done.push(await one(x));
                text = restore(done.join(' '), t.prepared.spans);
              }
              stats.chars += t.prepared.text.length * (parts.length > 1 ? 2 : 1);
            }
            for (let attempt = 0; text === null && attempt < 3; attempt++) {
              const eng = primary.name === 'deepl' ? fallback : primary;
              if (eng === null) break;
              if (eng !== primary) await eng.check();
              const used = termPairs.filter(([a]) => t.u.text.includes(a));
              text = restore(
                await eng.translateOne(t.prepared.text, lang, used, context),
                t.prepared.spans,
              );
              engine = eng.name;
            }
            if (text === null) {
              stats.failed.push(t.u.id);
              if (process.env.I18N_DEBUG)
                console.log(`${t.u.id}\n  > ${t.prepared.text}\n  < ${answers?.[n]}`);
              continue;
            }
            // The engine sometimes quotes a substituted label once more: „Laden““ → „Laden“.
            const { open, close } = TARGETS[lang];
            for (const q of new Set([open.trim(), close.trim(), '“', '”', '"'])) {
              text = text
                .replaceAll(`${close.trim()}${q}`, close.trim())
                .replaceAll(`${q}${open.trim()}`, open.trim());
            }
            out.set(t.u.id, text);
            memory[t.u.id] = { src: t.prepared.text, out: text, engine };
            stats.sent++;
          }
        }
      }
    };

    /** Created on the first DeepL request of the language, removed at its end. */
    let glossaryId;
    if (primary.name !== 'deepl' && !values.dry) await primary.check();
    try {
      // UI strings first: the help quotes them.
      plan(['msg'], false);
      await send(todo.splice(0));
      plan(['msg'], true);
      await send(todo.splice(0));
      plan(['help', 'scn']);
      await send(todo.splice(0));
    } finally {
      if (glossaryId) await deepl(key).dropGlossary(glossaryId);
    }

    if (values.dry) {
      console.log(
        `${lang}: ${stats.cached} unchanged, ${stats.manual} hand-edited, would send ${stats.chars} characters`,
      );
      continue;
    }
    const tr = (id) => out.get(id) ?? have.get(id);
    const files = [];
    if (only.has('msg')) files.push(writeMessages(lang, Object.keys(messagesEn), tr));
    if (only.has('help')) {
      const complete = units.filter((u) => u.kind === 'help').every((u) => tr(u.id) !== undefined);
      if (complete)
        files.push(
          writeHelp(
            lang,
            buildHelp(helpEn, (id) => tr(`help:${id}`)),
          ),
        );
      else console.warn(`  ${lang}: help not complete, help-${lang}.ts not written`);
    }
    if (only.has('scn')) files.push(writeLocale(lang, scenarios, tr));
    mkdirSync(MEMORY, { recursive: true });
    const sorted = Object.fromEntries(
      Object.keys(memory)
        .sort()
        .map((k) => [k, memory[k]]),
    );
    writeFileSync(memFile, `${JSON.stringify(sorted, null, 2)}\n`);
    format(files);
    console.log(
      `${lang}: ${stats.sent} translated (${stats.chars} characters to DeepL), ${stats.cached} unchanged, ${stats.manual} hand-edited kept` +
        (stats.failed.length === 0
          ? ''
          : `, ${stats.failed.length} FAILED: ${stats.failed.slice(0, 10).join(', ')}`),
    );
    for (const f of files) console.log(`  ${relative(ROOT, f)}`);
  }
}

/** A value from the git-ignored `.env.local` at the repository root (CLAUDE.md, invariant 2); never printed. */
function envFile(name) {
  const file = join(ROOT, '.env.local');
  if (!existsSync(file)) return undefined;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m !== null && m[1] === name) return m[2].replace(/^(['"])(.*)\1$/, '$2') || undefined;
  }
  return undefined;
}

function format(files) {
  const ts = files.filter((f) => f.endsWith('.ts'));
  if (ts.length === 0) return;
  // Biome's own launcher (a Node script): no shell, so the paths are passed as they are.
  const biome = join(ROOT, 'node_modules/@biomejs/biome/bin/biome');
  execFileSync(process.execPath, [biome, 'format', '--write', ...ts], { stdio: 'ignore' });
}

run().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
