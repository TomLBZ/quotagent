import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
const require = createRequire(new URL('../../../../host/package.json', import.meta.url))
export default {
  root: fileURLToPath(new URL('./', import.meta.url)),
  base: '/quotagent/',
  resolve: { alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')) } },
  esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
  build: { outDir: 'dist', emptyOutDir: true },
}
