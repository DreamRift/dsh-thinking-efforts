/**
 * dsh-thinking-efforts — 自定义提供方思考强度自动补齐插件。
 *
 * 保存 `llm-pi-ai` 自定义提供方模型时，为未声明 `reasoningEfforts` 的模型
 * 自动写入官方四档 `off / low / high / max`，使 Composer 模型选择器直接显示
 * 思考强度选项。用户显式声明过的条目不覆盖（`force: true` 可强制统一）。
 *
 * 适配说明（DSH 0.1.7-rc.x 官方桌面版 nightly，2026-08 本机源码核实）：
 *
 * - 触发事件是 `settings/document-updated(ns, revision)`。旧版插件监听的
 *   `settings/updated` 在 0.1.7-rc.2 的运行事件目录里已不存在（该版本唯一的
 *   settings 广播就是 document-updated），继续监听它等于没有任何触发器——
 *   这正是「安装后表面无效果」的直接原因。
 * - 读取当前配置用 `settings.describe()` 返回描述符的 `user` 层
 *   （profile patch 层，即用户自定义提供方所在层；`value` 是解析后的全图层，
 *   `base` 是 bundle 继承层）。旧版用的 `ctx.settings.get(ns)` 在该版本并不存在
 *   （settings 服务只有 describe/update/replace/mutate/configure/prepareDocument）。
 * - 写入仍走 `settings.mutate('llm-pi-ai', ops)`：`dsh-llm-pi-ai` 的 Config 为
 *   `z.object({ providers: z.dict(profile).default({}).volatile() })`，`providers`
 *   是 volatile 字段，路径写入合法，且 volatile 热提交不重启插件条目
 *   （llm-pi-ai 监听 `loader/volatile-update` 热重建路由，Composer 即时生效）。
 * - `models` 是数组，settings 的 path op 不支持尾插入，必须整数组 set；
 *   `modelOverrides` 是普通 dict，可按路径直接写。
 * - 防递归：写入后 describe 的 user 层已带 reasoningEfforts，ops 为空即停；
 *   另有 `applying` 守卫 + 事件延迟扫描，避免 describe 内同步 emit 重入。
 *
 * 源码依据（本机安装 @deepseek-ai/dsh 0.1.7-rc.2，桌面版 app.asar 内）：
 * - `dsh-settings/lib/index.js`：SettingsForms.describe/update/replace/mutate/write、
 *   `settings/document-updated` emit 点、volatile 路径校验。
 * - `dsh-config-editor/lib/index.js`：`configuration()` 的 override = profile patch 层；
 *   `edit()` 落盘 cordis.patch.yml 后 reconcileProfilePatches 热应用。
 * - `dsh-llm-pi-ai/lib/index.js`：THINKING_LEVELS、reasoningEfforts schema 与
 *   resolveModelReasoning、Config.providers volatile、getSupportedThinkingLevels。
 */

export const name = 'thinking-efforts'

export const inject = ['settings']

/** settings namespace：profile 条目 id（官方 base bundle 与各 profile 均为 `llm-pi-ai`）。 */
export const SETTINGS_NAMESPACE = 'llm-pi-ai'

/** 0.1.7-rc.x 起唯一的 settings 广播事件（替代已移除的 `settings/updated`）。 */
export const SETTINGS_DOCUMENT_UPDATED_EVENT = 'settings/document-updated'

// 对齐官方 llm-deepseek 适配器（rc.7 起）的四档推理档位：off / low / high / max。
// off 不发送 wire 值（pi-ai 读作"支持、不发送"）；其余档位发送其 wire 拼写。
export const OFF_LOW_HIGH_MAX = Object.freeze({ off: null, low: 'low', high: 'high', max: 'max' })

// 旧常量保留为别名（v0.1.0 兼容）；注意它现在也是四档集合。
/** @deprecated use OFF_LOW_HIGH_MAX */
export const OFF_HIGH_MAX = OFF_LOW_HIGH_MAX

/** 启动后首次扫描延迟：等 include 树与 llm-pi-ai 条目激活。 */
const STARTUP_SWEEP_DELAY_MS = 1500
/** describe 还拿不到 llm-pi-ai 描述符时的重试间隔与次数上限。 */
const STARTUP_RETRY_DELAY_MS = 1000
const MAX_STARTUP_RETRIES = 30
/** 事件触发后的扫描延迟（避开 describe 内同步 emit 的执行栈）。 */
const EVENT_SWEEP_DELAY_MS = 50
/** 写入成功后的确认扫描延迟。 */
const VERIFY_DELAY_MS = 250
/** 写入失败后的重试退避。 */
const RETRY_BACKOFF_MS = 5000

