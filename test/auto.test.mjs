import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readAutoConfig, planBody, outputLimitOf, effectiveOutputOf } from '../lib/auto.mjs'
import { createPlugin } from '../lib/provider.mjs'

const body = (over = {}) => Buffer.from(JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }], max_tokens: 100, ...over }))
const cfg = (over = {}) => ({ mode: 'switch', limits: { 'deepseek-v4.1-flash': 4096 }, chain: [{ model: 'glm-5.3', limit: 131072 }, { model: 'qwen3.8-max', limit: 131072 }], report: false, ...over })
const catalog = {
  'deepseek-v4.1-flash': { limit: { context: 1048576, output: 4000 } },
  'glm-5.3': { limit: { context: 1048576, output: 131072 } },
  'qwen3.8-max': { limit: { context: 1048576, output: 131072 } },
}

test('readAutoConfig: 默认值与 limits 解析', () => {
  const a = readAutoConfig({ CANNBOT_AUTO_LIMITS: '{"x":10}', CANNBOT_AUTO_REPORT: '0' })
  assert.equal(a.mode, 'switch')
  assert.deepEqual(a.limits, { 'deepseek-v4.1-flash': 4096, x: 10 })
  assert.equal(a.report, false)
  const b = readAutoConfig({})
  assert.equal(b.mode, 'switch')
  assert.equal(b.report, true)
  assert.equal(b.chain.length, 2)
})

test('readAutoConfig: 非法输入回退默认并告警', () => {
  const a = readAutoConfig({ CANNBOT_AUTO_MODE: 'nope', CANNBOT_AUTO_LIMITS: 'oops', CANNBOT_AUTO_CHAIN: 'bad:abc' })
  assert.equal(a.mode, 'switch')
  assert.deepEqual(a.limits, { 'deepseek-v4.1-flash': 4096 })
  assert.equal(a.chain.length, 2)
  assert.ok(a.warnings.length >= 3)
})

test('planBody: clamp 模式只收敛不切换', () => {
  const r = planBody(body({ max_tokens: 393216 }), { mode: 'clamp', limits: { 'deepseek-v4.1-flash': 4096 } })
  const parsed = JSON.parse(r.bodyText)
  assert.equal(parsed.model, 'deepseek-v4.1-flash')
  assert.equal(parsed.max_tokens, 4096)
  assert.deepEqual(r.clamped, { from: 393216, to: 4096 })
  assert.equal(r.switched, null)
})

test('planBody: 输出超限切换到链上第一个够容量的成员', () => {
  const r = planBody(body({ max_tokens: 50000 }), cfg())
  const parsed = JSON.parse(r.bodyText)
  assert.equal(parsed.model, 'glm-5.3')
  assert.equal(parsed.max_tokens, 50000)
  assert.deepEqual(r.switched, { from: 'deepseek-v4.1-flash', to: 'glm-5.3', reason: 'output' })
})

test('planBody: 上限取 curated 与 catalog 的较小值（4000 < 4096）', () => {
  const r = planBody(body({ max_tokens: 4096 }), cfg({ catalog }))
  assert.deepEqual(r.switched, { from: 'deepseek-v4.1-flash', to: 'glm-5.3', reason: 'output' })
})

test('planBody: catalog 内不存在的链成员被跳过', () => {
  const cat = { 'deepseek-v4.1-flash': catalog['deepseek-v4.1-flash'], 'qwen3.8-max': catalog['qwen3.8-max'] }
  const r = planBody(body({ max_tokens: 50000 }), cfg({ catalog: cat }))
  assert.equal(JSON.parse(r.bodyText).model, 'qwen3.8-max')
})

test('planBody: 没有成员容量足够时切到最大容量成员并收敛', () => {
  const r = planBody(body({ max_tokens: 500000 }), cfg())
  const parsed = JSON.parse(r.bodyText)
  assert.equal(parsed.model, 'glm-5.3')
  assert.equal(parsed.max_tokens, 131072)
  assert.equal(r.switched.reason, 'output-clamped')
  assert.deepEqual(r.clamped, { from: 500000, to: 131072 })
})

test('planBody: 链上完全无成员时在主模型上收敛', () => {
  const r = planBody(body({ max_tokens: 999999 }), cfg({ chain: [], catalog }))
  const parsed = JSON.parse(r.bodyText)
  assert.equal(parsed.model, 'deepseek-v4.1-flash')
  assert.equal(parsed.max_tokens, 4000)
  assert.equal(r.switched, null)
  assert.ok(r.clamped)
})

