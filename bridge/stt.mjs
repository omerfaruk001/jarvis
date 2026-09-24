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
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
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
  console.warn(`[jarvis] local speech recognition unavailable: ${err?.message ?? err}`)
}

/** Whether this machine can transcribe locally at all (the native addon
 *  loaded). The model may still be downloading; transcribe() waits for it. */
export const localSttAvailable = () => sherpa !== null

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

async function download() {
  mkdirSync(MODEL_ROOT, { recursive: true })
  const archive = join(MODEL_ROOT, `${NAME}.tar.bz2.part`)
  console.log(`[jarvis] downloading the ${SIZE} speech model (one time) from ${URL_}`)
  const res = await fetch(URL_)
  if (!res.ok || !res.body) throw new Error(`model download failed: HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length')) || 0
  let got = 0
  let shown = 0
  const body = Readable.fromWeb(res.body)
  body.on('data', (c) => {
    got += c.length
    const pct = total ? Math.floor((got / total) * 100) : 0
    if (pct >= shown + 10) {
      shown = pct - (pct % 10)
      console.log(`[jarvis] speech model ${shown}%`)
    }
  })
  await pipeline(body, createWriteStream(archive))

  // Unpack beside the final directory and move it into place only when every
  // file is there, so an interrupted first run never leaves a half model that
  // looks complete.
  const staging = join(MODEL_ROOT, `${NAME}.staging`)
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  try {
    await run(tarBinary(), [
      '-xf', archive,
      '-C', staging,
      ...Object.values(FILES).map((f) => `${NAME}/${f}`),
    ])
    rmSync(DIR, { recursive: true, force: true })
    renameSync(join(staging, NAME), DIR)
  } finally {
    rmSync(staging, { recursive: true, force: true })
    rmSync(archive, { force: true })
  }
  console.log(`[jarvis] speech model ready in ${DIR}`)
}

let loading = null

/** Load (downloading first if needed) exactly once; a failure is not cached,
 *  so the next utterance retries rather than the app staying deaf. */
function recognizer() {
  if (!sherpa) return Promise.reject(new Error('local speech recognition is not installed'))
  loading ??= (async () => {
    if (!modelPresent()) await download()
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
    console.log(`[jarvis] local speech recognition ready (whisper-${SIZE}, ${LANGUAGE})`)
    return rec
  })().catch((err) => {
    loading = null
    throw err
  })
  return loading
}

/** Start the download/load in the background so the first command isn't the
 *  one that waits for it. Errors are reported, and retried on first use. */
export function warmLocalStt() {
  if (!sherpa) return
  recognizer().catch((err) =>
    console.error(`[jarvis] local speech model failed to load: ${err?.message ?? err}`),
  )
}

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
  const rec = await recognizer()
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
