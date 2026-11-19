// Credential discovery, gateway endpoints and catalog mapping adapted from
// dsh-cannbot-connect, Copyright (c) 2026 gentle-knight, MIT (see LICENSE).
// 0.2.0/0.3.0 added the auto output adapter; 0.4.0 slimmed to the provider's
// own defect fixes (clamp, enforced-limit learning, output-budget chain
// switch, effective capacity reporting). Cross-member routing lives in
// magpie routing groups or the magpie-route-rules gateway middleware.
import { readFile, writeFile, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { planBody, effectiveOutputOf } from './auto.mjs'

export const ID = 'cannbot'
export const BASE = 'https://cannbot.hicann.cn/gateway/compatible-mode/v1'
export const MODELS = 'https://cannbot.hicann.cn/cannbot/api/models/personal'
const LOCAL = 'cannbot-local-session'
const EFFORTS = ['minimal', 'low', 'medium', 'high', 'max', 'xhigh']
const authError = (message) => Object.assign(new Error(message), { signIn: 'expired' })
const fingerprint = (value) => createHash('sha256').update(value).digest('hex')

export function secureEndpoint(raw) {
  let url
  try { url = new URL(raw) } catch { throw new Error('CANNBOT 端点不是有效 URL') }
  if (url.username || url.password || url.search || url.hash) throw new Error('CANNBOT 端点不能含用户信息、查询或片段')
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('CANNBOT 端点必须使用 HTTPS（仅回环地址允许 HTTP）')
  }
  return url.href.replace(/\/+$/, '')
}

export function credential(value, label) {
  if (typeof value !== 'string' || !/^[\x21-\x7e]+$/.test(value)) {
    throw authError(`CANNBOT ${label} 缺失或格式无效；请重新登录或导入凭据`)
  }
  return value
}

export async function readLocal({ env = process.env, home = homedir(), read = readFile } = {}) {
  const roots = [
    join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'opencode'),
    join(env.XDG_CONFIG_HOME || join(home, '.config'), 'opencode'),
  ]
  const copies = async (name) => Promise.all(roots.map(async (root) => {
    try { return JSON.parse(await read(join(root, name), 'utf8')) } catch { return undefined }
  }))
  const [sessions, auths] = await Promise.all([copies('session.json'), copies('auth.json')])
  const jwt = sessions.find((s) => typeof s?.accessToken === 'string' && s.accessToken)?.accessToken
  let vk = auths.find((a) => typeof a?.cannbot?.key === 'string' && a.cannbot.key)?.cannbot.key
  vk ??= auths.find((a) => typeof a?.['cannbot-cli']?.refresh === 'string' && a['cannbot-cli'].refresh.startsWith('vk-'))?.['cannbot-cli'].refresh
  return { jwt: credential(jwt, 'accessToken'), vk: credential(vk, 'Virtual Key') }
}

// Read only the selected account. Local mode pins its VK fingerprint: JWT
// renewal is automatic, while an account switch / VK rotation needs rebind.
export async function resolveCredentials(auth, localOptions) {
  if (auth?.type !== 'api') throw authError('请先登录 CANNBOT')
  if (auth.key === LOCAL && auth.metadata?.method === 'local') {
    const pair = await readLocal(localOptions)
    if (fingerprint(pair.vk) !== auth.metadata.vkFingerprint) {
      throw authError('CANNWork 的账号或 Virtual Key 已改变；请重新绑定本机登录态')
    }
    return pair
  }
  if (auth.metadata?.method !== 'paste') throw authError('CANNBOT 需要同时导入 accessToken 和 Virtual Key')
  return { jwt: credential(auth.metadata.accessToken, 'accessToken'), vk: credential(auth.key, 'Virtual Key') }
}

