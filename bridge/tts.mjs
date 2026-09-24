/**
 * ElevenLabs speech, in Turkish, in a woman's voice.
 *
 * The key never leaves this process: the browser POSTs text to /tts and gets
 * audio back. It comes from ELEVENLABS_API_KEY — the project's .env, or
 * ~/.jarvis/.env for the installed app (see env.mjs) — and is never logged.
 *
 * The part that matters most is what happens when it fails. A wrong key, an
 * exhausted quota or a network that cannot reach ElevenLabs must cost at most a
 * moment per sentence, never the answer: the browser falls back to the system
 * voice on any non-200, and this module stops calling out altogether once
 * ElevenLabs has said no in a way that retrying cannot fix.
 */

/**
 * The voice. ELEVENLABS_VOICE_ID picks one from your ElevenLabs library — for
 * the most natural Turkish, a native Turkish female voice from the Voice
 * Library. Unset, it is "Sarah", a premade female voice every account has,
 * which the multilingual Flash model speaks Turkish with. JARVIS_VOICE_ID is
 * the older name and still honoured.
 */
export const VOICE_ID =
  process.env.ELEVENLABS_VOICE_ID || process.env.JARVIS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL'

/** Flash v2.5: the low-latency multilingual model — a conversation needs speed
 *  more than the last few percent of quality — and one of the two that accept
 *  a language code, which stops a short sentence being read with an English
 *  accent. */
export const MODEL = process.env.ELEVENLABS_MODEL_ID || 'eleven_flash_v2_5'
const LANGUAGE = process.env.ELEVENLABS_LANGUAGE || 'tr'
const ENFORCES_LANGUAGE = /^eleven_(flash|turbo)_v2_5$/.test(MODEL)

/** Overridable for a proxy or a local stand-in; the real API by default. */
const BASE = (process.env.ELEVENLABS_API_BASE || 'https://api.elevenlabs.io').replace(/\/+$/, '')

/** A sentence that has not started arriving by now is not going to arrive in
 *  time to be worth waiting for; the system voice takes it instead. */
const TIMEOUT_MS = 12_000

/** After this many failures in a row, rest for COOL_MS before trying again. */
const MAX_FAILURES = 3
const COOL_MS = 60_000

let disabled = '' // set on an answer retrying cannot change: bad key, no access
let failures = 0
let coolUntil = 0

/** Whether a call is worth making right now, and if not, why. */
export function ttsBlocked() {
  if (disabled) return disabled
  if (Date.now() < coolUntil) return 'ElevenLabs art arda başarısız oldu; kısa bir süre sistem sesi kullanılıyor'
  return ''
}

function fail(status, detail) {
  // 401: bad or revoked key, or quota exhausted. 403: the key lacks the
  // text-to-speech permission. Neither gets better by asking again.
  if (status === 401 || status === 403) {
    disabled = `ElevenLabs isteği reddetti (HTTP ${status}) — anahtarı ve kotayı kontrol edin`
    console.error(`[jarvis] ${disabled}. Bu oturumda sistem sesi kullanılacak.${detail ? ` (${detail})` : ''}`)
    return
  }
  failures++
  if (failures >= MAX_FAILURES) {
    coolUntil = Date.now() + COOL_MS
    failures = 0
    console.warn(`[jarvis] ElevenLabs art arda ${MAX_FAILURES} kez başarısız oldu; ${COOL_MS / 1000} sn sistem sesi kullanılacak.`)
  }
}

/** Short, key-free summary of an error body, for the log. */
async function detailOf(res) {
  try {
    const text = (await res.text()).slice(0, 300)
    try {
      const j = JSON.parse(text)
      return String(j?.detail?.status ?? j?.detail?.message ?? j?.detail ?? text).slice(0, 160)
    } catch {
      return text.slice(0, 160)
    }
  } catch {
    return ''
  }
}

/**
 * Speak `text`. Resolves to the upstream response, ready to stream, or throws
 * an Error carrying `status` for the caller to pass on. Never throws anything
 * that should take the bridge down.
 */
export async function synthesize(key, text) {
  const blocked = ttsBlocked()
  if (blocked) throw Object.assign(new Error(blocked), { status: 503 })

  let res
  try {
    res = await fetch(
      `${BASE}/v1/text-to-speech/${encodeURIComponent(VOICE_ID)}/stream` +
        // 22kHz mono is half the bytes of 44kHz and indistinguishable through
        // a laptop speaker.
        `?output_format=mp3_22050_32`,
      {
        method: 'POST',
        headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/mpeg' },
        body: JSON.stringify({
          text,
          model_id: MODEL,
          ...(ENFORCES_LANGUAGE ? { language_code: LANGUAGE } : {}),
          voice_settings: { stability: 0.45, similarity_boost: 0.75, speed: 1.0 },
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    )
  } catch (err) {
    fail(0)
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError'
    throw Object.assign(
      new Error(timedOut ? 'ElevenLabs zaman aşımına uğradı' : `ElevenLabs'e ulaşılamadı: ${err?.message ?? err}`),
      { status: timedOut ? 504 : 502 },
    )
  }

  if (!res.ok || !res.body) {
    const detail = await detailOf(res)
    fail(res.status, detail)
    throw Object.assign(new Error(`ElevenLabs HTTP ${res.status}${detail ? `: ${detail}` : ''}`), {
      status: res.status || 502,
    })
  }

  failures = 0
  return res
}
