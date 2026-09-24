import { BACKEND, BRIDGE_HTTP_URL, env } from '../config'

/**
 * What speech engines are actually available, decided once at boot.
 *
 * The whole point is that the app runs for anyone. A student who has done
 * nothing but install Claude Code and log in gets the browser's own speech
 * recognition and voice — no keys, no accounts, it just works. A student who
 * also has an ElevenLabs key (in their Claude Code config or a .env) gets Scribe
 * transcription and the ElevenLabs voice instead, automatically, with no flag to
 * set. This module is how the rest of the app learns which of those two worlds
 * it is in, so voice.ts and tts.ts never have to guess.
 *
 * The premium paths both live behind the bridge — it holds the key and makes
 * the calls, so the browser never sees a secret. In direct mode (no bridge)
 * only a key baked into the bundle could reach ElevenLabs for speech, and that
 * is not a path worth encouraging, so direct mode is treated as browser-only.
 */

export type Capabilities = {
  /** ElevenLabs speech-to-text (Scribe) is reachable via the bridge. */
  stt: boolean
  /** ElevenLabs text-to-speech is reachable via the bridge. */
  tts: boolean
  /** Who transcribes when `stt` is true: ElevenLabs Scribe, or Whisper running
   *  locally inside the bridge (which wants WAV rather than Opus). */
  sttEngine?: 'elevenlabs' | 'local' | null
  /** Where the local Whisper model is, when sttEngine is 'local'. */
  sttStatus?: SttStatus | null
  /** The bridge answered /health at all. */
  reachable?: boolean
  /** It answered, but predates local speech recognition — an older bridge
   *  still holding the port from another terminal is the usual cause. */
  outdated?: boolean
}

export type SttStatus = {
  state: 'idle' | 'downloading' | 'extracting' | 'loading' | 'ready' | 'error'
  progress: number
  error: string
}

type Health = {
  stt?: boolean
  tts?: boolean
  sttEngine?: 'elevenlabs' | 'local' | null
  sttStatus?: SttStatus | null
}

/** Browser-only until the probe says otherwise. Safe default: the app works. */
let current: Capabilities = { stt: false, tts: false }
let probed = false

/** The last known capabilities. Read synchronously by the voice and speech
 *  layers; accurate once `probeCapabilities` has resolved during boot. */
export function caps(): Capabilities {
  return current
}

export function capabilitiesProbed(): boolean {
  return probed
}

/**
 * Ask the bridge what it can do, once. Called during the boot sequence, before
 * the voice loop starts, so the first "Hey Jarvis" already uses the right
 * engine. Never throws: a failed probe simply leaves the browser fallback in
 * place, which is the correct behaviour when the bridge is unreachable.
 */
export async function probeCapabilities(): Promise<Capabilities> {
  if (BACKEND !== 'bridge') {
    // No bridge to ask. Direct mode has no server-side speech, so browser only.
    current = { stt: false, tts: false }
    probed = true
    return current
  }
  // Several tries, not one. The desktop app starts the bridge and the window
  // together, and on a slow first start (Windows, antivirus scanning a new
  // native module) a single three-second probe could miss it — which dropped
  // the app onto the browser recogniser, the one engine that cannot work in
  // Electron. The bridge is local, so a failed try costs almost nothing.
  for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt++) {
    const h = await fetchHealth()
    if (h) {
      current = {
        stt: Boolean(h.stt),
        tts: Boolean(h.tts),
        // A bridge from before sttEngine existed only ever meant ElevenLabs.
        sttEngine: h.sttEngine ?? (h.stt ? 'elevenlabs' : null),
        sttStatus: h.sttStatus ?? null,
        reachable: true,
        outdated: !('sttEngine' in h),
      }
      probed = true
      return current
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  current = { stt: false, tts: false, reachable: false }
  probed = true
  return current
}

const PROBE_ATTEMPTS = 15

async function fetchHealth(): Promise<Health | null> {
  try {
    const res = await fetch(`${BRIDGE_HTTP_URL}/health`, {
      signal: AbortSignal.timeout(3000),
    })
    return res.ok ? ((await res.json()) as Health) : null
  } catch {
    return null
  }
}

/** The local model's progress, re-read for the HUD while it downloads. */
export async function refreshSttStatus(): Promise<SttStatus | null> {
  const h = await fetchHealth()
  if (!h) return null
  current = { ...current, sttStatus: h.sttStatus ?? null }
  return current.sttStatus ?? null
}

/** A short human label for the HUD: what voice stack is actually in play. */
export function engineLabel(): string {
  const c = current
  if (c.stt && c.tts) return 'ElevenLabs'
  if (c.sttEngine === 'local') return 'yerel Whisper'
  if (c.tts) return 'ElevenLabs voice'
  // env.elevenKey is only meaningful in direct mode; harmless to mention.
  if (env.elevenKey && BACKEND !== 'bridge') return 'ElevenLabs (direct)'
  return 'tarayıcı konuşması'
}
