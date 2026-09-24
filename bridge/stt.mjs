/**
 * Local speech-to-text: Whisper, on this machine, through sherpa-onnx.
 *
 * Why this exists. With no ElevenLabs key the app used to fall back to the
 * browser's own SpeechRecognition, and inside Electron that API cannot work at
 * all: Chromium sends the audio to a Google service that needs an API key baked
 * in at build time, Electron ships without one, and every session ends in
 * `error: network` a moment after it starts. Measured in the desktop app: the
 * recogniser fires start → audiostart → audioend → error:network → end, over
 * and over. The microphone meter still moved, so JARVIS looked like he was
 * hearing you — and not one word ever reached the bridge.
 *
 * So the words are worked out here instead. The browser still does voice
 * activity detection locally (vad.ts), then posts each segment to /stt as
 * 16 kHz mono WAV; this module runs Whisper on it. No key, no account, nothing
 * leaves the machine, and Turkish is a first-class language for Whisper.
 *
 * The model is not in the repository or the installer — it is a couple of
 * hundred megabytes. It is downloaded once, on first start, from the
 * sherpa-onnx GitHub releases into ~/.jarvis/models (JARVIS_MODEL_DIR), and
 * only the int8 encoder, decoder and token table are kept.
 */

import { createRequire } from 'node:module'
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { availableParallelism, homedir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const require = createRequire(import.meta.url)

/**
 * tiny | base | small. `small` by default because Turkish needs it. Measured on
 * the same spoken commands: base heard "Bugün tarih ne?" as "Bugün tarihle."
 * and "tarihine", and the model then answered a question nobody asked; small
 * got every one right. It costs a ~640 MB one-time download (360 MB kept) and
 * a second or two per command on a laptop CPU. JARVIS_WHISPER_MODEL=base is
 * the lighter, faster, sloppier option.
 */
const SIZE = (process.env.JARVIS_WHISPER_MODEL ?? 'small').trim() || 'small'
const LANGUAGE = (process.env.JARVIS_STT_LANGUAGE ?? 'tr').trim() || 'tr'
const MODEL_ROOT = process.env.JARVIS_MODEL_DIR || join(homedir(), '.jarvis', 'models')
const NAME = `sherpa-onnx-whisper-${SIZE}`
const DIR = join(MODEL_ROOT, NAME)
const URL_ =
  `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${NAME}.tar.bz2`

const FILES = {
  encoder: `${SIZE}-encoder.int8.onnx`,
  decoder: `${SIZE}-decoder.int8.onnx`,
  tokens: `${SIZE}-tokens.txt`,
}

let sherpa = null
try {
  sherpa = require('sherpa-onnx-node')
} catch (err) {
  console.error(
    `[jarvis] yerel konuşma tanıma yüklenemedi: ${err?.message ?? err}\n` +
      '[jarvis] Çözüm: JARVIS klasöründe "npm install" çalıştırın (sherpa-onnx-node ve ' +
      'Windows için sherpa-onnx-win-x64 kurulmalı). Windows\'ta hata sürerse ' +
      '"Microsoft Visual C++ Redistributable (x64)" kurun.',
  )
}

/** Whether this machine can transcribe locally at all (the native addon
 *  loaded). The model may still be downloading — see localSttStatus(). */
export const localSttAvailable = () => sherpa !== null

/**
 * Where the model is, for the HUD. A first run downloads ~640 MB, and a
 * command spoken during that used to wait on it silently — which from the
 * outside is indistinguishable from JARVIS not working at all.
 */
const status = { state: 'idle', progress: 0, error: '' }
export const localSttStatus = () => ({ ...status })

const set = (state, progress = status.progress, error = '') => {
  status.state = state
  status.progress = progress
  status.error = error
}

const modelPresent = () => Object.values(FILES).every((f) => existsSync(join(DIR, f)))

/**
 * The tar that ships with the OS. On Windows that is System32\tar.exe (bsdtar,
 * present since Windows 10 1803), named explicitly because libuv searches PATH
 * only, and Git for Windows' GNU tar on PATH mangles drive-letter paths.
 */
function tarBinary() {
  if (process.platform === 'win32') {
    const sys = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    if (existsSync(sys)) return sys
  }
  return 'tar'
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    let err = ''
    child.stderr.on('data', (d) => (err += d))
    child.on('error', reject)
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${err.trim()}`)),
    )
  })
}

/**
 * The same extraction in pure JavaScript. Slower — about a minute and a half
 * per 200 MB on a small machine — but it cannot fail for want of a tool:
 * older Windows 10 builds ship a tar.exe without bzip2 support.
 */
async function extractInJs(archive, into) {
  const bunzip = require('unbzip2-stream')
  const tar = require('tar-stream')
  const want = new Set(Object.values(FILES).map((f) => `${NAME}/${f}`))
  mkdirSync(join(into, NAME), { recursive: true })
  const ex = tar.extract()
  ex.on('entry', (header, stream, next) => {
    if (!want.has(header.name)) {
      stream.on('end', next)
      stream.resume()
      return
    }
    const out = createWriteStream(join(into, header.name))
    out.on('finish', next)
    out.on('error', next)
    stream.pipe(out)
  })
  await pipeline(createReadStream(archive), bunzip(), ex)
}

async function download() {
  mkdirSync(MODEL_ROOT, { recursive: true })
  const archive = join(MODEL_ROOT, `${NAME}.tar.bz2.part`)
  console.log(`[jarvis] konuşma modeli indiriliyor (yalnızca ilk sefer, whisper-${SIZE}): ${URL_}`)
  set('downloading', 0)
  const res = await fetch(URL_)
  if (!res.ok || !res.body) throw new Error(`model indirilemedi: HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length')) || 0
  let got = 0
  let shown = 0
  const body = Readable.fromWeb(res.body)
  body.on('data', (c) => {
    got += c.length
    const pct = total ? Math.floor((got / total) * 100) : 0
    status.progress = pct
    if (pct >= shown + 10) {
      shown = pct - (pct % 10)
      console.log(`[jarvis] konuşma modeli %${shown}`)
    }
  })
  await pipeline(body, createWriteStream(archive))

  // Unpack beside the final directory and move it into place only when every
  // file is there, so an interrupted first run never leaves a half model that
  // looks complete.
  set('extracting', 100)
  console.log('[jarvis] konuşma modeli açılıyor…')
  const staging = join(MODEL_ROOT, `${NAME}.staging`)
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  try {
    try {
      await run(tarBinary(), [
        '-xf', archive,
        '-C', staging,
        ...Object.values(FILES).map((f) => `${NAME}/${f}`),
      ])
    } catch (err) {
      console.warn(`[jarvis] sistem tar'ı açamadı (${err?.message ?? err}); JavaScript ile açılıyor`)
      rmSync(staging, { recursive: true, force: true })
      await extractInJs(archive, staging)
    }
    if (!Object.values(FILES).every((f) => existsSync(join(staging, NAME, f)))) {
      throw new Error('model arşivinde beklenen dosyalar yok')
    }
    rmSync(DIR, { recursive: true, force: true })
    renameSync(join(staging, NAME), DIR)
  } finally {
    rmSync(staging, { recursive: true, force: true })
    rmSync(archive, { force: true })
  }
  console.log(`[jarvis] konuşma modeli hazır: ${DIR}`)
}

let loading = null
let ready = null

/** Load (downloading first if needed) exactly once; a failure is not cached,
 *  so the next attempt retries rather than the app staying deaf. */
function recognizer() {
  if (!sherpa) return Promise.reject(new Error('yerel konuşma tanıma kurulu değil'))
  loading ??= (async () => {
    if (!modelPresent()) await download()
    set('loading', 100)
    const rec = await sherpa.OfflineRecognizer.createAsync({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        whisper: {
          encoder: join(DIR, FILES.encoder),
          decoder: join(DIR, FILES.decoder),
          language: LANGUAGE,
          task: 'transcribe',
        },
        tokens: join(DIR, FILES.tokens),
        numThreads: Math.max(1, Math.min(4, availableParallelism() - 1)),
        provider: 'cpu',
        debug: 0,
      },
    })
    ready = rec
    set('ready', 100)
    console.log(`[jarvis] yerel konuşma tanıma hazır (whisper-${SIZE}, ${LANGUAGE})`)
    return rec
  })().catch((err) => {
    loading = null
    set('error', 0, String(err?.message ?? err))
    throw err
  })
  return loading
}

