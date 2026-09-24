/**
 * Load .env files into process.env before anything reads them.
 *
 * The bridge holds the secrets — the ElevenLabs key above all — so it is the
 * process that has to see them; Vite's own .env loading only reaches the
 * browser bundle, and only VITE_ names. server.mjs imports this first, so
 * every module after it sees the values at load time.
 *
 * Looked for, in order: the project's .env and .env.local (a source checkout,
 * `npm start`, `npm run electron:dev`), then ~/.jarvis/.env (the installed
 * app — its files live under the install directory, which is replaced on
 * every update and never packages a .env). A variable already set in the real
 * environment wins, and an earlier file wins over a later one.
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const FILES = [
  join(ROOT, '.env'),
  join(ROOT, '.env.local'),
  join(homedir(), '.jarvis', '.env'),
]

/** KEY=value per line; `export ` prefix, # comments and matching quotes
 *  allowed. Enough for a hand-written file, without a dependency. */
export function parseEnv(text) {
  const out = {}
  // Strip a UTF-8 BOM: Windows Notepad adds one, and it would otherwise become
  // part of the first variable's name.
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    let value = m[2].trim()
    const q = value[0]
    if ((q === '"' || q === "'") && value.length >= 2 && value.endsWith(q)) {
      value = value.slice(1, -1)
    } else {
      value = value.replace(/\s+#.*$/, '') // an unquoted value ends at a comment
    }
    out[m[1]] = value
  }
  return out
}

/** Which files were read — names only, for the startup banner. Values are
 *  never logged. */
export const loadedEnvFiles = []

for (const file of FILES) {
  if (!existsSync(file)) continue
  try {
    for (const [k, v] of Object.entries(parseEnv(readFileSync(file, 'utf8')))) {
      if (process.env[k] === undefined && v !== '') process.env[k] = v
    }
    loadedEnvFiles.push(file)
  } catch (err) {
    console.warn(`[jarvis] ${file} okunamadı: ${err?.message ?? err}`)
  }
}
