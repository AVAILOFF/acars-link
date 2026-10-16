import {
  DISTANCE_TARGETS,
  FLIGHT_PHASES,
  PILOT_COMMANDS,
  TIME_REFS,
  TRIGGER_EVENTS,
} from '@acars/core';

/**
 * JSON Schema (2020-12) of a scenario file (docs/05-scenario-engine.md; T06, T12: `wait: reply`,
 * `branch`, `resend`, `on: command`). Structure only; semantics (expressions, templates,
 * variables, branch keys, `set` targets) are checked by `compileScenario` in `@acars/core`.
 * `set` — T14. `vdgs` — T22 (line widths are checked by `compileScenario`). `wait: until`, `group` — T39. `draw`, `loop`, `break`, `if` — T50.
 */

const phase = { enum: [...FLIGHT_PHASES] } as const;
const text = { type: 'string', minLength: 1 } as const;
const id = { type: 'string', pattern: '^[a-z][a-z0-9_]*$' } as const;
const option = { type: 'string', pattern: '^[A-Z][A-Z0-9]*$' } as const;
/** A VDGS line: a template, or `{ red: template }`. */
const vdgsLines = {
  type: 'array',
  minItems: 1,
  maxItems: 7,
  items: {
    oneOf: [
      text,
      { type: 'object', additionalProperties: false, required: ['red'], properties: { red: text } },
    ],
  },
} as const;

