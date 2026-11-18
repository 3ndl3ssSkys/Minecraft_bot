# Project memory — Minecraft LLM Bot

Everything learned while building this bot: what it is, how it's put together, why things are the way they are, and the traps already found. Claude Code loads this file automatically; it's also meant for humans picking the project up later.

- **Setup for users:** [START-HERE.md](START-HERE.md) (Windows, one path, exact commands — the user found SETUP.md too much to start with), then [SETUP.md](SETUP.md). **Configuring** (goals, feelings, personality, chat, reactions, fighting): [CONFIGURING.md](CONFIGURING.md).
- **Feature reference:** [README.md](README.md).
- **The whole conversation, request by request, and the next task:** [HISTORY.md](HISTORY.md). Read it when picking the project up. Section 14 is the next thing to build: long-term memory and separate bot saves.

## The user and what they want

- Address the user as **EndlessSkys** (or Endless). Never use their real first name, which shows up in their Windows paths (`C:\Users\<name>`): write "your user folder" or `%USERPROFILE%` instead.
- **Goal:** a fully autonomous Minecraft Java bot that plays and talks **like a real person**, driven by a local LLM (Ollama + Qwen 2.5).
  - It refuses like a human, never like an assistant.
  - **It never uses emojis** (the user asked). The prompts say so, and `ChatManager.sanitize` strips them (`EMOJI` regex) because small models add them anyway.
  - It has feelings, trust and liking, its own judgment, skill levels and realistic senses.
  - It's a good guest on friends' servers.
- **Hardware:** a dedicated server PC with a **GTX 1660 Super (6 GB VRAM) and 32 GB RAM**, running **Windows** (Command Prompt), Node 26. Nobody plays Minecraft on that PC, so the whole GPU goes to Ollama. The bot is headless and needs no GPU.
  - **Measured on it:**
    - `qwen2.5:7b` does **not** fully fit: `ollama ps` showed 5.2–5.4 GB at `18–21%/79–82% CPU/GPU`, because Windows uses part of the VRAM for the screen.
    - **`qwen3:4b` fits (3.2 GB, 100% GPU), but it's a thinking-only version:** even `ollama run qwen3:4b --think=false` reasoned for pages and ended with `</think>`. Use **`qwen3:4b-instruct`** (same size, answers directly) with `llm.think: false`. **Confirmed on the user's PC:** 3.2 GB, 100% GPU, answers directly.
    - `ollama ps` still showed "4 minutes from now" afterwards, so `OLLAMA_KEEP_ALIVE=24h` (and probably the other `setx` values) wasn't active yet: Ollama hadn't fully restarted. The bot sends `keep_alive: 24h` itself anyway.
    - Verdict given to the user: this one model is enough on that card. Reflexes don't use it; chat ~1–2 s; decisions a few seconds. Optional: add `qwen3:1.7b` as `fastModel` if replies feel slow while it's deciding (both fit). Bigger 7–8B models spill onto the CPU there; a 1.7B for everything would make worse decisions.
    - It's not known yet whether the `setx` Ollama variables (flash attention, q8_0 KV) took effect.
- **Accounts:** the user plays on their own Java account, so the bot can't use it at the same time.
  - **Java is the main route, and it must not require an account:** `server.auth: "auto"` (default) plays as an **offline account** unless `username` is a Microsoft email, and drops to offline if that sign-in fails. Java gives the bot every feature.
  - **Bedrock stays as a backup:** Geyser + Floodgate servers through ViaProxy with the user's Bedrock account (`server.platform: "bedrock"`), usually set as `server.fallback`.
  - Online-mode servers refuse offline accounts. The friend's host offered a plugin as long as **it never touches other players' saves**: FastLogin with premium UUIDs kept (SETUP.md 6D), or Geyser + Floodgate. Never suggest plain `online-mode=false` (it changes every UUID).
  
  Geyser **without** Floodgate (`auth-type: online`) needs a Java account. That's server authentication, and we do not try to bypass it.
- **Friends' servers:** the bot should be able to join without the friends setting anything up for it.
- **Working rules:** develop on branch `claude/confident-meitner-1ita5a`, commit with clear messages, and push. Don't open PRs unless asked.

## Where things stand (update this as it changes)

- **The user's setup:**
  - Done so far: Ollama, Node and Git installed; the repo cloned to the user folder; `npm install`; `npm run setup`.
  - `config.local.json`: owner `EndlessSkys`, bot name `TheBestWanderer`, level `complicated`, a custom friendly/cautious/PvE/explorer personality, server `localhost:25565`. The model should be switched to `qwen3:4b-instruct` by rerunning setup (it detects the thinking problem and offers this).
  - The user has run the three `setx` Ollama settings by hand; Ollama still needs a restart for them to apply.
  - **Next for the user:** `git pull`, `npm run setup` (choose `qwen3:4b-instruct`; setup also applies the Ollama settings and tests the model), restart Ollama, check `ollama ps` shows 100% GPU, `npm run doctor` (let the timing step finish), then the local Paper test server (START-HERE.md step 4, `online-mode=false` on a fresh world), then `npm start`.
  - After that: the friend's server via FastLogin (SETUP.md 6D) or the Bedrock fallback.
- **First real play session (26.1 Paper, qwen3:4b-instruct):**
  - The bot spawned, planned goals and greeted, but every action had empty args (the Ollama key-sorting problem above, now fixed).
  - It didn't answer the user, who didn't say its name: now it also answers when nobody else is online or the speaker is within 12 blocks.
  - Each chat line arrived twice on 26.1: now deduped in `onMessage`.
