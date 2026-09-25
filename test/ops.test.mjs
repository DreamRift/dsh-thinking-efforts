import test from 'node:test'
import assert from 'node:assert/strict'
import { buildReasoningOps, selectUserProviders, apply, OFF_LOW_HIGH_MAX, OFF_HIGH_MAX } from '../lib/index.js'

test('adds off/low/high/max to models without declared efforts', () => {
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
      value: [{ id: 'deepseek-v4-flash', reasoningEfforts: OFF_LOW_HIGH_MAX }],
    },
  ])
})

test('does not overwrite explicit reasoningEfforts (3-tier or 4-tier)', () => {
  const ops = buildReasoningOps({
    providers: {
      gateway: {
        models: [
          { id: 'm1', reasoningEfforts: false },
          { id: 'm2', reasoningEfforts: { off: null, high: 'high', max: 'max' } },
          { id: 'm3', reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' } },
          { id: 'm4', reasoningEfforts: { low: 'low' } },
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
      value: OFF_LOW_HIGH_MAX,
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
      value: [{ id: 'm1', reasoningEfforts: OFF_LOW_HIGH_MAX }],
    },
  ])
})

test('force skips entries already equal to the target (write convergence)', () => {
  const ops = buildReasoningOps(
    {
      providers: {
        gateway: {
          models: [{ id: 'm1', reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' } }],
          modelOverrides: { 'm2': { reasoningEfforts: { max: 'max', high: 'high', low: 'low', off: null } } },
        },
      },
    },
    { force: true },
  )
  assert.equal(ops.length, 0)
})

test('force still rewrites partial or legacy declarations', () => {
  const ops = buildReasoningOps(
    {
      providers: {
        gateway: {
          models: [
            { id: 'm1', reasoningEfforts: { off: null, high: 'high', max: 'max' } },
            { id: 'm2', reasoningEfforts: { high: 'high', max: 'max', low: 'low', off: null, extra: 'x' } },
          ],
        },
      },
    },
    { force: true },
  )
  assert.equal(ops.length, 1)
  assert.deepEqual(ops[0].value, [
    { id: 'm1', reasoningEfforts: OFF_LOW_HIGH_MAX },
    { id: 'm2', reasoningEfforts: OFF_LOW_HIGH_MAX },
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

test('exported OFF_HIGH_MAX is aliased to OFF_LOW_HIGH_MAX', () => {
  assert.equal(OFF_HIGH_MAX, OFF_LOW_HIGH_MAX)
  assert.deepEqual(OFF_HIGH_MAX, { off: null, low: 'low', high: 'high', max: 'max' })
})

// ---------- selectUserProviders ----------

test('selectUserProviders reads the user layer of the llm-pi-ai descriptor', () => {
  const providers = { stepfun: { models: [{ id: 'step-5-preview' }] } }
  const selected = selectUserProviders([
    { ns: 'web-search-pool', user: { providers: {} } },
    { ns: 'llm-pi-ai', user: { providers } },
  ])
  assert.equal(selected, providers)
})

test('selectUserProviders returns undefined while the namespace has no descriptor', () => {
  assert.equal(selectUserProviders([]), undefined)
  assert.equal(selectUserProviders([{ ns: 'llm' }]), undefined)
  assert.equal(selectUserProviders(undefined), undefined)
  assert.equal(selectUserProviders('nope'), undefined)
})

test('selectUserProviders tolerates a descriptor without a user layer', () => {
  assert.deepEqual(selectUserProviders([{ ns: 'llm-pi-ai' }]), {})
  assert.deepEqual(selectUserProviders([{ ns: 'llm-pi-ai', user: null }]), {})
  assert.deepEqual(selectUserProviders([{ ns: 'llm-pi-ai', user: { providers: null } }]), {})
  assert.deepEqual(selectUserProviders([{ ns: 'llm-pi-ai', user: { providers: [] } }]), {})
})

test('selectUserProviders honors a custom namespace', () => {
  // 目标命名空间没有描述符 = 未就绪（undefined），而不是空 providers。
  assert.equal(selectUserProviders([{ ns: 'llm-pi-ai', user: { providers: { a: {} } } }], 'other'), undefined)
  const providers = { a: {} }
  assert.equal(selectUserProviders([{ ns: 'other', user: { providers } }], 'other'), providers)
})

// ---------- apply 装配（假 ctx / 假 settings / 可控定时器） ----------

/** 可控定时器：timeout(cb, delay) 收集待执行回调，返回取消函数。 */
function createFakeTimer() {
  const pending = []
  return {
    pending,
    timeout(callback, delay) {
      const entry = { callback, delay }
      pending.push(entry)
      return () => {
        const index = pending.indexOf(entry)
        if (index >= 0) pending.splice(index, 1)
      }
    },
    /** 依次执行待执行回调（每个回调可能排入新的回调），直到清空或达到步数上限。 */
    async flush(maxSteps = 64) {
      for (let step = 0; step < maxSteps && pending.length > 0; step += 1) {
        const [entry] = pending.splice(0, 1)
        await entry.callback()
      }
    },
  }
}

function createFakeSettings(descriptors) {
  const state = { descriptors, mutations: [] }
  const service = {
    state,
    onMutate: null,
    describe() {
      return state.descriptors
    },
    async mutate(ns, ops) {
      state.mutations.push({ ns, ops: structuredClone(ops) })
      if (service.onMutate) await service.onMutate(ns, ops)
    },
  }
  return service
}

function createFakeCtx(settings, timer) {
  const listeners = new Map()
  return {
    logger: { info() {}, warn() {}, error() {} },
    settings,
    timer,
    on(name, listener) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(listener)
    },
    get(name) {
      if (name === 'settings') return settings
      if (name === 'timer') return timer
      return undefined
    },
    emit(name, ...args) {
      for (const listener of listeners.get(name) ?? []) listener(...args)
    },
  }
}

/** 模拟真实系统：mutate 成功后 user 层即带上 reasoningEfforts。 */
function reflectingOnMutate(settings) {
  return async (ns, ops) => {
    const descriptor = settings.state.descriptors.find((row) => row.ns === ns)
    if (!descriptor?.user?.providers) return
    for (const op of ops) {
      const route = op.path[1]
      if (op.path[2] === 'models') descriptor.user.providers[route].models = structuredClone(op.value)
      else if (op.path[2] === 'modelOverrides') {
        const modelId = op.path[3]
        descriptor.user.providers[route].modelOverrides[modelId] = {
          ...descriptor.user.providers[route].modelOverrides[modelId],
          reasoningEfforts: op.value,
        }
      }
    }
  }
}

test('apply sweeps at startup and writes user-layer models once', async () => {
  const settings = createFakeSettings([
    { ns: 'llm-pi-ai', user: { providers: { stepfun: { models: [{ id: 'step-5-preview' }] } } } },
  ])
  settings.onMutate = reflectingOnMutate(settings)
  const timer = createFakeTimer()
  const ctx = createFakeCtx(settings, timer)

  const dispose = apply(ctx, {})
  await timer.flush()

  assert.equal(settings.state.mutations.length, 1)
  assert.equal(settings.state.mutations[0].ns, 'llm-pi-ai')
  assert.deepEqual(settings.state.mutations[0].ops, [
    {
      op: 'set',
      path: ['providers', 'stepfun', 'models'],
      value: [{ id: 'step-5-preview', reasoningEfforts: OFF_LOW_HIGH_MAX }],
    },
  ])
  // 写入被反映进 describe 后，后续扫描不再产生 ops（无递归写）。
  assert.equal(timer.pending.length, 0)
  dispose()
})

test('apply retries while the llm-pi-ai descriptor is absent, then patches it', async () => {
  const settings = createFakeSettings([])
  settings.onMutate = reflectingOnMutate(settings)
  const timer = createFakeTimer()
  const ctx = createFakeCtx(settings, timer)

  const dispose = apply(ctx, {})
  await timer.flush(6)
  assert.equal(settings.state.mutations.length, 0)
  assert.ok(timer.pending.length > 0, '启动重试应仍在排队')

  // llm-pi-ai 条目就绪：describe 开始返回描述符（用户刚保存了自定义提供方）。
  settings.state.descriptors = [
    { ns: 'llm-pi-ai', user: { providers: { 'custom-gateway': { models: [{ id: 'deepseek-v4-flash' }] } } } },
  ]
  await timer.flush()

  assert.equal(settings.state.mutations.length, 1)
  assert.deepEqual(settings.state.mutations[0].ops[0].path, ['providers', 'custom-gateway', 'models'])
  dispose()
})

test('apply reacts to settings/document-updated for llm-pi-ai only', async () => {
  const settings = createFakeSettings([
    { ns: 'llm-pi-ai', user: { providers: { stepfun: { models: [{ id: 'step-5-preview' }] } } } },
  ])
  settings.onMutate = reflectingOnMutate(settings)
  const timer = createFakeTimer()
  const ctx = createFakeCtx(settings, timer)

  const dispose = apply(ctx, {})
  await timer.flush(4)
  assert.equal(settings.state.mutations.length, 1)

  // 其他命名空间的广播不触发写入。
  settings.state.descriptors = [{ ns: 'llm-pi-ai', user: { providers: { other: { models: [{ id: 'm' }] } } } }]
  ctx.emit('settings/document-updated', 'web-search-pool', 3)
  await timer.flush(4)
  assert.equal(settings.state.mutations.length, 1)

  // llm-pi-ai 的广播触发补齐。
  ctx.emit('settings/document-updated', 'llm-pi-ai', 4)
  await timer.flush()
  assert.equal(settings.state.mutations.length, 2)
  assert.deepEqual(settings.state.mutations[1].ops[0].path, ['providers', 'other', 'models'])
  dispose()
})

test('apply writes modelOverrides through path ops', async () => {
  const settings = createFakeSettings([
    { ns: 'llm-pi-ai', user: { providers: { gateway: { modelOverrides: { 'm-1': { maxTokens: 1 } } } } } },
  ])
  settings.onMutate = reflectingOnMutate(settings)
  const timer = createFakeTimer()
  const ctx = createFakeCtx(settings, timer)

  const dispose = apply(ctx, {})
  await timer.flush()

  assert.equal(settings.state.mutations.length, 1)
  assert.deepEqual(settings.state.mutations[0].ops, [
    {
      op: 'set',
      path: ['providers', 'gateway', 'modelOverrides', 'm-1', 'reasoningEfforts'],
      value: OFF_LOW_HIGH_MAX,
    },
  ])
  dispose()
})

test('apply is a no-op when every model already declares efforts', async () => {
  const settings = createFakeSettings([
    {
      ns: 'llm-pi-ai',
      user: {
        providers: {
          stepfun: { models: [{ id: 'step-5-preview', reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' } }] },
        },
      },
    },
  ])
  const timer = createFakeTimer()
  const ctx = createFakeCtx(settings, timer)

  const dispose = apply(ctx, {})
  await timer.flush()
  assert.equal(settings.state.mutations.length, 0)
  assert.equal(timer.pending.length, 0)
  dispose()
})

test('apply respects enabled: false', async () => {
  const settings = createFakeSettings([
    { ns: 'llm-pi-ai', user: { providers: { stepfun: { models: [{ id: 'step-5-preview' }] } } } },
  ])
  const timer = createFakeTimer()
  const ctx = createFakeCtx(settings, timer)

  const dispose = apply(ctx, { enabled: false })
  await timer.flush()
  ctx.emit('settings/document-updated', 'llm-pi-ai', 1)
  await timer.flush()
  assert.equal(settings.state.mutations.length, 0)
  dispose()
})

test('apply with force: true rewrites declared efforts', async () => {
  const settings = createFakeSettings([
    { ns: 'llm-pi-ai', user: { providers: { stepfun: { models: [{ id: 'm', reasoningEfforts: { high: 'high' } }] } } } },
  ])
  settings.onMutate = reflectingOnMutate(settings)
  const timer = createFakeTimer()
  const ctx = createFakeCtx(settings, timer)

  const dispose = apply(ctx, { force: true })
  await timer.flush()
  assert.equal(settings.state.mutations.length, 1)
  assert.deepEqual(settings.state.mutations[0].ops[0].value, [{ id: 'm', reasoningEfforts: OFF_LOW_HIGH_MAX }])
  dispose()
})

test('apply retries after a failed mutate with backoff', async () => {
  let calls = 0
  const settings = createFakeSettings([
    { ns: 'llm-pi-ai', user: { providers: { stepfun: { models: [{ id: 'step-5-preview' }] } } } },
  ])
  settings.onMutate = async (ns, ops) => {
    calls += 1
    if (calls === 1) throw new Error('settings namespace is read-only')
    await reflectingOnMutate(settings)(ns, ops)
  }
  const timer = createFakeTimer()
  const ctx = createFakeCtx(settings, timer)

  const dispose = apply(ctx, {})
  await timer.flush()

  assert.equal(settings.state.mutations.length, 2)
  assert.equal(settings.state.mutations[1].ns, 'llm-pi-ai')
  dispose()
})

test('apply warns once while the namespace never becomes ready', async () => {
  const settings = createFakeSettings([])
  const timer = createFakeTimer()
  const warns = []
  const ctx = createFakeCtx(settings, timer)
  ctx.logger.warn = (message) => warns.push(message)

  const dispose = apply(ctx, {})
  await timer.flush(64)
  assert.ok(timer.pending.length === 0, '重试上限到達后不应再排队')
  assert.equal(warns.length, 1)

  // 之后再来事件也不重复告警。
  ctx.emit('settings/document-updated', 'llm-pi-ai', 9)
  await timer.flush(8)
  assert.equal(warns.length, 1)
  assert.equal(settings.state.mutations.length, 0)
  dispose()
})

test('apply dispose cancels the pending startup sweep', async () => {
  const settings = createFakeSettings([
    { ns: 'llm-pi-ai', user: { providers: { stepfun: { models: [{ id: 'step-5-preview' }] } } } },
  ])
  const timer = createFakeTimer()
  const ctx = createFakeCtx(settings, timer)

  const dispose = apply(ctx, {})
  assert.ok(timer.pending.length > 0, '启动扫描应已排队')
  dispose()
  assert.equal(timer.pending.length, 0)
  await timer.flush()
  assert.equal(settings.state.mutations.length, 0)
})

test('apply survives describe throwing', async () => {
  const settings = createFakeSettings([])
  settings.describe = () => {
    throw new Error('profile directory unreadable')
  }
  const timer = createFakeTimer()
  const ctx = createFakeCtx(settings, timer)

  const dispose = apply(ctx, {})
  await timer.flush(4)
  assert.equal(settings.state.mutations.length, 0)
  dispose()
})
