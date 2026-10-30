# Project memory — Minecraft LLM Bot

Everything learned while building this bot: what it is, how it's put together, why things are the way they are, and the traps already found. Claude Code loads this file automatically; it's also meant for humans picking the project up later.

- **Setup for users:** [SETUP.md](SETUP.md).
- **Feature reference:** [README.md](README.md).

## The user and what they want

- Address the user as **EndlessSkys** (or Endless).
- **Goal:** a fully autonomous Minecraft Java bot that plays and talks **like a real person**, driven by a local LLM (Ollama + Qwen 2.5).
  - It refuses like a human, never like an assistant.
  - It has feelings, trust and liking, its own judgment, skill levels and realistic senses.
  - It's a good guest on friends' servers.
- **Hardware:** a dedicated server PC with a **GTX 1660 Super (6 GB VRAM) and 32 GB RAM**. Nobody plays Minecraft on that PC, so the whole GPU goes to Ollama. The bot is headless and needs no GPU.
- **Accounts:** the user plays on their own Java account, so the bot can't use it at the same time. The bot joins either:
  - **offline-mode servers**;
  - **Geyser + Floodgate servers through ViaProxy with the user's Bedrock account** (`server.platform: "bedrock"`);
  - or with a separate Java account.
  
  Geyser **without** Floodgate (`auth-type: online`) needs a Java account. That's server authentication, and we do not try to bypass it.
- **Friends' servers:** the bot should be able to join without the friends setting anything up for it.
- **Working rules:** develop on branch `claude/confident-meitner-1ita5a`, commit with clear messages, and push. Don't open PRs unless asked.

## Architecture

Plain Node.js (CommonJS, Node ≥ 22), Mineflayer 4.39 + mineflayer-pathfinder 2.4.5. Style: no semicolons, two-space indent, single quotes, short doc comments on classes and non-obvious functions.

```
Perception (2s tick) → state JSON + feelings + relationships + lessons + know-how
   → Ollama /api/chat (JSON schema) → {thought, emotion, goal, action, taskUpdate}
   → ActionExecutor runs ONE action (timeouts, AbortSignal, pause-for-typing)
   → result into Memory → next prompt
```

| File | Owns |
| --- | --- |
| `index.js` (~3000 lines) | `DEFAULT_CONFIG` (the source of truth for every option), `loadConfig` (+ `--server` profiles, env overrides, compatibility), `Memory`, `Perception`, `OllamaClient` (one request at a time, priority queue: reply 0, reaction 1, decision 2, smalltalk 3, reflect 4), prompt builders (`personaBlock`, `mindBlock`, `buildDecisionPrompt`, `HUMAN_VOICE`), schemas, `ChatManager` (rate limits, danger shortening, robot-speak guard, stop-to-type), `ChatResponder` (analysis → appraisal → phrasing; !commands; postponing in danger), `SETTABLE` + `parseSetting` (in-game settings), `SmallTalk`, `EventReactor` (all game events → memory, social, emotions, reactions), `Brain` (loop, reflexes, busy work while thinking, XP), `Agent` (wiring, connection, server helpers, kick handling, saving), `parsePluginChat`. |
| `actions.js` | `ACTIONS` registry (30 tools: move, follow, explore, mine, place, chat, equip, attack, retreat, eat, collect, craft, give, sleep, smelt, store/take, activate, fish, useItem, knowledge, readSigns, inspectContainer, parkour, planBuilding/build/cancelBuilding, emote, wait), `gotoGoal` (our own pathfinder driver), `placeAt`, `ActionExecutor` (availability filters, hard timeout, `pauseFor`, ctx with social/learning/tasks/builder/intel/containers). |
| `combat.js` | The fight loop: kit reading, ballistics, mace + wind charge, bows/crossbows, axe vs shield, combos, potions (undead-aware), golden apples, totems, cobweb, pearl escape, water clutch, mob tactics. Gated by `ctx.intel.combatProfile()`. |
| `intelligence.js` | 8 levels, the concave `skillAt` curve, `UNLOCKS`, `BASE_ONLY` (mace and seeing through walls depend on the configured level, not practice), per-domain XP learning, mindset texts. |
| `senses.js` | Line-of-sight perception (+ 20 s memory), invisibility rules, name tags (vanilla rules + teams), hearing sounds and **world events**, particles and block cracks, suspicion and investigation. |
| `containers.js` | Chest classification (mine / community / private / unlooted / looted) from signs, structures, builds, openers and contents; content diffs; `mayTake`; sign reading. |
| `social.js` | Per-player **trust** (safety) and **affinity** (liking), hostility, incidents (hits, kills, harm nearby), gifts, promises, body language, chat analysis effects. |
| `tasks.js` | Request appraisal by kind (favours vs fights) + the obedience blend; tasks with progress, patience budget, partial hand-over, forgetting and recall, protect/attack permissions. |
| `emotions.js` | Six core feelings, decay to personality temperament, behaviour modifiers. |
| `learning.js` | `Store` (atomic JSON at `data/brain.json`), combat style bandit, danger zones + parkour cool-off, LLM lessons, `save()`. |
| `knowledge.js` | ~60 tiered facts, game-data lookups (recipes, smelting, loot inverse index), `relevantFacts`, `lookup`, `learnFrom`. |
| `building.js` | Terrain read, site score, flatten / terrace / stilts / dig-in, style pieces, seeded unique designs, support-aware ordering, material substitution. Complexity scales with building skill. |
| `doctor.js` | `npm run doctor`: setup checks + an Ollama benchmark + server ping + `--probe-login`. |
| `test/` | `npm test` unit suites; `test/tools/` live tools (mock Ollama, flying-squid server, test player, scenario harness). |
| `scripts/` | Start scripts (Windows/Linux), systemd unit, `regen-config.js`. |

