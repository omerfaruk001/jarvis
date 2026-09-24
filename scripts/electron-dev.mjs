/**
 * Run JARVIS as a desktop app in development.
 *
 * The packaged app serves its own build, but in development we want Vite's hot
 * reload on the face. So this starts Vite on a fixed dev-range port, waits until
 * it actually answers, then launches Electron pointed at it. Electron itself
 * starts the bridge (with writes enabled) — the same path the packaged app
 * takes — so there is one place that owns the brain, not two.
 *
 *   npm run electron:dev
 */

import { spawn } from 'node:child_process'
import process from 'node:process'
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { PLAIN_OUTPUT_ENV, pipeTagged } from '../electron/output.mjs'

const PORT = 5173

/**
 * Put MediaPipe's WebAssembly where the page can load it, same as scripts/
 * start.mjs does for the web flow. Gesture control is optional, so a missing
 * source is not fatal — carry on without it.
 */
function vendorWasm() {
  const from = 'node_modules/@mediapipe/tasks-vision/wasm'
  const to = 'public/mediapipe'
  if (!existsSync(from)) return
  if (existsSync(`${to}/vision_wasm_internal.wasm`)) return
  try {
    mkdirSync(to, { recursive: true })
    cpSync(from, to, { recursive: true })
    console.log('  el takibi çalışma zamanı public/mediapipe içine kopyalandı.')
  } catch (err) {
    console.warn(`  el takibi çalışma zamanı kopyalanamadı: ${err.message}`)
  }
}

const children = []
let stopping = false

function shutdown(code) {
  if (stopping) return
  stopping = true
  for (const c of children) {
    try {
      c.kill()
    } catch {
      /* already gone */
    }
  }
  setTimeout(() => process.exit(code), 200)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

/** Resolve once Vite is answering on the port, so Electron never loads too early. */
async function waitForVite(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`Vite did not come up on ${url} within ${timeoutMs}ms`)
}

vendorWasm()

console.log('\nJ.A.R.V.I.S. masaüstü (geliştirme) — arayüz Vite üzerinde başlatılıyor.\n')

// The face: Vite, on a fixed port so we know where to point Electron. Call the
// binary directly rather than through npm so no shell is involved.
const vite = spawn(
  process.execPath,
  ['node_modules/vite/bin/vite.js', '--port', String(PORT), '--strictPort'],
  // Piped rather than inherited so escape codes can be stripped on the way
  // through — PowerShell under conhost prints them as literal junk.
  { env: { ...process.env, ...PLAIN_OUTPUT_ENV, PORT: String(PORT) } },
)
pipeTagged(vite.stdout, process.stdout, '[face]')
pipeTagged(vite.stderr, process.stderr, '[face]')
children.push(vite)
vite.on('exit', (code) => shutdown(code ?? 0))

const url = `http://localhost:${PORT}`
try {
  await waitForVite(url)
} catch (err) {
  console.error(err.message)
  shutdown(1)
}

console.log(`\n  Vite hazır; Electron ${url} adresiyle açılıyor.\n`)

// Resolve the electron executable through its own package so this works the
// same on every platform without assuming a global install.
const { default: electronPath } = await import('electron')

const electron = spawn(electronPath, ['.'], {
  env: { ...process.env, ...PLAIN_OUTPUT_ENV, ELECTRON_START_URL: url },
})
pipeTagged(electron.stdout, process.stdout, '[app]')
pipeTagged(electron.stderr, process.stderr, '[app]')
children.push(electron)
electron.on('exit', (code) => shutdown(code ?? 0))