test('planBody: 需求在上限内时不改写', () => {
  const r = planBody(body({ max_tokens: 4000 }), cfg({ catalog }))
  assert.deepEqual(JSON.parse(r.bodyText), JSON.parse(body({ max_tokens: 4000 }).toString()))
  assert.equal(r.switched, null)
  assert.equal(r.clamped, null)
})

test('planBody: max_completion_tokens 同样处理；两键并存一并改写', () => {
  const r = planBody(body({ max_tokens: 50000, max_completion_tokens: 50000 }), cfg())
  const parsed = JSON.parse(r.bodyText)
  assert.equal(parsed.model, 'glm-5.3')
  assert.equal(parsed.max_completion_tokens, 50000)
})

test('planBody: 未知模型不猜上限，保持原样', () => {
  const r = planBody(body({ model: 'mystery-1', max_tokens: 999999 }), cfg())
  assert.equal(JSON.parse(r.bodyText).max_tokens, 999999)
  assert.equal(r.switched, null)
  assert.ok(r.note)
})

test('planBody: 缺 max_tokens / 非 JSON / 非对象保持原样', () => {
  for (const raw of [body({ max_tokens: undefined }), Buffer.from('not-json'), Buffer.from('[1,2]')]) {
    const r = planBody(raw, cfg())
    assert.equal(r.switched, null)
    assert.ok(r.note)
  }
})

test('planBody: provider 前缀识别且切换后发送裸 id', () => {
  const r = planBody(body({ model: 'cannbot/deepseek-v4.1-flash', max_tokens: 50000 }), cfg())
  assert.equal(JSON.parse(r.bodyText).model, 'glm-5.3')
})

test('planBody: enforced 实测上限参与收敛（由调用方合并传入）', () => {
  const r = planBody(body({ max_tokens: 50000 }), cfg({ limits: { 'deepseek-v4.1-flash': 4096, 'glm-5.3': 8192 }, catalog: null }))
  const parsed = JSON.parse(r.bodyText)
  assert.equal(parsed.model, 'qwen3.8-max', 'glm 被实测压到 8192 < 50000 → 跳过 → qwen')
})

test('effectiveOutputOf: 链提升有效输出容量', () => {
  assert.equal(effectiveOutputOf('deepseek-v4.1-flash', cfg()), 131072)
  assert.equal(effectiveOutputOf('deepseek-v4.1-flash', cfg({ chain: [] })), 4096)
  assert.equal(outputLimitOf('unknown', null, {}), null)
})

// ── integration: loader fetch ────────────────────────────────────────────────

async function makePlugin(over = {}, fetchImpl) {
  const calls = []
  const impl = fetchImpl || (async (url, init) => {
    calls.push({ url: String(url), body: init?.body })
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  const plugin = createPlugin({ fetchImpl: impl, auto: cfg(over) })
  const auth = { type: 'api', key: 'vk-test', metadata: { method: 'paste', accessToken: 'jwt.a.b' } }
  const loader = await plugin.auth.loader(async () => auth)
  return { calls, loader, plugin }
}

const chatReq = (payload) => new Request('https://cannbot.hicann.cn/gateway/compatible-mode/v1/chat/completions', {
  method: 'POST', body: JSON.stringify(payload), headers: { 'content-type': 'application/json' },
})

test('loader fetch: 输出超限在网关边界切换并带标记', async () => {
  const { calls, loader } = await makePlugin()
  const res = await loader.fetch(chatReq({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }], max_tokens: 50000 }), {})
  assert.equal(JSON.parse(calls[0].body).model, 'glm-5.3')
  assert.equal(res.headers.get('x-cannbot-auto-from'), 'deepseek-v4.1-flash')
  assert.equal(res.headers.get('x-cannbot-auto-model'), 'glm-5.3')
  assert.equal(await res.text(), JSON.stringify({ ok: true }))
})

test('loader fetch: 上限内请求保持原模型且不带标记', async () => {
  const { calls, loader } = await makePlugin()
  const res = await loader.fetch(chatReq({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1000 }), {})
  assert.equal(JSON.parse(calls[0].body).model, 'deepseek-v4.1-flash')
  assert.equal(res.headers.get('x-cannbot-auto-model'), null)
})

test('loader fetch: 非 JSON 请求体按字节转发', async () => {
  const { calls, loader } = await makePlugin()
  const raw = 'binary-ish {"broken'
  const req = new Request('https://cannbot.hicann.cn/gateway/compatible-mode/v1/chat/completions', {
    method: 'POST', body: raw, headers: { 'content-type': 'application/json' },
  })
  await loader.fetch(req, {})
  assert.equal(calls[0].body.toString(), raw)
})