/**
 * 判断一份 reasoningEfforts 声明是否已等于目标四档（键集合与逐键值都相同）。
 * force 模式下用它收敛：值已相同的条目不重复写，避免验证扫描无限循环。
 * @param {unknown} value 已声明的 reasoningEfforts。
 * @returns {boolean} 是否与 OFF_LOW_HIGH_MAX 等价。
 */
function sameAsTargetEfforts(value) {
  if (value === OFF_LOW_HIGH_MAX) return true
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(OFF_LOW_HIGH_MAX)
  if (Object.keys(value).length !== keys.length) return false
  return keys.every((key) => Object.hasOwn(value, key) && value[key] === OFF_LOW_HIGH_MAX[key])
}

/**
 * 给定 `{ providers }` 配置，生成补齐 reasoningEfforts 的 settings path ops。
 * 纯函数：不依赖 DSH，可单测。
 *
 * - `providers[route].models`：整数组 set（path op 不支持数组尾插入）。
 * - `providers[route].modelOverrides[modelId]`：按路径直接 set。
 * - 已有 `reasoningEfforts`（含 `false` 与三档旧值）的条目不操作，`force: true` 除外；
 *   force 下值与目标四档等价的条目也不写（保证写后收敛，不循环）。
 * @param {{providers?: Record<string, object>}} config 配置快照。
 * @param {{force?: boolean}} options `force` 覆盖用户显式声明。
 * @returns {{op: 'set', path: string[], value: unknown}[]} 写入 ops。
 */
