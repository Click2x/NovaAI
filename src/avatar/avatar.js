// VRM avatar: load, frame, idle animation (blink, breathing, relaxed arms, look-at-cursor).
// Expression and lip-sync hooks (setExpression, setMouth) are in place for later phases.
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm'

// opts.frame: 'body' (default, the whole figure for the overlay) or 'bust' (head and shoulders, for the setup screen).
export async function createAvatar(canvas, url, opts = {}) {
  // alpha + premultiplied so the window shows through; the hit-test reads alpha straight from the GL buffer.
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, premultipliedAlpha: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setClearColor(0x000000, 0)
  renderer.outputColorSpace = THREE.SRGBColorSpace

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(25, 1, 0.1, 50)

  const key = new THREE.DirectionalLight(0xffffff, Math.PI)
  key.position.set(1, 1.5, 2)
  scene.add(key, new THREE.AmbientLight(0xffffff, 0.6))

  const loader = new GLTFLoader()
  loader.register((parser) => new VRMLoaderPlugin(parser))
  const gltf = await loader.loadAsync(url)
  const vrm = gltf.userData.vrm
  VRMUtils.removeUnnecessaryVertices(gltf.scene)
  VRMUtils.combineSkeletons(gltf.scene)
  VRMUtils.rotateVRM0(vrm) // VRM 0.x faces -Z; this makes both versions face the camera
  scene.add(vrm.scene)

  // Relaxed pose: VRM loads in a T-pose.
  const bone = (name) => vrm.humanoid.getNormalizedBoneNode(name)
  bone('leftUpperArm').rotation.z = -1.3
  bone('rightUpperArm').rotation.z = 1.3

  // Frame the whole body, feet near the bottom of the window.
  const box = new THREE.Box3().setFromObject(vrm.scene)
  const size = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())
  const fovRad = THREE.MathUtils.degToRad(camera.fov)
  const bust = opts.frame === 'bust'
  const dist = ((bust ? size.y * 0.36 : size.y * 1.08)) / (2 * Math.tan(fovRad / 2))
  if (bust) center.y = box.max.y - size.y * 0.17
  camera.position.set(center.x, center.y, center.z + dist)
  camera.lookAt(center)

  const lookTarget = new THREE.Object3D()
  lookTarget.position.set(center.x, box.max.y - size.y * 0.12, center.z + dist)
  scene.add(lookTarget)
  if (vrm.lookAt) vrm.lookAt.target = lookTarget

  // Blink scheduling.
  let nextBlink = 2 + Math.random() * 3
  let blinkT = -1
  let t = 0

  const expr = vrm.expressionManager
  const spine = bone('spine')
  const chest = bone('chest')

  function resize() {
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
  }
  resize()
  window.addEventListener('resize', resize)

  return {
    renderer,
    // Move the gaze target. nx, ny in [-1, 1] across the window, y up.
    lookAtNormalized(nx, ny) {
      lookTarget.position.x = center.x + nx * 0.6
      lookTarget.position.y = center.y + size.y * 0.3 + ny * 0.4
    },
    setExpression(name, value) {
      if (expr && expr.getExpression(name)) expr.setValue(name, value)
    },
    setMouth(value) {
      if (expr) expr.setValue('aa', value)
    },
    // Lip-sync: { aa, ih, ou, ee, oh } in 0..1, driven every frame while Nova speaks.
    setVisemes(shapes) {
      if (!expr) return
      for (const k of ['aa', 'ih', 'ou', 'ee', 'oh']) expr.setValue(k, shapes[k] || 0)
    },
    update(dt) {
      t += dt
      // Blink.
      if (blinkT < 0) {
        nextBlink -= dt
        if (nextBlink <= 0) blinkT = 0
      } else {
        blinkT += dt
        const phase = blinkT / 0.16
        if (expr) expr.setValue('blink', phase < 1 ? Math.sin(phase * Math.PI) : 0)
        if (phase >= 1) { blinkT = -1; nextBlink = 2 + Math.random() * 4 }
      }
      // Breathing.
      const b = Math.sin(t * 1.6) * 0.012
      if (spine) spine.rotation.x = b
      if (chest) chest.rotation.x = b * 0.8
      vrm.update(dt)
    },
    render() {
      renderer.render(scene, camera)
    },
    // Alpha (0-255) of the pixel under a CSS-pixel position in the window. Call right after render().
    alphaAt(cssX, cssY) {
      const gl = renderer.getContext()
      const pr = renderer.getPixelRatio()
      const x = Math.floor(cssX * pr)
      const y = Math.floor(renderer.domElement.height - 1 - cssY * pr)
      if (x < 0 || y < 0 || x >= renderer.domElement.width || y >= renderer.domElement.height) return 0
      const px = new Uint8Array(4)
      gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
      return px[3]
    },
  }
}