test('loader fetch: 400 学习强制上限并透明重试切换', async () => {
  const seen = []
  const plugin = createPlugin({
    fetchImpl: async (url, init) => {
      if (String(url).includes('/models/personal')) {
        return new Response(JSON.stringify({
          success: true,
          data: {
            personalModels: [
              { model: 'deepseek-v4-flash', title: 'DS', contextLength: 1048576, completionOptions: { maxTokens: 393216 } },
              { model: 'glm-5.3', title: 'GLM', contextLength: 1048576, completionOptions: { maxTokens: 131072 } },
            ],
            builtinModels: [],
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      const sent = JSON.parse(init.body)
      seen.push(sent.model)
      if (sent.model === 'deepseek-v4-flash') {
        return new Response(JSON.stringify({ error: { message: 'integer above maximum value, expected a value <= 4096, but got 50000 instead.' } }),
          { status: 400, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ ok: true, served: sent.model }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
    auto: cfg({ limits: {}, report: true }),
  })
  const auth = { type: 'api', key: 'vk', metadata: { method: 'paste', accessToken: 'jwt' } }
  const loader = await plugin.auth.loader(async () => auth)
  const res = await loader.fetch(chatReq({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }], max_tokens: 50000 }), {})
  assert.equal(res.status, 200)
  assert.deepEqual(seen, ['deepseek-v4-flash', 'glm-5.3'], '400 → 学习 → 重试切换')
  assert.equal(res.headers.get('x-cannbot-auto-model'), 'glm-5.3')
  const rows = await plugin.provider.models({}, { auth })
  assert.equal(rows['deepseek-v4-flash'].limit.output, 131072, '学习值参与有效容量上报')
})

test('loader fetch: 学习后方案相同则不重试，错误按脱敏转发', async () => {
  const calls = []
  const plugin = createPlugin({
    fetchImpl: async (url, init) => {
      calls.push(String(url))
      const echoed = init?.headers?.get?.('authorization') ?? ''
      return new Response(JSON.stringify({ error: { message: `bad request (auth=${echoed}), expected a value <= 4096` } }),
        { status: 400, headers: { 'content-type': 'application/json' } })
    },
    auto: cfg({ mode: 'clamp', limits: { 'deepseek-v4.1-flash': 4096 } }),
  })
  const auth = { type: 'api', key: 'vk-secret', metadata: { method: 'paste', accessToken: 'jwt-secret' } }
  const loader = await plugin.auth.loader(async () => auth)
  const res = await loader.fetch(chatReq({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }], max_tokens: 393216 }), {})
  assert.equal(res.status, 400)
  const text = await res.text()
  assert.ok(text.includes('[redacted]'))
  assert.ok(!text.includes('vk-secret') && !text.includes('jwt-secret'))
  assert.equal(calls.length, 1)
})

test('loader fetch: 非上限类 400 不学习不重试', async () => {
  const calls = []
  const plugin = createPlugin({
    fetchImpl: async () => {
      calls.push('chat')
      return new Response(JSON.stringify({ error: { message: 'invalid messages format' } }), { status: 400, headers: { 'content-type': 'application/json' } })
    },
    auto: cfg(),
  })
  const auth = { type: 'api', key: 'vk', metadata: { method: 'paste', accessToken: 'jwt' } }
  const loader = await plugin.auth.loader(async () => auth)
  const res = await loader.fetch(chatReq({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }], max_tokens: 50000 }), {})
  assert.equal(res.status, 400)
  assert.equal(calls.length, 1)
})

test('loader fetch: catalog 由 models hook 缓存并参与判定', async () => {
  const plugin = createPlugin({
    fetchImpl: async (url, init) => {
      if (String(url).includes('/models/personal')) {
        return new Response(JSON.stringify({
          success: true,
          data: {
            personalModels: [
              { model: 'deepseek-v4.1-flash', title: 'DS', contextLength: 1048576, completionOptions: { maxTokens: 4000 } },
              { model: 'glm-5.3', title: 'GLM', contextLength: 1048576, completionOptions: { maxTokens: 131072 } },
            ],
            builtinModels: [],
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    },
    auto: cfg({ report: true }),
  })
  const auth = { type: 'api', key: 'vk', metadata: { method: 'paste', accessToken: 'jwt' } }
  const loader = await plugin.auth.loader(async () => auth)
  const rows = await plugin.provider.models({}, { auth })
  assert.equal(rows['deepseek-v4.1-flash'].limit.output, 131072, '目录上报有效容量')
  const res = await loader.fetch(chatReq({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }], max_tokens: 4096 }), {})
  assert.equal(res.headers.get('x-cannbot-auto-model'), 'glm-5.3', 'catalog 上限 4000 < 4096 → 切换')
})