/** Start the download/load in the background so the first command isn't the
 *  one that waits for it. Errors are reported, and retried on next use. */
export function warmLocalStt() {
  if (!sherpa) return
  recognizer().catch((err) =>
    console.error(`[jarvis] konuşma modeli yüklenemedi: ${err?.message ?? err}`),
  )
}

/** Thrown while the model is still on its way, so /stt can answer at once
 *  with where it is instead of holding the request for minutes. */
export class SttNotReady extends Error {}

/**
 * Whisper, given silence or a cough, confidently produces the closing line of
 * a subtitled video it was trained on. These are the Turkish (and a couple of
 * English) ones it reaches for; an utterance that is only one of them is
 * treated as nothing said.
 */
const HALLUCINATIONS = [
  /^altyaz[ıi].*$/i,
  /^izledi[ğg]iniz i[çc]in te[şs]ekk[üu]r(ler| ederim)\.?$/i,
  /^abone olmay[ıi] unutmay[ıi]n\.?$/i,
  /^thank you( for watching)?\.?$/i,
  /^\[.*\]$|^\(.*\)$/,
]

/**
 * Parse a PCM WAV body into mono float samples. Accepts the 16-bit and 32-bit
 * float encodings; the browser sends 16-bit mono at 16 kHz.
 */
