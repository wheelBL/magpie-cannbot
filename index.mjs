import { createPlugin } from './lib/provider.mjs'

// Magpie treats every exported function as a plugin. Helpers live in lib/.
export const CannbotPlugin = async () => createPlugin()
