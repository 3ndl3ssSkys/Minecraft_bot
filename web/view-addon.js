/* Loaded into the 3D view before prismarine-viewer's own script (see viewer.js).
 * - Field of view: Minecraft's 70 instead of the library's fixed 75, changeable from the panel.
 * - Smooth turning: the bot's yaw/pitch arrive in jumps (up to 20 a second); the camera eases toward them every frame.
 * - window.__botView exposes the camera as drawn, so the panel can work out what a click or a circle points at.
 */
(function () {
  'use strict'
  const params = new URLSearchParams(location.search)
  const state = window.__botView = {
    fov: Number(params.get('fov')) || 70,
    smooth: params.get('smooth') !== '0',
    camera: null,
    target: null, // rotation the viewer last asked for
    shown: null // rotation on screen now
  }
  const TAU = Math.PI * 2
  const wrap = (a) => ((a + Math.PI) % TAU + TAU) % TAU - Math.PI

  function hookCamera (cam) {
    if (state.camera === cam) return
    state.camera = cam
    const rot = cam.rotation
    const rawSet = rot.set.bind(rot)
    state.rawSet = rawSet
    // The viewer calls rotation.set(pitch, yaw, 0, 'ZYX') on every position update: keep it as the target instead.
    rot.set = function (x, y, z, order) {
      state.target = { x, y }
      if (!state.shown || !state.smooth) { state.shown = { x, y }; return rawSet(x, y, z, order || 'ZYX') }
      return rot
    }
  }

  function patch (THREE) {
    if (!THREE || THREE.__botPatched) return
    try {
      const P = THREE.PerspectiveCamera.prototype
      const update = P.updateProjectionMatrix
      P.updateProjectionMatrix = function () {
        if (this.fov !== state.fov && state.fov) this.fov = state.fov
        hookCamera(this)
        return update.call(this)
      }
      Object.defineProperty(THREE, '__botPatched', { value: true })
    } catch (err) { console.warn('view addon:', err) }
  }

  // prismarine-viewer does `global.THREE = require('three')` first thing: catch it as it arrives.
  let real
  try {
    Object.defineProperty(window, 'THREE', { configurable: true, get () { return real }, set (v) { real = v; patch(v) } })
  } catch { /* already defined */ }

  let last = performance.now()
  function frame (now) {
    requestAnimationFrame(frame)
    const cam = state.camera
    if (!cam) return
    if (cam.fov !== state.fov) { cam.fov = state.fov; cam.updateProjectionMatrix() }
    const t = state.target
    if (!t || !state.shown) return
    const dt = Math.min(0.1, (now - last) / 1000)
    last = now
    const k = state.smooth ? 1 - Math.exp(-dt * 16) : 1 // ~95% of the way in 0.2 s
    const s = state.shown
    s.y += wrap(t.y - s.y) * k
    s.x += (t.x - s.x) * k
    state.rawSet(s.x, s.y, 0, 'ZYX')
  }
  requestAnimationFrame(frame)

  // The panel changes these live.
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || !e.data || e.data.type !== 'botView') return
    if (Number.isFinite(e.data.fov)) state.fov = Math.max(30, Math.min(110, e.data.fov))
    if (typeof e.data.smooth === 'boolean') state.smooth = e.data.smooth
  })

  /** The camera as drawn right now (for pointing). */
  state.snapshot = function () {
    const cam = state.camera
    if (!cam) return null
    const s = state.shown || { x: cam.rotation.x, y: cam.rotation.y }
    return { pos: { x: cam.position.x, y: cam.position.y, z: cam.position.z }, yaw: s.y, pitch: s.x, fov: cam.fov, aspect: cam.aspect }
  }
})()