- **First real server contact:** the user's local Paper **26.1** test server accepted the offline login (version and auth fine), then kicked it with "You are not white-listed". Fix given: `whitelist add TheBestWanderer` in the server console (or `whitelist off`), then restart the bot, which stops retrying after a whitelist kick on purpose.
- **Nothing has run against a real Minecraft server yet.** All live tests used flying-squid and the mock LLM. Expect the first real sessions to surface prompt and behaviour issues: read the user's logs and tune from them.
- **When the user pastes output:** it uses their real name in paths. Never repeat it (see the naming rule at the top).

- **Review pass (HISTORY.md §16), not yet seen by the user on a live server:** log bias, circling, suggestions-as-tasks, stock chat phrases, real parkour with a per-level skill ladder, boldness with better gear, plan queue, goal commitment, chat preempting decisions, long-term memory and profiles. Delivered as one cumulative patch against the branch (`git apply minecraft_bot_improvements.patch`). **Next for the user:** apply it, set `llm.fastModel` (`qwen3:1.7b`) plus `OLLAMA_MAX_LOADED_MODELS=2`, play, and send logs.

- **Sight, reach, threats, owner directions, speed (HISTORY.md §28):** from the user's first real underground session:
  - block sight fixed (it saw nothing beyond 3 blocks), and clicking needs a clear face (`reach.js`);
  - `threat.js` danger/worth/verdict per creature;
  - owner mining directions became code tasks (stripMine), with no trust loss for being told what to do;
  - the obtain stall fixed, tool check up front;
  - a timing line per decision with one-time diagnoses, a pruned state.
  - Crafting checked against the server (`craftVerified`) after the user saw ingredients left in the crafting grid.
  - Viewer (HISTORY.md §31): the jitter came from prismarine-viewer's overlapping 50 ms tweens. Fixed (measured on frame steps while walking: stops 10 → 0 of 180 frames, variation 105% → 41%), and the view now has the game's sky, weather, light, hand and overlays.
  - Speed pass (HISTORY.md §29): routines (`routines.js`) cut model calls, e.g. 13 → 2 in a 45 s search test. The decision prompt is ordered slow → fast-changing (`stableFirst`; reusable state 8% → ~48%), and `npm run training-set` builds a fine-tuning file.
  - Next for the user: `git pull`, play, send the log (the "Thought for" lines show where the time goes).
