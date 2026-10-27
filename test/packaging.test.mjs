import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const main = fs.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8')

test('electron-builder config points at things that exist', () => {
  const b = pkg.build
  assert.ok(b, 'package.json has a build section')
  assert.ok(fs.existsSync(path.join(root, pkg.main)), 'main entry exists')
  assert.equal(b.productName, 'Nova.Ai')
  assert.deepEqual(b.win.target, [{ target: 'nsis', arch: ['x64'] }])
  assert.equal(b.nsis.oneClick, false)
  assert.equal(b.publish, null)                                    // never tries to upload anything
  for (const r of b.extraResources) assert.ok(fs.existsSync(path.resolve(root, r.from)), r.from)
  assert.ok(b.files.includes('electron/**/*') && b.files.includes('dist/**/*'))
  assert.ok(b.asarUnpack.includes('node_modules/get-windows/**'))   // get-windows runs a helper binary, it cannot live inside the asar
  assert.ok(fs.existsSync(path.join(root, 'node_modules', 'get-windows', 'main')) || !fs.existsSync(path.join(root, 'node_modules', 'get-windows')))
})

test('the packaged avatar path in main.js matches extraResources', () => {
  const r = pkg.build.extraResources.find((x) => x.from.endsWith('Nova_v1_grunge.vrm'))
  assert.ok(r)
  assert.match(main, /process\.resourcesPath, 'vrm', 'Nova_v1_grunge\.vrm'/)
  assert.equal(r.to, 'vrm/Nova_v1_grunge.vrm')
})

test('every page is a build input, and the scripts exist', () => {
  const vite = fs.readFileSync(path.join(root, 'vite.config.js'), 'utf8')
  for (const page of ['index.html', 'code.html', 'chat.html', 'onboarding.html', 'settings.html']) {
    assert.ok(fs.existsSync(path.join(root, page)), page)
    assert.ok(vite.includes(`'${page}'`), `${page} in vite inputs`)
  }
  assert.ok(pkg.scripts.dist.includes('electron-builder') && pkg.scripts.pack.includes('--dir'))
})