export const SCENARIO_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://acars-sim.local/schema/scenario-v1.json',
  title: 'ACARS scenario v1',
  type: 'object',
  additionalProperties: false,
  required: ['id', 'version', 'category', 'title', 'enabled_by_default', 'trigger', 'steps'],
  properties: {
    id: { type: 'string', pattern: '^[a-z][a-z0-9_]*$' },
    version: { const: 1 },
    category: { enum: ['docs', 'ops', 'irregular', 'external', 'fun'] },
    title: text,
    // UI only (T14): the app shows them in its language; telexes stay English.
    title_ru: text,
    description: text,
    description_ru: text,
    enabled_by_default: { type: 'boolean' },
    trigger: {
      type: 'object',
      required: ['on'],
      oneOf: [
        {
          additionalProperties: false,
          required: ['on', 'phase'],
          properties: {
            on: { enum: ['phase_enter', 'phase'] },
            phase,
            window: {
              type: 'object',
              additionalProperties: false,
              required: ['after_min', 'before_tod_min'],
              properties: {
                after_min: { type: 'number', minimum: 0 },
                before_tod_min: { type: 'number', minimum: 0 },
              },
            },
          },
        },
        {
          additionalProperties: false,
          required: ['on', 'event'],
          properties: { on: { const: 'event' }, event: { enum: [...TRIGGER_EVENTS] } },
        },
        {
          additionalProperties: false,
          required: ['on', 'command'],
          properties: { on: { const: 'command' }, command: { enum: [...PILOT_COMMANDS] } },
        },
        {
          additionalProperties: false,
          required: ['on', 'at'],
          properties: {
            on: { const: 'time' },
            at: {
              type: 'object',
              additionalProperties: false,
              required: ['rel', 'offset_min'],
              properties: { rel: { enum: [...TIME_REFS] }, offset_min: { type: 'number' } },
            },
          },
        },
        {
          additionalProperties: false,
          required: ['on', 'dist'],
          properties: {
            on: { const: 'distance' },
            dist: {
              type: 'object',
              additionalProperties: false,
              required: ['to'],
              anyOf: [{ required: ['lte_nm'] }, { required: ['gte_nm'] }],
              properties: {
                to: { enum: [...DISTANCE_TARGETS] },
                lte_nm: { type: 'number', minimum: 0 },
                gte_nm: { type: 'number', minimum: 0 },
              },
            },
          },
        },
      ],
    },
    conditions: { type: 'array', items: text },
    probability: { type: 'number', minimum: 0, maximum: 1 },
    cooldown: {
      oneOf: [
        { enum: ['per_flight', 'per_session', 'none'] },
        {
          type: 'object',
          additionalProperties: false,
          required: ['minutes'],
          properties: { minutes: { type: 'number', exclusiveMinimum: 0 } },
        },
      ],
    },
    excludes: { type: 'array', items: id },
    // T39: limit per flight is described in `groups.ts`.
    group: id,
    priority: { type: 'integer' },
    steps: { $ref: '#/$defs/steps' },
  },
  $defs: {
    steps: {
      type: 'array',
      minItems: 1,
      items: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['send'],
            properties: {
              send: {
                type: 'object',
                additionalProperties: false,
                required: ['body'],
                properties: { header: text, body: text, footer: text },
              },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['wait'],
            properties: {
              wait: {
                oneOf: [
                  {
                    type: 'object',
                    additionalProperties: false,
                    required: ['minutes'],
                    properties: { minutes: { type: 'number', exclusiveMinimum: 0 } },
                  },
                  {
                    type: 'object',
                    additionalProperties: false,
                    required: ['phase'],
                    properties: { phase },
                  },
                  {
                    type: 'object',
                    additionalProperties: false,
                    required: ['until', 'timeout_min'],
                    properties: {
                      until: text,
                      timeout_min: { type: 'number', exclusiveMinimum: 0 },
                    },
                  },
                  {
                    type: 'object',
                    additionalProperties: false,
                    required: ['reply'],
                    properties: {
                      reply: {
                        type: 'object',
                        additionalProperties: false,
                        required: ['options', 'default'],
                        properties: {
                          options: { type: 'array', minItems: 1, uniqueItems: true, items: option },
                          timeout_min: { type: 'number', exclusiveMinimum: 0 },
                          timeout_round: { const: true },
                          default: option,
                        },
                      },
                    },
                  },
                ],
              },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['branch'],
            properties: {
              branch: {
                type: 'object',
                minProperties: 1,
                propertyNames: option,
                additionalProperties: { $ref: '#/$defs/steps' },
              },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['resend'],
            properties: {
              resend: {
                type: 'object',
                additionalProperties: false,
                required: ['of'],
                properties: { of: { type: 'array', minItems: 1, items: id } },
              },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['draw'],
            properties: {
              draw: {
                type: 'array',
                minItems: 1,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['set'],
                  properties: {
                    weight: { type: 'integer', minimum: 1, maximum: 1000 },
                    set: {
                      type: 'object',
                      minProperties: 1,
                      propertyNames: { type: 'string', pattern: '^run\\.[a-z][a-z0-9_]*$' },
                      additionalProperties: {
                        anyOf: [
                          { type: 'string' },
                          { type: 'number' },
                          { type: 'boolean' },
                          { type: 'null' },
                          {
                            type: 'array',
                            minItems: 2,
                            maxItems: 2,
                            items: { type: 'integer' },
                          },
                        ],
                      },
                    },
                  },
                },
              },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['loop'],
            properties: {
              loop: {
                type: 'object',
                additionalProperties: false,
                required: ['until', 'steps'],
                properties: {
                  until: text,
                  stop: text,
                  every_min: { type: 'number', exclusiveMinimum: 0 },
                  steps: { $ref: '#/$defs/steps' },
                },
              },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['if', 'steps'],
            properties: { if: text, steps: { $ref: '#/$defs/steps' } },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['break'],
            properties: { break: { const: true } },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['smoke'],
            properties: {
              smoke: {
                oneOf: [
                  { enum: ['start', 'stop'] },
                  {
                    type: 'object',
                    additionalProperties: false,
                    required: ['start'],
                    properties: {
                      start: { enum: ['orig', 'dest'] },
                      along_nm: { type: 'number', minimum: 0, maximum: 3 },
                      side_nm: {
                        type: 'array',
                        minItems: 2,
                        maxItems: 2,
                        items: { type: 'number', minimum: 0, maximum: 3 },
                      },
                    },
                  },
                ],
              },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['vdgs'],
            properties: {
              vdgs: {
                type: 'object',
                additionalProperties: false,
                required: ['narrow'],
                properties: {
                  duration_sec: { type: 'number', minimum: 1, maximum: 60 },
                  narrow: vdgsLines,
                  small: vdgsLines,
                  wide: vdgsLines,
                  x: vdgsLines,
                },
              },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['set'],
            properties: {
              set: {
                type: 'object',
                minProperties: 1,
                propertyNames: { type: 'string', pattern: '^[a-z][a-z0-9_]*\\.[a-z0-9_]+$' },
                additionalProperties: {
                  anyOf: [
                    { type: 'string' },
                    { type: 'number' },
                    { type: 'boolean' },
                    { type: 'null' },
                  ],
                },
              },
            },
          },
        ],
      },
    },
  },
} as const;
