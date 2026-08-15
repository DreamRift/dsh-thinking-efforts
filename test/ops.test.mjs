import test from 'node:test'
import assert from 'node:assert/strict'
import { buildReasoningOps, OFF_HIGH_MAX } from '../lib/index.js'

test('adds off/high/max to models without declared efforts', () => {
  const ops = buildReasoningOps({
    providers: {
      gateway: {
        models: [{ id: 'deepseek-v4-flash' }],
      },
    },
  })
  assert.deepEqual(ops, [
    {
      op: 'set',
      path: ['providers', 'gateway', 'models'],
      value: [{ id: 'deepseek-v4-flash', reasoningEfforts: OFF_HIGH_MAX }],
    },
  ])
})

test('does not overwrite explicit reasoningEfforts', () => {
  const ops = buildReasoningOps({
    providers: {
      gateway: {
        models: [
          { id: 'm1', reasoningEfforts: false },
          { id: 'm2', reasoningEfforts: { low: 'low' } },
        ],
      },
    },
  })
  assert.equal(ops.length, 0)
})

test('adds to modelOverrides', () => {
  const ops = buildReasoningOps({
    providers: {
      deepseek: {
        modelOverrides: { 'deepseek-v4-flash': { maxTokens: 1 } },
      },
    },
  })
  assert.deepEqual(ops, [
    {
      op: 'set',
      path: ['providers', 'deepseek', 'modelOverrides', 'deepseek-v4-flash', 'reasoningEfforts'],
      value: OFF_HIGH_MAX,
    },
  ])
})

test('force overwrites explicit reasoningEfforts', () => {
  const ops = buildReasoningOps(
    {
      providers: {
        gateway: {
          models: [{ id: 'm1', reasoningEfforts: { low: 'low' } }],
        },
      },
    },
    { force: true },
  )
  assert.deepEqual(ops, [
    {
      op: 'set',
      path: ['providers', 'gateway', 'models'],
      value: [{ id: 'm1', reasoningEfforts: OFF_HIGH_MAX }],
    },
  ])
})

test('ignores providers without models or overrides', () => {
  const ops = buildReasoningOps({
    providers: {
      gateway: { baseURL: 'https://example.com' },
    },
  })
  assert.equal(ops.length, 0)
})

test('returns no ops for empty or invalid config', () => {
  assert.equal(buildReasoningOps(undefined).length, 0)
  assert.equal(buildReasoningOps(null).length, 0)
  assert.equal(buildReasoningOps({}).length, 0)
})
