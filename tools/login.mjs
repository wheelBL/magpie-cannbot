#!/usr/bin/env node
/**
 * Sign in to CANNBOT from the terminal, without VS Code.
 *
 *   node tools/login.mjs            open the GitCode page and wait for it
 *   node tools/login.mjs --no-open  print the URL (remote/headless)
 *   node tools/login.mjs --status   show what is stored now
 *
 * On success it writes:
 *   ~/.config/magpie/cannbot-signin.json   the refresh token (0600)
 *   ~/.local/share/opencode/session.json   the access token
 *   ~/.config/magpie/plugin-auth.json      magpie's account row for cannbot
 *
 * The plugin then renews the sign-in automatically; neither the VS Code
 * extension nor an external refresh script is needed.
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import * as oauth from '../lib/oauth.mjs'
import * as signin from '../lib/signin.mjs'

const LOCAL = 'cannbot-local-session'
const args = new Set(process.argv.slice(2))

const pluginAuthPath = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'magpie', 'plugin-auth.json')

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return {} }
}

function openBrowser(url) {
  const [command, argv] = process.platform === 'darwin'
    ? ['open', [url]]
    : process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]]
  try {
    const child = spawn(command, argv, { detached: true, stdio: 'ignore' })
    child.unref()
    return true
  } catch {
    return false
  }
}

function showStatus() {
  const own = signin.readOwnAuth()
  const session = signin.readSession()
  const exp = session === undefined ? undefined : signin.jwtExpiry(session.accessToken)
  const magpie = readJson(pluginAuthPath).cannbot
  console.log(`magpie's refresh token: ${own === undefined ? 'no' : `yes (${signin.ownAuthPath()})`}`)
  console.log(`session.json:           ${session === undefined ? 'no' : `yes, ${exp === undefined ? 'expiry unknown' : `expires ${new Date(exp).toISOString()}`}`}`)
  console.log(`magpie account row:     ${magpie === undefined ? 'no' : `${magpie.key} (${magpie.metadata?.method ?? '?'})`}`)
}

async function main() {
  if (args.has('--help') || args.has('-h')) {
    console.log('usage: node tools/login.mjs [--no-open] [--status]')
    return
  }
  if (args.has('--status')) {
    showStatus()
    return
  }

  const { authorizeUrl, state } = await oauth.startAuthorize()
  console.log('请在浏览器里完成 GitCode 登录：')
  console.log(`  ${authorizeUrl}`)
  if (!args.has('--no-open') && !openBrowser(authorizeUrl)) {
    console.log('（打不开浏览器，请手动复制上面的地址）')
  }
  console.log('等待授权回调…')

  const tokens = await oauth.waitForTokens(state)
  const account = await oauth.userInfo(tokens.accessToken).catch(() => ({}))
  const accountId = account?.username ?? account?.login ?? account?.email ?? signin.accountOf(tokens.accessToken).accountId ?? 'cannbot'
  const email = account?.email ?? signin.accountOf(tokens.accessToken).email

  // Everything that can fail on the network comes first: a half-written
  // credential store (token but no account row) leaves the provider unusable.
  const vk = await oauth.catalogVirtualKey(tokens.accessToken)

  signin.writeOwnAuth(tokens, {
    ideType: 'codearts',
    ...(accountId ? { accountId } : {}),
    ...(email ? { email } : {}),
  })
  signin.saveSession(signin.defaultSessionPath(), tokens.accessToken)

  const entry = {
    type: 'api',
    key: LOCAL,
    metadata: {
      method: 'local',
      vk,
      ...(accountId ? { accountId } : {}),
      ...(email ? { email } : {}),
    },
  }
  const file = readJson(pluginAuthPath)
  file.cannbot = entry
  signin.writeFileAtomic(pluginAuthPath, JSON.stringify(file, null, 2), 0o600)

  console.log(`\n登录成功：${accountId}${email ? ` <${email}>` : ''}`)
  console.log(`refresh token → ${signin.ownAuthPath()}`)
  console.log(`access token  → ${signin.defaultSessionPath()}`)
  console.log('重启 magpie 后生效：cannbot 会自动续期，不再需要 VS Code。')
}

await main()