export function parseWav(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a WAV file')
  }
  let off = 12
  let fmt = null
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    const body = off + 8
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      }
    } else if (id === 'data' && fmt) {
      const end = Math.min(buf.length, body + size)
      const step = (fmt.bits / 8) * fmt.channels
      const n = Math.floor((end - body) / step)
      const samples = new Float32Array(n)
      for (let i = 0; i < n; i++) {
        const at = body + i * step
        samples[i] =
          fmt.format === 3 && fmt.bits === 32
            ? buf.readFloatLE(at)
            : fmt.bits === 16
              ? buf.readInt16LE(at) / 32768
              : 0
      }
      return { samples, sampleRate: fmt.sampleRate }
    }
    off = body + size + (size % 2)
  }
  throw new Error('WAV has no audio data')
}

/** Transcribe one segment. Returns '' for silence and for known hallucinations. */
export async function transcribeLocal(samples, sampleRate) {
  if (!ready) {
    // Kick a retry if the last attempt failed, then report instead of waiting.
    if (status.state === 'error' || status.state === 'idle') warmLocalStt()
    const { state, progress, error } = status
    throw new SttNotReady(
      state === 'downloading'
        ? `Konuşma modeli indiriliyor (%${progress}) — ilk açılışta bir kez olur, lütfen bekleyin.`
        : state === 'extracting' || state === 'loading'
          ? 'Konuşma modeli hazırlanıyor — birkaç saniye içinde hazır.'
          : `Konuşma modeli yüklenemedi: ${error || 'bilinmeyen hata'} — yeniden deneniyor.`,
    )
  }
  const rec = ready
  // Half a second of silence either side. Whisper was trained on 30-second
  // windows and, handed a clip that starts and stops on the words, routinely
  // drops the tail — measured on Turkish commands: "Carvis." came back "Jar",
  // "Hey Carviz, saat kaç?" came back "Hey". Padded, both come back whole.
  const pad = Math.round(sampleRate * 0.5)
  const padded = new Float32Array(samples.length + pad * 2)
  padded.set(samples, pad)
  const stream = rec.createStream()
  stream.acceptWaveform({ samples: padded, sampleRate })
  const result = await rec.decodeAsync(stream)
  const text = String(result?.text ?? '').replace(/\s+/g, ' ').trim()
  if (!text || HALLUCINATIONS.some((re) => re.test(text))) return ''
  return text
}
