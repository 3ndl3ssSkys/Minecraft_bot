# Minecraft LLM Bot

An autonomous Minecraft Java Edition player built on **Mineflayer** + **mineflayer-pathfinder**, with decisions made by a local LLM (**Ollama** running **Qwen 2.5**). It explores, mines, crafts, smelts, fights, chats, and reacts to what happens in the world.

On top of that it has an inner life:

- **Feelings** rise and fall with what happens to it.
- **Trust** in each player (are they safe?) changes with what that player *does*.
- **Liking** for each player (do I enjoy them?) grows from chemistry and time spent together, not from politeness.
- **Learned experience** builds up over time: which fighting styles work, where it died, and short lessons.
- **Its own judgment** about requests: it weighs what's asked, who's asking and what it would rather be doing. It sometimes does only part of a job, and sometimes forgets one. Owners and admins can add obedience on top, for any role or any single player.
- **Real PvP**: bows with ballistics, axe/sword combos, mace + wind-charge smashes, potions, golden apples, totems, pearls, cobwebs, and tactics for specific mobs.
- **Minecraft know-how**: recipes, loot and ore levels from the game's own data, plus hand-written experience.
- **Its own buildings**: designed from reusable pieces, unique each time, and fitted to the terrain.
- **Natural pacing**: it keeps busy while thinking, stops moving to type, and only types a word or two when it's in danger.

When it says no, it says it like a person, never like a bot.

```
Perception (every 2s) ──► state JSON + feelings + relationships + lessons ──► Ollama ──► {thought, emotion, goal, action}
        ▲                                                                                      │
        └──────────── result fed back into the next prompt ◄──── ActionExecutor (one action at a time)
```

## Quick start

