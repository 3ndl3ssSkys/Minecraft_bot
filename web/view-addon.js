/* Loaded into the 3D view before prismarine-viewer's own script (see viewer.js), to make it look and move like the game.
 *
 * Movement
 * - Smooth camera: the bot's position and rotation arrive in steps (up to 20 a second, unevenly). prismarine-viewer starts
 *   a new 50 ms slide for each one, and overlapping slides fight, which is what jittered. Here the viewer only sets a
 *   target and the camera eases toward it every frame, at render time.
 * - View bobbing while walking, lower eyes when sneaking, the hurt tilt, falling over on death (like the game).
 * - Field of view: Minecraft's 70 instead of the library's 75 (changeable from the panel).
 * The world, from Minecraft's own textures (shipped with prismarine-viewer)
 * - Sky colour and fog by time of day and weather (Overworld), red fog in the Nether, dark purple in the End.
 * - Sun and moon (with the right moon phase) crossing the sky, stars at night, drifting clouds at y 192.
 * - Rain and snow around it when it's outside; darker light at night and in caves; blue fog under water, orange in lava.
 * - First-person hand: Steve's arm, or the item or block it holds, with the swing and the equip dip.
 * - Cracks on the block it's breaking; the vignette, pumpkin blur and "You died!" screen.
 * window.__botView exposes the camera as drawn, so the panel can work out what a click or a circle points at.
 */