function positive(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}
export function modelRow(row, baseURL = BASE) {
  return {
    id: row.model,
    name: typeof row.title === 'string' && row.title ? row.title : row.model,
    api: { id: row.model, url: baseURL, npm: '@ai-sdk/openai-compatible' },
    limit: { context: positive(row.contextLength, 1048576), output: positive(row.completionOptions?.maxTokens, 131072) },
    reasoning: true,
    tool_call: true,
    modalities: { input: ['text'], output: ['text'] },
    capabilities: {
      reasoning: true, toolcall: true, attachment: false,
      input: { text: true, image: false, audio: false, video: false, pdf: false },
      output: { text: true },
    },
    variants: Object.fromEntries(EFFORTS.map((e) => [e, { reasoningEffort: e }])),
  }
}
export function catalogRows(body, baseURL = BASE) {
  const data = body?.data
  if (body?.success !== true || !data || !Array.isArray(data.personalModels) || !Array.isArray(data.builtinModels)) {
    throw new Error('CANNBOT 模型目录格式无效')
  }
  const rows = Object.create(null)
  for (const row of [...data.personalModels, ...data.builtinModels]) {
    if (typeof row?.model !== 'string' || !row.model.trim() || Object.hasOwn(rows, row.model)) continue
    rows[row.model] = modelRow(row, baseURL)
  }
  return rows
}

function combinedSignal(signal) {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000)
}