1. Install **Node.js 22+** and [Ollama](https://ollama.com), then pull the model:
   ```bash
   ollama pull qwen2.5:7b
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Edit `config.json`: set `server.host`, `server.port` and `server.username`, and put your username in `behavior.owners`.
4. Run the bot:
   ```bash
   npm start
   ```
   To use a different config file:
   ```bash
   node index.js my-config.json
   ```

Environment variables override the config: `MC_HOST`, `MC_PORT`, `MC_USERNAME`, `MC_AUTH`, `MC_VERSION`, `OLLAMA_URL`, `OLLAMA_MODEL`, `BOT_PERSONALITY`, `BOT_CHAT_MODE`, and `BOT_DEBUG=1` for verbose logs.

> **Model size:** `qwen2.5:7b` is a good default. `qwen2.5:3b` is faster on weak hardware but makes more mistakes; `qwen2.5:14b` plans and role-plays noticeably better. Ollama 0.5+ is recommended for strict JSON-schema output.

## Minecraft 26.3 and other newer versions

Mineflayer currently supports Minecraft up to **26.1**. Neither the released packages nor PrismarineJS's development branch have 26.2 or 26.3 support yet. Mineflayer refuses to connect to anything newer. The bot handles this for you:

1. Before connecting, it pings the server. If the server is newer than Mineflayer supports, it connects using the newest supported protocol (26.1) instead of failing (`server.viaFallback`, on by default).
2. The server has to accept a 26.1 client. Pick one of these options:
   - **Paper / Spigot / Fabric server:** install **ViaVersion** and a **ViaBackwards** release that supports 26.3. Players on newer clients are unaffected.
   - **Vanilla server, or no plugins allowed:** run **[ViaProxy](https://github.com/ViaVersion/ViaProxy)** on the bot's machine. Set its target server to your server and the target version to 26.3, then point `server.host`/`server.port` at ViaProxy's listening address.
3. When PrismarineJS adds native support, run this, and the bot will connect natively from then on:
   ```bash
   npm run update-mc
   ```

You can also pin a version with `"server": { "version": "26.1" }`. If you're kicked for "outdated client", the log tells you which of the above you need.

## Files

| File | Purpose |
| --- | --- |
| `index.js` | Config, perception, the Ollama client, the decision loop, chat, reactions, commands, reconnects |
| `actions.js` | The tool API the LLM can call (including the PvP combat engine), plus the `ActionExecutor` |
| `emotions.js` | The emotion engine: six core feelings with decay, temperament and behaviour modifiers |
| `social.js` | Per-player trust and liking, intent reading, promises, body language |
| `tasks.js` | Judging requests by task type (plus obedience levels), and running them: progress, patience, partial hand-overs, forgetting |
| `combat.js` | The fight engine: weapons, projectiles, potions and consumables, per-mob tactics |
| `knowledge.js` | Minecraft know-how: facts, item descriptions, "how do I get X" from recipes/loot data |
| `building.js` | Building designer: terrain reading, site choice, pieces, unique designs, support-aware ordering |
| `util.js` | Small shared helpers |
| `learning.js` | Combat-style learning, danger zones, LLM-written lessons, and persistence |
| `config.json` | All settings (every key has a default in code, so you can delete the ones you don't change) |
| `personalities/*.json` | Presets: `friendly`, `grumpy-miner`, `shy-explorer`, `hype-builder` |
| `data/brain.json` | Created at runtime: relationships, feelings, tasks, combat stats, lessons, danger zones, admins, in-game settings |

## How it thinks

1. **Perceive.** Every 2s the bot builds a JSON snapshot. It includes:
   - its position, health, hunger and equipment (with durability), plus its inventory;
   - nearby entities, with ids. Players also get their trust and liking scores, relationship, role, whether they're armed or hostile, and how they seem;
   - notable blocks, the block it's looking at, time and weather;
   - its goal, feelings, the task it's doing for someone (with progress and remaining patience), tasks it said it would do later, and nearby danger zones;
   - recent actions with results, events and chat.
2. **Decide.** The snapshot goes to Ollama together with a summary of the people online and what it has learned. A JSON schema forces a reply like:
   ```json
   {"thought": "Steve killed me last time and he's got a sword out. Not going near him.", "emotion": "nervous",
    "emotionIntensity": 7, "goal": "mine iron away from spawn", "action": {"name": "explore", "args": {"direction": "east"}}}
   ```
3. **Act.** Exactly one action runs to completion or failure. The result goes into the next prompt.
4. **Throttle.** Decisions are at least `loop.minLlmIntervalMs` apart. Every LLM request goes through one priority queue, so only one is ever in flight. The order is: chat replies, then reactions, then decisions, then small talk, then reflection.

**Reflexes** run without the LLM: fight-or-flight against attacking players, keeping away from armed enemies, fighting back against mobs, fleeing creepers, and eating when hungry.

## Feelings (`emotions`)

The bot has six core feelings: joy, anger, fear, sadness, boredom and surprise. Events push them up, and they decay back to the personality's **temperament** at `emotions.decayPerMinute`.

Many things move them:
- getting hit, dying, low health, hunger, nightfall
- gifts, kind words, insults, broken or kept promises
- winning or losing fights, success or failure streaks, idling
- the LLM's own report of how it feels

The dominant feeling becomes a label ("annoyed (6/10), also a bit scared — mostly because Steve hit you") that appears in every prompt. It also changes behaviour:
- Anger and sadness make it less willing to do favours.
- Happiness makes it chattier; sadness and fear make it quieter.
- Anger versus fear tips fight-or-flight.

| Setting | Meaning |
| --- | --- |
| `emotions.volatility` | 0 = stoic, 1 = normal, 2+ = dramatic |
| `emotions.decayPerMinute` | how fast it calms down |
| `emotions.lock` | force a feeling (e.g. `"angry"`), or `null` |
| personality `temperament` / `sensitivity` | resting feelings, and per-feeling multipliers (e.g. a shy preset has `fear: 1.6`) |

## Trust and relationships (`trust`)

Every player starts at `trust.initial` (75/100, fairly high). Trust changes with **what they do**:

| Lowers trust | Raises trust |
| --- | --- |
| Hitting the bot: a fist hit costs less than a weapon hit; a single punch from a friend is treated as horseplay | Gifts (tossing items it picks up), scaled by value |
| **Repeated hits** (3+ in 20s) | **Keeping a promise** |
| Hitting it **while it's nearly dead** | Helping it fight a mob or an attacker |
| **Killing it** (more each time) | Apologising (less effective each time: "you said that last time") |
| Hurting players, pets (wolves, cats, horses…) or villagers near it, scaled by how much it likes the victim | Kind messages, crouch-greetings |
| Killing a player near it | Time: it slowly forgives, scaled by personality `forgiveness` |
| **Breaking a promise** ("I'll bring you iron" and never doing it) | |
| Threats and insults (the LLM rates each message) | |

Harsh incidents also mark the player **hostile** for a while (`trust.hostileMemoryMinutes`). Hostile players get ignored sometimes (`trust.ignoreHostileChance`), and their requests are refused. The bot keeps its distance from them when they're armed and may fight back.

**Promises** are pulled from chat by the LLM. The kinds are `give_item`, `come`, `stop_attacking`, `help` and `other`. Each has a deadline:
- *Gift promises* are checked against what that player actually tosses.
- *Come* promises are checked against where they are.
- *Stop attacking* promises are broken by the next hit.
- *Help* and *other* promises can't be verified. When they expire, the penalty is softer.

**Reading people:**
- From chat, the LLM tags each player's emotion and intent (friendly, joking, rude, threatening, apologetic, manipulative…).
- From body language, it notices crouch-spam greetings, someone approaching armed, someone following it around, and someone staring at it.
- These impressions are shown next to the player in every prompt.

On 1.20+ servers the server reports exactly who caused each hit. On older versions the bot infers the attacker from nearby arm swings.

Trust tiers: close friend (92+), trusted friend (80+), friendly (60+), unsure (45+), wary (20+), enemy.

### Liking (`affinity`)

Trust is about **safety**; liking is about **chemistry**. Someone can be perfectly polite and still dull, and a rude-but-funny friend can be well liked. Strangers start at 50 ("no strong feelings"), and owners start at 75.

| Raises liking | Lowers liking |
| --- | --- |
| Messages *this personality* enjoys: funny, interesting, shared interests (the LLM rates `likeImpact`) | Boring, needy, bossy or annoying messages |
| Time spent near each other without trouble (`affinity.perMinuteTogether`) | **Constantly asking for things** (more than 3 requests in 30 min) |
| Doing things together: finishing a task for them, a kept promise, a first apology | Attacking it, killing it, attacking its friends, broken promises |
| Gifts — a little; gifts don't buy friendship | Asking it to kill one of its friends |

Liking tiers: best friend (85+), good friend (70+), likes them (57+), no strong feelings (43+), doesn't really like them (28+), can't stand them.

## Requests (`judgment`)

Every request starts with the bot's own judgment (obedience levels, below, can add to it). When someone asks for something, the bot first works out *what* they're asking. The LLM classifies the request (kind, item, amount, target, effort, risk), and the bot makes its own estimate of the work: "a stack of diamonds" is huge, "10 logs" is small. Then it decides how it feels about **that particular request**:

| Kind of request | What mostly decides it |
| --- | --- |
| Favours: gather, craft, give, come, follow, protect, build | **How much it likes the person**, then how much work it is, how risky, its mood, whether it's busy with someone else's task, and whether it needs to eat or heal first. Trust only matters when it's low ("I don't trust you"). Giving away valuable items also depends on `generosity`. |
| "Go kill X" | **Whether it wants to**. It weighs: a grudge against X (they hurt or killed it, attacked its friends, are hostile); friendship with X (it refuses to kill friends, and *the person who asked* loses trust and liking for suggesting it); conflicts with earlier promises (it won't attack someone it promised to protect or is doing a job for); whether it would win (if outmatched it says "later"); its `violence` trait; whether it trusts the asker; and `pvp.mode` / `protectedPlayers` / `neverAttackOwners`. |
| Duels with the asker ("1v1 me") | Liking and mood |

The outcome is one of:
- **do it** — it drops what it's doing (if the job isn't for someone else);
- **do part of it** — "I can grab you 20 or so", for big jobs;
- **later** — the task goes on its queue;
- **no**.

Only after deciding does the LLM write the reply, in character, from the decision and its reason. Refusals follow the personality's `refusalStyle` and mood: friendly "ah not rn, maybe after this?", grumpy "do it yourself kid", shy "um... sorry, i cant", hype "NAH im busy cooking". Assistant-speak ("I'm unable to assist…") is caught and replaced before it's sent.

**Working on tasks:**
- Accepted requests become tasks with progress. For item jobs, progress is measured from its inventory, and the hand-over (walking over and tossing the items) happens automatically when it has enough. *Come* and *follow* complete when done, and fights complete when won.
- Each task gets a **patience budget**: the estimated time × how much it likes the person × the personality's `patience`. When patience runs out, or it decides it would rather do something else, or its own needs come first, it **wraps up**: it hands over what it has ("got you 4, that's all i had time for") or says it gave up.
- **Forgetting:** "later" tasks slowly fade. They fade faster for people it likes less, when it has a lot on its plate, after dying and after fights, and with a more forgetful personality. A forgotten task disappears from its mind until the player brings it up; then it remembers ("oh shoot, i totally forgot") and puts it back on the list.
- A newer request from the same person replaces their older one. Someone it likes a lot more can bump a job it hasn't really started yet.

| Setting | Default | Meaning |
| --- | --- | --- |
| `judgment.ownerLoyalty` | 0.3 | extra willingness for owners (still not automatic) |
| `judgment.randomness` | 0.12 | human unpredictability |
| `judgment.maxQueuedTasks` | 4 | more "later" promises than this, and the oldest slip |
| `judgment.forgetting` | true | allow forgetting |
| `judgment.requestedFights` | true | consider kill requests at all |
| personality `helpfulness`, `patience`, `forgetfulness`, `violence`, `generosity` | | per-character temperament for all of the above |

### Obedience levels (`obedience`)

On top of its own willingness, owners and admins can set how obedient it is, for every role or for single players:

```
chance = own willingness + (1 − own willingness) × obedience level
```

At `0` it's purely its own call. At `1` it does whatever it physically can. Hard limits still apply: offline targets, `protectedPlayers`, `pvp.mode: never`, and hostile requesters. Its conscience (not killing friends, keeping its own promises) also holds, unless `overrideConscience` is on and the level is 0.9 or higher.

| Setting | Default | Meaning |
| --- | --- | --- |
| `obedience.levels.owner` / `admin` / `trusted` / `player` | 0.5 / 0.3 / 0.15 / 0 | per role ("trusted" = trust ≥ 80 or liking ≥ 70) |
| `obedience.players` | `{}` | per-player levels, e.g. `{ "steve": 0.8 }` — set with `!obey Steve 0.8` |
| `obedience.whoCanInstruct` | `everyone` | who may ask at all; others only get favours (lower chance, no obedience) |
| `obedience.overrideConscience` | false | let very high obedience override loyalty and promises |

## Combat and learning (`pvp`, `learning`)

`attackTarget` hands the fight to `combat.js`, which runs about 20 updates per second and uses whatever the bot carries:

| Tactic | What it does |
| --- | --- |
| **Melee** | Crits (hit while falling), sprint-reset w-taps, strafing, shield blocking between swings, and each weapon's 1.9+ cooldown (item swaps reset it). |
| **Axe + sword** | An axe hit knocks a raised shield down for 5 seconds; the `comboAxe` style opens with a heavy axe crit and follows with quick sword hits. Blocking is read from the target's metadata. |
| **Bow / crossbow** | Real projectile physics (gravity + drag, simulated per tick), leading moving targets. Shoots at range, then switches to melee when they close in. Crossbows load and fire. |
| **Mace** | Throws a wind charge at its feet to launch upward, swaps to the mace mid-air and smashes on the way down. Also drops onto targets from high ground. |
| **Potions** | Drinks strength/swiftness (and fire resistance against fire mobs) before serious fights. Throws splash harming/poison/weakness/slowness at enemies. Healing hurts undead and harming heals them, so it picks accordingly. |
| **Staying alive** | At low health: totem into the off-hand, splash or drink healing, golden apples (backing off to eat), regeneration, fire resistance or water when burning. Water-bucket clutch when falling hard, any time. |
| **Utility** | A cobweb at a close attacker's feet, and an ender pearl away from a fight it's losing. |
| **Mob tactics** | Creepers: hit and run (or shoot). Skeletons and pillagers: shield up and close in. Slimes and magma cubes: keeps going until every split piece is dead. Breezes and endermen: no arrows. Witches: rush. Phantoms: wait for the swoop. Wardens: run. |

It **learns which style works**. The styles are `aggressive`, `balanced`, `cautious`, `hitAndRun`, plus `comboAxe` (with an axe and sword), `ranged` (with a bow or crossbow and arrows) and `mace` (with a mace and wind charges). Only styles its current kit supports are considered. Stats are tracked per opponent (each mob type, each player, and players as a group). An epsilon-greedy bandit picks the best-known style and sometimes experiments (`learning.epsilon`). Retreat thresholds adapt: it backs off earlier against things that beat it, and stays in longer against things it beats easily.

It also learns:
- **Danger zones**: places where it died to lava, falls or drowning, or got stuck. The pathfinder routes around them, and they show up in the prompt.
- **Movement**: repeated fall damage while moving switches risky parkour off for 20 minutes.
- **Lessons**: after deaths, lost fights, fights with players and failure streaks, the LLM writes a one-line lesson ("Tester attacks without warning; keep distance when he has a sword out"). Lessons are deduplicated, reinforced when repeated, and shown in every decision prompt.

PvP rules (`pvp.mode`):
- `never`: it won't fight players.
- `defensive` (default): it fights only players who attack it or are hostile.
- `always`: it can fight anyone.

Players can ask for a duel ("1v1 me"), and `allowSparring` lets the bot accept. `neverAttackOwners` and `behavior.protectedPlayers` always apply.

Everything is saved to `data/brain.json` every 30s and on shutdown, so relationships and experience carry across sessions.

## Knowledge (`knowledge.js`)

The bot knows Minecraft the way an experienced player does:
- **Know-how:** about 50 hand-written facts on progression, tool tiers, ore heights (1.18+), food and farming, brewing ingredients, enchanting, villagers, the Nether and the End, combat items, mob behaviour, dangers and building. The most relevant few are added to each decision prompt based on its goal, task, inventory and surroundings.
- **Game data:** precise answers from the server version's own data — recipes ("6 planks (any wood) + 1 iron_ingot → shield"), smelting, which blocks drop an item and the minimum tool, mob drops, stack size, durability, food value and blast resistance.
- **The `knowledge` action:** the LLM can look anything up instantly ("how do i make a bucket", "brewing", "mace"). Running out of building materials also tells it how to get them.

## Building (`building.js`)

`planBuilding` takes the bot's own **concept** ("cozy spruce cabin with a porch by the lake") and a purpose: house, shelter, storage, workshop, lookout or hut.
- **Reading the land:** it reads a heightmap around itself and picks a site, scoring flatness, water, trees, distance and danger zones. It never builds over anyone else's blocks.
- **Fitting the terrain:**
  - small bumps → **flattened**;
  - moderate slopes → **cut-and-fill terrace** with a stone foundation;
  - steep ground or water → **stilts** with steps down to the ground;
  - hillside burrows → **dug into the hill**, with earth over the roof.
  
  A one-block apron around the build is smoothed, and trees in the way are cleared.
- **Unique designs:** the design combines familiar construction pieces:
  - log-frame corners, walls, windows in a rhythm, a door on the most open side;
  - gable, hip, A-frame or flat roofs (stepped two blocks thick so every block is supported), with overhangs;
  - chimney, porch with fence posts, battlements, a lookout ladder;
  - furniture that fits the purpose (bed, chests, crafting table, furnaces, torches).
  
  A seeded generator varies the style, proportions, roof, window rhythm, door side, overhang, extras and accent materials using the concept, the site and the bot's name. It names the result too ("Wanderer's Hillside Cabin").
- **Materials:** chosen from what it has, falling back to similar blocks (any planks, any logs, stone-like blocks) when it runs low.
- **Building it:** `build` places a few dozen blocks per call, supports first, digging out whatever is in the way. If materials run out it says exactly what's missing and how to get it. Plans are saved, so a build continues after a restart. `!build` shows progress.

## Natural pacing

- **While it thinks:** during every LLM call it does something small and useful — picks up items lying around, checks an unchecked chest (and remembers its contents: `status.knownContainers`), mines a visible ore or something its task needs, or hops around doing parkour (more often for restless personalities: `restlessness`). It stops the moment the decision arrives, and skips all of this in danger.
- **Typing:** it stops moving while it types, like a player with the chat box open (`chat.typingCharsPerSecond`, default 9; `chat.stopToType`). In testing, a walking bot stood still for the ~6 seconds a long message took, then carried on.
- **In danger** (fighting, almost dead, just hit, something hostile right next to it):
  - Messages are cut to a few words and typed in under a second ("hey whats up").
  - Replies are often **postponed** until it's safe, then answered with a short "sorry, was fighting" (`chat.danger.postponeChance`). Urgent messages like "help" or "behind you" are answered right away.
  - It doesn't do small talk.

## Actions (tools)

| Action | Args |
| --- | --- |
| `moveToBlock` | `x, y, z, range?` |
| `moveToPlayer` / `followPlayer` | `playerName, range? / durationSeconds?` |
| `explore` | `distance?, direction?` |
| `mineBlock` | `blockType, count?, maxDistance?`: finds the block, paths to it, equips the best tool, mines it, collects the drops |
| `placeBlock` | `blockType, x, y, z` |
| `craftItem` | `itemName, count?`: uses a nearby crafting table automatically |
| `smeltItem` | `itemName, count?, waitSeconds?`: furnace, smoker or blast furnace; adds fuel and collects output |
| `storeItems` / `takeItems` | `itemNames` ("all" keeps tools, armor and some food) / `itemName, count?` with a chest or barrel |
| `sleepInBed` | — |
| `activateBlock` | `x, y, z`: doors, gates, trapdoors, levers, buttons, bells |
| `fish` | `seconds?` |
| `giveItem` | `playerName, itemName, count?`: walks over and tosses the items |
| `equipItem` | `itemName, destination?` |
| `attackTarget` | `entityId, maxSeconds?, style?, sparring?` — style: aggressive, balanced, cautious, hitAndRun, comboAxe, ranged, mace |
| `retreat` | `entityId, distance?` |
| `eatFood` | `foodName?` |
| `collectDrops` | `radius?` |
| `chatMessage` | `text` |
| `useItem` | `itemName, target?` ("self", "feet", entity id, "x,y,z"): drink or eat, throw (splash potions, pearls, wind charges, snowballs), place buckets, use on blocks or entities (bone meal, flint and steel, shears, name tags, leads) |
| `knowledge` | `topic` — instant lookup of items, recipes and how-tos |
| `inspectContainer` | `x?, y?, z?` — open a chest/barrel and remember its contents |
| `parkour` | `seconds?` — hop around nearby blocks |
| `planBuilding` | `purpose, concept, size?` — design a building fitted to the terrain |
| `build` | `maxBlocks?` — continue building the plan |
| `cancelBuilding` | — |
| `emote` | `gesture`: wave, jump, nod, shake_head, crouch, spin, look_around |
| `wait` | `seconds` |

Every action has its arguments checked, a timeout scaled to distance, and a global hard timeout. Every action can be cancelled.

Pathfinding failures come back as `NO_PATH`, `PATH_TIMEOUT`, `STUCK`, `PATH_INTERRUPTED` or `TOO_FAR`. Nearly broken tools are swapped for another tool, blocks that need a proper tool are refused, and tool breaks are reported.

Use `behavior.enabledActions` / `disabledActions` to limit the tool list.

## Personalization

### Personality

Set `"personality"` to a preset name from `personalities/`, or write one inline. Beyond the description and speaking style, these fields shape its inner life:

```json
"temperament": { "joy": 0.15, "anger": 0.25, "fear": 0.05, "sadness": 0.1, "boredom": 0.15, "surprise": 0 },
"helpfulness": 0.35,
"patience": 0.8,
"forgetfulness": 0.15,
"violence": 0.5,
"generosity": 0.25,
"sensitivity": { "anger": 1.5, "fear": 0.6 },
"forgiveness": 0.2,
"trustSensitivity": 1.4,
"fightOrFlight": 0.75,
"refusalStyle": "blunt and sarcastic — \"do it yourself, kid\", \"no.\"",
"fallbackRefusals": ["no.", "do it yourself kid"]
```

`fightOrFlight` ranges from 0 (always runs) to 1 (always fights back). Mood, health and gear (yours vs theirs) also factor in. A preset's `reactions` block overrides reaction settings per event. Switch presets live with `!persona <name>`.

### Chat modes (`chat.mode`)

| Mode | Replies when spoken to | Unprompted messages | Event reactions |
| --- | --- | --- | --- |
| `silent` | no | no | no (gestures still play) |
| `respond` | **yes** | no | only if `chat.reactionsInRespondMode` is true |
| `unprompted` | no | **yes** | yes |
| `both` | **yes** | **yes** | yes |

Other options:
- `respondTo`: `mentions`, `everyone` or `whitelist`.
- `ignore`: players it never replies to.
- `replyDelayMs` and `typingCharsPerSecond`: human-like delays.
- `minSecondsBetweenMessages` and `maxMessagesPerMinute`: anti-spam limits.
- `unprompted.*`: the small-talk timer. It is scaled by mood, so a happy bot chats more.
- `goalChangeInterrupts`: an accepted request interrupts the current action.

### Event reactions (`reactions.events`)

```json
"playerJoined": { "enabled": true, "chance": 0.7, "cooldownSec": 15, "perTarget": true, "style": "template",
                  "templates": ["hey {player}!"], "templatesWary": ["oh. {player}."] }
```

`style` can be:
- `template`;
- `llm` — written in character, with the bot's feelings and its relationship with that player;
- `gesture`;
- `silent`.

`templatesWary` is used for players it doesn't trust, and friendly gestures are skipped for them.

Events:
- **General:** `spawn`, `playerJoined`, `playerLeft`, `playerNearby`, `death`, `hurt`, `lowHealth`, `hungry`, `playerDied`, `killedMob`, `hostileNearby`, `toolBroke`, `nightfall`, `daybreak`, `rainStart`, `levelUp`, `itemPickup`.
- **Social:** `attackedByPlayer`, `killedByPlayer`, `gift`, `promiseKept`, `promiseBroken`, `harmNearby`, `crouchGreeting`, `wonFight`, `lostFight`.

Placeholders: `{player} {mob} {item} {level} {health} {food} {cause} {victim} {promise} {name}`.

## Commands

Roles:
- **Owners** (`behavior.owners`) can use everything.
- **Admins** (`behavior.admins`, or added in game with `!admin add`) can use most commands.
- The terminal running the bot counts as an owner.

When anyone else types `!stop`, it's treated as normal chat, so the bot just answers them like a person would. Per-command roles are set in `commands.permissions`.

| Command | Role | |
| --- | --- | --- |
| `!status`, `!help` | admin | health, food, action, goal, feeling |
| `!stop` `!pause` `!resume` | admin | control the brain |
| `!come` `!follow` `!goal <text\|clear>` | admin | from an **owner**: done directly. From an **admin**: treated as a request and judged like any other. |
| `!mode <silent\|respond\|unprompted\|both>` | admin | chat mode |
| `!emotion` | admin | `!emotion` (show) · `!emotion angry 8` (set) · `!emotion lock happy` · `!emotion unlock` · `!emotion volatility 0.5` |
| `!trust [player] [0-100\|reset]` | admin | view a relationship (trust, liking, history), or set trust; no player = list |
| `!tasks [clear]` | admin | what it's doing for whom, what it said it'd do later, and what it forgot |
| `!obey` | admin | `!obey` (show) · `!obey player 0.2` · `!obey trusted 0.4` · `!obey Steve 0.8` / `!obey Steve reset` · owner-only: `!obey owner …`, `!obey admin …`, `!obey who <everyone\|trusted\|admins\|owners\|nobody>`, `!obey conscience on\|off` |
| `!build [cancel]` | admin | current building plan, progress and missing materials |
| `!set <key> <value\|reset>` / `!get <key>` / `!settings [reset]` | admin | change settings live (see below) |
| `!lessons`, `!reactions on\|off` | admin | |
| `!admin add\|remove <player>` | owner | |
| `!persona <name>`, `!forget <player>`, `!save` | owner | |

**Live settings** (`!set`) persist in `data/brain.json` and override `config.json` until reset:
- **Chat:** `chat.mode`, `chat.respondTo`, `chat.unaddressedReplyChance`, `chat.unprompted.chance`, `chat.unprompted.intervalSeconds`, `chat.reactionsInRespondMode`, `chat.goalChangeInterrupts`
- **Reactions:** `reactions.enabled`, `reactions.gestures`
- **Obedience:** `obedience.levels.owner/admin/trusted/player`, `obedience.whoCanInstruct`, `obedience.overrideConscience`
- **Pacing:** `chat.stopToType`, `busyWork.enabled`
- **Emotions:** `emotions.enabled`, `emotions.volatility`, `emotions.decayPerMinute`, `emotions.lock`, `emotions.lockIntensity`
- **Trust:** `trust.enabled`, `trust.initial`, `trust.recoveryPerHour`, `trust.ignoreHostileChance`
- **PvP:** `pvp.mode`, `pvp.allowSparring`, `pvp.neverAttackOwners`
- **Learning:** `learning.reflect`, `learning.epsilon`

Keys under `trust.`, `pvp.` and `learning.`, plus the owner/admin obedience levels, `whoCanInstruct` and the conscience override, are owner-only (`commands.ownerOnlySettings`).

## Safety switches

- `pvp.mode` defaults to `defensive`. `protectedPlayers` are never attacked, and owners aren't either unless they ask for a spar.
- LLM chat output is sanitized: no leading `/` (no server commands), no control characters or `§` codes, and no assistant-speak.
- The pathfinder never digs through chests, barrels, furnaces or crafting tables.
- `behavior.maxTravelDistance` limits how far a single move can go.

## Troubleshooting

- **"Cannot reach Ollama"**: start it with `ollama serve`, or set `llm.url` / `OLLAMA_URL`.
- **"Server version … is not supported" / "Outdated client"**: see [Minecraft 26.3 and other newer versions](#minecraft-263-and-other-newer-versions).
- **Slow decisions**: use a smaller model, lower `llm.numCtx`, or raise `loop.minLlmIntervalMs`.
- **Kicked for spam**: raise `chat.minSecondsBetweenMessages` and lower `chat.maxMessagesPerMinute`.
- **Builds stall** with "missing materials": give it the materials, or let it gather them. `!build` shows what's left, and `!build cancel` drops the plan.
- **Online-mode servers**: set `"auth": "microsoft"` and use your account email as `username`.
- **Start relationships over**: stop the bot and delete `data/brain.json`, or use `!forget <player>` / `!trust <player> reset`.
