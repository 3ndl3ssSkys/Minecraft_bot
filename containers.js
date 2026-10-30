'use strict'

/**
 * containers.js — reading chests like a player would.
 *
 * For every chest/barrel the bot looks into, it works out what kind it is:
 *
 *   mine        it placed it itself
 *   community   a sign says free/public/shared, or lots of different players use it
 *   private     a sign with someone's name / "keep out", or it sits in someone's base
 *               (player-built blocks around, tidy full stacks, one regular user)
 *   unlooted    a natural structure chest (dungeon spawner, mineshaft, temple,
 *               village, stronghold, bastion, ...) that still has its loot
 *   looted      a structure chest that's been emptied or picked over
 *
 * It also remembers contents, notices when things go missing since its last
 * look ("someone took 12 iron"), and who it heard opening it. Taking from a
 * private chest that isn't yours is stealing — the bot won't, unless allowed.
 */

const { Vec3 } = require('vec3')

const COMMUNITY_WORDS = /\b(community|public|free|shared|share|donat\w*|take what|help yourself|anyone|everyone|spawn chest|giveaway|for all|freebies?)\b/i
const PRIVATE_WORDS = /\b(private|keep out|do ?n[o']t (touch|take|steal)|no stealing|mine|personal|stay out|property|owner|'s (stuff|chest|storage|base|house|items|loot)|storage|vault)\b/i
const LOOT_ITEMS = /^(saddle|name_tag|enchanted_book|music_disc_\w+|golden_apple|enchanted_golden_apple|\w+_horse_armor|bread|wheat|rotten_flesh|string|bone|gunpowder|redstone|coal|iron_ingot|gold_ingot|gold_nugget|iron_nugget|emerald|diamond|lapis_lazuli|\w+_seeds|bucket|map|compass|heart_of_the_sea|trial_key|ominous_trial_key|obsidian|flint_and_steel|ender_pearl|golden_carrot|book|paper|feather|leather|rail|powered_rail|detector_rail|torch|\w+_sapling|cobweb|poisonous_potato|potato|carrot|beetroot|suspicious_stew|glow_berries|amethyst_shard|experience_bottle|tnt|sand|\w+_smithing_template|netherite_scrap|ancient_debris|gold_block|iron_block|crossbow|arrow|spectral_arrow|golden_\w+|iron_\w+|diamond_\w+|clock|emerald_block|cooked_\w+|apple|sugar_cane|bamboo|prismarine_crystals|nautilus_shell|tripwire_hook|goat_horn|\w+_pottery_sherd|bottle_o_enchanting)$/
const PLAYER_BUILT = /planks|glass|_bricks$|wool|concrete|terracotta|crafting_table|furnace|smoker|blast_furnace|_door$|_bed$|lantern|barrel|bookshelf|carpet|_sign$|anvil|enchanting_table|brewing_stand|item_frame|torch|_stairs$|_slab$|smooth_stone|quartz|chiseled/

/** Natural-structure fingerprints: blocks that give a structure away. */
const STRUCTURES = [
  { name: 'dungeon', test: (n) => n === 'spawner' || n === 'trial_spawner' },
  { name: 'trial chamber', test: (n) => /^(tuff_bricks|vault|chiseled_tuff|polished_tuff|waxed_\w*copper\w*|copper_grate)$/.test(n) },
  { name: 'mineshaft', test: (n) => /^(rail|cobweb)$/.test(n), underground: true },
  { name: 'stronghold', test: (n) => /^(end_portal_frame|infested_stone_bricks|mossy_stone_bricks|cracked_stone_bricks)$/.test(n) },
  { name: 'desert temple', test: (n) => /^(chiseled_sandstone|orange_terracotta)$/.test(n) },
  { name: 'jungle temple', test: (n) => /^(chiseled_stone_bricks|mossy_cobblestone)$/.test(n), alsoNeeds: /vine/ },
  { name: 'bastion', test: (n) => /^(polished_blackstone_bricks|cracked_polished_blackstone_bricks|gilded_blackstone)$/.test(n) },
  { name: 'nether fortress', test: (n) => /^(nether_brick_fence|nether_bricks)$/.test(n) },
  { name: 'end city', test: (n) => /^(purpur_block|purpur_pillar|end_stone_bricks)$/.test(n) },
  { name: 'ancient city', test: (n) => /^(reinforced_deepslate|sculk_shrieker|deepslate_tiles)$/.test(n) },
  { name: 'village', test: (n) => /^(bell|composter|lectern|fletching_table|cartography_table|smithing_table)$/.test(n) },
  { name: 'shipwreck or buried treasure', test: () => false } // decided from water/sand around, below
]

const key = (p) => `${p.x},${p.y},${p.z}`

function signText (block) {
  try {
    const t = block.getSignText?.()
    if (t) return t.filter(Boolean).map((x) => String(x).replace(/\s+/g, ' ').trim()).filter(Boolean).join(' / ')
  } catch { /* not a sign entity */ }
  return block.signText ? String(block.signText).trim() : ''
}

class ContainerIntel {
  constructor (agent, data = {}) {
    this.agent = agent
    this.records = data.records || {}
  }

  record (pos) {
    const k = key(pos)
    this.records[k] ||= { x: pos.x, y: pos.y, z: pos.z, type: 'chest', firstSeen: Date.now(), openers: {}, placedByMe: false, history: [] }
    return this.records[k]
  }

  onPlaced (pos, type) {
    const r = this.record(pos)
    r.placedByMe = true
    r.type = type
    this.agent.learning?.markDirty()
  }

  onOpenedBy (pos, player) {
    if (!player || player === this.agent.bot.username) return
    // Sounds come from the chest's centre; match the chest we know about nearest to it.
    const rec = Object.values(this.records).find((r) => Math.abs(r.x - pos.x) <= 1 && Math.abs(r.y - pos.y) <= 1 && Math.abs(r.z - pos.z) <= 1) || this.record(pos)
    rec.openers[player] = (rec.openers[player] || 0) + 1
    rec.lastOpener = { player, at: Date.now() }
  }

  /** Nearby signs (text + position), for chests and for the prompt. */
  signsNear (bot, center, radius = 6, limit = 6) {
    const ids = bot.registry.blocksArray.filter((b) => /_sign$|_hanging_sign$/.test(b.name)).map((b) => b.id)
    const out = []
    for (const p of bot.findBlocks({ point: center, matching: ids, maxDistance: radius, count: limit })) {
      const b = bot.blockAt(p)
      const text = b && signText(b)
      if (text) out.push({ pos: p, text })
    }
    return out
  }

  /** What's around the chest: structure? someone's base? */
  surroundings (bot, pos) {
    const counts = { built: 0, water: 0, sand: 0, vine: 0, total: 0 }
    const found = new Set()
    for (let dx = -6; dx <= 6; dx++) {
      for (let dy = -3; dy <= 4; dy++) {
        for (let dz = -6; dz <= 6; dz++) {
          const b = bot.blockAt(new Vec3(pos.x + dx, pos.y + dy, pos.z + dz))
          if (!b || b.name === 'air' || b.name === 'cave_air') continue
          counts.total++
          if (PLAYER_BUILT.test(b.name)) counts.built++
          if (/water/.test(b.name)) counts.water++
          if (/^(sand|gravel|sandstone)$/.test(b.name)) counts.sand++
          if (/vine/.test(b.name)) counts.vine++
          for (const s of STRUCTURES) {
            if (!s.test(b.name)) continue
            if (s.underground && pos.y > 50) continue
            if (s.alsoNeeds && !counts.vine) continue
            found.add(s.name)
          }
        }
      }
    }
    if (!found.size && counts.water > 40 && /planks|log/.test(bot.blockAt(new Vec3(pos.x, pos.y - 1, pos.z))?.name || '')) found.add('shipwreck')
    if (!found.size && counts.sand > 80 && pos.y < 70 && counts.built < 3) found.add('buried treasure')
    const villagers = Object.values(bot.entities).some((e) => e.name === 'villager' && e.position.distanceTo(new Vec3(pos.x, pos.y, pos.z)) < 24)
    if (villagers) found.add('village')
    return { structure: [...found][0] || null, built: counts.built, total: counts.total }
  }

  /**
   * Classify a chest we just looked into, and note what changed since last time.
   * @returns {{ kind, label, owner, confidence, reasons: string[], changes: string|null }}
   */
  inspect (bot, block, contents) {
    const pos = block.position
    const rec = this.record(pos)
    rec.type = block.name
    const prev = rec.contents
    const prevSeen = rec.lastSeen || 0
    rec.contents = contents
    rec.lastSeen = Date.now()
    rec.history.push({ at: Date.now(), contents })
    if (rec.history.length > 5) rec.history.shift()

    // What changed since we last looked?
    let changes = null
    if (prev) {
      const taken = []; const added = []
      for (const [item, n] of Object.entries(prev)) if ((contents[item] || 0) < n) taken.push(`${n - (contents[item] || 0)} ${item}`)
      for (const [item, n] of Object.entries(contents)) if ((prev[item] || 0) < n) added.push(`${n - (prev[item] || 0)} ${item}`)
      if (taken.length || added.length) {
        changes = [taken.length ? `missing since you last looked: ${taken.join(', ')}` : '', added.length ? `new: ${added.join(', ')}` : ''].filter(Boolean).join('; ')
      }
      // Someone raided OUR chest.
      if (taken.length && rec.placedByMe && !rec.selfTookAt) {
        const suspect = rec.lastOpener && rec.lastOpener.at > prevSeen ? rec.lastOpener.player : null
        this.agent.memory.addEvent('stolen', `Things went missing from your ${block.name} at (${pos.x}, ${pos.y}, ${pos.z}): ${taken.join(', ')}${suspect ? ` — you heard ${suspect} opening it` : ''}.`)
        if (suspect) this.agent.social?.adjustTrust(suspect, -6, `took things from your chest (${taken.slice(0, 2).join(', ')})`)
        this.agent.emotions?.stimulate({ anger: 0.2, sadness: 0.1 }, 'someone took things from your chest')
      }
    }
    rec.selfTookAt = 0

    const c = this.classify(bot, block, rec, contents, prev)
    rec.classification = { ...c, at: Date.now() }
    this.agent.learning?.markDirty()
    return { ...c, changes }
  }

  classify (bot, block, rec, contents, prev) {
    const reasons = []
    const score = { mine: 0, community: 0, private: 0, unlooted: 0, looted: 0 }
    let owner = null

    if (rec.placedByMe) { score.mine += 10; reasons.push('you placed it') }

    // Signs.
    const signs = this.signsNear(bot, block.position, 5)
    const players = new Set([...Object.keys(bot.players), ...Object.values(this.agent.social?.players || {}).map((p) => p.name)].map((n) => n.toLowerCase()))
    for (const s of signs) {
      if (COMMUNITY_WORDS.test(s.text)) { score.community += 4; reasons.push(`sign: "${s.text}"`) }
      if (PRIVATE_WORDS.test(s.text)) { score.private += 3; reasons.push(`sign: "${s.text}"`) }
      const named = s.text.match(/([A-Za-z0-9_]{3,16})(?:'s|s'| owns| only)/)
      const nameInSign = s.text.split(/[^A-Za-z0-9_]+/).find((w) => players.has(w.toLowerCase()))
      if (named || nameInSign) {
        owner = (named?.[1]) || nameInSign
        score.private += 2
        if (!reasons.some((r) => r.includes(s.text))) reasons.push(`sign names ${owner}: "${s.text}"`)
      }
    }

    // Where is it?
    const around = this.surroundings(bot, block.position)
    const items = Object.entries(contents)
    const total = items.reduce((a, [, n]) => a + n, 0)
    const lootish = items.filter(([n]) => LOOT_ITEMS.test(n)).length
    const fullStacks = items.filter(([n, c]) => c >= (bot.registry.itemsByName[n]?.stackSize || 64)).length
    if (around.structure) {
      reasons.push(`part of a ${around.structure}`)
      if (!items.length) { score.looted += 5; reasons.push('empty') }
      else if (lootish / items.length >= 0.6 && fullStacks <= 1 && !Object.keys(rec.openers).length) { score.unlooted += 5; reasons.push('still has its loot') }
      else if (lootish / items.length >= 0.6) { score.looted += 2; score.unlooted += 2; reasons.push('picked over') }
      else { score.private += 2; reasons.push('someone has been storing their own stuff in it') }
    } else if (around.built >= 6) {
      score.private += 2 + Math.min(3, around.built / 15)
      reasons.push(`inside someone's build (${around.built} placed blocks around)`)
    } else if (!items.length) {
      reasons.push('empty, in the open')
    }

    // How it's used.
    const openers = Object.entries(rec.openers).sort((a, b) => b[1] - a[1])
    if (openers.length >= 3) { score.community += 3; reasons.push(`${openers.length} different players use it`) }
    else if (openers.length === 1 && openers[0][1] >= 2) { owner ||= openers[0][0]; score.private += 1.5; reasons.push(`${openers[0][0]} uses it`) }
    if (items.length >= 4 && fullStacks / items.length > 0.6) { score.private += 1.5; reasons.push('tidy full stacks (someone\'s storage)') }
    if (prev && Object.keys(prev).length && !items.length && around.structure) reasons.push('emptied since you last looked')

    const kind = Object.entries(score).sort((a, b) => b[1] - a[1])[0]
    const best = kind[1] > 0 ? kind[0] : 'unknown'
    const labels = {
      mine: 'your own chest',
      community: 'a community chest',
      private: owner ? `${owner}'s chest` : "someone's private chest",
      unlooted: `an unlooted ${around.structure} chest`,
      looted: `a looted ${around.structure || 'loot'} chest`,
      unknown: 'a chest (not sure whose)'
    }
    return { kind: best, label: labels[best], owner, confidence: Math.min(1, kind[1] / 6), reasons: reasons.slice(0, 4) }
  }

  /**
   * May the bot take from this chest? Private chests that aren't ours are off-limits
   * (unless the owner is one of our owners or asked us to fetch something).
   */
  mayTake (pos, { forPlayer } = {}) {
    const rec = this.records[key(pos)]
    const c = rec?.classification
    if (!c || !this.agent.config.behavior.respectPrivateChests) return { ok: true }
    if (c.kind !== 'private') return { ok: true }
    const owners = this.agent.config.behavior.owners.map((o) => o.toLowerCase())
    if (c.owner && (owners.includes(c.owner.toLowerCase()) || c.owner.toLowerCase() === String(forPlayer || '').toLowerCase())) return { ok: true }
    return { ok: false, reason: `That's ${c.label}${c.reasons[0] ? ` (${c.reasons[0]})` : ''}. Taking from it would be stealing.` }
  }

  noteSelfTook (pos) {
    const rec = this.records[key(pos)]
    if (rec) rec.selfTookAt = Date.now()
  }

  /** Nearest remembered containers, for the prompt. */
  nearest (pos, n = 4) {
    return Object.values(this.records)
      .filter((r) => r.contents)
      .map((r) => ({ r, d: Math.hypot(r.x - pos.x, r.y - pos.y, r.z - pos.z) }))
      .filter((x) => x.d < 64)
      .sort((a, b) => a.d - b.d)
      .slice(0, n)
      .map(({ r }) => {
        const items = Object.entries(r.contents).slice(0, 6).map(([k, v]) => `${v} ${k}`).join(', ') || 'empty'
        const mins = Math.round((Date.now() - r.lastSeen) / 60000)
        return `${r.classification?.label || r.type} at (${r.x}, ${r.y}, ${r.z}), checked ${mins < 1 ? 'just now' : `${mins}m ago`}: ${items}`
      })
  }

  seenRecently (pos, ms = 10 * 60000) {
    const r = this.records[key(pos)]
    return Boolean(r?.lastSeen && Date.now() - r.lastSeen < ms)
  }

  toJSON () {
    const entries = Object.entries(this.records).sort((a, b) => (b[1].lastSeen || 0) - (a[1].lastSeen || 0)).slice(0, 200)
    return { records: Object.fromEntries(entries) }
  }
}

module.exports = { ContainerIntel, signText, COMMUNITY_WORDS, PRIVATE_WORDS }
