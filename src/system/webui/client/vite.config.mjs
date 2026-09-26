import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { workerSource } from './offline-worker.mjs'
const require = createRequire(new URL('../../../../host/package.json', import.meta.url))
export default {
  root: fileURLToPath(new URL('./', import.meta.url)),
  base: '/quotagent/',
  plugins:[{name:'quotagent-offline-shell',generateBundle(options,bundle){const staticFiles=['manifest.webmanifest','app-icon-192.png','app-icon-512.png'],files=Object.keys(bundle).filter(name=>/\.(js|css|png|svg|woff2?)$/.test(name)),hash=createHash('sha256');hash.update(workerSource.toString());for(const file of Object.values(bundle))hash.update(file.code||file.source||'');for(const file of staticFiles)hash.update(readFileSync(new URL('./public/'+file,import.meta.url)));this.emitFile({type:'asset',fileName:'sw.js',source:workerSource([...files,...staticFiles],hash.digest('hex').slice(0,16))})}}],
  resolve: { alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')) } },
  esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
  build: { outDir: 'dist', emptyOutDir: true },
}
