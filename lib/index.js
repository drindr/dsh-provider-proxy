// provider-proxy — dsh host plugin.
//
// Per-provider outbound HTTP(S) proxy for LLM providers. It wraps
// globalThis.fetch so requests to configured provider hosts are sent through
// an undici ProxyAgent, while every other request keeps using the original
// fetch. Configuration lives in the active profile entry's volatile
// `providers` field and is editable from the web Settings UI
// (settings.section "Provider Proxy").
//
// OpenAI official is shipped as a default disabled rule:
//
//   provider-proxy:
//     providers:
//       openai:
//         enabled: false
//         proxyUrl: ""
//         hosts:
//           - api.openai.com
//
// Set enabled: true and proxyUrl to an HTTP(S) proxy (for example
// http://127.0.0.1:7890) to route only api.openai.com through it.

import z from '@deepseek-ai/schemastery'
import { ProxyAgent } from 'undici'

export const name = 'provider-proxy'

// The custom settings page shares the owning profile entry's schema.
export const inject = ['settings']

const ruleSchema = z.object({
  enabled: z.boolean().default(false),
  proxyUrl: z.string().default(''),
  hosts: z.array(z.string()).default([]),
})

export const Config = z.object({
  providers: z.dict(ruleSchema).default({}).volatile(),
})

/** Merge the default OpenAI rule into whatever the composition supplied. */
function normalizeConfig(config) {
  const providers = { ...(config?.providers ?? {}) }
  if (providers.openai === undefined) {
    providers.openai = {
      enabled: false,
      proxyUrl: '',
      hosts: ['api.openai.com'],
    }
  }
  return { providers }
}

const ORIGINAL_FETCH = Symbol('provider-proxy:original-fetch')

/**
 * The browser-side fetch wrapper is installed once per process. It consults
 * the latest settings snapshot on every request, so a user can toggle a
 * provider rule live without restarting dsh.
 */
function installFetchWrapper() {
  if (globalThis[ORIGINAL_FETCH] !== undefined) return

  globalThis[ORIGINAL_FETCH] = globalThis.fetch

  // State is intentionally module-local and replaced by updateRules() when
  // settings change.
  let rules = []
  const agents = new Map()

  function ensureAgent(proxyUrl) {
    let agent = agents.get(proxyUrl)
    if (agent === undefined) {
      agent = new ProxyAgent(proxyUrl)
      agents.set(proxyUrl, agent)
    }
    return agent
  }

  function updateRules(nextRules) {
    rules = nextRules
  }

  function urlOf(input) {
    if (typeof input === 'string') return new URL(input)
    if (input instanceof URL) return input
    if (input && typeof input.url === 'string') return new URL(input.url)
    return undefined
  }

  globalThis.fetch = function providerProxyFetch(input, init = {}) {
    const url = urlOf(input)
    if (url !== undefined) {
      for (const rule of rules) {
        if (url.hostname === rule.host || url.hostname.endsWith('.' + rule.host)) {
          return globalThis[ORIGINAL_FETCH](input, { ...init, dispatcher: ensureAgent(rule.proxyUrl) })
        }
      }
    }
    return globalThis[ORIGINAL_FETCH](input, init)
  }

  // Expose the updater through a non-enumerable symbol so apply() can refresh
  // rules after settings changes without re-wrapping fetch.
  Object.defineProperty(globalThis, Symbol.for('provider-proxy.updateRules'), {
    value: updateRules,
    configurable: true,
  })
}

function rulesFromConfig(config) {
  const providers = config?.providers ?? {}
  const rules = []
  for (const [provider, rule] of Object.entries(providers)) {
    if (!rule?.enabled || typeof rule?.proxyUrl !== 'string' || rule.proxyUrl.length === 0) continue
    const hosts = Array.isArray(rule?.hosts) ? rule.hosts : []
    for (const host of hosts) {
      if (typeof host === 'string' && host.trim().length > 0) {
        rules.push({ provider, host: host.trim(), proxyUrl: rule.proxyUrl })
      }
    }
  }
  return rules
}

function validateConfig(config) {
  for (const [provider, rule] of Object.entries(config.providers)) {
    if (!rule?.enabled || !rule?.proxyUrl) continue
    let proxy
    try { proxy = new URL(rule.proxyUrl) } catch {
      throw new Error(`provider-proxy: provider "${provider}" proxyUrl must be an HTTP(S) URL`)
    }
    if (proxy.protocol !== 'http:' && proxy.protocol !== 'https:') {
      throw new Error(`provider-proxy: provider "${provider}" proxyUrl must start with http:// or https://`)
    }
    if (!Array.isArray(rule.hosts) || rule.hosts.length === 0) {
      throw new Error(`provider-proxy: provider "${provider}" is enabled but has no hosts`)
    }
    for (const host of rule.hosts) {
      if (typeof host !== 'string' || host.trim().length === 0) {
        throw new Error(`provider-proxy: provider "${provider}" has an empty host`)
      }
    }
  }
}

export function apply(ctx, config) {
  const current = () => normalizeConfig({ providers: config.providers.get() })
  validateConfig(current())
  // Preserve write-time validation when SettingsForms edits live Config.
  ctx.on('internal/config', function (_raw, next) {
    const candidate = next()
    if (this === ctx.fiber) validateConfig(normalizeConfig({ providers: Config(candidate).providers.get() }))
    return candidate
  })
  ctx.effect(() => ctx.settings.configure({ auto: false }, ctx.fiber))

  installFetchWrapper()
  const updateRules = globalThis[Symbol.for('provider-proxy.updateRules')]
  const refresh = () => updateRules(rulesFromConfig(current()))
  refresh()
  ctx.on('loader/volatile-update', refresh)
  ctx.effect(() => () => updateRules([]))
}
