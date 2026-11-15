#!/usr/bin/env node
/**
 * Builds the standalone web app package:
 *   1. Builds the webview UI via Vite (into app/dist/webview/)
 *   2. Bundles the app entry via esbuild (into app/dist/app.js)
 *   3. Bundles the AskUserQuestion hook (into app/dist/ask-hook.js)
 */
'use strict'

const { execSync } = require('child_process')
const esbuild = require('esbuild')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const APP_DIR = __dirname
const APP_PKG = require(path.join(APP_DIR, 'package.json'))

console.log('Building Team Monitor app...\n')

// 1. Build the webview UI
console.log('[1/2] Building webview...')
execSync('npx vite build --config vite.config.app.ts', {
  cwd: path.join(ROOT, 'web'),
  stdio: 'inherit',
})

// 2. Bundle the app
console.log('\n[2/2] Bundling app...')
esbuild.buildSync({
  entryPoints: [path.join(APP_DIR, 'src', 'app.ts')],
  bundle: true,
  platform: 'node',
  target: 'node18',
  outfile: path.join(APP_DIR, 'dist', 'app.js'),
  alias: {
    'vscode': path.join(ROOT, 'scripts', 'vscode-shim.js'),
  },
  define: {
    AGENT_FLOW_APP_VERSION: JSON.stringify(APP_PKG.version),
  },
  banner: {
    js: '#!/usr/bin/env node',
  },
  sourcemap: false,
  logLevel: 'warning',
})

// 3. Bundle the Claude Code AskUserQuestion hook (small, no server code)
esbuild.buildSync({
  entryPoints: [path.join(APP_DIR, 'src', 'team', 'ask-hook-main.ts')],
  bundle: true,
  platform: 'node',
  target: 'node18',
  outfile: path.join(APP_DIR, 'dist', 'ask-hook.js'),
  banner: {
    js: '#!/usr/bin/env node',
  },
  sourcemap: false,
  logLevel: 'warning',
})

// 4. Copy the sound files (web/public/sounds/*.ogg|*.mp3) flat into the webview folder; the static server serves
//    files by basename from there. Nothing else from web/public is copied.
const fs = require('fs')
const SOUNDS_DIR = path.join(ROOT, 'web', 'public', 'sounds')
const WEBVIEW_OUT = path.join(APP_DIR, 'dist', 'webview')
if (fs.existsSync(SOUNDS_DIR)) {
  let copied = 0
  for (const name of fs.readdirSync(SOUNDS_DIR)) {
    if (!/^[a-z0-9][a-z0-9._-]*\.(ogg|mp3)$/i.test(name)) continue
    fs.copyFileSync(path.join(SOUNDS_DIR, name), path.join(WEBVIEW_OUT, name))
    copied++
  }
  if (copied) console.log(`Copied ${copied} sound file(s) into app/dist/webview/`)
}

// 5. Copy the PWA files (web/public/pwa: manifest, service worker, icons; icons drawn by scripts/pwa-icons.js) flat
//    into the webview folder, like the sounds.
const PWA_DIR = path.join(ROOT, 'web', 'public', 'pwa')
if (fs.existsSync(PWA_DIR)) {
  let copied = 0
  for (const name of fs.readdirSync(PWA_DIR)) {
    if (!/^[a-z0-9][a-z0-9._-]*\.(png|webmanifest|js)$/i.test(name)) continue
    fs.copyFileSync(path.join(PWA_DIR, name), path.join(WEBVIEW_OUT, name))
    copied++
  }
  if (copied) console.log(`Copied ${copied} PWA file(s) into app/dist/webview/`)
}

console.log('\nDone! Package ready in app/dist/')
