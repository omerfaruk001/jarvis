/**
 * JARVIS as a Windows desktop app.
 *
 * The web build already works: the React face talks to a local Node bridge over
 * ws://localhost:8787, and the bridge is the brain and the hands. This process
 * just wraps both in one window so a student double-clicks an icon instead of
 * running two commands.
 *
 * It does three things and nothing more:
 *   1. Starts the bridge as a child process, with JARVIS_ALLOW_WRITES=1 so the
 *      assistant can actually act — this is a trusted desktop app, not a public
 *      deployment, so the write gate that guards a demo is opened here.
 *   2. Serves the built face over http on a dev-range port (packaged) or points
 *      at the running Vite server (dev). Either way the origin is one the bridge
 *      already trusts, so nothing in the bridge changes.
 *   3. Opens a frameless-enough BrowserWindow, grants it the camera and
 *      microphone the assistant needs, and shuts the bridge down on exit.
 */

import { app, BrowserWindow, session, shell } from 'electron'
import { spawn } from 'node:child_process'
import process from 'node:process'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serveBuild } from './static.mjs'
import { PLAIN_OUTPUT_ENV, pipeTagged } from './output.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

// The app root: the project directory in dev, resources/app when packaged
// (asar is off, so the layout is the ordinary one — see the build config).
const APP_ROOT = app.getAppPath()

// In dev the launcher (scripts/electron-dev.mjs) starts Vite and passes its URL
// here. When it is absent we are the packaged app and serve the build ourselves.
const DEV_URL = process.env.ELECTRON_START_URL || null

let win = null
let bridge = null
let staticServer = null

/**
 * Start the bridge, tagging its output so it is legible in the terminal during
 * development and captured by any log the packaged app is launched with.
 *
 * `origins` is the exact origin the window will load from, handed to the bridge
 * so it accepts our socket even if the port scan landed outside the default
 * range. Writes are enabled here on purpose: a desktop app the user installed
 * and launched is the trusted context the bridge's read-only default was
 * waiting for.
 */
function startBridge(origins) {
  const bridgePath = join(APP_ROOT, 'bridge', 'server.mjs')
  const env = {
    ...process.env,
    ...PLAIN_OUTPUT_ENV,
    JARVIS_ALLOW_WRITES: '1',
    JARVIS_ALLOWED_ORIGINS: origins,
  }

  // The Claude Agent SDK doesn't answer on its own: for every turn it spawns a
  // native Claude Code binary that ships as a platform-specific optional
  // dependency (@anthropic-ai/claude-agent-sdk-<platform>). The SDK finds it by
  // require.resolve from inside node_modules, which works in dev but is exactly
  // the kind of thing a packager can drop — and when it's missing the socket
  // still opens, the HUD still lights up, and every turn dies silently with
  // "Native CLI binary not found". So point the bridge straight at the copy we
  // bundled, when it's actually there, and let the SDK's own search be the
  // fallback. This is packaging knowledge, and it belongs in the layer that
  // knows how the app was packaged, not in the bridge.
  //
  // electron-builder may hoist the optional package to the top level or nest it
  // under the SDK's own node_modules depending on how it resolved the tree, so
  // probe both rather than betting on one.
  const NATIVE_PKG = join(
    '@anthropic-ai',
    'claude-agent-sdk-win32-x64',
    'claude.exe',
  )
  const claudeExe = [
    join(APP_ROOT, 'node_modules', NATIVE_PKG),
    join(APP_ROOT, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'node_modules', NATIVE_PKG),
  ].find(existsSync)
  if (claudeExe) {
    env.JARVIS_CLAUDE_CODE_PATH = claudeExe
  } else {
    console.warn(
      '[jarvis] bundled Claude binary not found next to the app; ' +
        'the SDK will fall back to resolving it from node_modules.',
    )
  }

  /**
   * Prefer the system Node, because that is exactly how the bridge and the
   * Claude Agent SDK are exercised today (`npm run bridge`) — the SDK spawns
   * its own Node subprocesses, and keeping the runtime identical is the surest
   * way not to break anything. If Node is not on PATH, fall back to running our
   * own Electron binary as Node, which every packaged Electron can do.
   */
  const tryNode = () => spawn('node', [bridgePath], { env, cwd: APP_ROOT })
  const asElectronNode = () =>
    spawn(process.execPath, [bridgePath], {
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
      cwd: APP_ROOT,
    })

  let child = tryNode()
  child.once('error', (err) => {
    if (err && err.code === 'ENOENT') {
      console.warn('[jarvis] system node not found; running the bridge on Electron.')
      wire(asElectronNode())
    } else {
      console.error('[jarvis] bridge failed to start:', err)
    }
  })
  wire(child)

  function wire(c) {
    child = c
    bridge = c
    pipeTagged(c.stdout, process.stdout, '[bridge]')
    pipeTagged(c.stderr, process.stderr, '[bridge]')
    c.on('exit', (code) => {
      console.log(`[jarvis] bridge exited (${code}).`)
    })
  }
}

function stopBridge() {
  if (bridge && !bridge.killed) {
    try {
      bridge.kill()
    } catch {
      /* already gone */
    }
  }
  bridge = null
}

function createWindow(faceUrl) {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#01060c', // the reactor's near-black, so no white flash on load
    show: false,
    autoHideMenuBar: true,
    title: 'J.A.R.V.I.S.',
    webPreferences: {
      // The face is a plain web app that reaches the bridge over the network; it
      // has no business touching Node, so the renderer stays locked down.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  win.once('ready-to-show', () => win?.show())

  // Links that would open a new window (a source tag, an external page) go to
  // the real browser rather than spawning a chromeless popup inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://localhost') || url.startsWith('http://127.0.0.1')) {
      return { action: 'allow' }
    }
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  win.on('closed', () => {
    win = null
  })

  win.loadURL(faceUrl)
}

/**
 * Grant exactly the camera and microphone the assistant needs, and nothing
 * else. Electron denies media by default, which would leave the wake word deaf
 * and the "open the camera" blade blank with no error the user could act on.
 */
function grantMediaPermissions() {
  const MEDIA = new Set(['media', 'audioCapture', 'videoCapture'])
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(MEDIA.has(permission))
  })
  session.defaultSession.setPermissionCheckHandler((_wc, permission) =>
    MEDIA.has(permission),
  )
}

// Only ever one instance: two windows would mean two bridges fighting over
// port 8787, and the second would silently fail its socket.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(async () => {
    grantMediaPermissions()

    let faceUrl
    let origins
    if (DEV_URL) {
      faceUrl = DEV_URL
      const u = new URL(DEV_URL)
      origins = `http://localhost:${u.port},http://127.0.0.1:${u.port}`
    } else {
      staticServer = await serveBuild(join(APP_ROOT, 'dist'))
      faceUrl = staticServer.origin
      origins = `http://localhost:${staticServer.port},http://127.0.0.1:${staticServer.port}`
    }

    startBridge(origins)
    createWindow(faceUrl)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(faceUrl)
    })
  })

  // The bridge is a child of this process; take it down whenever we go.
  app.on('window-all-closed', () => {
    stopBridge()
    void staticServer?.close()
    app.quit()
  })
  app.on('before-quit', stopBridge)
  process.on('exit', stopBridge)
}
