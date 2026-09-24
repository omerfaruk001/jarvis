/**
 * A tiny static file server for the built face, used only in the packaged app.
 *
 * The interface talks to the bridge over ws://localhost:8787, and the bridge
 * only trusts WebSocket origins on localhost:5173-5199 / 4173-4199 (see
 * bridge/server.mjs). If Electron loaded the build over file://, the socket
 * handshake would carry a null origin and be refused — the reactor would spin,
 * the microphone would hear you, and the brain would answer nothing.
 *
 * So the build is served over http://localhost from inside a dev-range port,
 * which the bridge already accepts unchanged. No bridge edit, no widened trust:
 * the packaged app looks exactly like the dev server to the half that guards.
 */

import { createServer } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'

/**
 * The extension → media type table. `.wasm` matters: the hand-tracking runtime
 * is served from our own origin and the browser refuses to instantiate it under
 * the wrong type, which surfaces as gesture control simply never starting.
 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

/**
 * Find a free TCP port inside a range, so a second copy of the app (or Vite
 * already sitting on 5173) does not wedge the launch. The range is the same one
 * the bridge trusts, which is the whole point of scanning within it.
 */
function freePortIn(start, end) {
  return new Promise((resolve, reject) => {
    const tryPort = (port) => {
      if (port > end) {
        return reject(new Error(`no free port in ${start}-${end}`))
      }
      const probe = createServer()
      probe.once('error', () => probe.close(() => tryPort(port + 1)))
      probe.once('listening', () =>
        probe.close(() => resolve(port)),
      )
      probe.listen(port, '127.0.0.1')
    }
    tryPort(start)
  })
}

/**
 * Serve `root` (the Vite build) over http on 127.0.0.1, on a port in the dev
 * range. Returns { origin, port, close } once it is actually listening.
 *
 * Unknown paths fall back to index.html so a deep link or a reload lands on the
 * single-page app rather than a 404 — the build is one HTML file plus hashed
 * assets, and everything that is not a real file on disk is a route into it.
 */
export async function serveBuild(rootIn) {
  // Resolve once so the separators match what join() below produces — a
  // forward-slash root against a backslash join is why a request for a real
  // file would silently fall through to index.html.
  const root = resolve(rootIn)
  if (!existsSync(join(root, 'index.html'))) {
    throw new Error(
      `no build found at ${root}. Run "npm run build" before packaging.`,
    )
  }

  const port = await freePortIn(5173, 5199)

  const server = createServer((req, res) => {
    // Strip the query, decode, and normalise away any ".." so a crafted URL
    // cannot climb out of the build directory.
    let pathname = decodeURIComponent((req.url ?? '/').split('?')[0])
    if (pathname === '/') pathname = '/index.html'
    const safe = normalize(pathname).replace(/^(\.\.[/\\])+/, '')
    let filePath = join(root, safe)

    // Directory, missing file, or anything outside root → the SPA entry point.
    if (
      !filePath.startsWith(root) ||
      !existsSync(filePath) ||
      statSync(filePath).isDirectory()
    ) {
      filePath = join(root, 'index.html')
    }

    const type = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
    res.writeHead(200, {
      'content-type': type,
      // The build is immutable per hash; index.html must not be, or a reinstall
      // keeps serving the old shell. Only the entry document is no-store.
      'cache-control': filePath.endsWith('index.html')
        ? 'no-store'
        : 'public, max-age=31536000, immutable',
    })
    createReadStream(filePath)
      .on('error', () => {
        if (!res.headersSent) res.writeHead(500)
        res.end()
      })
      .pipe(res)
  })

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))

  return {
    port,
    origin: `http://localhost:${port}`,
    close: () =>
      new Promise((r) => {
        // Drop idle keep-alive sockets so close resolves promptly on shutdown
        // rather than waiting for the browser's connections to time out.
        server.closeAllConnections?.()
        server.close(r)
      }),
  }
}
