import { randomUUID } from 'node:crypto'
import * as utilityRuntime from './tool-runtime.mjs'
export const COLLECTION = 'studio-plugins'
export const clean = (value, max = 2000) => String(value ?? '').trim().slice(0, max)
export const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }) }
export const copy = value => JSON.parse(JSON.stringify(value))
export const now = () => new Date().toISOString()
export const idOf = () => `plugin-${randomUUID()}`
const COLOR = /^(#[\da-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla)\([\d.,%\s]+\))$/

export const generationPrompt = `You design useful personal plugins for a quotation workspace.
Respond with exactly one JSON object, no markdown: {"name":"short descriptive name","description":"one sentence","kind":"theme|widget|skill|calculator","spec":{...}}.
Choose theme for visual customization, widget for a personal reference panel, skill for a reusable agent workflow, calculator for an interactive custom utility that computes, transforms, analyzes, or formats data with user inputs. A calculator is not limited to arithmetic: it can implement any useful synchronous pure JavaScript function.
Theme spec: {"accent":"#hex","background":"#hex","surface":"#hex","text":"#hex","radius":"12px"}. All colors must be CSS hex colors with strong legibility and pleasant contrast. A theme must respect the user's requested colors/mood.
Widget spec: {"title":"...","body":"helpful content specific to the request","items":["..."]}. Do not invent live business metrics; this is a personal reference panel. For live tasks choose skill.
Skill spec: {"prompt":"a complete reusable instruction for the assistant to execute using its current account's live workspace context and tools","steps":["short action steps"]}. Skills should automate analysis, extraction, draft preparation, and follow-up planning. They cannot publish quotations, award orders, approve changes, or make financial commitments without human review. Incorporate the user's concrete requested routine and preferences.
Calculator spec: {"title":"...","fields":[{"name":"camelCaseInputName","label":"Readable label including units","type":"number|text","default":0}],"code":"function(input, workspace) { ... return { summary: 'Readable result', rows: [{label:'Description', value:123}], ...namedResults }; }"}. Write the COMPLETE actual JavaScript implementation yourself, with all formulas and logic needed for the user's request. The source is executed as written, not interpreted as a template. User input fields and function input keys must match exactly. Numeric fields receive numbers. It may read ONLY the provided account workspace snapshot: {rfqs,quotes,orders,messages,changes,contacts,stats,comparison}; RFQ item fields are {id,description,quantity,unit}, quote items additionally have unitPrice and private cost when owned by that supplier. Handle missing data helpfully. Return a JSON-serializable object; use concise summary and rows with label/value for readability, plus named numeric results when appropriate. It must be synchronous and pure: no import, network, files, process, eval, timers, external libraries, or external actions. Use standard JavaScript/Math/JSON, validate meaningful input ranges, and round money to 2 decimals when relevant. Never invent current account data. Infer formulas from the request and state assumptions in output when needed.
Generate substantive useful content; do not merely repeat the request. Do not include credentials, file paths, or unrelated features.`

export function parseDescriptor(message) {
  const text = typeof message === 'string' ? message : String(message?.content ?? '')
  const jsonText = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '')
  let descriptor
  try { descriptor = JSON.parse(jsonText) } catch {
    const start = jsonText.indexOf('{')
    const end = jsonText.lastIndexOf('}')
    try { descriptor = JSON.parse(jsonText.slice(start, end + 1)) } catch {
      fail('The model returned an incomplete plugin. Please retry the request.', 502)
    }
  }
  if (!descriptor || !['theme', 'widget', 'skill', 'calculator'].includes(descriptor.kind)) {
    fail('The model did not return a supported plugin type. Please retry.', 502)
  }
  const result = { name: clean(descriptor.name, 100), description: clean(descriptor.description, 800),
    kind: descriptor.kind, spec: {} }
  if (!result.name) fail('The model returned a plugin without a name. Please retry.', 502)
  const spec = descriptor.spec ?? {}
  if (result.kind === 'theme') {
    for (const key of ['accent', 'background', 'surface', 'text']) {
      if (!COLOR.test(clean(spec[key], 80))) fail(`The generated theme needs a valid ${key} color. Please retry.`, 502)
      result.spec[key] = clean(spec[key], 80)
    }
    const radius = String(spec.radius ?? '12px')
    result.spec.radius = /^\d{1,2}(?:px|rem)$/.test(radius) ? radius : '12px'
  } else if (result.kind === 'widget') {
    result.spec = { title: clean(spec.title || result.name, 160), body: clean(spec.body, 6000),
      items: Array.isArray(spec.items) ? spec.items.slice(0, 20).map(value => clean(value, 500)) : [] }
    if (!result.spec.body && !result.spec.items.length) fail('The generated widget is empty. Please retry.', 502)
  } else if (result.kind === 'calculator') {
    if (!Array.isArray(spec.fields) || spec.fields.length > 24) fail('The generated utility needs a field list with at most 24 inputs.', 502)
    const names = new Set()
    const fields = spec.fields.map(field => {
      const name = clean(field.name, 64)
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name) || names.has(name)) fail('The generated utility has an invalid or duplicate input name.', 502)
      names.add(name)
      if (!['number', 'text'].includes(field.type)) fail('Generated utility inputs must be numbers or text.', 502)
      const value = field.type === 'number' ? Number(field.default ?? 0) : clean(field.default, 6000)
      if (field.type === 'number' && !Number.isFinite(value)) fail('A generated numeric default is invalid.', 502)
      return { name, label: clean(field.label || name, 160), type: field.type, default: value }
    })
    const code = String(spec.code ?? '').trim()
    try { utilityRuntime.compileUtility(code) } catch (error) {
      fail(`The generated utility needs a correction: ${error.message}. Please retry.`, 502)
    }
    result.spec = { title: clean(spec.title || result.name, 160), fields, code }
  } else {
    result.spec = { prompt: clean(spec.prompt, 12000),
      steps: Array.isArray(spec.steps) ? spec.steps.slice(0, 15).map(value => clean(value, 1000)) : [] }
    if (!result.spec.prompt) fail('The generated skill needs executable instructions. Please retry.', 502)
  }
  return result
}

export function descriptorOf(plugin) {return {name:plugin.name,description:plugin.description,kind:plugin.kind,spec:copy(plugin.spec)}}
export function moduleSource(plugin) {
  const descriptor={id:plugin.id,...descriptorOf(plugin),lineageId:plugin.lineageId||plugin.originId||plugin.id,ownerId:plugin.ownerId,global:!!plugin.global,createdAt:plugin.createdAt,revisionId:plugin.revisionId,revisionNumber:plugin.revisionNumber,contentHash:plugin.contentHash}
  return `// Immutable generated extension revision. Native effects belong to Installed plugins.\nexport const name = ${JSON.stringify(plugin.id)};\nexport const inject = [];\nexport const descriptor = ${JSON.stringify(descriptor,null,2)};\nexport function apply(ctx, config = {}) {\n  ctx.effect(() => config.attach(descriptor, config));\n}\n`
}
