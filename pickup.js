'use strict'

/**
 * pickup.js — items lying on the ground: take them or leave them, the way a decent player would.
 *
 * Takes valuables, what its goal or task needs, useful things and its own stuff from where it died.
 * Leaves what another player dropped for themselves or lost when they died (unless that player has gone),
 * junk, things next to a monster or in lava, and anything not worth a slot when the inventory is full.
 * Items a player tossed TOWARD it are gifts and are taken (social.js counts them).
 */

const VALUABLE = /diamond|emerald|netherite|ancient_debris|gold_ingot|iron_ingot|raw_gold|raw_iron|ender_pearl|ender_eye|totem|golden_apple|enchanted|elytra|trident|shulker|name_tag|saddle|music_disc|nether_star|heart_of_the_sea|_pickaxe$|_sword$|_axe$|_shovel$|_hoe$|_helmet$|_chestplate$|_leggings$|_boots$|^bow$|^crossbow$|^shield$|^mace$|beacon|experience_bottle|blaze_rod|wither_skeleton_skull/
const JUNK = /^(rotten_flesh|poisonous_potato|spider_eye|wheat_seeds|beetroot_seeds|pumpkin_seeds|melon_seeds|dirt|coarse_dirt|gravel|netherrack|kelp|egg|snowball|pufferfish|tropical_fish|dead_bush|short_grass|tall_grass|fern|cobbled_deepslate|tuff|diorite|andesite|granite)$/
const FILLER_STACK = 128 // a player stops picking up cobblestone and the like once they have plenty

/**
 * @param {object} d   { item, count, distance, from?: { player, gift? }, deathOf?: string, ownDeath?: boolean,
 *                       freeSlots, carried (same item already carried), wanted (needed for goal/task), hostileNear,
 *                       hazard (lava/fire/drop), present (the dropper is still around) }
 * @returns {{ take: boolean, why: string }}
 */
function judgeDrop (d) {
  const name = d.item || 'something'
  if (d.ownDeath) return { take: true, why: 'your own things from where you died' }
  if (d.hazard) return { take: false, why: `it's in ${d.hazard}` }
  if (d.hostileNear) return { take: false, why: `a ${d.hostileNear} is right next to it` }
  if (d.from?.gift) return { take: true, why: `${d.from.player} threw it to you` }
  if (d.deathOf && d.present !== false) return { take: false, why: `${d.deathOf} lost it when they died; it's theirs` }
  if (d.from?.player && d.present !== false) return { take: false, why: `${d.from.player} dropped it; it's theirs` }
  const valuable = VALUABLE.test(name)
  if (d.wanted) return { take: true, why: `you need ${name} for ${d.wanted}` }
  if (d.freeSlots <= 0 && !d.carried && !valuable) return { take: false, why: 'your inventory is full' }
  if (valuable) return { take: true, why: 'valuable' }
  if (JUNK.test(name)) return { take: false, why: 'junk' }
  if ((d.carried || 0) >= FILLER_STACK) return { take: false, why: `you already have plenty of ${name}` }
  if (d.distance > 16) return { take: false, why: 'too far to bother' }
  return { take: true, why: 'useful' }
}

module.exports = { judgeDrop, VALUABLE, JUNK }
