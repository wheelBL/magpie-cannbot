import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as oauth from '../lib/oauth.mjs'
import {
  catalogRows,
  createPlugin,
  modelRow,
  secureEndpoint,
} from '../lib/provider.mjs'

const CHAT = 'https://cannbot.hicann.cn/gateway/compatible-mode/v1/chat/completions'
const CATALOG = { success: true, data: { personalModels: [{ model: 'm', apiKey: 'vk-1' }], builtinModels: [] } }

const jwtWith = (claims) => {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${part({ alg: 'none', typ: 'JWT' })}.${part(claims)}.sig`
}

const json = (value, status = 200) => new Response(JSON.stringify(value), { status })

function sse(payload) {
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`event:success\ndata:${JSON.stringify(payload)}\n\n`))
      controller.close()
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

test('tokenState and jwtExpiry read the JWT’s exp', () => {
  const now = 1_800_000_000_000
  const at = (seconds) => jwtWith({ exp: Math.floor(now / 1000) + seconds })
  assert.equal(oauth.tokenState(at(3600), now), 'valid')
  assert.equal(oauth.tokenState(at(120), now), 'expiring')
  assert.equal(oauth.tokenState(at(-1), now), 'expired')
  assert.equal(oauth.tokenState('nope', now), 'unknown')
  assert.equal(oauth.jwtExpiry(at(60)), now + 60_000)
})

test('secureEndpoint and credential refuse unsafe input', () => {
  assert.throws(() => secureEndpoint('http://cannbot.hicann.cn/v1'), /HTTPS/)
  assert.throws(() => secureEndpoint('https://u:p@cannbot.hicann.cn/v1'), /用户信息/)
  assert.equal(secureEndpoint('https://cannbot.hicann.cn/v1/'), 'https://cannbot.hicann.cn/v1')
  assert.equal(secureEndpoint('http://127.0.0.1:3499/v1'), 'http://127.0.0.1:3499/v1')
  assert.throws(() => oauth.credential('has space', 'accessToken'), /格式无效/)
  assert.equal(oauth.credential('ok-token', 'accessToken'), 'ok-token')
})

test('catalogRows tolerates a missing list and refuses an empty catalog', () => {
  assert.deepEqual(Object.keys(catalogRows(CATALOG)), ['m'])
  assert.deepEqual(Object.keys(catalogRows({ success: true, data: { builtinModels: [{ model: 'b' }] } })), ['b'])
  assert.deepEqual(Object.keys(catalogRows({ success: true, data: { personalModels: [{ model: 'p' }] } })), ['p'])
  assert.throws(() => catalogRows({ success: true, data: {} }), /没有模型/)
  const row = modelRow({ model: 'x' })
  assert.equal(row.limit.context, 1048576)
  assert.equal(row.capabilities.toolcall, true)
})

test('refreshSignIn trades the refresh token and keeps the rotated one', async () => {
  const tokens = await oauth.refreshSignIn('r-old', {
    ideType: 'vscode',
    fetchImpl: async (url, init) => {
      assert.equal(url, oauth.REFRESH_URL)
      assert.deepEqual(JSON.parse(init.body), { refreshToken: 'r-old', ideType: 'vscode' })
      return json({ accessToken: 'a-new', refreshToken: 'r-new', expiresIn: 3600 })
    },
  })
  assert.equal(tokens.accessToken, 'a-new')
  assert.equal(tokens.refreshToken, 'r-new')
  assert.ok(tokens.expires > Date.now())
})

test('the OAuth method hands magpie a URL and resolves the SSE callback', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('/api/oauth/authorize')) {
      return json({ authorizeUrl: 'https://gitcode.com/oauth/authorize?x=1', state: 's-1' })
    }
    if (String(url).includes('/api/oauth/sse/connect')) {
      return sse({ accessToken: 'access-1', refreshToken: 'refresh-1', expiresIn: 3600 })
    }
    if (String(url).includes('/api/oauth/userinfo')) return json({ username: 'xubinglin' })
    return json(CATALOG)
  }
  const plugin = createPlugin({ fetchImpl })
  const method = plugin.auth.methods[0]
  assert.equal(method.type, 'oauth')
  assert.match(method.label, /GitCode/)
  const started = await method.authorize()
  assert.equal(started.url, 'https://gitcode.com/oauth/authorize?x=1')
  assert.equal(started.method, 'auto')
  const result = await started.callback()
  assert.equal(result.type, 'success')
  assert.equal(result.access, 'access-1')
  assert.equal(result.refresh, 'refresh-1')
  assert.equal(result.accountId, 'xubinglin')
  assert.ok(result.expires > Date.now())
})

test('an OAuth account signs requests with its access token and the cached VK', async () => {
  const token = jwtWith({ exp: Math.floor(Date.now() / 1000) + 3600 })
  let catalogs = 0
  const seen = []
  const plugin = createPlugin({
    fetchImpl: async (url, init) => {
      if (String(url).includes('api/models/personal')) {
        catalogs += 1
        return json(CATALOG)
      }
      seen.push(init.headers)
      return json({ ok: true })
    },
  })
  const loader = await plugin.auth.loader(async () => ({ type: 'oauth', access: token, refresh: 'r', expires: 9e15 }))
  const res = await loader.fetch(CHAT, { method: 'POST', headers: { 'x-api-key': 'wrong' }, body: '{"model":"m"}' })
  assert.equal(res.status, 200)
  assert.equal(seen[0].get('authorization'), `Bearer ${token}`)
  assert.equal(seen[0].get('x-api-vkey'), 'vk-1')
  assert.equal(seen[0].get('api-key'), 'vk-1')
  await loader.fetch(CHAT, { method: 'POST', body: '{"model":"m"}' })
  assert.equal(catalogs, 1, 'the catalog VK is cached across requests')
})

test('an upstream 401 is marked as a lapsed sign-in', async () => {
  const token = jwtWith({ exp: Math.floor(Date.now() / 1000) + 3600 })
  const plugin = createPlugin({
    fetchImpl: async (url) => String(url).includes('api/models/personal')
      ? json(CATALOG)
      : new Response('{"error":"revoked"}', { status: 401 }),
  })
  const loader = await plugin.auth.loader(async () => ({ type: 'oauth', access: token, refresh: 'r', expires: 9e15 }))
  const res = await loader.fetch(CHAT, { method: 'POST', body: '{"model":"m"}' })
  assert.equal(res.status, 401)
  assert.equal(res.headers.get('x-magpie-sign-in'), 'expired')
})

test('a lapsed OAuth sign-in is answered with a marked 401, not a thrown fetch', async () => {
  const plugin = createPlugin({ fetchImpl: async () => json({}) })
  const loader = await plugin.auth.loader(async () => ({ type: 'oauth', access: '', refresh: 'r' }))
  const res = await loader.fetch(CHAT, { method: 'POST', body: '{}' })
  assert.equal(res.status, 401)
  assert.equal(res.headers.get('x-magpie-sign-in'), 'expired')
})

test('the plugin offers the OAuth method only', () => {
  const plugin = createPlugin({ fetchImpl: async () => json({}) })
  assert.equal(plugin.auth.methods.length, 1)
  assert.equal(plugin.auth.methods[0].type, 'oauth')
})

test('a non-OAuth account is refused instead of signed', async () => {
  const plugin = createPlugin({ fetchImpl: async () => json({}) })
  const loader = await plugin.auth.loader(async () => ({ type: 'api', key: 'x', metadata: { method: 'paste' } }))
  const res = await loader.fetch(CHAT, { method: 'POST', body: '{}' })
  assert.equal(res.status, 401)
  assert.equal(res.headers.get('x-magpie-sign-in'), 'expired')
})

test('the refresh hook returns the fields magpie keeps', async () => {
  const plugin = createPlugin({
    fetchImpl: async () => json({ accessToken: 'a-2', refreshToken: 'r-2', expiresIn: 3600 }),
  })
  const next = await plugin.auth.refresh({ type: 'oauth', access: 'a-1', refresh: 'r-1', expires: 1 })
  assert.equal(next.access, 'a-2')
  assert.equal(next.refresh, 'r-2')
  assert.ok(next.expires > Date.now())
  await assert.rejects(plugin.auth.refresh({ type: 'oauth' }), /refreshToken/)
})

test('waitForTokens reports a timeout and a cancellation in words', async () => {
  const never = async (url, init) => new Promise((_, reject) => {
    init.signal?.addEventListener('abort', () => {
      const error = new Error('aborted')
      error.name = 'AbortError'
      reject(error)
    }, { once: true })
  })
  await assert.rejects(
    oauth.waitForTokens('s-timeout', { fetchImpl: never, timeoutMs: 20 }),
    /登录超时/,
  )
  const controller = new AbortController()
  const pending = oauth.waitForTokens('s-cancel', { fetchImpl: never, signal: controller.signal, timeoutMs: 60_000 })
  controller.abort()
  await assert.rejects(pending, /登录已取消/)
})

test('the auth hook is single-account and has no API-key method', () => {
  const plugin = createPlugin({ fetchImpl: async () => json({}) })
  assert.equal(plugin.auth.single, true)
  assert.equal(plugin.auth.methods.length, 1)
  assert.equal(plugin.auth.methods[0].type, 'oauth')
  assert.equal(typeof plugin.auth.refresh, 'function')
  assert.equal(plugin.auth.keepAlive, true)
})

test('the model listing reads the catalog once and needs no Virtual Key', async () => {
  const token = jwtWith({ exp: Math.floor(Date.now() / 1000) + 3600 })
  let catalogs = 0
  const plugin = createPlugin({
    fetchImpl: async (url) => {
      assert.match(String(url), /api\/models\/personal/)
      catalogs += 1
      return json(CATALOG)
    },
  })
  const models = await plugin.provider.models({ models: {} }, { auth: { type: 'oauth', access: token, refresh: 'r', expires: 9e15 } })
  assert.deepEqual(Object.keys(models), ['m'])
  assert.equal(catalogs, 1)
})