export function createPlugin({ fetchImpl = globalThis.fetch, localOptions, baseURL = BASE, modelsURL = MODELS, auto = null } = {}) {
  baseURL = secureEndpoint(baseURL)
  modelsURL = secureEndpoint(modelsURL)
  const chatURL = `${baseURL}/chat/completions`
  const readAuth = (auth) => resolveCredentials(auth, localOptions)
  const autoOn = !!auto && auto.mode !== 'off'
  // Last good catalog (raw upstream limits) — the adapter clamps against raw
  // truth while the reported catalog below carries effective capacities.
  let catalogCache = null
  // Output caps the gateway itself enforced (learned from 400 responses that
  // name the ceiling). Measured truth beats advertised values.
  const enforced = Object.create(null)
  // Per-model payload capacity learned from outcomes (bytes): maxOk = largest
  // body that succeeded (lower bound of the member's limit); minFail =
  // smallest body that got a 413 (upper bound). Evidence lets the plugin
  // pre-emptively swap members BEFORE a doomed send — finer granularity and
  // better experience than the reactive 413 retry.
  const payloadLimits = Object.create(null)
  // First chain member (excluding currentModel) whose evidence does NOT
  // reject a body of this size: proven bigger, never failed, or unknown.
  const payloadCandidate = (currentModel, bodyBytes) => {
    for (const entry of auto?.chain || []) {
      const m = typeof entry === 'string' ? entry : entry?.model
      if (!m || m === currentModel) continue
      const p = payloadLimits[m]
      if (p && p.minFail != null && bodyBytes >= p.minFail) continue
      return m
    }
    return null
  }
  const mergedLimits = () => ({ ...auto?.limits, ...enforced })
  // ── 证据持久化（0.5.3）：payloadLimits + enforced 跨重启存活 ──
  // 文件 ~/.config/magpie/cannbot-evidence.json；启动加载（best-effort），
  // 变更后 2s 防抖原子写。首启无文件 = 空表，从首个 413/400 重学。
  const evidencePath = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'magpie', 'cannbot-evidence.json')
  let evidenceTimer = null
  const saveEvidence = () => {
    if (evidenceTimer) return
    evidenceTimer = setTimeout(() => {
      evidenceTimer = null
      const tmp = evidencePath + '.tmp'
      writeFile(tmp, JSON.stringify({ payloadLimits, enforced, savedAt: Date.now() }))
        .then(() => rename(tmp, evidencePath))
        .catch(() => { /* persistence is best-effort */ })
    }, 2000)
  }
  void (async () => {
    try {
      const raw = JSON.parse(await readFile(evidencePath, 'utf8'))
      for (const [m, pl] of Object.entries(raw.payloadLimits || {})) {
        if (pl && typeof pl === 'object' && (Number.isFinite(pl.maxOk) || Number.isFinite(pl.minFail))) {
          payloadLimits[m] = { maxOk: pl.maxOk ?? 0, minFail: pl.minFail }
        }
      }
      for (const [m, cap] of Object.entries(raw.enforced || {})) {
        if (Number.isFinite(cap) && cap > 0) enforced[m] = cap
      }
    } catch { /* fresh start: re-learn from the first failure */ }
  })()
  const modelsResponse = (jwt, signal) => fetchImpl(modelsURL, {
    headers: { authorization: `Bearer ${jwt}`, accept: 'application/json' },
    redirect: 'error', signal: combinedSignal(signal),
  })
  return {
    async config(config) {
      config.provider ??= {}
      config.provider[ID] ??= {
        name: 'CANNBOT', npm: '@ai-sdk/openai-compatible', api: baseURL,
        // A known upstream bootstrap, not a promise of account access.
        models: { 'deepseek-v4.1-flash': modelRow({ model: 'deepseek-v4.1-flash' }, baseURL) },
      }
    },
    auth: {
      provider: ID,
      methods: [
        {
          type: 'oauth', label: '绑定本机 CANNWork 登录态（JWT 随 CANNWork 更新）',
          async authorize() {
            // Explicit sign-in is the first local file read; module load is inert.
            const pair = await readLocal(localOptions)
            const pin = fingerprint(pair.vk)
            return {
              url: '', method: 'auto',
              instructions: '已找到本机 CANNWork 凭据；本插件只读，续期请保持 CANNWork 登录。',
              callback: async () => ({
                type: 'success', key: LOCAL, accountId: `CANNWork 本机 ${pin.slice(0, 8)}`,
                metadata: { method: 'local', vkFingerprint: pin },
              }),
            }
          },
        },
        {
          type: 'api', label: '导入 accessToken + Virtual Key',
          prompts: [
            { type: 'password', key: 'accessToken', message: 'CANNWork session.json 的 accessToken' },
            { type: 'password', key: 'virtualKey', message: 'CANNWork auth.json 的 cannbot.key（Virtual Key）' },
          ],
          async authorize(inputs) {
            try {
              const jwt = credential(inputs?.accessToken?.trim(), 'accessToken')
              const vk = credential(inputs?.virtualKey?.trim(), 'Virtual Key')
              return { type: 'success', key: vk, accountId: `导入 ${fingerprint(vk).slice(0, 8)}`, metadata: { method: 'paste', accessToken: jwt } }
            } catch (error) { return { type: 'failed', error: error.message } }
          },
        },
      ],
      async loader(getAuth) {
        return {
          baseURL, apiKey: 'cannbot-managed-by-plugin',
          async fetch(input, init) {
            const req = new Request(input, { ...init, duplex: 'half' })
            if (req.url !== chatURL || req.method !== 'POST') throw new Error('CANNBOT 只允许向已核验的 chat/completions 端点发送请求')
            const { jwt, vk } = await readAuth(await getAuth())
            const headers = new Headers(req.headers)
            // Replace caller/SDK credentials and remove credentials for other protocols.
            for (const name of ['authorization', 'api-key', 'x-api-vkey', 'x-api-key', 'cookie', 'proxy-authorization']) headers.delete(name)
            headers.set('authorization', `Bearer ${jwt}`)
            headers.set('x-api-vkey', vk)
            headers.set('api-key', vk)
            // Output adapter: buffer the gateway-bound JSON body, clamp the
            // budget to upstream truth, switch along the chain when the caller
            // asks for more output than the primary can deliver. Parse
            // failures forward the buffered bytes verbatim.
            let outBody = req.body
            let planned = null
            if (autoOn && req.body != null) {
              let bytes
              try {
                bytes = Buffer.from(await new Response(req.body).arrayBuffer())
              } catch (error) {
                throw Object.assign(new Error(`CANNBOT auto 读取请求体失败：${error?.message || error}`), { status: 400 })
              }
              try {
                planned = planBody(bytes, { mode: auto.mode, limits: mergedLimits(), chain: auto.chain, catalog: catalogCache })
              } catch { planned = null }
              headers.delete('content-length')
              outBody = planned?.bodyText != null ? planned.bodyText : bytes
            }
            const sentBytes = planned?.bodyText != null ? Buffer.byteLength(planned.bodyText) : 0
            // ── pre-send payload guard ─────────────────────────────────────
            // When evidence says this member rejects bodies of this size,
            // swap to a chain member that has carried equal-or-bigger bodies
            // (or has no 413 record) BEFORE sending: no failed request, no
            // retry latency. First-time 413s still fall to the reactive retry.
            if (autoOn && planned?.bodyText != null && sentBytes > 0) {
              const head = planned.switched?.to ?? planned.model
              const pre = payloadLimits[head]
              if (pre?.minFail != null && sentBytes >= pre.minFail) {
                const candidate = payloadCandidate(head, sentBytes)
                if (candidate) {
                  try {
                    const parsed = JSON.parse(planned.bodyText)
                    parsed.model = candidate
                    const newText = JSON.stringify(parsed)
                    if (newText !== planned.bodyText) {
                      planned.bodyText = newText
                      planned.switched = { from: head, to: candidate, reason: 'payload' }
                      outBody = newText
                    }
                  } catch { /* guard is best-effort */ }
                }
              }
            }
            const send = (bodyValue) => fetchImpl(chatURL, {
              method: 'POST', headers, body: bodyValue,
              signal: req.signal, redirect: 'error',
            })
            const respond = (source, bodyOverride, switched) => {
              const marked = new Headers(source.headers)
              if (switched) {
                marked.set('x-cannbot-auto-from', switched.from)
                marked.set('x-cannbot-auto-model', switched.to)
              }
              marked.delete('content-length')
              return new Response(bodyOverride ?? source.body, { status: source.status, statusText: source.statusText, headers: marked })
            }
            // ── 0.5.0 stream-failure retry ────────────────────────────────
            // The gateway sometimes ends an SSE stream without a
            // finish_reason (budget exhausted mid-reasoning → abrupt close)
            // or with finish_reason=length and no content at all. Attempt-1
            // is forwarded live; if it terminates in either of those ways
            // with nothing answer-like forwarded (no content / tool_calls),
            // it is transparently retried on the next chain candidate and
            // that stream is appended. Everything fails open: any wrapper
            // error surfaces the original stream.
            const chainTarget = (currentModel, requestedOutput) => {
              const known = !!catalogCache && Object.keys(catalogCache).length > 0
              const merged = mergedLimits()
              const members = []
              for (const entry of auto?.chain || []) {
                const m = typeof entry === 'string' ? entry : entry?.model
                if (!m || m === currentModel || members.some((x) => x.model === m)) continue
                if (known && !(m in catalogCache)) continue
                let cap = typeof entry === 'object' && Number.isFinite(entry.limit) ? entry.limit : null
                if (cap == null && Number.isFinite(merged[m])) cap = merged[m]
                if (cap == null && known && catalogCache[m]?.limit?.output != null) cap = catalogCache[m].limit.output
                if (!Number.isFinite(cap) || cap <= 0) continue
                members.push({ model: m, cap })
              }
              const enough = requestedOutput != null
                ? members.filter((x) => x.cap >= requestedOutput)
                : members
              if (enough.length) return enough[0].model
              if (members.length) return members.sort((a, b) => b.cap - a.cap)[0].model
              return currentModel
            }
            const streamRetryPump = async (controller, firstBody, requestedOutput) => {
              console.error('[dbg] pump start, model=%s, requested=%s', planned?.model, requestedOutput)
              let attempt = 1
              let currentModel = planned?.model
              let stream = firstBody
              try {
                while (stream) {
                  const scan = { tail: Buffer.alloc(0), finish: null, content: false, tool: false, done: false }
                  const update = (chunk) => {
                    const win = Buffer.concat([scan.tail, chunk])
                    const f = /"finish_reason":"([a-z_]+)"/.exec(win.toString('utf8'))
                    if (f) scan.finish = f[1]
                    if (win.includes('"tool_calls"')) scan.tool = true
                    if (win.includes('"delta":{"content"') || win.includes('"message":{"content":"')) scan.content = true
                    if (win.includes('data: [DONE]')) scan.done = true
                    scan.tail = win.subarray(Math.max(0, win.length - 64))
                  }
                  const reader = (stream.getReader ? stream : stream.body).getReader()
                  const held = []
                  let premature = false
                  try {
                    for (;;) {
                      const { done, value } = await reader.read()
                      if (done) { premature = !scan.finish && !scan.done; break }
                      if (!value) continue
                      update(value)
                      if (scan.finish) held.push(value)
                      else controller.enqueue(value)
                    }
                  } catch { premature = true }
                  const starved = scan.finish === 'length' && !scan.content && !scan.tool
                  console.error('[dbg] after read: premature=%s finish=%s content=%s tool=%s done=%s retryable-check=%s', premature, scan.finish, scan.content, scan.tool, scan.done, attempt === 1 && (premature || starved) && !scan.content && !scan.tool)
                  const retryable = attempt === 1 && (premature || starved) && !scan.content && !scan.tool
                  if (!retryable) {
                    for (const h of held) controller.enqueue(h)
                    break
                  }
                  // pick the retry target: first chain candidate that can carry
                  // the budget; otherwise the largest-capacity member; if the
                  // chain is exhausted, the same model gets one clean retry.
                  const target = chainTarget(currentModel, requestedOutput)
                  let retryBodyText = null
                  try {
                    const parsed = JSON.parse(planned.bodyText)
                    parsed.model = target
                    retryBodyText = JSON.stringify(parsed)
                  } catch { }
                  if (retryBodyText == null || retryBodyText === planned.bodyText) {
                    for (const h of held) controller.enqueue(h)
                    break
                  }
                  const res2 = await send(retryBodyText)
                  if (res2.status >= 400) { await res2.text().catch(() => {}); break }
                  stream = res2.body
                  currentModel = target
                  attempt += 1
                  controller.enqueue(Buffer.from('\n', 'utf8'))
                }
              } catch { /* fail-open: end the stream where it is */ }
              try { controller.close() } catch { }
            }
            let res = await send(outBody)
            // Learn the gateway's enforced output ceiling from a 400 that names
            // it ("expected a value <= N"), then retry once with a re-planned
            // request when the new truth changes the plan. Never retries
            // identical bytes; learning is one retry at most.
            let failureText = null
            if (res.status >= 400 && autoOn && planned?.model && planned.bodyText != null) {
              failureText = await res.text().catch(() => '')
              const learned = /expected a value <=\s*(\d+)/i.exec(failureText)
              if (learned) {
                const cap = Number(learned[1])
                const sentModel = planned.switched?.to ?? planned.model
                if (cap > 0 && (enforced[sentModel] == null || cap < enforced[sentModel])) {
                  enforced[sentModel] = cap
                  saveEvidence()
                  try {
                    const replan = planBody(Buffer.from(planned.bodyText, 'utf8'), {
                      mode: auto.mode, limits: mergedLimits(), chain: auto.chain, catalog: catalogCache,
                    })
                    if (replan.bodyText != null && replan.bodyText !== planned.bodyText) {
                      const retried = await send(replan.bodyText)
                      if (retried.status < 400) return respond(retried, null, replan.switched)
                      res = retried
                      failureText = null
                    }
                  } catch { /* learning is best-effort; fall through with the failure */ }
                }
              }
            }
            // ── payload-too-large chain retry (0.5.1) ─────────────────────
            // 413 (or a 400 naming a size limit) from this member is a
            // per-model upstream capacity bar, not a gateway-wide one: the
            // same body is often fine on another chain member. One
            // transparent retry along the chain; a gateway-wide limit or an
            // exhausted chain falls through to the client as before.
            if (autoOn && planned?.model && planned.bodyText != null &&
                (res.status === 413 ||
                 (res.status === 400 && /payload too large|request entity too large|request too large/i.test(failureText ?? '')))) {
              if (failureText == null) failureText = await res.text().catch(() => '')
              const cur = planned.switched?.to ?? planned.model
              // record the payload rejection: this member's limit is below sentBytes
              const pl413 = payloadLimits[cur] ?? (payloadLimits[cur] = {})
              pl413.minFail = Math.min(pl413.minFail ?? Infinity, sentBytes)
              saveEvidence()
              const target = chainTarget(cur, planned.requested ?? null)
              let retryBodyText = null
              try {
                const parsed = JSON.parse(planned.bodyText)
                parsed.model = target
                retryBodyText = JSON.stringify(parsed)
              } catch { }
              if (target && target !== cur && retryBodyText != null && retryBodyText !== planned.bodyText) {
                try {
                  const retried = await send(retryBodyText)
                  if (retried.status < 400) {
                    res = retried
                    planned.switched = { ...(planned.switched || { from: cur }), to: target, reason: 'payload-retry' }
                  }
                  // else: keep the original failure for the client
                } catch { /* fail-open with the original failure */ }
              }
            }
            // Successful JSON/SSE: SSE responses get the stream-failure retry
            // wrapper; other bodies pass through unchanged.
            if (res.status < 400) {
              // record the payload success: this member carried sentBytes
              const okModel = planned?.switched?.to ?? planned?.model
              if (okModel && sentBytes > 0) {
                const pl = payloadLimits[okModel] ?? (payloadLimits[okModel] = {})
                const before = pl.maxOk ?? 0
                pl.maxOk = Math.max(before, sentBytes)
                if (pl.maxOk !== before) saveEvidence()
              }
              const ctype = String(res.headers.get('content-type') || '')
              if (autoOn && auto.streamRetry !== false && res.body && ctype.includes('text/event-stream') && planned?.model != null) {
                const body = new ReadableStream({
                  start: (controller) => {
                    void streamRetryPump(controller, res.body, planned.requested ?? null).catch(() => {
                      try { controller.close() } catch { }
                    })
                  },
                })
                return respond(res, body, planned?.switched)
              }
              return respond(res, null, planned?.switched)
            }
            // Never include provider-echoed secrets in an error returned to clients.
            let text = failureText != null ? failureText : await res.text().catch(() => '')
            for (const secret of [jwt, vk]) text = text.split(secret).join('[redacted]')
            const outHeaders = new Headers(res.headers)
            outHeaders.delete('content-length')
            outHeaders.delete('content-encoding')
            return new Response(text, { status: res.status, statusText: res.statusText, headers: outHeaders })
          },
        }
      },
    },
    provider: {
      id: ID,
      async models(provider, { auth, signal } = {}) {
        if (!auth) return provider.models
        const { jwt } = await readAuth(auth)
        let res
        try { res = await modelsResponse(jwt, signal) } catch {
          if (signal?.aborted) throw new Error('CANNBOT 模型目录请求已取消')
          return provider.models
        }
        if (res.status === 401 || res.status === 403) throw authError(`CANNBOT 拒绝了登录凭据（HTTP ${res.status}）；请在 CANNWork 续期或重新导入`)
        if (!res.ok) return provider.models
        let body
        try { body = await res.json() } catch { throw new Error('CANNBOT 模型目录不是有效 JSON') }
        const rows = catalogRows(body, baseURL)
        catalogCache = rows
        // Report the deliverable budget (own truthful limit or the chain's
        // largest) so hosts configure realistic caps; advertised-but-
        // unenforceable values must not leak into host configs.
        if (auto?.report) {
          const reported = Object.create(null)
          for (const [id, row] of Object.entries(rows)) {
            const effective = effectiveOutputOf(id, { limits: mergedLimits(), chain: auto.chain, catalog: rows })
            reported[id] = effective != null
              ? { ...row, limit: { ...row.limit, output: effective } }
              : row
          }
          return reported
        }
        return rows
      },
    },
  }
}
