import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import * as signin from '../lib/signin.mjs'
import {
  createPlugin,
  credential,
  catalogRows,
  modelRow,
  resolveCredentials,
  secureEndpoint,
  LOCAL,
} from '../lib/provider.mjs'

const CHAT = 'https://cannbot.hicann.cn/gateway/compatible-mode/v1/chat/completions'

const jwtWith = (claims) => {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${part({ alg: 'none', typ: 'JWT' })}.${part(claims)}.sig`
}

async function withTemp(run) {
  const root = mkdtempSync(join(tmpdir(), 'cannbot-repo-test-'))
  const previous = { data: process.env.XDG_DATA_HOME, config: process.env.XDG_CONFIG_HOME }
  process.env.XDG_DATA_HOME = join(root, 'data')
  process.env.XDG_CONFIG_HOME = join(root, 'config')
  try {
    return await run(root)
  } finally {
    if (previous.data === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = previous.data
    if (previous.config === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previous.config
    rmSync(root, { recursive: true, force: true })
  }
}

function writeSession(root, accessToken) {
  mkdirSync(join(root, 'data', 'opencode'), { recursive: true })
  writeFileSync(join(root, 'data', 'opencode', 'session.json'), JSON.stringify({ accessToken }))
}

function writeAuthJson(root, vk) {
  mkdirSync(join(root, 'data', 'opencode'), { recursive: true })
  writeFileSync(join(root, 'data', 'opencode', 'auth.json'), JSON.stringify({ cannbot: { type: 'api', key: vk } }))
}

test('tokenState tells valid, expiring, expired and unknown apart', () => {
  const now = 1_800_000_000_000
  const at = (seconds) => jwtWith({ exp: Math.floor(now / 1000) + seconds })
  assert.equal(signin.tokenState(at(3600), now), 'valid')
  assert.equal(signin.tokenState(at(120), now), 'expiring')
  assert.equal(signin.tokenState(at(-1), now), 'expired')
  assert.equal(signin.tokenState('not-a-jwt', now), 'unknown')
  assert.equal(signin.jwtExpiry(at(60)), now + 60_000)
})

test('secureEndpoint and credential refuse unsafe input', () => {
  assert.throws(() => secureEndpoint('http://cannbot.hicann.cn/v1'), /HTTPS/)
  assert.throws(() => secureEndpoint('https://user:pass@cannbot.hicann.cn/v1'), /用户信息/)
  assert.equal(secureEndpoint('https://cannbot.hicann.cn/v1/'), 'https://cannbot.hicann.cn/v1')
  assert.equal(secureEndpoint('http://127.0.0.1:3499/v1'), 'http://127.0.0.1:3499/v1')
  assert.throws(() => credential('has space', 'accessToken'), /格式无效/)
  assert.equal(credential('ok-token', 'accessToken'), 'ok-token')
})

test('catalogRows keeps personal rows first, one per model, and modelRow defaults', () => {
  const body = {
    success: true,
    data: {
      builtinModels: [{ model: 'glm-5.3', title: 'Builtin', contextLength: 1000, completionOptions: { maxTokens: 10 }, apiKey: 'vk' }],
      personalModels: [{ model: 'glm-5.3', title: 'GLM-5.3', contextLength: 1048576, completionOptions: { maxTokens: 131072 }, apiKey: 'vk' }],
    },
  }
  const rows = catalogRows(body)
  assert.deepEqual(Object.keys(rows), ['glm-5.3'])
  assert.equal(rows['glm-5.3'].name, 'GLM-5.3')
  assert.equal(rows['glm-5.3'].limit.context, 1048576)
  assert.equal(rows['glm-5.3'].limit.output, 131072)
  const fallback = modelRow({ model: 'm' })
  assert.equal(fallback.limit.context, 1048576)
  assert.equal(fallback.limit.output, 131072)
  assert.equal(fallback.capabilities.toolcall, true)
})

test('writeOwnAuth keeps magpie’s refresh token in a 0600 file', async () => {
  await withTemp(async (root) => {
    const path = signin.writeOwnAuth({ refreshToken: 'r-1' }, { ideType: 'vscode', accountId: 'u-1' })
    assert.equal(path, join(root, 'config', 'magpie', 'cannbot-signin.json'))
    assert.equal(statSync(path).mode & 0o777, 0o600)
    const value = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(value.refreshToken, 'r-1')
    assert.equal(value.ideType, 'vscode')
  })
})

test('ensureAccessToken refreshes magpie’s own token and recreates session.json', async () => {
  await withTemp(async (root) => {
    signin.writeOwnAuth({ refreshToken: 'own-old' }, { ideType: 'vscode' })
    const fresh = jwtWith({ exp: Math.floor(Date.now() / 1000) + 3600 })
    const token = await signin.ensureAccessToken({
      fetchImpl: async (url, init) => {
        assert.equal(url, signin.REFRESH_URL)
        assert.deepEqual(JSON.parse(init.body), { refreshToken: 'own-old', ideType: 'vscode' })
        return new Response(JSON.stringify({ accessToken: fresh, refreshToken: 'own-new' }), { status: 200 })
      },
    })
    assert.equal(token, fresh)
    assert.equal(JSON.parse(readFileSync(join(root, 'data', 'opencode', 'session.json'), 'utf8')).accessToken, fresh)
    assert.equal(signin.readOwnAuth().refreshToken, 'own-new')
  })
})

test('refreshOnce never spends the token while VS Code is open', async () => {
  await withTemp(async (root) => {
    writeSession(root, jwtWith({ exp: Math.floor(Date.now() / 1000) - 60 }))
    await assert.rejects(
      signin.refreshOnce(signin.readSessionFile(), { running: () => true }),
      /VS Code 正在运行/,
    )
  })
})

test('resolveCredentials refuses an expired imported token', async () => {
  const expired = jwtWith({ exp: Math.floor(Date.now() / 1000) - 60 })
  await assert.rejects(
    resolveCredentials({ type: 'api', key: 'vk-1', metadata: { method: 'paste', accessToken: expired } }),
    /已过期/,
  )
})

test('loader rewrites the gateway credentials and keeps only the verified endpoint', async () => {
  await withTemp(async (root) => {
    const token = jwtWith({ exp: Math.floor(Date.now() / 1000) + 3600 })
    writeSession(root, token)
    writeAuthJson(root, 'vk-test')
    const pin = createHash('sha256').update('vk-test').digest('hex')
    let seen
    const plugin = createPlugin({
      fetchImpl: async (url, init) => {
        seen = { url, headers: init.headers, body: init.body }
        return new Response('{"ok":true}', { status: 200 })
      },
    })
    const loader = await plugin.auth.loader(async () => ({
      type: 'api', key: LOCAL, metadata: { method: 'local', vkFingerprint: pin },
    }))
    const res = await loader.fetch(CHAT, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong', 'x-api-key': 'wrong', 'content-type': 'application/json' },
      body: '{"model":"deepseek-v4.1-flash"}',
    })
    assert.equal(res.status, 200)
    assert.equal(seen.url, CHAT)
    assert.equal(seen.headers.get('authorization'), `Bearer ${token}`)
    assert.equal(seen.headers.get('x-api-vkey'), 'vk-test')
    assert.equal(seen.headers.get('api-key'), 'vk-test')
    await assert.rejects(loader.fetch('https://evil.example/v1/chat/completions', { method: 'POST', body: '{}' }), /只允许/)
  })
})

test('loader answers a lapsed sign-in with a marked 401 instead of throwing', async () => {
  const plugin = createPlugin({
    readAuth: async () => {
      throw signin.signInError('CANNWork 登录态已失效')
    },
  })
  const loader = await plugin.auth.loader(async () => ({ type: 'api' }))
  const res = await loader.fetch(CHAT, { method: 'POST', body: '{}' })
  assert.equal(res.status, 401)
  assert.equal(res.headers.get('x-magpie-sign-in'), 'expired')
  assert.match(await res.text(), /登录态已失效/)
})

test('models maps the catalog and marks a refused sign-in', async () => {
  await withTemp(async (root) => {
    const token = jwtWith({ exp: Math.floor(Date.now() / 1000) + 3600 })
    writeSession(root, token)
    writeAuthJson(root, 'vk-test')
    const pin = createHash('sha256').update('vk-test').digest('hex')
    const plugin = createPlugin({
      fetchImpl: async () => new Response(JSON.stringify({
        success: true,
        data: { personalModels: [{ model: 'glm-5.3', title: 'GLM', contextLength: 100, completionOptions: { maxTokens: 10 } }], builtinModels: [] },
      }), { status: 200 }),
    })
    const models = await plugin.provider.models({ models: {} }, { auth: { type: 'api', key: LOCAL, metadata: { method: 'local', vkFingerprint: pin } } })
    assert.deepEqual(Object.keys(models), ['glm-5.3'])
  })
})

// --- native OAuth login ---------------------------------------------------

import * as oauth from '../lib/oauth.mjs'

test('startAuthorize asks for the web callback and returns the URL and state', async () => {
  let seen
  const out = await oauth.startAuthorize({
    fetchImpl: async (url) => {
      seen = url
      return new Response(JSON.stringify({ authorizeUrl: 'https://gitcode.com/oauth/authorize?x=1', state: 's-1' }), { status: 200 })
    },
  })
  assert.match(seen, /\/cannbot\/api\/oauth\/authorize\?ideType=codearts$/)
  assert.deepEqual(out, { authorizeUrl: 'https://gitcode.com/oauth/authorize?x=1', state: 's-1' })
})

test('SSE parser ignores heartbeats and returns the success tokens', () => {
  const feed = oauth.parseSseChunk('s-1')
  assert.equal(feed('event:heartbeat\ndata:123\n\n'), undefined)
  const tokens = feed('event:success\ndata:{"accessToken":"a","refreshToken":"r","expiresIn":3600}\n\n')
  assert.deepEqual(tokens, { state: 's-1', accessToken: 'a', refreshToken: 'r', expiresIn: 3600 })
})

test('SSE parser splits across chunks and reports an error event', () => {
  const feed = oauth.parseSseChunk('s-2')
  assert.equal(feed('event:succ'), undefined)
  const tokens = feed('ess\ndata:{"accessToken":"a2","refreshToken":"r2","expiresIn":60}\n\n')
  assert.equal(tokens.accessToken, 'a2')
  const bad = oauth.parseSseChunk('s-3')
  assert.throws(() => bad('event:error\ndata:{"message":"denied"}\n\n'), /denied/)
})

test('local credentials use the Virtual Key stored on the account row', async () => {
  await withTemp(async (root) => {
    const token = jwtWith({ exp: Math.floor(Date.now() / 1000) + 3600 })
    writeSession(root, token)
    const pin = createHash('sha256').update('vk-row').digest('hex')
    const creds = await resolveCredentials({
      type: 'api', key: LOCAL, metadata: { method: 'local', vk: 'vk-row', vkFingerprint: pin },
    })
    assert.equal(creds.jwt, token)
    assert.equal(creds.vk, 'vk-row')
  })
})

test('catalogVirtualKey reads the shared key from the authenticated catalog', async () => {
  const key = await oauth.catalogVirtualKey('jwt', {
    fetchImpl: async () => new Response(JSON.stringify({
      success: true,
      data: { personalModels: [{ model: 'm', apiKey: 'vk-1' }], builtinModels: [] },
    }), { status: 200 }),
  })
  assert.equal(key, 'vk-1')
})

// --- native OAuth as a magpie auth method ---------------------------------

function sseResponse(payload) {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`event:success\ndata:${JSON.stringify(payload)}\n\n`))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

test('the OAuth method hands magpie a URL and resolves the SSE callback', async () => {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push(String(url))
    if (String(url).includes('/api/oauth/authorize')) {
      return new Response(JSON.stringify({ authorizeUrl: 'https://gitcode.com/oauth/authorize?x=1', state: 's-1' }), { status: 200 })
    }
    if (String(url).includes('/api/oauth/sse/connect')) {
      return sseResponse({ accessToken: 'access-1', refreshToken: 'refresh-1', expiresIn: 3600 })
    }
    if (String(url).includes('/api/oauth/userinfo')) {
      return new Response(JSON.stringify({ username: 'xubinglin', email: 'x@example.com' }), { status: 200 })
    }
    return new Response(JSON.stringify({
      success: true,
      data: { personalModels: [{ model: 'm', apiKey: 'vk-oauth' }], builtinModels: [] },
    }), { status: 200 })
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

test('an OAuth account signs requests with its access token and the catalog VK', async () => {
  await withTemp(async () => {
    const token = jwtWith({ exp: Math.floor(Date.now() / 1000) + 3600 })
    let catalogCalls = 0
    const seen = []
    const plugin = createPlugin({
      fetchImpl: async (url, init) => {
        if (String(url).includes('api/models/personal')) {
          catalogCalls += 1
          return new Response(JSON.stringify({
            success: true,
            data: { personalModels: [{ model: 'm', apiKey: 'vk-oauth' }], builtinModels: [] },
          }), { status: 200 })
        }
        seen.push(init.headers)
        return new Response('{"ok":true}', { status: 200 })
      },
    })
    const loader = await plugin.auth.loader(async () => ({ type: 'oauth', access: token, refresh: 'r', expires: 9e15 }))
    const res = await loader.fetch(CHAT, { method: 'POST', headers: { 'x-api-key': 'wrong' }, body: '{"model":"m"}' })
    assert.equal(res.status, 200)
    assert.equal(seen[0].get('authorization'), `Bearer ${token}`)
    assert.equal(seen[0].get('x-api-vkey'), 'vk-oauth')
    assert.equal(seen[0].get('api-key'), 'vk-oauth')
    await loader.fetch(CHAT, { method: 'POST', body: '{"model":"m"}' })
    assert.equal(catalogCalls, 1, 'the catalog VK is cached across requests')
  })
})

test('an upstream 401 is marked as a lapsed sign-in', async () => {
  await withTemp(async () => {
    const token = jwtWith({ exp: Math.floor(Date.now() / 1000) + 3600 })
    const plugin = createPlugin({
      fetchImpl: async (url) => String(url).includes('api/models/personal')
        ? new Response(JSON.stringify({ success: true, data: { personalModels: [{ model: 'm', apiKey: 'vk' }], builtinModels: [] } }), { status: 200 })
        : new Response('{"error":"revoked"}', { status: 401 }),
    })
    const loader = await plugin.auth.loader(async () => ({ type: 'oauth', access: token, refresh: 'r', expires: 9e15 }))
    const res = await loader.fetch(CHAT, { method: 'POST', body: '{"model":"m"}' })
    assert.equal(res.status, 401)
    assert.equal(res.headers.get('x-magpie-sign-in'), 'expired')
  })
})

test('catalogRows accepts a personal-only or builtin-only account', () => {
  const personal = catalogRows({ success: true, data: { personalModels: [{ model: 'p', title: 'P' }] } })
  assert.deepEqual(Object.keys(personal), ['p'])
  const builtin = catalogRows({ success: true, data: { builtinModels: [{ model: 'b', title: 'B' }] } })
  assert.deepEqual(Object.keys(builtin), ['b'])
  assert.throws(() => catalogRows({ success: true, data: { personalModels: [], builtinModels: [] } }), /没有模型/)
})

test('credential files are written atomically with 0600 and no temp left behind', async () => {
  await withTemp(async (root) => {
    const path = signin.writeOwnAuth({ refreshToken: 'r-1' })
    assert.equal(statSync(path).mode & 0o777, 0o600)
    assert.deepEqual(readdirSync(join(root, 'config', 'magpie')).filter((name) => name.endsWith('.tmp')), [])
  })
})

test('the legacy local sign-in works with no opencode auth.json (VK from the catalog)', async () => {
  await withTemp(async (root) => {
    signin.writeOwnAuth({ refreshToken: 'own-1' }, { ideType: 'vscode' })
    const fresh = jwtWith({ exp: Math.floor(Date.now() / 1000) + 3600 })
    const plugin = createPlugin({
      fetchImpl: async (url) => {
        if (String(url).includes('/api/oauth/refresh')) {
          return new Response(JSON.stringify({ accessToken: fresh, refreshToken: 'own-2', expiresIn: 3600 }), { status: 200 })
        }
        if (String(url).includes('api/models/personal')) {
          return new Response(JSON.stringify({ success: true, data: { personalModels: [{ model: 'm', apiKey: 'vk-catalog' }], builtinModels: [] } }), { status: 200 })
        }
        return new Response('{}', { status: 200 })
      },
    })
    const method = plugin.auth.methods[1]
    const started = await method.authorize()
    assert.equal(started.method, 'auto')
    const result = await started.callback()
    assert.equal(result.type, 'success')
    assert.equal(result.metadata.vk, 'vk-catalog')
    assert.equal(JSON.parse(readFileSync(join(root, 'data', 'opencode', 'session.json'), 'utf8')).accessToken, fresh)
  })
})
