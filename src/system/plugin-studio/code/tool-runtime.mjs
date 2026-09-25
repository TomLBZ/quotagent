import { Script, createContext } from 'node:vm'

export const name = 'personal-utility-runtime'
export const inject = []
export const provides = ['studioRuntime']

/** The model supplies the implementation. This runtime supplies only execution,
 * account scoping, serialization, and lifecycle; no business formula lives here. */
export function compileUtility(source) {
  if (typeof source !== 'string' || !source.trim() || source.length > 24000) {
    throw new Error('A generated utility needs a JavaScript function of at most 24,000 characters.')
  }
  return new Script(`"use strict"; (() => {
    const utility = (${source});
    if (typeof utility !== 'function') throw new Error('The generated implementation is not a function.');
    const result = utility(JSON.parse(__input), JSON.parse(__workspace));
    if (result && typeof result.then === 'function') throw new Error('Personal utilities must return a synchronous result.');
    return JSON.stringify(result === undefined ? null : result);
  })()`, { filename: 'generated-personal-utility.js' })
}

export function apply(ctx, config = {}) {
  const utilities = new Map()
  const timeout = Number(config.timeout ?? 750)
  ctx.provide('studioRuntime', {
    register(owner, descriptor, source) {
      const utility = { owner, descriptor: structuredClone(descriptor), script: compileUtility(source) }
      if (utilities.has(descriptor.id)) throw new Error('This utility is already registered.')
      utilities.set(descriptor.id, utility)
      return () => { if (utilities.get(descriptor.id) === utility) utilities.delete(descriptor.id) }
    },
    run(user, id, input, workspace) {
      const utility = utilities.get(id)
      if (!utility) throw new Error('Load this utility before running it.')
      if (utility.owner !== '*' && utility.owner !== user.id) throw new Error('Install this utility in your own workspace before running it.')
      const context = createContext({ __input: JSON.stringify(input), __workspace: JSON.stringify(workspace) },
        { codeGeneration: { strings: false, wasm: false }, microtaskMode: 'afterEvaluate' })
      const output = utility.script.runInContext(context, { timeout })
      if (output.length > 200000) throw new Error('The utility returned too much data. Ask for a smaller summary.')
      return JSON.parse(output)
    },
    list: user => [...utilities.values()].filter(row => row.owner === '*' || row.owner === user.id)
      .map(row => structuredClone(row.descriptor)),
  })
  ctx.effect(() => () => utilities.clear())
}
