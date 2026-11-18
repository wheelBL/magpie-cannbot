import { createPlugin } from './lib/provider.mjs'
import { readAutoConfig } from './lib/auto.mjs'

// Magpie treats every exported function as a plugin. Helpers live in lib/.
export const CannbotPlugin = async () => {
  const auto = readAutoConfig(process.env)
  if (auto.warnings.length) console.error('[cannbot-auto]', auto.warnings.join('; '))
  return createPlugin({ auto })
}