- **Join fix (HISTORY.md §27):** the voice chat update made real servers drop the bot at login (`socketClosed`); fixed. The README now opens with what it does, how to use it and how to configure it.
- **Voice chat, PvP, research (HISTORY.md §26):** Simple Voice Chat client (tested against a fake server written from the mod's source), friendly spars with a 3-heart stop and gg, PvP minigame fighting with team awareness, online research for Master/Impossible. None of it has met a real server yet.
- **Menus and local voice (HISTORY.md §25):** `navigateMenus` (goal → hotbar item → menu entries, back out), owner invites through menus on Bedrock (The Hive) or when a command fails, server notices in `state.server.notices`; local voice server (Whisper + Kokoro), sentence-by-sentence speech, 16 kHz WAV from the page.
- **Public networks and voice (HISTORY.md §24):** network.js (menus, commands, parties, owner invites, quiet in public chat), voice page with wake words, browser or Whisper/Kokoro engines, https for LAN, `explainAndShow` narration in time with actions. Tested live on flying-squid + Chromium over https (wake word, spoken reply, a narrated walkthrough); real speech recognition and a real network are untested.
- **Mouse/keyboard, server manners, redstone (HISTORY.md §23):** human mouse and WASD input, rules and protected farms/pets/towns with lawfulness (anarchist preset), redstone simulator/optimizer/designs/building and contraption recognition for knowledgeable bots. Unit-tested; oriented redstone placement is unverified (flying-squid can't do it).
- **Common sense and player habits (HISTORY.md §22):** the user saw it crafting crafting tables with 3 in its pockets. Fixed (placement verified and retried, honest error, `commonsense.js` guard, example replaced). Also: picking up placed stations before leaving, habits, death runs, sprint-jumping, menu time by level. Tested on flying-squid; the user hasn't run it yet.
- **Viewer page rebuilt (HISTORY.md §21):** game-like HUD, inventory with icons, FOV 70 + smooth camera, collapsible chat, feelings/goals/tasks controls, pointing and circling. Smooth head turning in game (`look.js`). Tested on flying-squid + Chromium; the user hasn't seen it yet.

## Architecture

Plain Node.js (CommonJS, Node ≥ 22), Mineflayer 4.39 + mineflayer-pathfinder 2.4.5. Style: no semicolons, two-space indent, single quotes, short doc comments on classes and non-obvious functions.

```
Perception (2s tick) → state JSON + feelings + relationships + lessons + know-how
   → LLM (Ollama /api/chat or OpenAI-compatible, JSON schema) → {thought, emotion, goal, action, taskUpdate}
   → ActionExecutor runs ONE action (timeouts, AbortSignal, pause-for-typing)
   → result into Memory → next prompt

Parkour (parkour.js): findJumps → chance per level (TIERS) → runJump (run-up, timed take-off, air steering) or the pathfinder wrapper
   (getMoveParkourForward filtered by skill); every jump outcome feeds the `parkour` XP domain. Tests run it on prismarine-physics (test/tools/simbot.js).
Memory (memory.js): importance-scored long-term memories + per-player chat history in the save file (data/profiles/<name>/brain.json with --profile).

Reflexes (every physics tick, 20/s, no LLM): falls, lava, drowning, hits → take the body
   (abort the action, Brain waits on reflexes.busy) → memory event afterwards
```

| File | Owns |
| --- | --- |
| `index.js` (~3000 lines) | `DEFAULT_CONFIG` (the source of truth for every option), `loadConfig` (+ `--server` profiles, env overrides, compatibility), `Memory`, `Perception`, `OllamaClient` (Ollama or OpenAI-compatible; two lanes when `llm.fastModel` is set — chat (reply 0, reaction 1, smalltalk 3) on the fast model, decisions 2 and reflect 4 on the main one; each lane one request at a time, priority-sorted; the fast lane can use another provider), prompt builders (`personaBlock`, `mindBlock`, `buildDecisionPrompt`, `HUMAN_VOICE`), schemas, `ChatManager` (rate limits, danger shortening, robot-speak guard, stop-to-type), `ChatResponder` (analysis → appraisal → phrasing; !commands; postponing in danger), `SETTABLE` + `parseSetting` (in-game settings), `SmallTalk`, `EventReactor` (all game events → memory, social, emotions, reactions), `Brain` (loop, decision-level reflexes like fight/flee, busy work while thinking — the LLM wait is raced against `interruptFn` so a hit acts at once, `considerTruce`, `watchFight`/`rethinkFight` (the mind can stop or flee mid-fight), XP), `Agent` (wiring, connection, server helpers, kick handling, saving), `parsePluginChat`. |
| `actions.js` | `ACTIONS` registry (30 tools: move, follow, explore, mine, place, chat, equip, attack, retreat, eat, collect, craft, give, sleep, smelt, store/take, activate, fish, useItem, knowledge, readSigns, inspectContainer, parkour, planBuilding/build/cancelBuilding, emote, wait), `gotoGoal` (our own pathfinder driver), `placeAt`, `ActionExecutor` (availability filters, hard timeout, `pauseFor`, ctx with social/learning/tasks/builder/intel/containers). |
| `goals.js` | The goal tree: overall (`life`) → long-term (≤4) → current (with `steps`, `now`, `detour`) → history. Sources: config / owner name / self; set goals are `fixed`. `onDecision` (goal, subgoal, goalStatus incl. `new_goal`), detours (own goals taken over after 3 min), `needsPlan`/`maybePlan`/`applyPlan` (low-priority planner call, keeps fixed goals), `forPrompt` (status.goals). |
| `acquire.js` | `nextAcquireStep`: the next concrete step to have N of an item — mine the dropping block (pickaxe first), craft (known recipes), **smelt** (input → furnace → fuel → `smeltItem`) or **hunt** (`MOB_DROPS`, returns `then: 'collectDrops'`). `foodTarget` picks cooked meat from the animals around. Used for tasks, the autopilot and `obtainItem`. |
| `pickup.js` | `judgeDrop`: take or leave a dropped item (own death drops, gifts tossed toward it, other players' drops and death spills, junk, hazards, full inventory, wanted for goal/task). `Agent.dropVerdict(entity)` feeds it from `EventReactor.drops`/`deathSpots`. |
| `skills.js` | Situational skills installed into ACTIONS (`install(ACTIONS, helpers, SHORT)`, avoids a require cycle): `shelter`, `pillarUp`, `climbOut`, `bridge`, `stripMine` (`DEPTHS` modern/legacy, `NEEDS` pickaxe tier, `hazardAround` before every dig), `placeTorch`. Habits in `Brain.habitStep` (torch in dark tunnels, climb out when stuck), night routine in `autopilotStep`, pillar escape in `Brain.reflex`. |
| `viewer.js` + `web/panel.html` | Optional browser panel (`viewer.enabled`, `--viewer`, `!viewer on`, port 3007, 127.0.0.1 unless host+password): prismarine-viewer first-person view under `/view/` (only `viewer/lib/worldView` is required: the package index pulls native `canvas`), SSE `/events` (status every 1 s, log lines via a wrapped `agent.log`), `POST /send` (talk = whisper from the first owner, command = `@console`, say = `bot.chat`). `stateMap`/`convertColumn` translate 26.x worlds to 1.21.4 block by block (the viewer only knows ≤1.21.4). Our routes must be registered **before** prismarine-viewer's `setupRoutes`, whose compression middleware buffers the event stream. We serve our own `/view/` index that loads `web/view-addon.js` first. The add-on:
  - catches `window.THREE` to patch `PerspectiveCamera.prototype.updateProjectionMatrix` (FOV, camera hook) and `Object3D.prototype.add` (finds the scene; `WebGLRenderer.render` is per instance in r128, so patching its prototype does nothing);
  - overrides the camera's `updateMatrixWorld` so prismarine's overlapping 50 ms tweens only set a target and the drawn position eases toward it (the jitter fix), plus bobbing, sneaking, the hurt tilt and the death fall;
  - draws sky dome, sun, moon phases, stars, a cloud shader, fog (world materials need `needsUpdate` once fog first exists), lights scaled by `env.sky`/`env.block`, rain/snow, destroy-stage cracks, the hand (Steve arm UVs / held item from `/icons`, front faces only because it's drawn without depth testing) and overlays, all from `/view/textures/<ver>/…`;
  - is fed by `/view/env` (SSE, 10/s, `BotViewer.env()` plus `hookSwings` wrapping `bot.swingArm` and `bot.dig`);
  - `__botView.snapshot()` gives pointing the camera as drawn; `/icons` (iconResolver over the shipped textures), `/control` (feelings, goals, tasks as the first owner), `/point`. |
| `pointing.js` | Viewer pointing: `rayDir`/`project` (three.js Euler ZYX = Mineflayer yaw/pitch), click or outline → `bot.world.raycast` blocks + creatures inside the outline, `describePointing` (relative without F3). |
| `look.js` | `installHumanInput`: mouse and keyboard like a person. Flicks (Fitts timing, minimum-jerk curve, undershoot + correction), smooth pursuit in fights, instant only when `precise()` (reflexes, parkour). Paths: catches the pathfinder's `look(yaw, 0)`, eases the camera to a look-ahead point with a walking pitch, and picks WASD combos relative to the camera (`behavior.humanKeys`); exact on parkour/dig/place nodes, ledges and water. |
| `etiquette.js` | Server manners: rules (chat `rule` field → `ChatResponder.handleRule`, signs, system messages) kept by authority × `lawfulness` (personality / `etiquette.lawfulness`; `anarchist` preset); `check()` before actions; `protectedMob` (named, pet, villager/golem, vehicle, `contained` in a player-made box or pen = farm); `builtUp` (someone's town). `!rules`. |
| `redstone.js` | Logic-level redstone simulator (redstone ticks): `Circuit`, `analyze` (truth table / delay / clock period / latch), `optimize` (cheaper, same job), `DESIGNS` (not/or/nor/and/nand/clock), `place` (rotate), `readFromWorld`, `describe`. |
| `mechanics.js` | Recognises contraptions (cobble gen, observer farms, auto-smelter, sorter, iron farm, trading hall, mob farm, elevators, ice roads, piston doors, flying machines, TNT dupers) with mechanic/benefit/rate/improvements by knowledge level; `state.contraptions`. |
| `tech.js` | Actions `inspectRedstone` (knowledge 4+), `designCircuit` and `buildCircuit` (6+; `minKnowledge` filter in `availableTools`): oriented placement by camera aim + `_genericPlace(forceLook: 'ignore')`, facing check and fix, real lever test against the simulation. |
| `reach.js` | What a player can click: `clickableFace(bot, block, { reach, normal })` (a ray from the eyes lands on that block's face, nothing in between; leaves and glass block clicks), `obstacle`, `facePoints`. Used by `placeAt` (support face it can see, else GoalPlaceBlock with LOS), `placeNearby` (visible spots first), `goNextTo` (GoalLookAtBlock, throws NOT_IN_VIEW), activate/useItem/crafting tables (click the visible face), mineBlock (digs the visible face, punches through leaves/grass in the way, skips blocks sealed in rock with realistic sight). |
| `threat.js` | Sizing up creatures: `assess(mobs, me, ctx)` → per mob danger (share of health lost killing it: mob dmg × rate × armour/shield/knockback × time-to-kill from own weapon dps × skill), worth (wanted drops, food when hungry, will chase anyway, near a friend, hurt me; minus neutral-unprovoked, unneeded animals, babies; protected = leave), verdict fight/avoid/flee/leave/ignore, plus the group total and verdict; `describe` for `status.threats`. `Agent.threat()` feeds it perceived mobs only; used by `dangerInfo` and `Brain.reflex` (flee, early engage at 4.5 m when worth it, avoid). |
| `routines.js` | Keeping at a decision without new model calls: `stepCount` ("chop 20 oak logs" → item, count, anyWood), `seekTarget` ("find a village" → blocks/entities to watch for), `seen`. `Brain.commit` (after every llm/plan decision): mining/crafting toward a step's amount → `startObtain(item, count, { anyWood })`; explore with a find-target → `Brain.seek` (up to 5 more explores until seen); stripMine → seek until the ore item count rises. `seekStep` sits after `obtainStep` in the loop; prethink stands down while it runs. |
| `commonsense.js` | `review(decision, view)` before every non-reflex/non-command action: one-is-enough items, tool/armor downgrades, third try of a failure, crafting the same thing over and over, over-gathering, eat when full, sleep by day, second station, dropping valuables. `carryHints` for status.hints. Wired in `Brain.commonSense` (wants = player task / non-self goal / build / obtain). |
| `places.js` | Mental map (saved as `places`): placed blocks with a skill-rolled `remember`, home, bed, sleptDay, deaths. `reclaimable`, `leaving`, `freshDeath`, `forPrompt` (state.places). `Brain.takeThingsFirst` + `this.resume`. |
| `habits.js` | Chores by rule (`Brain.choreStep`): armor, shield, tool replacement, junk, `hotbarMoves` (action `organizeHotbar`). |
| `motion.js` | Sprint-jumping on straight flat path stretches (parkour 3+; drops passed nodes from the shared pathfinder path while airborne), `adjustLook` (no enderman eye contact). |
| `network.js` | Public networks: `context()` (sidebar, boss bars, title/action bar, named hotbar items, open menu, tab-complete commands → `state.server`), `isNetwork`/`inLobby`, `describeWindow`/`findSlot`, `allowed` (SAFE_COMMAND vs DANGEROUS), auto-accepting owners' invites (clickEvent run_command or the named command; system messages only). Actions `useHotbarItem`, `readMenu`, `clickMenu`, `serverCommand`, `joinOwner`. `ChatManager.publicAllowed` (`chat.publicChat`). |
| `voice.js` + `web/voice.html` + `web/voice-client.js` | Voice through the viewer: `/voice` page (browser SpeechRecognition or MediaRecorder → `voice.sttUrl` Whisper; speechSynthesis or `voice.ttsUrl` audio). `Voice.say` queues lines and waits for the page's `/voice/done`; `heard` (wake words, conversation window, SHOW_ME → `explainAndShow`). `ChatManager.deliver` speaks owner-directed lines when a page is active. `viewer.https` makes a self-signed cert with node-forge (mic needs a secure context). |
| `scripts/voice-server.py` | `npm run voice-server`: one Python process with faster-whisper (`base.en`, CPU int8) and kokoro-onnx (fp32 model + voices auto-downloaded from the kokoro-onnx GitHub releases into `scripts/voice-models/`), OpenAI-compatible `/v1/audio/transcriptions` and `/v1/audio/speech` (WAV), `/v1/audio/voices`, `/health`. Stdlib HTTP server, own multipart parser (no `cgi` in Python 3.13). |
| `svc.js` | Simple Voice Chat client (protocol from the mod's source, compat 21): `voicechat:request_secret` → `voicechat:secret` (key, connection id, port, host, codec, MTU) over plugin channels (`restBuffer`), `voicechat:client_state`; UDP `0xFF + connectionId + varint-len AES-128-GCM(iv12 + data + tag16)`; Authenticate → AuthAck(nonce) → ConnectionCheck(nonce) → CheckAck; KeepAlive echo; Mic packets (Opus 48 kHz, 960-sample frames, seq, whisper) sent in real time + an empty end packet; Player/Group/Location sound → per-speaker Opus decode (opusscript) → utterance WAV 16 kHz after `svc.silenceMs`. `Voice.route`/`speakTo`/`sayInGame`/`heardInGame` decide voice chat vs page vs typing. |
| `research.js` | Online research for Master/Impossible (`intelligence.baseIndex >= research.minLevel`): DuckDuckGo HTML (or SearXNG/Brave), Minecraft Wiki API, `htmlToText`, LLM notes saved as `research`, `relevant()` into decision knowhow; action `research` (`minBaseLevel`); `Agent.researchGame` reads up on a new network minigame. |
| `explain.js` | `explainAndShow`: `Agent.planExplanation` (LLM steps: say/action/look) → each step spoken while its action runs and the spot is looked at and highlighted; next step after both. |
| `reflexes.js` | The fast layer: `predictLanding` (tick simulation), `fallDamage` (Feather Falling/Protection EPF), `TRICKS` (17 saves + hazard tricks with level and `need`), `fallOptions` → expected-damage choice, executors (placeBelow, edge clutch, boat, pearl, elytra, mace, mount, wall pearl), hazards (lava, fire, drowning, suffocation, TNT), `onHurt` (startle, weapon out, edge sneak), learning saves (`discover`, `learnFromText`), `avoidHazards` for the pathfinder. |
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
| `setup.js` | `npm run setup`: a short questionnaire that writes `config.local.json` (owner name, server, bot name, personality, level, models from Ollama). |
| `test/` | `npm test` unit suites; `test/tools/` live tools (mock Ollama, flying-squid server, test player, scenario harness). |
| `scripts/` | Start scripts (Windows/Linux), systemd unit, `regen-config.js`. |

**What gets saved** (`data/brain.json`, every 30 s and on shutdown): `social` (players: trust, affinity, notes, promises, stats), `emotions`, `tasks` + history, `building` (current plan + history), `obeyPlayers`, `intelligence` (xp), `reflexes` (learned saves + practice), `goals` (tree + history + last config), `chests`, `knownFacts`, `learnedItems`, `combat`, `movement` (danger zones), `lessons`, `stats`, `admins`, `settings` (in-game overrides, which win over config.json until reset).

**Changing a setting for the user:** `npm run set -- llm.fastModel qwen3:1.7b` (scripts/set.js) writes it into their `config.local.json`, which lives only on their PC (we can't edit it from here). At start, `unknownSettings` warns about keys the bot doesn't know, with a guess (a top-level `fastModel` → `llm.fastModel`), and `readJson` strips Notepad's BOM and reports line/column on a JSON error.

**User settings:** `config.json` holds the defaults (regenerated by `scripts/regen-config.js`); the user's own settings go in **`config.local.json`** (gitignored, merged on top by `loadConfig` unless a config file is passed on the command line). Point users there, not at `config.json`.

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
- **Intelligence:** the skill curve is concave — big early gains, small later ones (0.08 → 0.41 → … → 0.97 → 1.00). **Mace PvP only for Hardcore+, good mace only for Master/Impossible**, by configured level. A Beginner learns slowly but without a cap (`maxGain` 7, xp scale 120: ~2 levels at 40 xp, past Master around 300) — the user wants a Beginner to be able to end up better than a Master. X-ray is opt-in and Impossible-only (counts as cheating on most servers).
- **Speed: two layers.** The user said reactions can't wait 2–4 s. Anything time-critical (falls, lava, drowning, hits) is code in `reflexes.js` with a human reaction delay from skill (≈420 → 70 ms); the LLM only plans and talks. Fall saves by level as the user listed: Advanced knows the common saves (water, blocks, pearl, elytra) but executes imperfectly; Master knows boat, ladder/vine, mace-on-mob, mounting; Impossible crouch-clutches, wall-pearls and is frame-perfect. Success = `sigmoid(14 × (skill − need))`, × 0.65 under 1.2 ticks of window and × 0.3 under 0.8 (except Impossible). A fumble is decided up front and acted out (late click). Beginners discover saves from bad falls (trick level ≤ own level + 3) or from chat.
- **Truce:** "sorry/stop/truce" from the opponent is judged instantly in `Brain.considerTruce` (affinity, trust, forgiveness, hits, still swinging, broken truce before).
- **The mind keeps a say** (user asked "can the AI still decide to stop attacking?"): reflexes start fights, but `pvp.rethinkSeconds` check-ins (reaction priority → fast lane) can stop or flee; chat replies get the last 90 s of memory events so words match actions.
- **Goals** (user's design): overall → encompassing/long-term → goal → subgoals, each set or self-made; set goals stay (detours instead), own goals can change (`new_goal`). Config goals re-apply only when the config changed (`lastConfig`).
- **Skills in code, the model chooses** (user: "actually make it intelligent"): `obtainItem` sets `Brain.obtain`; `obtainStep` (in the loop after tasks, before the plan queue and the autopilot) runs `acquire.js` steps until it has the item, explores after 2 failures, stops after 3 searches / 80 steps / 25 min, goes back to a furnace that's still cooking (`o.smelt`). The autopilot then gets a stone sword and hunts and cooks when it has no food. Training a model from scratch isn't realistic; fine-tuning the 4B on recorded good decisions is (TRAINING.md, `logging.trainingData`).
- **"Moving and deciding in under a second"** (user): the model itself can't decide that fast on a 1660 Super. `Brain.prethink` starts the next decision while the current action runs (with a "what next after this" nudge); `usePrethought` uses it if chat, health and goal didn't change and the action worked. Measured with a 2 s mock: 0–1 s between actions. Plus `postActionDelayMs` 150, `minLlmIntervalMs` 1000, and code skills that need no model at all.
- **Game modes** (user: "smart on the different modes"): `ActionExecutor.availableTools` hides block actions in adventure (`ADVENTURE_BLOCKED`) and almost everything in spectator (`SPECTATOR_OK`); reflexes and the autopilot skip creative/spectator; creative `obtainItem` uses `bot.creative.setInventorySlot`; the pathfinder can't dig in adventure/spectator (refreshed on the `game` event); hints explain each mode and hardcore.
- **Coordinates need F3** (user): `Agent.coordsKnown()` = knowledge tier ≥ 1 or learned (`F3_FACT`, chat like "press f3"), never when the server sets reducedDebugInfo (login packet / entity status 22/23). Otherwise `promptState` makes every position relative (`dx/dy/dz`) and `ActionExecutor.execute` turns dx/dy/dz args into a block. The viewer always shows the real coordinates to the person.
- **Layout and building sense** (user asked whether it understands its surroundings, doors vs mining, reasonable builds):
  - `Perception.layout()` (state `layout`): outdoors / under a roof / underground, blocked sides, drop-offs, a door nearby, darkness.
  - Doors: the pathfinder opens them (`pathfinding.openDoors`).
  - Digging: it digs only when it's cheaper than walking around (`digCost` 4); `dontCreateFlow` keeps it from digging into water or lava; `noGrief` stops it digging through player-built blocks.
  - `planBuilding` picks wood instead of a stone keep unless it has 64+ stone or the concept asks for stone, and leaves the windows open until it has glass.
  - `dropItems` throws things away.
- **Ground items** (user asked): take or leave with a reason, never other players' things while they're around; gifts only when tossed toward the bot (thrower facing it, within 8 blocks).
- **Dying on purpose** (user asked for it): the `respawn` action, never on hardcore, 10-min cooldown, `reflexes.standDown` so it doesn't clutch out of its own choice; its death isn't mourned, recorded as a danger zone, or turned into a lesson.
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
- **Backup route:** `server.fallback` names a `servers` profile. `fallbackServer()` merges it over the main settings (clearing realm, password, version, platform; no chains). Triggers: online-mode kick, failed forced Microsoft sign-in, duplicate login. It never switches back by itself (that could kick the user).
- **Mods:** Mineflayer is a vanilla client. `serverMods()` reads Forge/NeoForge mod lists from the ping; mod-mismatch kicks stop reconnects.
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
- A failed Microsoft sign-in (prismarine-auth) emits `error` but **never `end`**: no connection was opened. `Agent.connect` ends it by hand, once.
- `bot.activateBlock()` first does `await bot.lookAt(center, false)`, which waits a physics tick unless we're already looking there: call `bot.lookAt(..., true)` right before it. `bot.activateItem()` (buckets, boats, pearls) sends the current rotation in `use_item` on 1.21.
- Water clutch timing: the landing block's top is in reach while the feet are ≤ ~2.8 above it; a 20-block fall moves 1.6 blocks/tick, so the window is ~1.7 ticks — fine for good players. Act a tick early (the click goes out with the next move).
- **bot.craft doesn't wait for the server.** It fills the grid, writes the result into slot 0 itself, takes it and marks the grid empty locally. When the server doesn't make the item, the ingredients stay in the real grid and the craft "succeeds". Seen on the user's Paper 26.1: 4+4 birch planks (4 stick crafts) and 3 logs (3 plank crafts) left in the 2x2 grid. Grid slots (1-4) don't count in `inventory.items()`, so the bot also lost track of those items. `craftVerified` (actions.js) checks the real count after the server's corrections, empties the grid (`returnGrid`: shift-click, else close the inventory) and falls back to `craftByHand` (recipes.js `tryLayout`, waiting for the server's result). The grid is also emptied 3 s after spawning. flying-squid can't test any crafting: it doesn't answer inventory clicks (1.16.5) or corrupts them (1.21.4); `test/craft.test.js` uses a fake vanilla-like inventory instead.
- **Seeing a block ≠ a ray to its centre.** `senses.canSee(bot, blockCentre)` always hit the block's own face first, so with realistic sight nothing beyond 3 blocks (except leaves/glass) counted as seen until the fix: use `canSeeBlock(bot, pos)` (face points, the block itself as the target). For entities, `visibleShare` samples five body points.
- **flying-squid crashes on tab_complete** (`SizeOf error … packet_tab_complete`): it then silently stops sending that client chat. Test configs set `network.discoverCommands: false`. It also never opens crafting-table windows on 1.21.4 either.
- **Never write a packet before login.** `client.registerChannel(name, parser, true)` writes `minecraft:register` immediately. Called at bot creation, it went out before the handshake, and real servers dropped the socket (`socketClosed`, no kick). flying-squid doesn't care, so tests passed. Register with `false` and `writeChannel` on `login` (svc.js). To check, capture the first bytes with a raw TCP server.
- On **Node 26**, "nothing listening on localhost" (tried on IPv6 and IPv4) is an `AggregateError` with an **empty message**. Always log errors through `errText()` (index.js, exported for the doctor).
- Bug found and fixed (Nov 17): `Brain.trackPlan` had a stray `this.autopilot = new Autopilot()` that reset the autopilot after almost every action (its fail memory and pause never worked).
- flying-squid didn't confirm a block placed mid-jump (pillarUp/bridge): placements are capped at 0.7 s and then checked, so it can't stall. Unverified on Paper.
- `test/recipes.test.js` random crafting trials fail very rarely (seen once in 6 runs); re-run before chasing it.
- `bot.setControlState(name, value)` **asserts a boolean**: `false || undefined` crashes it.
- `bot.look(..., false)` resolves on physics ticks, and **physics stops on death** until the server sends a position. Race it with a timeout.
- mineflayer-pathfinder only advances to the next node when the bot is within 0.35 blocks of it and less than 1 block above or below it. Mid-jump the bot flies over nodes and the pathfinder turns back for them. `motion.js` removes passed nodes from `path_update`'s `results.path`, which is the same array the pathfinder uses.
- Mineflayer runs physics **before** emitting `physicsTick`, so controls set in a `physicsTick` listener apply next tick. A listener added after the pathfinder's wins for that tick.
- flying-squid can't open crafting-table windows on 1.16.5 (`windowOpen did not fire`), and it rejects armor-slot clicks.
- Kokoro speed: the fp32 `kokoro-v1.0.onnx` ran about 3× faster than real time on the cloud box's 4 cores; the int8 model was **slower** than real time there (int8 ONNX ops are slow on some CPUs). Use fp32.
- Hugging Face is blocked from the cloud session (403), so Whisper models can't be downloaded to test there; GitHub release downloads work.
- flying-squid computes a placed block's facing from the player's **position**, not its rotation, and doesn't place wall torches or levers. Vanilla uses the rotation: repeaters face the way you look (their `facing` property points at the input), pistons face back at you, observers watch the way you look. Test oriented placement on Paper.
- Mineflayer's `bot.placeBlock` looks at the clicked face first, which sets the rotation the server uses for facing. For an exact facing, aim yourself and call `bot._genericPlace(ref, face, { forceLook: 'ignore' })`.
- The pathfinder calls `bot.look(yaw, 0)` every tick while walking. `look.js` recognises those calls (not forced, pitch 0, pathfinder moving) and must pass them through raw when the keyboard layer is off; otherwise every tick starts a new flick and the bot can't walk.

**Item and entity data**
- Potions on 1.20.5+ are the `potion_contents` component (`potionId` = vanilla registry order, listed in `combat.js`); older versions use NBT `Potion`.
- Shield blocking: `living_entity_flags` metadata bit 0x01 (hand active) + 0x02 (off-hand) + the shield held.
- Invisible: shared flags bit 0x20; sneaking: bit 0x02.
- Pets: `flags & 0x04` means tamed; `owneruuid` gives the owner.
- Custom names: decode with `prismarine-chat` `fromNotch`.

**Versions and data**
- `minecraft-data` lists 26.3 in its version list but has **no data** for it (dataPaths only to 26.1). Mineflayer refuses newer servers unless the version is pinned.

**Ollama**
- Hybrid Qwen3 models think out loud by default; send `think: false` (the client drops it if a model or Ollama version rejects it).
- **Thinking-only versions** (plain `qwen3:4b` in Ollama is one) ignore `think: false` and end with a lone `</think>`. In that case `stripThinking()` cuts the reasoning before the JSON is parsed, the client warns once, the doctor flags it, and setup tests every model for it and offers the `-instruct` version.
- **Ollama sorts schema keys alphabetically** (seen on the user's PC: output began `{"action":{"args":{},"name":...},"emotion"...`). With a schema the model wrote `args` before choosing `name`, so it was always `{}` and every action failed INVALID_ARGS, and it wrote the action before its `thought`. So **decisions use plain JSON mode** (`llm.decisionSchema: false`) with a filled-in example (`DECISION_EXAMPLE`) giving the order. The smaller schema calls (chat analysis, plan, fight check-in) still use schemas; their order matters less.
- Structured outputs: pass a JSON schema as `format` (Ollama ≥ 0.5). The client falls back to `format: "json"` if rejected.
- Decision prompts are ~3.4k tokens of fixed system text + 0.6–2.5k of state. `/api/chat` returns timing fields (the doctor uses them), and `/api/ps` gives `size_vram`.

**Other**
- **Offline-mode whitelists are case-sensitive by UUID:** the offline UUID is a hash of `OfflinePlayer:<exact name>`. On the user's Paper 26.1, `whitelist add TheBestWanderer` stored `thebestwanderer` (a different UUID), so the bot was still refused. Fix: `whitelist off`, or a `whitelist.json` entry with the exact-case UUID (TheBestWanderer = `6db913b6-f8a5-3118-949c-8ed39321b39c`). Editing `white-list=false` in server.properties only applies after a server restart.
- Floodgate names have a `.` (or `*`) prefix. Chat parsing and own-name matching handle that.
- Over ViaProxy the bot uses `auth: "offline"` to the proxy; ViaProxy's selected account authenticates upstream. Its default bind is `0.0.0.0:25568`.

## Testing

- **Unit tests:** `npm test` (social, tasks, senses + chests + chat formats + intelligence gates, login/backup routes/mods, reflexes, LLM lanes, goals); `npm run check` (syntax).
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
  - the backup route: a fake online-mode server refuses the offline bot → it switches to the backup profile and spawns;
  - fall reflexes: teleported 25 up, Mediocre places a slime block on the landing spot (Beginner doesn't); startle looks (Beginner ~70° off, Advanced/Impossible on target in 0.2 s), weapon out on a serious hit;
  - interrupting the LLM: with a 5 s decision pending, a hit starts the escape immediately and the late answer is dropped;
  - the LLM lanes (unit test with a stub server): a reply returns in ~100 ms while a 600 ms decision runs; OpenAI-format requests; mixed providers;
  - goals live (mock): the planner made an overall goal, kept the config's long-term goal and added steps; decisions advanced steps;
  - the fight check-in live: in a fight with the Tester, after "sorry" the next check-in stopped the fight and it said "fine. truce";
  - the doctor.
- **Not verified yet:**
  - real Qwen output (all runs used the mock);
  - a full build, the mace combo and potion/totem use in a real fight;
  - shield-blocking detection;
  - Realms, login plugins and Microsoft sign-in (including `auto` dropping to offline after a failed sign-in);
  - FastLogin on a real server;
  - the ViaProxy + Geyser + Floodgate Bedrock route;
  - fall saves on a real server (flying-squid has no fall damage and no buckets/boats/pearls): water bucket, boat, pearl, elytra, ladder, mace, mount, wall pearl, edge clutch; lava/drowning escapes;
  - real speeds of qwen3:4b-instruct + qwen3:1.7b on the 1660 Super, and hosted APIs;
  - the `respawn` action on a real server (lava/drop finding, /kill);
  - how well a real small model keeps to the goal tree (detours vs new_goal).
  - real decision times with the compact prompt. Measured with the old ~3.4k-token prompt: reads 209 tokens/s, writes 53 tokens/s, 100% GPU, ≈14.8 s estimated per decision. The compact prompt (`llm.compactPrompt`, ~1.5k tokens) and the doctor's real cold/warm/after-chat timings were built for this; the user hasn't run them yet.

## Environment notes (for Claude cloud sessions)

- **Downloads:** Mojang and Paper downloads are blocked; npm and raw.githubusercontent.com work (that's how ViaProxy/ViaBedrock docs were checked; api.github.com was 403).
- **Test server:** install flying-squid outside the repo or with `npm install --no-save flying-squid@1.12.0`. Start test players **after** the bot.
- **The user's machine is Windows** (Command Prompt). Give `cmd` commands; `npm` scripts must not use Unix-only syntax (e.g. `VAR=1 node …` — use a flag like `--debug` instead).
- **Setup tooling for the user:**
  - `npm run setup` applies the Ollama `setx` settings (asks first, explains each, reads current values from `HKCU\Environment`), downloads a missing model (asks first), and tests that the model answers without thinking; it also strips `[brackets]`/quotes from answers, matches levels loosely, and turns a free-text personality into `{ base, setupDescription, traits, description, likes }` plus mind settings;
  - the doctor warns that its timing step takes a while (the user once Ctrl+C'd it);
  - the npm warnings (uuid deprecated, moderate vulnerabilities) are harmless — tell users not to run `npm audit fix --force`.
- **Processes:** don't kill all `node` processes (the sandbox refuses it); run test processes under `timeout` instead.

## Ideas not done yet

- A browser viewer of what the bot sees (prismarine-viewer; it would render on the viewer's device).
- **Done in HISTORY.md §16:** long-term memories (`memory.js`), saved chat history, per-bot profiles (`--profile`), real parkour (`parkour.js`), skill-based aggression, plan queue and goal commitment. Still open: a deterministic "enough logs" guard if the model ignores the hints, live testing on a real server, web lookups for real-world chat knowledge (needs a hosted model).
- Testing against a real Paper server with Geyser/Floodgate/ViaVersion and real Qwen, then tuning prompts from real transcripts.
- Smarter building materials (crafting planks from logs on its own when a build runs short).
