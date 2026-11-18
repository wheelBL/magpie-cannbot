// Auto output adapter for the CANNBOT gateway (provider-layer defect fixes only).
//
// The CANNBOT gateway advertises output limits it does not always enforce
// (deepseek-v4.1-flash: advertised 393216/4000 over time, enforced <= 4096),
// so this provider clamps every request to the real ceiling and switches to a
// chain member when the caller asks for more output than the primary can
// deliver. Cross-member routing (images, input length, measured perf) does
// NOT live here — that belongs to magpie routing groups or a gateway
// middleware (magpie-route-rules).
//
// Pure functions only; env parsing lives in readAutoConfig.

export const MODES = ['off', 'clamp', 'switch']
export const DEFAULT_MODE = 'switch'
export const DEFAULT_REPORT = true
export const DEFAULT_LIMITS = { 'deepseek-v4.1-flash': 4096 }
export const DEFAULT_CHAIN = [
  { model: 'glm-5.3', limit: 131072 },
  { model: 'qwen3.8-max', limit: 131072 },
]
const TOKEN_KEYS = ['max_tokens', 'max_completion_tokens']
const PROVIDER_PREFIX = 'cannbot/'
const FALSEY = new Set(['0', 'false', 'off', 'no'])

const positiveInt = (value) => Number.isFinite(value) && Number.isInteger(value) && value > 0 ? value : null

export function readAutoConfig(env = process.env) {
  const warnings = []
  let mode = typeof env.CANNBOT_AUTO_MODE === 'string' ? env.CANNBOT_AUTO_MODE.trim().toLowerCase() : DEFAULT_MODE
  if (!MODES.includes(mode)) {
    warnings.push(`CANNBOT_AUTO_MODE=${env.CANNBOT_AUTO_MODE} 无效，回退 ${DEFAULT_MODE}`)
    mode = DEFAULT_MODE
  }
  const limits = { ...DEFAULT_LIMITS }
  if (env.CANNBOT_AUTO_LIMITS) {
    try {
      const parsed = JSON.parse(env.CANNBOT_AUTO_LIMITS)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('不是对象')
      for (const [model, value] of Object.entries(parsed)) {
        const limit = positiveInt(value)
        if (limit == null) warnings.push(`CANNBOT_AUTO_LIMITS["${model}"]=${value} 不是正整数，已忽略`)
        else limits[model] = limit
      }
    } catch (error) {
      warnings.push(`CANNBOT_AUTO_LIMITS 解析失败（${error.message}），仅用内置上限`)
    }
  }
  const chain = [...DEFAULT_CHAIN]
  if (env.CANNBOT_AUTO_CHAIN) {
    const entries = []
    for (const part of env.CANNBOT_AUTO_CHAIN.split(',')) {
      const piece = part.trim()
      if (!piece) continue
      const at = piece.indexOf(':')
      const model = (at < 0 ? piece : piece.slice(0, at)).trim()
      const limit = at < 0 ? null : positiveInt(Number(piece.slice(at + 1).trim()))
      if (!model) { warnings.push(`CANNBOT_AUTO_CHAIN 项 "${piece}" 缺模型 id，已忽略`); continue }
      if (at >= 0 && limit == null) { warnings.push(`CANNBOT_AUTO_CHAIN 项 "${piece}" 上限不是正整数，已忽略`); continue }
      entries.push(limit == null ? { model } : { model, limit })
    }
    if (entries.length) chain.length = 0, chain.push(...entries)
    else warnings.push('CANNBOT_AUTO_CHAIN 没有有效项，保留内置链')
  }
  const report = env.CANNBOT_AUTO_REPORT == null
    ? DEFAULT_REPORT
    : !FALSEY.has(String(env.CANNBOT_AUTO_REPORT).trim().toLowerCase())
  return { mode, limits, chain, report, warnings }
}

function catalogValue(catalog, model) {
  if (!catalog || typeof catalog !== 'object') return null
  const row = catalog[model]
  if (row == null) return null
  if (typeof row === 'number') return positiveInt(row)
  const out = row?.limit?.output
  return positiveInt(out)
}