**What gets saved** (`data/brain.json`, every 30 s and on shutdown): `social` (players: trust, affinity, notes, promises, stats), `emotions`, `tasks` + history, `building` (current plan + history), `obeyPlayers`, `intelligence` (xp), `chests`, `knownFacts`, `learnedItems`, `combat`, `movement` (danger zones), `lessons`, `stats`, `admins`, `settings` (in-game overrides, which win over config.json until reset).

**Adding things:**
- **An option:** add it to `DEFAULT_CONFIG`, then run `node scripts/regen-config.js`. To make it settable in game, add it to `SETTABLE` (types number, boolean, enum, string).
- **An action:** add it to `ACTIONS` with description, params and run; throw `ActionError(code, message)` for expected failures; respect `ctx.signal`. Map it to a skill domain in `ACTION_DOMAINS` (index.js) if practice should count, and to `BEDROCK_UNSUPPORTED` if it needs block breaking or inventories.
- **A !command:** add a case in `ChatResponder.handleCommand` and its role in `commands.permissions`.

## Design decisions (and why)

- **Requests:** the bot judges each request itself, per task kind:
  - **favours** depend mostly on **liking** (not kindness);
  - **kill requests** depend on grudge vs friendship, conflicts with commitments, whether it could win, violence and pvp rules.
  
  The user later asked to keep admin obedience controls but give **every role/player a level**, so it's a blend: `chance = own + (1 − own) × obedience` (`!obey`). Hard limits always hold, and conscience (friends, promises) holds unless `overrideConscience` is on and the level is ≥ 0.9.
- **Trust ≠ liking:** trust is about safety and changes with actions; liking is chemistry (LLM `likeImpact`, time together, shared tasks). Gifts barely buy liking; constant requests annoy.
- **Tasks:** they can be done partly ("got you 4, that's all I had time for"), forgotten (salience decay; recalled when the player brings them up), deferred, or bumped by the same asker.
- **Intelligence:** the skill curve is concave — big early gains, small later ones (0.08 → 0.41 → … → 0.97 → 1.00). **Mace only for Hardcore+, good mace only for Master/Impossible**, by configured level. A Beginner learns up to about Advanced. X-ray is opt-in and Impossible-only (counts as cheating on most servers).
- **Senses:**
  - Realistic by default: entities only with line of sight; blocks only once seen.
  - Invisibility works, except through armor, swirls right in front, or touching.
  - **Name tags show through walls unless the player sneaks** (vanilla), so unidentified players appear as "unknown player".
  - Unexplained player-type sounds build suspicion, which **known nearby players damp**, leading to an investigation.
- **Pacing:**
  - It does busy work while the LLM thinks.
  - It **stands still while typing**.
  - **In danger** it types 1–3 words fast or postpones the reply ("sorry, was fighting").
- **Voice:** `HUMAN_VOICE` + `refusalStyle` + the `ROBOTIC` regex guard: never "I cannot comply".
- **Good guest:** `noGrief` (pathfinder can't break player-built blocks; `mineBlock` skips them), `respectPrivateChests`, sign/chat rules, rate limits, and **no reconnect on duplicate login** (never kick the user's own session), whitelist, ban, or online-mode rejection.
- **Versions:** Mineflayer tops out at 26.1. Against newer servers (26.3) it pings and connects as 26.1 (`viaFallback`), which needs ViaBackwards or ViaProxy. ViaProxy itself supports Java servers up to 26.3.
- **Bedrock route limits** (ViaBedrock): no block breaking, no inventories, no mob sounds. `platform: "bedrock"` hides those actions and stops digging.

## Gotchas already hit (don't rediscover these)

