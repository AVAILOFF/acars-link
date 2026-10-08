import { DISTANCE_TARGETS, FLIGHT_PHASES, TIME_REFS, TRIGGER_EVENTS } from '@acars/core';

/**
 * JSON Schema (2020-12) of a scenario file, v0 (docs/05-scenario-engine.md, T06).
 * Structure only; semantics (expressions, templates, variables) are checked by
 * `compileScenario` in `@acars/core`. `reply`, `branch`, `set` are not in v0.
 */

const phase = { enum: [...FLIGHT_PHASES] } as const;
const text = { type: 'string', minLength: 1 } as const;

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
    enabled_by_default: { type: 'boolean' },
    trigger: {
      type: 'object',
      required: ['on'],
      oneOf: [
        {
          additionalProperties: false,
          required: ['on', 'phase'],
          properties: { on: { enum: ['phase_enter', 'phase'] }, phase },
        },
        {
          additionalProperties: false,
          required: ['on', 'event'],
          properties: { on: { const: 'event' }, event: { enum: [...TRIGGER_EVENTS] } },
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
        { enum: ['per_flight', 'per_session'] },
        {
          type: 'object',
          additionalProperties: false,
          required: ['minutes'],
          properties: { minutes: { type: 'number', exclusiveMinimum: 0 } },
        },
      ],
    },
    excludes: { type: 'array', items: { type: 'string', pattern: '^[a-z][a-z0-9_]*$' } },
    priority: { type: 'integer' },
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
                ],
              },
            },
          },
        ],
      },
    },
  },
} as const;
