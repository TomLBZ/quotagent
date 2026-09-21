/**
 * 极简 standard-schema（v1）构造器 —— 给进树模块的 `Config` 用。
 *
 * 为什么自己写：cordis 通过 `Config["~standard"].validate(config)` 校验配置（`lib/index.js: resolveConfig`），
 * 它**只消费 standard-schema 接口本身**，并不带构造器（`cordis` 的导出里没有 `Schema`；
 * 生态里的构造包没有装）。所以这里只实现 cordis 真正会调用的那一点点接口：
 * `~standard.validate(value) -> {value} | {issues}`，并在此之上提供模块需要的组合子。
 *
 * 与 H5 的分工：**这一层管"模块自己的配置形状"**（未知键、类型、const 不可翻转）；
 * 宿主白名单/冻结面（`kernel.*`、`humanOnly`）由 `host/lib/frozen.mjs` + `host/lib/schema.mjs` 管（H5）。
 * 两层都不许"看不出来地放行"：未知键一律拒绝。
 */

const VENDOR = 'quotagent'

const issue = (message, path = []) => ({ message, path })

/** 组合子基类：`parse` 供本仓 fixture 直接调用，`~standard.validate` 供 cordis 调用。 */
class Node {
  constructor(kind, { const: isConst = false } = {}) {
    this.kind = kind
    this.isConst = isConst
  }

  validate(value, path = []) {
    return { value }
  }

  /** 默认值（子类覆盖；组合器与 `default()` 都依赖它）。 */
  defaultValue() {
    return undefined
  }

  /** 供 fixture（A3）直接调用的入口：不合法即抛 ValidationError 形状的错误。 */
  parse(value) {
    const result = this['~standard'].validate(value)
    if (result.issues) {
      const error = new Error(`[config-invalid] ${result.issues.map((item) => item.message).join('; ')}`)
      error.issues = result.issues
      throw error
    }
    return result.value
  }

  get ['~standard']() {
    const self = this
    return {
      version: 1,
      vendor: VENDOR,
      validate(value) {
        const result = self.validate(value === undefined ? undefined : value)
        return result.issues ? { issues: result.issues } : { value: result.value }
      },
    }
  }

  /** 供 fixture 用的自省：列出直接子键（A3 要找到 const 键）。 */
  get dict() {
    return {}
  }
}

class ObjectNode extends Node {
  constructor(shape) {
    super('object')
    this.shape = shape
  }

  get dict() {
    return this.shape
  }

  validate(value, path = []) {
    const input = value ?? {}
    if (typeof input !== 'object' || Array.isArray(input)) {
      return { issues: [issue(`${path.join('.') || '(root)'} 必须是对象`, path)] }
    }
    const issues = []
    const out = {}
    for (const key of Object.keys(input)) {
      if (!(key in this.shape)) {
        issues.push(issue(`未知键 ${[...path, key].join('.')}（白名单外的键不得写入）`, [...path, key]))
      }
    }
    for (const [key, node] of Object.entries(this.shape)) {
      const raw = input[key]
      const result = node.validate(raw === undefined ? node.defaultValue() : raw, [...path, key])
      if (result.issues) issues.push(...result.issues)
      else out[key] = result.value
    }
    return issues.length ? { issues } : { value: out }
  }
}

class ConstNode extends Node {
  constructor(value) {
    super('const', { const: true })
    this.value = value
  }

  defaultValue() {
    return this.value
  }

  validate(value, path = []) {
    if (value !== this.value) {
      return { issues: [issue(`const 键 ${path.join('.')} 不得翻转（期望 ${JSON.stringify(this.value)}）`, path)] }
    }
    return { value }
  }
}

class ScalarNode extends Node {
  constructor(kind, { fallback = undefined, enumValues = null } = {}) {
    super(kind)
    this.fallback = fallback
    this.enumValues = enumValues
  }

  defaultValue() {
    return this.fallback
  }

  validate(value, path = []) {
    if (value === undefined) return { value: this.fallback }
    if (this.enumValues && !this.enumValues.includes(value)) {
      return { issues: [issue(`${path.join('.')} 取值 ${JSON.stringify(value)} 不在枚举内`, path)] }
    }
    if (this.kind === 'number' && typeof value !== 'number') {
      return { issues: [issue(`${path.join('.')} 必须是数字`, path)] }
    }
    if (this.kind === 'string' && typeof value !== 'string') {
      return { issues: [issue(`${path.join('.')} 必须是字符串`, path)] }
    }
    if (this.kind === 'boolean' && typeof value !== 'boolean') {
      return { issues: [issue(`${path.join('.')} 必须是布尔`, path)] }
    }
    return { value }
  }
}

class ArrayNode extends Node {
  constructor(item, { fallback = [] } = {}) {
    super('array')
    this.item = item
    this.fallback = fallback
  }

  defaultValue() {
    return this.fallback
  }

  validate(value, path = []) {
    const input = value ?? this.fallback
    if (!Array.isArray(input)) return { issues: [issue(`${path.join('.')} 必须是数组`, path)] }
    const issues = []
    const out = []
    input.forEach((entry, index) => {
      const result = this.item.validate(entry, [...path, String(index)])
      if (result.issues) issues.push(...result.issues)
      else out.push(result.value)
    })
    return issues.length ? { issues } : { value: out }
  }
}

class UnionNode extends Node {
  constructor(options, { fallback = undefined } = {}) {
    super('union')
    this.options = options
    this.fallback = fallback
  }

  defaultValue() {
    return this.fallback
  }

  validate(value, path = []) {
    if (value === undefined) return { value: this.fallback }
    if (!this.options.includes(value)) {
      return { issues: [issue(`${path.join('.')} 取值 ${JSON.stringify(value)} 不在 ${JSON.stringify(this.options)} 内`, path)] }
    }
    return { value }
  }
}

/** 组合子（链式 `.default()` 与构建器风格都支持）。 */
const withDefault = (node, fallback) => {
  node.fallback = fallback
  const originalDefault = node.defaultValue?.bind(node)
  node.defaultValue = () => (originalDefault ? (originalDefault() ?? fallback) : fallback)
  return node
}

export const object = (shape) => new ObjectNode(shape)
export const string = () => new ScalarNode('string')
export const number = () => new ScalarNode('number')
export const boolean = () => new ScalarNode('boolean')
export const array = (item) => new ArrayNode(item)
export const union = (options) => new UnionNode(options)
export const constant = (value) => new ConstNode(value)
export const enumOf = (values) => new ScalarNode('string', { enumValues: values })

/** 让 `Schema.object({...}).default()` 这类链式写法可用（cordis 生态常见风格）。 */
for (const cls of [ObjectNode, ScalarNode, ArrayNode, UnionNode, ConstNode]) {
  cls.prototype.default = function chainDefault(fallback) {
    return withDefault(this, fallback)
  }
}
ObjectNode.prototype.optional = function optional() { return this }
