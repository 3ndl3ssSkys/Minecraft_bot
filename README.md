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
- **An intelligence level**, from complete Beginner (who learns as it goes) to Impossible, plus a configurable way of thinking.
- **Real senses**: line-of-sight vision (invisibility works), hearing mobs, footsteps, chests and mining, noticing particles, getting suspicious and investigating.
- **Reading the world**: signs, and whose chest is whose (yours, community, someone's private chest, unlooted or looted loot chests).
- **A good guest on friends' servers**: server profiles, login plugins, plugin chat formats, no griefing, and no fighting your own login.

When it says no, it says it like a person, never like a bot.

```
Perception (every 2s) ──► state JSON + feelings + relationships + lessons ──► Ollama ──► {thought, emotion, goal, action}
        ▲                                                                                      │
        └──────────── result fed back into the next prompt ◄──── ActionExecutor (one action at a time)
```

> **New here?** [SETUP.md](SETUP.md) walks through everything from an empty PC to a running bot. [CLAUDE.md](CLAUDE.md) holds the project's design notes and lessons learned.

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

Environment variables override the config: `MC_HOST`, `MC_PORT`, `MC_USERNAME`, `MC_AUTH`, `MC_VERSION`, `MC_PASSWORD`, `OLLAMA_URL`, `OLLAMA_MODEL`, `BOT_PERSONALITY`, `BOT_CHAT_MODE`, `BOT_INTELLIGENCE`, `BOT_SERVER` (profile name), and `BOT_DEBUG=1` for verbose logs.

> **Model size:** `qwen2.5:7b` is a good default. `qwen2.5:3b` is faster on weak hardware but makes more mistakes; `qwen2.5:14b` plans and role-plays noticeably better. Ollama 0.5+ is recommended for strict JSON-schema output.

## Running it on your server computer

The bot runs alongside Ollama on any PC that can reach the Minecraft server; it can be the same machine as the server. The bot draws nothing on screen, so it needs no graphics card itself; the GPU is for the LLM.

### Windows

1. Install:
   - [Node.js 22 LTS](https://nodejs.org);
   - [Git](https://git-scm.com);
   - [Ollama](https://ollama.com/download);
   - an up-to-date NVIDIA driver.
2. Download the model:
   ```bash
   ollama pull qwen2.5:7b
   ```
3. Recommended for 6 GB graphics cards: in **System Properties → Environment Variables**, add these user variables, then quit Ollama from the tray and start it again.
   - `OLLAMA_FLASH_ATTENTION` = `1`
   - `OLLAMA_KV_CACHE_TYPE` = `q8_0` (halves the memory the context uses)
   - `OLLAMA_KEEP_ALIVE` = `24h` (keeps the model loaded between calls)
4. Get the bot:
   ```bash
   git clone -b claude/confident-meitner-1ita5a https://github.com/3ndl3ssSkys/Minecraft_bot.git
   ```
   ```bash
   cd Minecraft_bot
   ```
   ```bash
   npm install
   ```
5. Edit `config.json`:
   - `server` — use `127.0.0.1` if the Minecraft server runs on this same PC;
   - `behavior.owners` — your in-game name;
   - `personality` and `intelligence.level`;
   - any `servers` profiles.
6. Check everything (`--probe-login` also tells you whether the server is online- or offline-mode):
   ```bash
   npm run doctor -- --probe-login
   ```
7. Start it once by hand: `npm start` (or `node index.js --server <profile>`). If it uses a Microsoft account, it prints a code to enter at microsoft.com/link, and the sign-in is remembered in `data/auth`.
8. Keep it running: `scripts\start-bot.bat` (add `--server <profile>` if needed) restarts it after a crash. To start it with Windows:
   - open **Task Scheduler → Create Task**;
   - choose "Run whether user is logged on or not" and the trigger "At startup";
   - set the action to `scripts\start-bot.bat`, with "Start in" set to the `Minecraft_bot` folder.
   
   If you use ViaProxy, start it the same way, before the bot.

### Linux

1. Install Ollama, which also installs a service:
   ```bash
   curl -fsSL https://ollama.com/install.sh | sh
   ```
   Install Node.js 22 and git with your package manager or NodeSource, then pull the model:
   ```bash
   ollama pull qwen2.5:7b
   ```
2. For the same 6 GB settings, add them to Ollama's service:
   ```bash
   sudo systemctl edit ollama
   ```
   Add these lines:
   ```
   [Service]
   Environment="OLLAMA_FLASH_ATTENTION=1" "OLLAMA_KV_CACHE_TYPE=q8_0" "OLLAMA_KEEP_ALIVE=24h"
   ```
3. Clone and install as above (for example into `/opt/Minecraft_bot`), edit `config.json`, run `npm run doctor`, and start it once with `npm start` for the Microsoft sign-in.
4. Run it as a service. Install `scripts/minecraft-bot.service` (edit the user, folder and `--server` profile in it first):
   ```bash
   sudo cp scripts/minecraft-bot.service /etc/systemd/system/
   ```
   ```bash
   sudo systemctl daemon-reload
   ```
   ```bash
   sudo systemctl enable --now minecraft-bot
   ```
   Follow the logs with:
   ```bash
   journalctl -u minecraft-bot -f
   ```

**Updating:** run `git pull`, then `npm install`. Everything the bot has learned (relationships, lessons, chests, skills) is in `data/brain.json`; back that file up.

### Hardware (e.g. a GTX 1660 Super with 32 GB of RAM)

| Part | Needs | On a 1660 Super (6 GB VRAM) + 32 GB RAM |
| --- | --- | --- |
| LLM (`qwen2.5:7b`) | ≈ 4.7 GB for the model + ≈ 0.5-1 GB for an 8k context | Fits, but only just. With flash attention and the `q8_0` context cache it fits comfortably. Expect roughly 4-8 s per decision and 2-5 s per chat reply (`npm run doctor` measures your real numbers). |
| LLM (`qwen2.5:3b`) | ≈ 2 GB | Fits easily and runs about twice as fast; it's less clever. Use it if a Minecraft client shares the GPU. |
| Minecraft **server** | CPU + 4-8 GB RAM (no GPU) | Fine: e.g. `java -Xmx6G -jar server.jar nogui` |
| Bot (Node.js) | ≈ 0.3-0.5 GB RAM, light CPU | Fine |
| ViaProxy (Bedrock route) | ≈ 0.5 GB RAM | Fine |
| Minecraft **client** on the same PC | 1-2 GB VRAM | This is what squeezes the GPU. The 7B model then spills partly onto the CPU and gets several times slower — use `qwen2.5:3b`, or play on another PC. |

32 GB of RAM is plenty for all of it together. On a dedicated server PC (Minecraft server + bot + Ollama, no game client), the 1660 Super runs the 7B model well. The bot keeps busy (gathering, checking chests, parkour) while the model thinks, so a few seconds per decision looks like a player thinking rather than lag. If `npm run doctor` says the model is only partly on the GPU, the fixes are:
- the Ollama variables above;
- `llm.numCtx: 6144`;
- closing other GPU programs;
- the 3B model.

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
| `intelligence.js` | Skill levels, the skill curve, ability unlocks, learning |
| `senses.js` | Sight (line of sight, invisibility), hearing, particles, suspicion |
| `containers.js` | Chest classification, contents memory, signs |
| `util.js` | Small shared helpers |
| `doctor.js` | `npm run doctor`: checks Node, config, Ollama (with a speed/VRAM benchmark) and the server |
| `scripts/` | `start-bot.bat` / `start-bot.sh` (auto-restart), a systemd service file, `regen-config.js` |
| `test/` | `npm test` unit suites; `test/tools/` live-test tools (mock Ollama, test server, test player, scenario harness) |
| `SETUP.md` / `CLAUDE.md` | step-by-step setup guide / design notes and lessons learned |
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

## Intelligence (`intelligence`)

Set `intelligence.level` (or use `!iq <level>`). Every level is better than the one below, but the gains shrink as you go up. The skill curve is concave: a step from Hardcore to Master changes far less than one from Beginning to Simple.

| Level | Skill | Plays like | Notable abilities |
| --- | --- | --- | --- |
| `beginning` | 0.08 | never played; knows only the basics, figures things out, makes newbie mistakes | spam-clicks, misses swings, aims badly; learns fastest |
| `simple` | 0.41 | has played a little | crits, bows, golden apples, sprinting |
| `mediocre` | 0.63 | an average casual player | strafing, shields, parkour, drinking potions, basic mob tactics |
| `complicated` | 0.78 | a decent player | w-taps, axe vs shield, totem swaps, chasing split slimes |
| `advanced` | 0.87 | an experienced survival player | axe/sword combos, throwing potions (undead-aware), buffs, pearl escapes |
| `hardcore` | 0.93 | a hardcore player | cobwebs, water clutches, tracking by sound, **mace PvP (sloppy)** |
| `master` | 0.97 | knows everything the game gives normal players | **good mace PvP**, all knowledge |
| `impossible` | 1.00 | exploits niche mechanics; can do almost anything | tracks entities through walls, niche-mechanic knowledge, near-perfect reactions and aim |

What skill changes:
- **Combat:** reaction time (≈390ms → 60ms), aim error (±13° → 0°), missed swings, cooldown discipline, crit frequency, and which tactics it knows.
- **Mace PvP:** only for Hardcore and up; good mace PvP only for Master and Impossible. Hardcore's wind-charge launch drifts and it swings early; Master steers onto the target and waits for full falling speed. These are tied to the configured level, so practice doesn't unlock them.
- **Knowledge:** a Beginner doesn't know how to make a shield or that diamonds need an iron pickaxe; Master knows every recipe, drop chance and block stat; Impossible adds niche mechanics (sound tracking, eye-of-ender triangulation, pearl stasis, slime chunks...).
- **Building:** a Beginner builds a box with a flat roof and no windows. Each level adds roofs, windows, overhangs, porches and chimneys, up to elaborate designs.
- **Movement:** parkour and sprinting are skills too.
- **Senses:** how much it notices.

**Learning** (`intelligence.learn`, on by default) raises skill per area (combat, building, survival, knowledge, senses) with experience, along the same diminishing curve. A Beginner can grow to around Advanced (it never reaches mace PvP); a Master barely improves; Impossible can't. It also **learns facts**:
- from dying ("lava hides under blocks…");
- from its own lessons;
- from **players telling it things in chat** ("use a wind charge under you then smash with the mace").

`learnRate` scales experience gained, `maxLearnedLevels` overrides how far it can grow, and `!iq` shows current levels per area.

`intelligence.allowXray` (off by default, Impossible only) lets it read ores and chests through walls from loaded chunk data. Most servers treat that as cheating, so only turn it on where that's OK.

## How it thinks (`mind`)

On top of personality, you can shape how it reasons:

```json
"mind": {
  "thinkLike": "a careful speedrunner",
  "playstyle": "builder",
  "priorities": { "survival": 1, "social": 2, "building": 2, "exploring": 1, "combat": 0.5, "gathering": 1 },
  "riskTolerance": 0.3,
  "curiosity": 0.8,
  "instructions": ["never go into the Nether without fire resistance", "always share food with friends"],
  "decisionTemperature": 0.6
}
```

- `playstyle`: `balanced`, `survivalist`, `builder`, `explorer`, `fighter`, `helper`, `trader` or `miner`.
- `priorities`: 0 means it doesn't care, 2 means it matters a lot.
- `curiosity` also controls how readily it investigates odd noises.

In game (owner): `!mind like a medieval knight`, `!mind style explorer`, `!mind risk 0.2`, `!mind add <rule>`, `!mind clear`.

## Senses (`senses`)

- **Sight** (`realisticSight`): it only perceives entities it has line of sight to (glass and leaves don't block), or ones right next to it. Things it loses sight of are remembered for 20 seconds ("last seen…").
  - **Invisibility works**, unless the invisible player's armor or held item shows, their potion swirls are visible close in front of it, or they're bumping into it.
  - It only knows about ores and other blocks it has actually seen.
  - Impossible tracks every entity the server sends, even through walls.
  - Players' name tags also show through walls unless they sneak (see [Name tags](#name-tags)).
- **Hearing** (`hearing`): every sound the server sends (about 16 blocks, through walls) is sorted into mob noises, footsteps, chests/barrels/doors opening, blocks breaking or being placed, combat (bows, crits, shields, splash potions), anvils, spawners, and the **creeper hiss**. A hiss makes it back away even if it can't see the creeper. World-wide sounds (a wither spawning, the dragon dying) are noticed too.
- **Particles** (`particles`): crits, mining dust, cracks spreading on a block, smoke, portal particles, hearts and potion splashes — when close, roughly in front of it, and in line of sight.
- **Suspicion:** a player-type sound or particle with no visible source (footsteps, a chest opening, mining) makes it suspicious.
  - Knowing other players are around greatly reduces that. If someone just walked behind a wall, a chest opening back there barely registers.
  - Past `suspicionThreshold` it gets nervous and **goes to investigate** (more likely when curious).
  - Tested live: with nobody known nearby, a chest opening behind a wall pushed suspicion to "high" and set an investigation at that spot. With a player who had just gone behind the wall, the same sound stayed below the threshold.

`!senses` shows what it has heard and noticed recently.

## Name tags

The bot knows who a player is from their **name tag**, following vanilla rules:
- **Readable:** in line of sight within 64 blocks.
- **Through walls:** yes, unless the player is **sneaking**. The bot then knows they're there ("name tag through wall") without seeing them.
- **Never:** for invisible players, or when scoreboard team settings hide tags.
- **Unknown players:** a player it can see but can't read (invisible with armor showing, too far, tag hidden) is listed as **"unknown player"**, with no relationship info, because it can't know who that is. Once identified, it keeps the name while they stay in view.
- **Ranks:** team prefixes and suffixes ("[Admin] Steve") and tab-list display names show up as `nameTag`, which helps it work out who's staff or which team someone is on.
- **Mobs:** named mobs and pets show their names (always-visible tags within 32 blocks, others only when it looks right at them up close). Tamed animals show their collar (`tamed`). Only Impossible knows a pet's owner, from the data the server sends.

Tested live: identified in the open → through the wall while standing → hidden once they sneak (remembered briefly, then gone) → not perceived when invisible.

## Chests and signs

**Signs** within view are read automatically (`status.signs`), and `readSigns` reads all signs nearby.

**Chests:** `inspectContainer`, `storeItems` and `takeItems` classify every chest and remember its contents:

| Kind | How it tells |
| --- | --- |
| **your own** | it placed it |
| **community** | a sign says community/free/shared/public/"take what you need", or several different players use it |
| **someone's private chest** | a sign naming them or saying "keep out"/"private"; inside a build (placed blocks all around); tidy full stacks; one regular user |
| **unlooted loot chest** | part of a natural structure (dungeon spawner, mineshaft rails/cobwebs, temple, village, stronghold, bastion, fortress, end city, ancient city, trial chamber, shipwreck, buried treasure) and still full of typical loot |
| **looted loot chest** | a structure chest that's empty or picked over |

- It notices changes since its last look ("missing since you last looked: 8 diamond"). If its own chest is raided, it remembers who it heard opening it, and that player loses trust.
- It **won't take from other players' private chests** (`behavior.respectPrivateChests`). The exceptions are chests belonging to its owners, or the player it's fetching for.

`!chests` lists what it knows about nearby chests.

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
| `!iq [level\|learn on/off]` | owner | show or set the intelligence level (per-area levels shown) |
| `!mind [like\|style\|risk\|curious\|add\|clear …]` | owner | how it thinks |
| `!chests`, `!senses` | admin | what it knows about nearby chests; what it heard and noticed |
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
- **Intelligence & mind:** `intelligence.level`, `intelligence.learn`, `intelligence.learnRate`, `intelligence.allowXray`, `mind.thinkLike`, `mind.playstyle`, `mind.riskTolerance`, `mind.curiosity`
- **Senses & manners:** `senses.realisticSight`, `senses.hearing`, `senses.particles`, `senses.investigate`, `senses.suspicionThreshold`, `behavior.respectPrivateChests`, `behavior.noGrief`
- **Emotions:** `emotions.enabled`, `emotions.volatility`, `emotions.decayPerMinute`, `emotions.lock`, `emotions.lockIntensity`
- **Trust:** `trust.enabled`, `trust.initial`, `trust.recoveryPerHour`, `trust.ignoreHostileChance`
- **PvP:** `pvp.mode`, `pvp.allowSparring`, `pvp.neverAttackOwners`
- **Learning:** `learning.reflect`, `learning.epsilon`

Keys under `trust.`, `pvp.`, `learning.`, `intelligence.` and `mind.`, plus the owner/admin obedience levels, `whoCanInstruct` and the conscience override, are owner-only (`commands.ownerOnlySettings`).

## Safety switches

- `pvp.mode` defaults to `defensive`. `protectedPlayers` are never attacked, and owners aren't either unless they ask for a spar.
- LLM chat output is sanitized: no leading `/` (no server commands), no control characters or `§` codes, and no assistant-speak.
- The pathfinder never digs through chests, barrels, furnaces or crafting tables.
- `behavior.maxTravelDistance` limits how far a single move can go.

## Accounts and joining servers

**Which account can the bot use?**

| Server type | What the bot needs |
| --- | --- |
| **Offline-mode** (`online-mode=false`, often with a login plugin) | Nothing: `"auth": "offline"` and any username. Set `server.password` and it answers `/register` and `/login` prompts automatically (AuthMe, nLogin, ...). This is the same as a PrismLauncher offline account. |
| **Normal (online-mode) Java server** | Its own Java account (`"auth": "microsoft"`, email as `username`; you sign in once in a browser and the token is cached in `data/auth`). |
| **Realms** | A Java account invited to the Realm: `"realm": "Realm name"`. |

- **Your own Java account** works, but one account can only be online once. If you log in while the bot is on, it's kicked with "logged in from another location". It then **stops reconnecting**, so it never kicks you back off. Use it when you aren't playing.
- **Bedrock accounts can't sign into Java servers directly.** Mineflayer only speaks the Java protocol. The route that works is through ViaProxy and a server running Geyser + Floodgate — see [Using a Bedrock account (ViaProxy)](#using-a-bedrock-account-viaproxy).
- PrismLauncher "offline" accounts are just offline mode: they only work on offline-mode servers.
- Note: Minecraft for PC has been sold as "Java & Bedrock Edition" since 2022 — if you bought it on PC since then, you already own Java (on your own account, which you're using).

### Using a Bedrock account (ViaProxy)

**What has to be true:**
- The friend's Java server runs **[GeyserMC](https://geysermc.org) + Floodgate**. Many servers with Bedrock players already do.
  - Geyser lets Bedrock players connect; Floodgate lets them in **without** a Java account.
  - With Geyser alone (`auth-type: online`), Bedrock players must sign into a Java account, so this route doesn't help there.
- You know the server's **Bedrock port**: Geyser's default is `19132`, over UDP. Ask your friend.

**How it fits together:** the bot (Java) → ViaProxy on your PC, signed into your Bedrock account → the friend's Geyser port → their Java server.

**Steps:**
1. Install a current **Java** (21 or newer; if ViaProxy refuses to start, update Java).
2. Download the latest **ViaProxy** jar from [GitHub Releases](https://github.com/ViaVersion/ViaProxy/releases/latest) and put it in its own folder; it stores its settings there.
3. Run it (double-click, or `java -jar ViaProxy-<version>.jar`). A window opens.
4. **Accounts tab** → **Add Bedrock account** → sign in with the Microsoft account that owns Bedrock, using the code it shows, in your browser.
5. **General tab:**
   - **Server address**: `friend.example.net:19132` (their Geyser port).
   - **Server version**: the **Bedrock** entry in the version list.
   - **Minecraft account**: select the Bedrock account you added.
   - Leave **Proxy online mode** off.
6. Click **Start**. ViaProxy listens on `0.0.0.0:25568` by default (the bind address).
7. Add a server profile for the bot:
   ```json
   "servers": {
     "friend-bedrock": {
       "host": "127.0.0.1", "port": 25568,
       "auth": "offline", "username": "Wanderer",
       "version": "1.21.4",
       "platform": "bedrock"
     }
   }
   ```
   `auth: offline` is right here: the bot connects to ViaProxy without signing in, and ViaProxy uses your Bedrock account for the real server. The bot's `username` is ignored.
8. Start the bot:
   ```bash
   node index.js --server friend-bedrock
   ```

**In game**, the bot shows up under your **Bedrock gamertag with Floodgate's prefix** (default `.`), e.g. `.YourGamertag`. Floodgate gives Bedrock players their own identity, so you should be able to stay on with your Java account at the same time. The bot understands `.`/`*`-prefixed names in chat and recognises its own name with or without the prefix.

**Running ViaProxy without the window**, once the account is added in the GUI:
```bash
java -jar ViaProxy-<version>.jar config viaproxy.yml
```
Then in `viaproxy.yml` set:
- `target-address` and `target-version` (the Bedrock version);
- `auth-method: account` and `minecraft-account-index: 0` (the first account in the GUI list).

**Limits of this route:** ViaProxy's Bedrock translation (ViaBedrock) is still a work in progress. It can't break blocks or use inventories (chests, crafting tables, furnaces) yet, and mob sounds aren't translated. With `"platform": "bedrock"` the bot knows this: mining, crafting, smelting, chests and building are removed from its actions and it doesn't dig while pathfinding. It can still explore, chat, follow, fight, use items and place blocks.

I couldn't test this route here (it needs a real Geyser server and a Bedrock account), so expect some rough edges. The ViaBedrock feature list is at https://github.com/RaphiMC/ViaBedrock#features.

**Tip:** ViaProxy also joins **Java servers up to 26.3** with a Java account (Accounts → Add Microsoft account, target version auto-detect). That's an alternative to ViaBackwards for new server versions.

### Geyser without Floodgate

This depends on how the server's Geyser is set up (`auth-type` in Geyser's config):

| Geyser `auth-type` | What it means | What to do |
| --- | --- | --- |
| `floodgate` | Bedrock accounts are allowed in as themselves | The ViaProxy route above works. |
| `online` (the default without Floodgate) | Every Bedrock player must **also sign in with a Java account** (Geyser asks for a microsoft.com/link code) | A Bedrock-only account can't get in. This is the server's login check, and the bot can't (and shouldn't) get around it. If you have a Java account for the bot, skip Bedrock entirely and connect directly with `"auth": "microsoft"` — it's simpler and every feature works. |
| `offline` | The Java server runs in offline mode | Skip Geyser and ViaProxy: connect the bot straight to the Java port with `"auth": "offline"`. Every feature works, including mining, chests and building. |

If the bot is kicked with a Geyser message about Java accounts, it says so in the log and stops retrying. `npm run doctor -- --probe-login` tells you whether a server is online- or offline-mode. **On your own server**, installing [Floodgate](https://geysermc.org/download?project=floodgate) next to Geyser is free and is what makes the Bedrock-account route possible.

### Joining friends' servers

Without them setting anything up:
- Put each server in `servers` and pick one with `--server`:
  ```json
  "servers": {
    "sam": { "host": "sam.example.net", "port": 25565, "auth": "microsoft", "username": "botaccount@example.com" },
    "lan": { "host": "192.168.1.20", "port": 25565, "auth": "offline", "username": "Wanderer", "password": "s3cret" }
  }
  ```
  ```bash
  node index.js --server sam
  ```
- **Versions:** detected automatically. Newer than Mineflayer supports → it connects as the newest supported version (needs ViaBackwards/ViaProxy, see above).
- **Resource packs:** accepted (`server.resourcePack`).
- **Chat:** plugin chat formats ("[Member] Steve: hi", "Steve » hi", "Steve -> me: psst") are understood. Add your own regexes with named groups `user`/`msg` in `server.chatPatterns`.
- **Kicks:** a whitelist or ban stops reconnects; spam kicks back off harder.
- **Manners:** it's a good guest by default.
  - `behavior.noGrief`: it won't mine or path through other players' builds.
  - `respectPrivateChests`: it doesn't take from private chests.
  - It reads signs and chat for rules and follows them.
  - It chats within rate limits.
- If a server has a whitelist, the bot's name has to be on it like anyone else's.

## Troubleshooting

- **"Cannot reach Ollama"**: start it with `ollama serve`, or set `llm.url` / `OLLAMA_URL`.
- **"Server version … is not supported" / "Outdated client"**: see [Minecraft 26.3 and other newer versions](#minecraft-263-and-other-newer-versions).
- **Slow decisions**: use a smaller model, lower `llm.numCtx`, or raise `loop.minLlmIntervalMs`.
- **Kicked for spam**: raise `chat.minSecondsBetweenMessages` and lower `chat.maxMessagesPerMinute`.
- **Builds stall** with "missing materials": give it the materials, or let it gather them. `!build` shows what's left, and `!build cancel` drops the plan.
- **Online-mode servers**: set `"auth": "microsoft"` and use your account email as `username`.
- **Start relationships over**: stop the bot and delete `data/brain.json`, or use `!forget <player>` / `!trust <player> reset`.