(function () {
  'use strict'
  const params = new URLSearchParams(location.search)
  const key = params.get('key') ? `key=${encodeURIComponent(params.get('key'))}` : ''
  const state = window.__botView = {
    fov: Number(params.get('fov')) || 70,
    smooth: params.get('smooth') !== '0',
    fx: params.get('fx') !== '0', // sky, weather, hand and the rest
    bobbing: params.get('bob') !== '0',
    camera: null,
    scene: null,
    target: null, // rotation the viewer last asked for
    shown: null, // rotation on screen now
    pos: null, // camera position on screen now (smoothed)
    env: null
  }
  const TAU = Math.PI * 2
  const wrap = (a) => ((a + Math.PI) % TAU + TAU) % TAU - Math.PI
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
  const lerp = (a, b, t) => a + (b - a) * t
  let THREE = null

  // ------------------------------------------------------------------------------------------------------------------
  // The camera: smoothed position and rotation, bobbing, sneaking, hurt tilt
  // ------------------------------------------------------------------------------------------------------------------
  const motion = { walk: 0, bob: 0, eye: 0, hurtAt: 0, lastHurt: 0, deadTilt: 0, prev: null, last: 0, swingAt: -1, swing: 0, equipAt: 0, held: undefined }

  function hookCamera (cam) {
    if (state.camera === cam) return
    state.camera = cam
    const rot = cam.rotation
    const rawSet = rot.set.bind(rot)
    state.rawSet = rawSet
    // The viewer calls rotation.set(pitch, yaw, 0, 'ZYX') on every position update: keep it as the target instead.
    rot.set = function (x, y, z, order) {
      state.target = { x, y }
      if (!state.shown) { state.shown = { x, y }; return rawSet(x, y, z, order || 'ZYX') }
      return rot
    }
    // Draw the camera where it should be right now, not where the last slide left it (the slide keeps the target).
    const original = cam.updateMatrixWorld.bind(cam)
    cam.updateMatrixWorld = function (force) {
      const raw = this.position
      const target = raw.clone()
      const shown = step(target)
      raw.copy(shown)
      original(force)
      raw.copy(target)
    }
  }

  /** One frame of camera motion: returns the position to draw; sets the rotation. */
  function step (target) {
    if (!state.target) return target // not first person (the overhead view): leave it to the viewer
    const now = performance.now()
    const dt = clamp((now - (motion.last || now)) / 1000, 0, 0.1)
    motion.last = now
    const env = state.env
    // Position: ease toward the target; jump when it moved far (teleport, respawn).
    if (!state.pos || state.pos.distanceTo(target) > 6 || !state.smooth) state.pos = target.clone()
    else state.pos.lerp(target, 1 - Math.exp(-dt / 0.045)) // ~45 ms: smooth, without lagging behind jumps
    const p = state.pos.clone()
    // Walking: distance covered drives the bob, as in the game.
    if (motion.prev) {
      const moved = Math.hypot(p.x - motion.prev.x, p.z - motion.prev.z)
      if (moved < 1 && moved > 0.002) motion.walk += moved // tiny wobbles aren't steps
      // How fast it really walks (its own velocity, blocks a tick), not the camera's easing: standing still never bobs.
      const want = env && env.ground && !env.dead && env.speed > 0.03 ? Math.min(0.1, env.speed) : 0
      motion.bob = lerp(motion.bob, want, 1 - Math.exp(-dt * 10))
    }
    motion.prev = p.clone()
    // Eyes: 1.62 standing (the viewer uses 1.6), 0.35 lower when sneaking.
    const eye = env && env.sneak ? -0.33 : 0.02
    motion.eye = lerp(motion.eye, eye, 1 - Math.exp(-dt * 14))
    p.y += motion.eye

    // Rotation: ease toward the target.
    let roll = 0
    let pitchAdd = 0
    const t = state.target
    if (t) {
      if (!state.shown) state.shown = { x: t.x, y: t.y }
      const k = state.smooth ? 1 - Math.exp(-dt * 30) : 1 // ~95% of the way in 0.1 s (the bot's own head already moves like a person's)
      state.shown.y += wrap(t.y - state.shown.y) * k
      state.shown.x += (t.x - state.shown.x) * k
    }
    if (state.fx && state.camera) {
      // View bobbing (the game's formula: sideways sway, a bounce, a little roll and nod).
      if (state.bobbing && motion.bob > 0.001) {
        const f = motion.walk * 0.6 * Math.PI
        const g = motion.bob
        const yaw = state.shown ? state.shown.y : 0
        const side = Math.sin(f) * g * 0.5
        p.x += Math.cos(yaw) * side
        p.z -= Math.sin(yaw) * side
        p.y -= Math.abs(Math.cos(f) * g)
        roll += Math.sin(f) * g * 3 * Math.PI / 180
        pitchAdd -= Math.abs(Math.cos(f - 0.2) * g) * 5 * Math.PI / 180
      }
      // Hurt: the camera jerks sideways and settles (10 ticks).
      const h = (now - motion.hurtAt) / 500
      if (h >= 0 && h < 1) roll -= Math.sin(Math.pow(1 - h, 4) * Math.PI) * 14 * Math.PI / 180
      // Dead: fall over.
      motion.deadTilt = lerp(motion.deadTilt, env && env.dead ? 1 : 0, 1 - Math.exp(-dt * 4))
      roll += motion.deadTilt * 80 * Math.PI / 180
      p.y -= motion.deadTilt * 1.2
    }
    if (state.shown && state.rawSet) state.rawSet(state.shown.x + pitchAdd, state.shown.y, roll, 'ZYX')
    return p
  }

  // ------------------------------------------------------------------------------------------------------------------
  // Hooks into three.js as prismarine-viewer loads it
  // ------------------------------------------------------------------------------------------------------------------
  function patch (lib) {
    if (!lib || lib.__botPatched) return
    THREE = lib
    try {
      const P = lib.PerspectiveCamera.prototype
      const update = P.updateProjectionMatrix
      P.updateProjectionMatrix = function () {
        if (this.fov !== state.fov && state.fov) this.fov = state.fov
        hookCamera(this)
        return update.call(this)
      }
      // The renderer's render() lives on each instance in this three.js, so find the scene as the viewer fills it.
      const add = lib.Object3D.prototype.add
      lib.Object3D.prototype.add = function (...objs) {
        if (this.isScene && !state.scene) state.scene = this
        return add.apply(this, objs)
      }
      Object.defineProperty(lib, '__botPatched', { value: true })
    } catch (err) { console.warn('view addon:', err) }
  }

  // prismarine-viewer does `global.THREE = require('three')` first thing: catch it as it arrives.
  let real
  try {
    Object.defineProperty(window, 'THREE', { configurable: true, get () { return real }, set (v) { real = v; patch(v) } })
  } catch { /* already defined */ }

  // ------------------------------------------------------------------------------------------------------------------
  // What the bot's surroundings are like (viewer.js /view/env, 10 a second)
  // ------------------------------------------------------------------------------------------------------------------
  let envAt = 0
  function listen () {
    let es
    try { es = new EventSource(`env${key ? `?${key}` : ''}`) } catch { return }
    es.onmessage = (e) => {
      try {
        const env = JSON.parse(e.data)
        const prev = state.env
        if (prev && env.hurt && env.hurt !== prev.hurt) motion.hurtAt = performance.now()
        if (!prev || env.swing !== prev.swing) motion.swingAt = prev ? performance.now() : -1
        if (!prev || env.held !== prev.held || env.slot !== prev.slot) { motion.equipAt = performance.now(); if (prev) heldChanged = true }
        state.env = env
        envAt = performance.now()
      } catch { /* bad line */ }
    }
  }
  listen()
  let heldChanged = true

  // ------------------------------------------------------------------------------------------------------------------
  // The world around: sky, sun and moon, stars, clouds, fog, light, weather, hand, cracks, overlays
  // ------------------------------------------------------------------------------------------------------------------
  const world = {}
  const tex = {}
  function texture (rel, repeat, own = false) {
    const v = state.env?.ver || '1.21.4'
    const k = `${v}/${rel}`
    if (tex[k] && !own) return tex[k]
    const t = new THREE.TextureLoader().load(`textures/${k}`)
    t.magFilter = THREE.NearestFilter
    t.minFilter = THREE.NearestFilter
    if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping }
    if (!own) tex[k] = t
    return t
  }

  function setupWorld (scene, camera) {
    // The sky: a dome coloured from the zenith to the horizon, drawn first and never in front of anything.
    const sky = new THREE.Group()
    sky.renderOrder = -100
    const domeGeo = new THREE.SphereGeometry(300, 24, 12)
    domeGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(domeGeo.attributes.position.count * 3), 3))
    const dome = new THREE.Mesh(domeGeo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, depthTest: false, depthWrite: false, fog: false }))
    dome.renderOrder = -100
    sky.add(dome)
    // Stars: fixed to the sky, turning with it.
    const starPos = []
    let seed = 10842
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }
    for (let i = 0; i < 1500; i++) {
      const u = rnd() * 2 - 1; const a = rnd() * TAU; const r = Math.sqrt(1 - u * u)
      starPos.push(Math.cos(a) * r * 250, u * 250, Math.sin(a) * r * 250)
    }
    const starGeo = new THREE.BufferGeometry()
    starGeo.setAttribute('position', new THREE.Float32BufferAttribute(starPos, 3))
    const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0, depthTest: false, depthWrite: false, fog: false }))
    stars.renderOrder = -99
    const celestial = new THREE.Group() // turns with the time of day: east is +x
    celestial.add(stars)
    const plane = (map, size) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ map, transparent: true, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, fog: false }))
      m.renderOrder = -98
      return m
    }
    const sun = plane(texture('environment/sun.png'), 60)
    sun.position.set(0, 200, 0); sun.rotation.x = Math.PI / 2
    const moonTex = texture('environment/moon_phases.png', false, true) // its own copy: the phase moves its offset
    moonTex.repeat.set(0.25, 0.5)
    const moon = plane(moonTex, 40)
    moon.position.set(0, -200, 0); moon.rotation.x = -Math.PI / 2
    celestial.add(sun, moon)
    sky.add(celestial)
    scene.add(sky)

    // Clouds: the game's cloud map, 12 blocks a pixel, at y 192, fading out with distance.
    const cloudMat = new THREE.ShaderMaterial({
      uniforms: { map: { value: texture('environment/clouds.png', true) }, offset: { value: new THREE.Vector2() }, color: { value: new THREE.Color(1, 1, 1) }, cam: { value: new THREE.Vector3() }, fade: { value: 400 } },
      vertexShader: 'varying vec3 vWorld; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
      fragmentShader: 'uniform sampler2D map; uniform vec2 offset; uniform vec3 color; uniform vec3 cam; uniform float fade; varying vec3 vWorld;' +
        'void main(){ vec4 c = texture2D(map, (vWorld.xz + offset) / 3072.0); float d = distance(vWorld.xz, cam.xz); float a = c.a * 0.8 * (1.0 - smoothstep(fade * 0.5, fade, d)); if (a < 0.01) discard; gl_FragColor = vec4(color * c.rgb, a); }',
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide
    })
    const clouds = new THREE.Mesh(new THREE.PlaneGeometry(1200, 1200), cloudMat)
    clouds.rotation.x = -Math.PI / 2
    clouds.renderOrder = 5
    scene.add(clouds)

    // Rain and snow: short streaks or flakes falling around the camera.
    const N = 700
    const dropPos = new Float32Array(N * 6)
    const drops = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(dropPos, 3)), new THREE.LineBasicMaterial({ color: 0x9fb4d8, transparent: true, opacity: 0.55, depthWrite: false }))
    drops.frustumCulled = false
    const flakePos = new Float32Array(N * 3)
    const flakes = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(flakePos, 3)), new THREE.PointsMaterial({ color: 0xffffff, size: 0.12, transparent: true, opacity: 0.85, depthWrite: false }))
    flakes.frustumCulled = false
    const seeds = Array.from({ length: N }, () => ({ x: (rnd() - 0.5) * 24, z: (rnd() - 0.5) * 24, y: rnd() * 20, s: 0.8 + rnd() * 0.4 }))
    scene.add(drops, flakes)

    // Cracks on the block being broken: the 10 destroy stages.
    const crackMat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, opacity: 0.9, fog: true })
    const crack = new THREE.Mesh(new THREE.BoxGeometry(1.002, 1.002, 1.002), crackMat)
    crack.visible = false
    scene.add(crack)

    // The hand, drawn on top of everything (it never pokes into walls), following the camera.
    scene.add(camera)
    const hand = new THREE.Group()
    camera.add(hand)
    const armGeo = new THREE.BoxGeometry(0.25, 0.75, 0.25)
    const uv = armGeo.attributes.uv
    const face = (i, u0, v0, u1, v1) => { // pixel rectangle on the 64x64 skin → one box face (tl, tr, bl, br)
      const c = [[u0, v0], [u1, v0], [u0, v1], [u1, v1]]
      for (let j = 0; j < 4; j++) uv.setXY(i * 4 + j, c[j][0] / 64, 1 - c[j][1] / 64)
    }
    face(0, 40, 20, 44, 32); face(1, 48, 20, 52, 32); face(2, 44, 16, 48, 20); face(3, 48, 16, 52, 20); face(4, 44, 20, 48, 32); face(5, 52, 20, 56, 32)
    uv.needsUpdate = true
    // Front faces only for solid shapes: drawn without depth testing (so the hand never pokes into a wall), the far
    // faces of a box would otherwise paint over the near ones. Flat items show both sides.
    const handMat = (map, flat = false) => new THREE.MeshBasicMaterial({ map, transparent: true, alphaTest: 0.1, depthTest: false, depthWrite: false, fog: false, side: flat ? THREE.DoubleSide : THREE.FrontSide })
    const arm = new THREE.Mesh(armGeo, handMat(texture('entity/player/wide/steve.png')))
    arm.renderOrder = 1000
    hand.add(arm)
    const item = new THREE.Group()
    hand.add(item)

    // Overlays on the page: the vignette, under water / pumpkin, "You died!".
    const overlay = (css) => { const d = document.createElement('div'); d.style.cssText = `position:fixed;inset:0;pointer-events:none;${css}`; document.body.appendChild(d); return d }
    const v = state.env?.ver || '1.21.4'
    const vignette = overlay(`background:url(textures/${v}/misc/vignette.png) center/100% 100%;mix-blend-mode:multiply;filter:invert(1);opacity:0.5`)
    const underwater = overlay(`background:url(textures/${v}/misc/underwater.png) center/cover;opacity:0;image-rendering:pixelated`)
    const pumpkin = overlay(`background:url(textures/${v}/misc/pumpkinblur.png) center/100% 100%;opacity:0;image-rendering:pixelated`)
    const died = overlay('display:none;background:rgba(120,0,0,.45);color:#fff;font:bold 7vh monospace;text-align:center;padding-top:30vh;text-shadow:3px 3px #3f0000')
    died.textContent = 'You died!'

    Object.assign(world, { plainSky: scene.background, bg: new THREE.Color(), scene, camera, sky, dome, domeGeo, stars, celestial, sun, moon, moonTex, clouds, cloudMat, drops, dropPos, flakes, flakePos, seeds, crack, crackMat, hand, arm, item, handMat, vignette, underwater, pumpkin, died })
  }

  // The game's sky maths (plains biome colours).
  const DAY_SKY = [0.47, 0.65, 1.0]
  const DAY_FOG = [0.75, 0.85, 1.0]
  function celestialAngle (t) {
    const d = (((t / 24000 - 0.25) % 1) + 1) % 1
    const e = 0.5 - Math.cos(d * Math.PI) / 2
    return (d * 2 + e) / 3
  }

  /** Light the scene by time of day and by the light where the eyes are. */
  function lights (scene, level) {
    if (!world.lights) world.lights = scene.children.filter((c) => c.isLight).map((l) => ({ l, base: l.intensity }))
    for (const { l, base } of world.lights) l.intensity = base * level
  }

  /** The held item: a flat icon, or a little block. */
  async function rebuildHeld (name) {
    const item = world.item
    while (item.children.length) item.remove(item.children[0])
    world.arm.visible = !name
    if (!name) return
    let icon = null
    try { icon = (await (await fetch(`/icons?names=${encodeURIComponent(name)}${key ? `&${key}` : ''}`)).json()).icons?.[name] } catch { /* no icon */ }
    if (state.env?.held !== name) return // changed again meanwhile
    const tint = (m, t) => { if (t) m.color = new THREE.Color(t) }
    if (icon?.cube) {
      const top = world.handMat(texture(icon.cube.up)); tint(top, icon.tint)
      const side = world.handMat(texture(icon.cube.left)); tint(side, icon.tintSides)
      const h = icon.half ? 0.5 : 1
      const g = new THREE.BoxGeometry(0.4, 0.4 * h, 0.4)
      const mesh = new THREE.Mesh(g, [side, side, top, top, side, side])
      mesh.renderOrder = 1000
      mesh.position.set(0.05, 0.05, 0)
      mesh.rotation.set(0.1, Math.PI / 4, 0)
      item.add(mesh)
    } else {
      const path = icon?.flat || `items/${name}.png`
      const m = world.handMat(texture(path), true); tint(m, icon?.tint)
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 0.55), m)
      mesh.renderOrder = 1000
      const tool = /_(sword|axe|pickaxe|shovel|hoe)$|^(stick|bone|blaze_rod|trident|mace|fishing_rod|bow|crossbow)$/.test(name)
      mesh.rotation.set(0, -Math.PI / 2.6, tool ? 0.15 : 0.35)
      mesh.position.set(0, tool ? 0.12 : 0.02, 0)
      item.add(mesh)
    }
  }

  let lastFrame = performance.now()
  function frame (now) {
    requestAnimationFrame(frame)
    const cam = state.camera
    if (!cam) return
    if (cam.fov !== state.fov) { cam.fov = state.fov; cam.updateProjectionMatrix() }
    const dt = clamp((now - lastFrame) / 1000, 0, 0.1)
    lastFrame = now
    if (!world.scene) {
      if (!state.scene || !state.env) return
      try { setupWorld(state.scene, cam) } catch (err) { console.warn('view addon:', err); state.fx = false; return }
    }
    const env = state.env
    const on = state.fx && env
    for (const o of [world.sky, world.clouds, world.drops, world.flakes, world.hand]) o.visible = Boolean(on)
    for (const o of [world.vignette, world.underwater, world.pumpkin]) o.style.display = on ? 'block' : 'none'
    if (!on) { world.scene.fog = null; world.crack.visible = false; world.died.style.display = 'none'; lights(world.scene, 1); world.scene.background = world.plainSky; return }

    const p = state.pos || cam.position
    const ticks = (env.time + (env.cycle ? (now - envAt) / 50 : 0)) % 24000
    const dim = env.dim
    const overworld = dim === 'overworld'
    const angle = celestialAngle(ticks)
    const bright = overworld ? clamp(Math.cos(angle * TAU) * 2 + 0.5, 0, 1) : dim === 'nether' ? 0.6 : 0.35
    const rain = overworld && env.rain ? (env.thunder ? 0.85 : 0.6) : 0

    // Sky and fog colours.
    let skyC, fogC
    if (overworld) {
      skyC = DAY_SKY.map((c) => c * bright)
      fogC = DAY_FOG.map((c) => c * (bright * 0.94 + 0.06))
      if (rain) { const g = (x) => x * 0.3 + 0.59 * x; skyC = skyC.map((c) => lerp(c, g(c) * 0.6, rain)); fogC = fogC.map((c) => lerp(c, g(c) * 0.6, rain)) }
      // Sunrise and sunset: the horizon glows orange on the sun's side.
      const sr = Math.cos(angle * TAU)
      if (sr > -0.4 && sr < 0.4) {
        const k = (1 - Math.abs(sr) / 0.4) * (1 - rain)
        fogC = [lerp(fogC[0], 1.0, k * 0.55), lerp(fogC[1], 0.5, k * 0.45), lerp(fogC[2], 0.25, k * 0.6)]
      }
    } else if (dim === 'nether') { skyC = [0.2, 0.03, 0.03]; fogC = [0.2, 0.03, 0.03] } else { skyC = [0.09, 0.05, 0.11]; fogC = [0.06, 0.04, 0.08] }
    if (env.eyeIn === 'water') fogC = [0.02, 0.1, 0.35]
    if (env.eyeIn === 'lava') fogC = [0.6, 0.1, 0]
    if (env.eyeIn === 'snow') fogC = [0.62, 0.73, 0.8]

    // The dome: zenith colour on top, fog colour at the horizon and below.
    const pos = world.domeGeo.attributes.position
    const col = world.domeGeo.attributes.color
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i) / 300
      const k = clamp((y + 0.05) / 0.45, 0, 1)
      col.setXYZ(i, lerp(fogC[0], skyC[0], k), lerp(fogC[1], skyC[1], k), lerp(fogC[2], skyC[2], k))
    }
    col.needsUpdate = true
    world.sky.position.copy(p)
    world.bg.setRGB(fogC[0], fogC[1], fogC[2])
    world.scene.background = world.bg

    // Fog: from about three quarters of the view distance out to its edge (the chunk edge disappears into it).
    const far = Math.max(32, (env.viewDistance || 4) * 16)
    let near = far * 0.7; let farF = far
    if (env.eyeIn === 'water') { near = 0; farF = 18 } else if (env.eyeIn === 'lava') { near = 0; farF = 2 } else if (env.eyeIn === 'snow') { near = 0; farF = 2 } else if (dim === 'nether') { near = far * 0.1; farF = far * 0.6 } else if (rain) { near = far * 0.5 }
    if (!world.scene.fog) {
      world.scene.fog = new THREE.Fog(0, near, farF)
      // Materials compiled before there was fog ignore it until they're rebuilt (chunks added later are fine).
      world.scene.traverse((o) => { if (o.material) for (const m of [].concat(o.material)) m.needsUpdate = true })
    }
    world.scene.fog.color.setRGB(fogC[0], fogC[1], fogC[2])
    world.scene.fog.near = near
    world.scene.fog.far = farF

    // Sun, moon and stars turn with the time of day (east to west); only in the Overworld.
    world.celestial.visible = overworld
    world.celestial.rotation.set(0, 0, angle * TAU)
    world.sun.material.opacity = 1 - rain
    world.moon.material.opacity = 1 - rain
    const phase = ((env.day % 8) + 8) % 8
    world.moonTex.offset.set((phase % 4) * 0.25, phase < 4 ? 0.5 : 0)
    const starB = Math.pow(clamp(1 - (Math.cos(angle * TAU) * 2 + 0.25), 0, 1), 2) * 0.5 * (1 - rain)
    world.stars.material.opacity = starB * 1.6

    // Clouds drift slowly along +x; greyer at night and in rain.
    world.clouds.visible = overworld
    world.clouds.position.set(Math.round(p.x), 192.33, Math.round(p.z))
    world.cloudMat.uniforms.offset.value.set((now / 1000) * 20 * 0.03, 0) // 0.03 blocks a tick, as in the game
    world.cloudMat.uniforms.cam.value.copy(p)
    const cb = bright * 0.9 + 0.1
    world.cloudMat.uniforms.color.value.setRGB(cb * (1 - rain * 0.4), cb * (1 - rain * 0.4), cb * (1 - rain * 0.35))

    // Light: day and night outside, the brighter of sky light and torch light where the eyes are (caves get dark).
    const skyLight = (env.sky / 15) * (overworld ? (bright * 0.85 + 0.15) * (1 - rain * 0.25) : 0.6)
    const blockLight = env.block / 15
    // Never pitch black: the game's default brightness still shows the ground at night and in caves.
    // The viewer has no light per block, so dimming the whole scene underground would black out everything at once:
    // keep caves readable (like a bright gamma setting), dimmer the further from the sky.
    const level = clamp(Math.max(skyLight, blockLight * 0.9), env.sky >= 8 ? 0.35 : 0.6, 1)
    world.light = lerp(world.light ?? level, level, 1 - Math.exp(-dt * 3)) // eyes adjust over a second or so
    lights(world.scene, world.light)

    // Rain or snow, only where the sky is open above (sky light at the eyes).
    const outside = env.sky >= 12
    const falling = rain && outside && !env.eyeIn
    world.drops.visible = falling && !env.snowy
    world.flakes.visible = falling && env.snowy
    if (falling) {
      const speed = env.snowy ? 2.5 : 14
      for (let i = 0; i < world.seeds.length; i++) {
        const s = world.seeds[i]
        s.y -= speed * s.s * dt
        if (s.y < -6) s.y += 20
        // Each drop has a fixed spot in a 24-block tile; the copy nearest the camera falls (so it doesn't move with you).
        const x = s.x + Math.round((p.x - s.x) / 24) * 24
        const z = s.z + Math.round((p.z - s.z) / 24) * 24
        const y = p.y + s.y - 8
        if (env.snowy) world.flakePos.set([x + Math.sin(now / 900 + i) * 0.3, y, z], i * 3)
        else world.dropPos.set([x, y, z, x, y + 0.6, z], i * 6)
      }
      world.drops.geometry.attributes.position.needsUpdate = true
      world.flakes.geometry.attributes.position.needsUpdate = true
      world.drops.material.color.setRGB(0.62 * world.light + 0.1, 0.7 * world.light + 0.1, 0.85 * world.light + 0.1)
    }

    // Cracks on the block being dug.
    const d = env.dig
    if (d) {
      const stage = clamp(Math.floor(d.progress * 10), 0, 9)
      if (world.crackStage !== stage) { world.crackMat.map = texture(`blocks/destroy_stage_${stage}.png`); world.crackMat.needsUpdate = true; world.crackStage = stage }
      world.crack.position.set(d.x + 0.5, d.y + 0.5, d.z + 0.5)
      world.crack.visible = true
    } else world.crack.visible = false

    // The hand: what it holds, the equip dip, swings (digging swings all the time), bobbing with the walk.
    if (heldChanged) { heldChanged = false; rebuildHeld(env.held) }
    const sinceEquip = (now - motion.equipAt) / 1000
    const dip = sinceEquip < 0.25 ? 1 - sinceEquip / 0.25 : 0
    const swingT = motion.swingAt >= 0 ? (now - motion.swingAt) / 300 : 1 // a swing takes 6 ticks
    const sw = swingT < 1 ? swingT : env.dig ? ((now / 300) % 1) : 1
    const s1 = sw < 1 ? Math.sin(Math.sqrt(sw) * Math.PI) : 0
    const s2 = sw < 1 ? Math.sin(sw * sw * Math.PI) : 0
    const f = motion.walk * 0.6 * Math.PI
    const bobX = state.bobbing ? Math.sin(f) * motion.bob * 0.6 : 0
    const bobY = state.bobbing ? -Math.abs(Math.cos(f) * motion.bob) * 0.6 : 0
    const h = world.hand
    h.position.set(0.56 - s1 * 0.2 + bobX, -0.5 - dip * 0.6 + s1 * 0.12 + bobY, -0.95 - s1 * 0.2)
    h.rotation.set(-s2 * 0.6 - 0.1, -0.35 + s1 * 0.4, -s1 * 0.3)
    // The arm reaches from the bottom-right corner forward, up and in toward the middle, side on (as in the game).
    if (!world.armSet) {
      const dir = new THREE.Vector3(-0.45, 0.55, -1).normalize() // shoulder → hand
      world.arm.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().negate()) // the skin's top (shoulder) at the back
      world.arm.rotateY(0.6) // show the inside of the arm, not its edge
      // The hand end at the lower right of the screen, the shoulder off past the corner.
      world.arm.position.copy(new THREE.Vector3(-0.24, 0.24, 0.12).sub(dir.clone().multiplyScalar(0.375)))
      world.arm.scale.setScalar(0.85)
      world.item.scale.setScalar(0.8)
      world.armSet = true
    }
    const shade = clamp(world.light, 0.25, 1)
    h.traverse((o) => { if (o.material) for (const m of [].concat(o.material)) { if (!m.userData.base) m.userData.base = m.color.clone(); m.color.copy(m.userData.base).multiplyScalar(shade) } })
    h.visible = !env.dead

    // Overlays.
    world.vignette.style.opacity = String(clamp(0.25 + (1 - world.light) * 0.5, 0.2, 0.75))
    world.underwater.style.opacity = env.eyeIn === 'water' ? '0.25' : '0'
    world.pumpkin.style.opacity = env.pumpkin ? '1' : '0'
    world.died.style.display = env.dead ? 'block' : 'none'
  }
  requestAnimationFrame(frame)

  // The panel changes these live.
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || !e.data || e.data.type !== 'botView') return
    if (Number.isFinite(e.data.fov)) state.fov = Math.max(30, Math.min(110, e.data.fov))
    if (typeof e.data.smooth === 'boolean') state.smooth = e.data.smooth
    if (typeof e.data.fx === 'boolean') state.fx = e.data.fx
    if (typeof e.data.bobbing === 'boolean') state.bobbing = e.data.bobbing
  })

  /** The camera as drawn right now (for pointing). */
  state.snapshot = function () {
    const cam = state.camera
    if (!cam) return null
    const s = state.shown || { x: cam.rotation.x, y: cam.rotation.y }
    const p = state.pos || cam.position
    return { pos: { x: p.x, y: p.y, z: p.z }, yaw: s.y, pitch: s.x, fov: cam.fov, aspect: cam.aspect }
  }
})()