// Curated/learned overrides are the ceiling of truth (gateways over-advertise);
// the catalog refines them downward and fills models without an override.
export function outputLimitOf(model, catalog, overrides) {
  const over = overrides?.[model]
  const cat = catalogValue(catalog, model)
  if (Number.isFinite(over) && Number.isFinite(cat)) return Math.min(over, cat)
  if (Number.isFinite(over)) return over
  if (Number.isFinite(cat)) return cat
  return null
}

function catalogKnown(catalog) {
  return !!catalog && typeof catalog === 'object' && Object.keys(catalog).length > 0
}

export function planBody(bytes, { mode = DEFAULT_MODE, limits = {}, chain = [], catalog = null } = {}) {
  const result = { bodyText: null, model: null, switched: null, clamped: null, note: null }
  let parsed
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString('utf8'))
  } catch {
    result.note = '请求体不是 JSON，保持原样'
    return result
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    result.note = '请求体不是 JSON 对象，保持原样'
    return result
  }
  result.bodyText = JSON.stringify(parsed)
  const rawModel = typeof parsed.model === 'string' && parsed.model.trim() ? parsed.model.trim() : null
  if (!rawModel) {
    result.note = '请求缺少 model，保持原样'
    return result
  }
  const model = rawModel.startsWith(PROVIDER_PREFIX) ? rawModel.slice(PROVIDER_PREFIX.length) : rawModel
  result.model = model
  const keys = TOKEN_KEYS.filter((k) => Number.isFinite(parsed[k]))
  const requested = keys.length ? Math.max(...keys.map((k) => parsed[k])) : null
  // Curated chain limits are fallback truth for members without overrides;
  // the caller's limits map (curated + measured enforced caps) wins over them.
  const chainLimits = {}
  for (const entry of chain) {
    if (entry && typeof entry === 'object' && Number.isFinite(entry.limit) && entry.model) chainLimits[entry.model] = entry.limit
  }
  const merged = { ...chainLimits, ...limits }
  const capOf = (m) => outputLimitOf(m, catalog, merged)

  if (requested == null) {
    result.note = '请求没有输出上限字段，保持原样'
    return result
  }
  const cap = capOf(model)
  if (cap == null) {
    result.note = `模型 ${model} 的输出上限未知，保持原样`
    return result
  }
  if (requested <= cap) return result

  if (mode === 'clamp') {
    for (const k of keys) parsed[k] = cap
    result.clamped = { from: requested, to: cap }
    result.bodyText = JSON.stringify(parsed)
    return result
  }
  // switch: walk the chain for a member with enough capacity
  const known = catalogKnown(catalog)
  const members = []
  for (const entry of chain) {
    const m = typeof entry === 'string' ? entry : entry?.model
    if (!m || m === model) continue
    const c = capOf(m)
    if (!positiveInt(c)) continue
    if (known && !(m in catalog)) continue
    members.push({ model: m, cap: c })
  }
  const target = members.find((x) => x.cap >= requested) || members.sort((a, b) => b.cap - a.cap)[0]
  if (!target) {
    for (const k of keys) parsed[k] = cap
    result.clamped = { from: requested, to: cap }
    result.note = '链上没有可切换的成员，已在主模型上收敛到其上限'
    result.bodyText = JSON.stringify(parsed)
    return result
  }
  parsed.model = target.model
  result.model = target.model
  result.switched = { from: model, to: target.model, reason: target.cap >= requested ? 'output' : 'output-clamped' }
  if (target.cap < requested) {
    for (const k of keys) parsed[k] = target.cap
    result.clamped = { from: requested, to: target.cap }
  }
  result.bodyText = JSON.stringify(parsed)
  return result
}

// Effective output capacity a client may rely on through this provider: any
// model can be auto-switched up to the chain's largest deliverable budget.
export function effectiveOutputOf(model, { limits = {}, chain = [], catalog = null } = {}) {
  const own = outputLimitOf(model, catalog, limits)
  let best = own
  const known = catalogKnown(catalog)
  for (const entry of chain) {
    const m = typeof entry === 'string' ? entry : entry?.model
    if (!m || m === model) continue
    const cap = typeof entry === 'object' && Number.isFinite(entry.limit) ? entry.limit
      : Number.isFinite(limits[m]) ? limits[m]
      : catalogValue(catalog, m)
    if (!positiveInt(cap)) continue
    if (known && !(m in catalog)) continue
    best = best == null ? cap : Math.max(best, cap)
  }
  return best
}
