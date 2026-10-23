import test from 'node:test'
import assert from 'node:assert/strict'
import { Config, apply } from '../lib/index.js'

test('routes configured hosts, refreshes volatile rules, and clears rules on disposal without networking', async () => {
  const nativeFetch = globalThis.fetch
  const calls = []
  const dispatchers = new Set()
  globalThis.fetch = async (input, init) => {
    calls.push({ input, init })
    if (init?.dispatcher) dispatchers.add(init.dispatcher)
    return new Response('fixture')
  }
  const callbacks = new Map()
  const disposers = []
  const fiber = {}
  const ctx = {
    fiber,
    settings: {
      configure(presentation, owner) {
        assert.equal(presentation.auto, false)
        assert.equal(owner, fiber)
        return () => {}
      },
    },
    on(name, callback) { callbacks.set(name, callback) },
    effect(effect) { const dispose = effect(); if (dispose) disposers.push(dispose) },
  }
  const rule = {
    enabled: true,
    proxyUrl: 'http://127.0.0.1:1',
    hosts: ['api.openai.com', 'auth.openai.com', 'chatgpt.com'],
  }
  let config = Config({ providers: { openai: rule } })
  assert.deepEqual(Config({}).providers.get(), {})
  try {
    apply(ctx, { providers: { get: () => config.providers.get() } })
    await fetch('https://auth.openai.com/oauth/token')
    assert.ok(calls.at(-1).init.dispatcher)
    await fetch('https://chatgpt.com/backend-api/codex/responses')
    assert.ok(calls.at(-1).init.dispatcher)
    await fetch('https://subdomain.api.openai.com/fixture')
    assert.ok(calls.at(-1).init.dispatcher)
    await fetch('https://unrelated.example/fixture')
    assert.equal(calls.at(-1).init.dispatcher, undefined)
    await fetch('https://auth.openai.com.unrelated.example/fixture')
    assert.equal(calls.at(-1).init.dispatcher, undefined)

    config = Config({ providers: { openai: { ...rule, enabled: false } } })
    callbacks.get('loader/volatile-update')()
    await fetch('https://auth.openai.com/oauth/token')
    assert.equal(calls.at(-1).init.dispatcher, undefined)

    const validate = callbacks.get('internal/config')
    assert.throws(() => validate.call(fiber, null, () => ({
      providers: { openai: { ...rule, proxyUrl: 'socks://127.0.0.1:1' } },
    })), /must start with http/)
    assert.throws(() => validate.call(fiber, null, () => ({
      providers: { openai: { ...rule, hosts: [] } },
    })), /has no hosts/)
    const valid = { providers: { openai: rule } }
    assert.equal(validate.call(fiber, null, () => valid), valid)

    config = Config(valid)
    callbacks.get('loader/volatile-update')()
    for (const dispose of disposers.reverse()) dispose()
    await fetch('https://auth.openai.com/oauth/token')
    assert.equal(calls.at(-1).init.dispatcher, undefined)
  } finally {
    globalThis.fetch = nativeFetch
    await Promise.all([...dispatchers].map(dispatcher => dispatcher.close()))
  }
})
