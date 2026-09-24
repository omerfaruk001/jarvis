/**
 * Keep terminal control codes out of everything JARVIS prints.
 *
 * Child output used to be tagged with colour escapes, and the SDK and its
 * subprocesses add their own. A terminal that doesn't interpret them — Windows
 * PowerShell under the classic console host, a redirected log, the packaged
 * app's captured output — prints them literally, as fragments like `[36m` or
 * `[555;...m` scattered through the log. So children are asked for plain
 * output, and anything that slips through is stripped before it is written.
 *
 * Shared by the desktop wrapper (electron/main.mjs) and the terminal launchers
 * in scripts/, so it lives beside the code that ships.
 */

/** Environment that asks well-behaved tools (Node, Vite, chalk, the Claude
 *  CLI) for uncoloured output. */
export const PLAIN_OUTPUT_ENV = { NO_COLOR: '1', FORCE_COLOR: '0' }

// CSI (ESC [ ... final), OSC (ESC ] ... BEL | ESC \), bare two-byte escapes,
// the 8-bit CSI introducer, and stray control characters other than \t \n \r.
const ANSI =
  // oxlint-disable-next-line no-control-regex -- matching control codes is the point
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|\x9b[0-?]*[ -/]*[@-~]|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g

export const stripAnsi = (text) => String(text).replace(ANSI, '')

/**
 * Forward a child's stream line by line, stripped and tagged. Chunks don't
 * respect line boundaries — an escape sequence can arrive split across two —
 * so a partial line is held until its newline arrives.
 */
export function pipeTagged(from, to, tag) {
  if (!from) return
  // A packaged Windows app has no console: writes can fail with EPIPE/EBADF,
  // and an unhandled stream error would take the main process down with it.
  to.on?.('error', () => {})
  const emit = (line) => {
    const clean = stripAnsi(line).trimEnd()
    if (!clean) return
    try {
      to.write(`${tag} ${clean}\n`)
    } catch {
      /* nowhere to write */
    }
  }
  let partial = ''
  from.setEncoding('utf8')
  from.on('data', (chunk) => {
    const lines = (partial + chunk).split(/\r?\n|\r/)
    partial = lines.pop() ?? ''
    for (const line of lines) emit(line)
  })
  from.on('end', () => {
    emit(partial)
    partial = ''
  })
}
