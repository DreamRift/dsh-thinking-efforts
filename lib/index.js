export const name = 'thinking-efforts'

export const inject = ['settings']

export const OFF_HIGH_MAX = Object.freeze({ off: null, high: 'high', max: 'max' })

export function buildReasoningOps(config, options = {}) {
  const ops = []
  const providers = config?.providers
  if (providers === null || typeof providers !== 'object') return ops
  for (const [route, profile] of Object.entries(providers)) {
    if (profile === null || typeof profile !== 'object') continue
    if (Array.isArray(profile.models)) {
      const patched = profile.models.map((entry) => {
        if (entry === null || typeof entry !== 'object' || typeof entry.id !== 'string' || entry.id.length === 0) return entry
        if (options.force !== true && entry.reasoningEfforts !== undefined) return entry
        return { ...entry, reasoningEfforts: { off: null, high: 'high', max: 'max' } }
      })
      const changed = patched.some((entry, index) => entry !== profile.models[index])
      if (changed) {
        ops.push({
          op: 'set',
          path: ['providers', route, 'models'],
          value: patched,
        })
      }
    }
    if (profile.modelOverrides !== null && typeof profile.modelOverrides === 'object') {
      for (const [modelId, override] of Object.entries(profile.modelOverrides)) {
        if (override === null || typeof override !== 'object') continue
        if (options.force !== true && override.reasoningEfforts !== undefined) continue
        ops.push({
          op: 'set',
          path: ['providers', route, 'modelOverrides', modelId, 'reasoningEfforts'],
          value: { off: null, high: 'high', max: 'max' },
        })
      }
    }
  }
  return ops
}

export function apply(ctx, config = {}) {
  const enabled = config.enabled !== false
  const force = config.force === true
  let applying = false

  const applyOnce = async (value) => {
    if (value === undefined || value === null || typeof value !== 'object') return
    const ops = buildReasoningOps(value, { force })
    if (ops.length === 0) return
    applying = true
    try {
      await ctx.settings.mutate('llm-pi-ai', ops)
    } catch (error) {
      ctx.logger?.error?.(`[thinking-efforts] auto apply failed: ${error?.message ?? String(error)}`)
    } finally {
      applying = false
    }
  }

  ctx.on('settings/updated', async (ns, next) => {
    if (!enabled || applying || ns !== 'llm-pi-ai') return
    await applyOnce(next)
  })

  const timer = ctx.get('timer')
  if (timer !== undefined) {
    timer.timeout(() => {
      if (!enabled) return
      try {
        void applyOnce(ctx.settings.get('llm-pi-ai'))
      } catch (error) {
        ctx.logger?.warn?.(`[thinking-efforts] initial apply skipped: ${error?.message ?? String(error)}`)
      }
    }, 2000)
  }
}
