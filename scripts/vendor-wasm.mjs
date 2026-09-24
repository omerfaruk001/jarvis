/**
 * Copy MediaPipe's WebAssembly into public/ before a build, so the packaged
 * dist/ carries the hand-tracking runtime from our own origin rather than a CDN
 * the CSP forbids. Idempotent and non-fatal: gesture control is optional, and a
 * missing source just means we build without it. Mirrors the copy scripts/
 * start.mjs does for the dev server.
 */

import { cpSync, existsSync, mkdirSync } from 'node:fs'

const from = 'node_modules/@mediapipe/tasks-vision/wasm'
const to = 'public/mediapipe'

if (!existsSync(from)) {
  console.log('  @mediapipe/tasks-vision not installed; building without gestures.')
} else if (existsSync(`${to}/vision_wasm_internal.wasm`)) {
  console.log('  hand-tracking runtime already vendored.')
} else {
  mkdirSync(to, { recursive: true })
  cpSync(from, to, { recursive: true })
  console.log('  vendored the hand-tracking runtime into public/mediapipe.')
}