export function buildReasoningOps(config, options = {}) {
  const ops = []
  const providers = config?.providers
  if (providers === null || typeof providers !== 'object') return ops
  for (const [route, profile] of Object.entries(providers)) {
    if (profile === null || typeof profile !== 'object') continue
    if (Array.isArray(profile.models)) {
      const patched = profile.models.map((entry) => {
        if (entry === null || typeof entry !== 'object' || typeof entry.id !== 'string' || entry.id.length === 0) return entry
        if (entry.reasoningEfforts !== undefined && (options.force !== true || sameAsTargetEfforts(entry.reasoningEfforts))) return entry
        return { ...entry, reasoningEfforts: OFF_LOW_HIGH_MAX }
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
        if (override.reasoningEfforts !== undefined && (options.force !== true || sameAsTargetEfforts(override.reasoningEfforts))) continue
        ops.push({
          op: 'set',
          path: ['providers', route, 'modelOverrides', modelId, 'reasoningEfforts'],
          value: OFF_LOW_HIGH_MAX,
        })
      }
    }
  }
  return ops
}

/**
 * 从 `settings.describe()` 的描述符数组里取出目标命名空间的用户层 providers。
 * 纯函数：不依赖 DSH，可单测。
 *
 * `describe()` 只为「schema 含 volatile 字段且条目已激活」的 profile 条目产出描述符；
 * 描述符缺失意味着 llm-pi-ai 尚未就绪（或该 profile 没有这个条目），调用方应稍后重试。
 * `user` 是 profile patch 层（用户自定义提供方所在层）；`value` 是全图层解析值，
 * `base` 是 bundle 继承层——只扫 user 层，避免把官方/bundle 提供方写进用户 patch。
 * @param {unknown} descriptors settings.describe() 的返回值。
 * @param {string} [namespace] 目标命名空间（profile 条目 id）。
 * @returns {Record<string, object>|undefined} 用户层 providers；条目未就绪时 `undefined`。
 */
export function selectUserProviders(descriptors, namespace = SETTINGS_NAMESPACE) {
  if (!Array.isArray(descriptors)) return undefined
  const descriptor = descriptors.find((row) => row != null && typeof row === 'object' && row.ns === namespace)
  if (descriptor === undefined) return undefined
  const providers = descriptor.user?.providers
  if (providers === null || typeof providers !== 'object' || Array.isArray(providers)) return {}
  return providers
}

/**
 * 插件装配：事件驱动 + 启动扫描，把四档 reasoningEfforts 补进用户层自定义提供方。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文（inject 了 settings）。
 * @param {{enabled?: boolean, force?: boolean}} [config] 插件配置。
 * @returns {() => void} dispose：停止扫描并清理定时器。
 */
export function apply(ctx, config = {}) {
  const enabled = config.enabled !== false
  const force = config.force === true
  const log = (level, message) => ctx.logger?.[level]?.(message)

  let settingsService = ctx.settings ?? ctx.get?.('settings') ?? null
  let applying = false
  let ready = false
  let retries = 0
  let disposed = false
  let pendingCancel = null
  let pendingDelay = Number.POSITIVE_INFINITY
  const timers = new Set()
  const timerService = ctx.get?.('timer') ?? ctx.timer ?? null

  /** 注册一个可取消延时任务；dispose 时统一清理。 */
  function defer(fn, delay) {
    let cancel
    if (timerService != null && typeof timerService.timeout === 'function') {
      cancel = timerService.timeout(() => {
        timers.delete(cancel)
        return fn()
      }, delay)
    } else {
      const handle = setTimeout(() => {
        timers.delete(handle)
        return fn()
      }, delay)
      cancel = () => clearTimeout(handle)
    }
    timers.add(cancel)
    return cancel
  }

  /** 请求一次扫描；更早的延迟可以抢占已排定的更晚扫描。 */
  function requestSweep(delay = EVENT_SWEEP_DELAY_MS) {
    if (disposed || !enabled) return
    if (pendingCancel !== null) {
      if (delay >= pendingDelay) return
      pendingCancel()
    }
    pendingDelay = delay
    pendingCancel = defer(() => {
      pendingCancel = null
      pendingDelay = Number.POSITIVE_INFINITY
      return sweep()
    }, delay)
  }

  async function sweep() {
    try {
      await runSweep()
    } catch (error) {
      log('error', `[thinking-efforts] sweep failed: ${error?.message ?? String(error)}`)
    }
  }

  async function runSweep() {
    if (disposed || !enabled || applying) return
    settingsService = settingsService ?? ctx.get?.('settings') ?? null
    if (settingsService == null) return

    let providers
    try {
      providers = selectUserProviders(settingsService.describe())
    } catch (error) {
      log('warn', `[thinking-efforts] settings describe failed: ${error?.message ?? String(error)}`)
      if (!ready && retries < MAX_STARTUP_RETRIES) {
        retries += 1
        requestSweep(STARTUP_RETRY_DELAY_MS)
      }
      return
    }

    if (providers === undefined) {
      // llm-pi-ai 条目尚未激活（启动窗口）或该 profile 没有此条目。
      if (!ready) {
        if (retries < MAX_STARTUP_RETRIES) {
          retries += 1
          requestSweep(STARTUP_RETRY_DELAY_MS)
        } else {
          log('warn', '[thinking-efforts] llm-pi-ai settings namespace is not ready; waiting for the next settings change')
        }
      }
      return
    }

    if (!ready) {
      ready = true
      retries = 0
      log('info', '[thinking-efforts] watching llm-pi-ai custom providers for missing reasoningEfforts')
    }

    const ops = buildReasoningOps({ providers }, { force })
    if (ops.length === 0) return

    applying = true
    let written = false
    try {
      await settingsService.mutate(SETTINGS_NAMESPACE, ops)
      written = true
      log('info', `[thinking-efforts] added off/low/high/max reasoningEfforts via ${ops.length} settings op(s)`)
    } catch (error) {
      log('warn', `[thinking-efforts] settings mutate failed: ${error?.message ?? String(error)}`)
    } finally {
      applying = false
    }
    // 写入会触发 settings/document-updated 与 app-boot/config-reload，
    // 下一轮扫描应当为空；这里兜底再排一次，防止事件丢失留下不确定状态。
    requestSweep(written ? VERIFY_DELAY_MS : RETRY_BACKOFF_MS)
  }

  if (enabled) {
    // 主触发器：settings 写入后 SettingsForms.describe() 的广播。
    ctx.on(SETTINGS_DOCUMENT_UPDATED_EVENT, (ns) => {
      if (ns === SETTINGS_NAMESPACE) requestSweep()
    })
    // 兜底触发器：profile patch 重放/热更新、provider 路由变化。
    ctx.on('app-boot/config-reload', () => requestSweep())
    ctx.on('llm/adapters-updated', () => requestSweep())
    requestSweep(STARTUP_SWEEP_DELAY_MS)
  }

  return function dispose() {
    disposed = true
    if (pendingCancel !== null) pendingCancel()
    pendingCancel = null
    for (const cancel of timers) cancel()
    timers.clear()
  }
}