**Pathfinding**
- `bot.pathfinder.stop()` sets a **sticky flag that cancels the NEXT path**. Use `setGoal(null)` to stop.
- `pathfinder.goto()` rejects with GoalChanged on any `setGoal`. That's why `gotoGoal` is our own driver: it listens to `goal_reached`, `path_update` and `path_stop`, and supports pausing.

**Mineflayer events and API**
- `entityCrouch` fires on **every** metadata packet while crouching; `entityUncrouch` only on transitions. Count uncrouches for crouch-spam detection.
- `entityHurt(entity, source)`: `source` (the attacker) only exists on 1.20+ (`damage_event`). Older versions guess from arm swings.
- Mineflayer **does not surface `world_event`** (block break 2001, splash potions, spawners, anvils, global wither/dragon/end portal events). Listen on `bot._client.on('world_event')`.
- `bot.blockAt` needs a **Vec3** (it calls `.floored()`).
- `bot.setControlState(name, value)` **asserts a boolean**: `false || undefined` crashes it.
- `bot.look(..., false)` resolves on physics ticks, and **physics stops on death** until the server sends a position. Race it with a timeout.

**Item and entity data**
- Potions on 1.20.5+ are the `potion_contents` component (`potionId` = vanilla registry order, listed in `combat.js`); older versions use NBT `Potion`.
- Shield blocking: `living_entity_flags` metadata bit 0x01 (hand active) + 0x02 (off-hand) + the shield held.
- Invisible: shared flags bit 0x20; sneaking: bit 0x02.
- Pets: `flags & 0x04` means tamed; `owneruuid` gives the owner.
- Custom names: decode with `prismarine-chat` `fromNotch`.

**Versions and data**
- `minecraft-data` lists 26.3 in its version list but has **no data** for it (dataPaths only to 26.1). Mineflayer refuses newer servers unless the version is pinned.

**Ollama**
- Structured outputs: pass a JSON schema as `format` (Ollama ≥ 0.5). The client falls back to `format: "json"` if rejected.
- Decision prompts are ~3.4k tokens of fixed system text + 0.6–2.5k of state. `/api/chat` returns timing fields (the doctor uses them), and `/api/ps` gives `size_vram`.

**Other**
- Floodgate names have a `.` (or `*`) prefix. Chat parsing and own-name matching handle that.
- Over ViaProxy the bot uses `auth: "offline"` to the proxy; ViaProxy's selected account authenticates upstream. Its default bind is `0.0.0.0:25568`.

## Testing

- **Unit tests:** `npm test` (social, tasks, senses + chests + chat formats + intelligence gates); `npm run check` (syntax).
- **Live tools:** `test/tools/` (see its README for how to run them and for **flying-squid's quirks**: players only see later joiners, no PvP damage or tossing, no sneak/invisibility metadata or break sounds, 1.21.4 inventory corruption, `/give` count concatenation, `/tp` crash on 1.21.4).
- **Verified live on flying-squid 1.16.5 / 1.21.4:**
  - movement, mining, placing, chat in and out, replies and requests;
  - owner commands and settings persistence;
  - trust and PvP reflexes (with injected events), tasks and partial hand-over logic;
  - combat styles running (ranged, axe combo, balanced, cobweb, arrows);
  - typing pause (~6 s plateau), danger-shortened replies, busy work;
  - building plans and first ~10% of a build;
  - sight occlusion, hearing → suspicion → investigation, name tags through walls / sneaking / invisible;
  - the version fallback against a fake 26.3 server;
  - the doctor.
- **Not verified yet:**
  - real Qwen output (all runs used the mock);
  - a full build, the mace combo and potion/totem use in a real fight;
  - shield-blocking detection;
  - Realms, login plugins and Microsoft sign-in;
  - the ViaProxy + Geyser + Floodgate Bedrock route;
  - real performance on the 1660 Super (estimated 4–8 s per decision for 7B).

## Environment notes (for Claude cloud sessions)

- **Downloads:** Mojang and Paper downloads are blocked; npm and raw.githubusercontent.com work (that's how ViaProxy/ViaBedrock docs were checked; api.github.com was 403).
- **Test server:** install flying-squid outside the repo or with `npm install --no-save flying-squid@1.12.0`. Start test players **after** the bot.
- **Processes:** don't kill all `node` processes (the sandbox refuses it); run test processes under `timeout` instead.

## Ideas not done yet

- A browser viewer of what the bot sees (prismarine-viewer; it would render on the viewer's device).
- A compact prompt mode (shorter tool docs) for small GPUs.
- Testing against a real Paper server with Geyser/Floodgate/ViaVersion and real Qwen, then tuning prompts from real transcripts.
- Smarter building materials (crafting planks from logs on its own when a build runs short).
