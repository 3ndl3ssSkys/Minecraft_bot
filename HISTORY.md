# Project history — the conversation so far

Everything EndlessSkys asked for while building this bot, in order, with what was done and decided each time. It's written so a new session (human or AI) can pick up exactly where this one stopped.

- **Design rules and gotchas:** [CLAUDE.md](CLAUDE.md), which is auto-loaded by Claude Code.
- **Setup and settings:** [START-HERE.md](START-HERE.md), [SETUP.md](SETUP.md) and [CONFIGURING.md](CONFIGURING.md).

The user is **EndlessSkys** (or Endless). Never use their real first name, even though it appears in the Windows paths they paste.

---

## 1. The original build

**Asked for:** `index.js`, `actions.js` and `package.json` for a Mineflayer + mineflayer-pathfinder bot driven by a local Ollama (Qwen 2.5), including:
- environment parsing into JSON every ~2 s;
- a tool API (move, mine, place, chat, equip, attack);
- a throttled reasoning loop that outputs a thought, an emotion and a tool;
- robust error handling;
- personalization, chat modes (respond only / unprompted / both) and reactions to game events.

**Done:** the perception → LLM (JSON schema) → one action → memory loop, a priority LLM queue, a chat manager with rate limits, personality presets, configurable event reactions, and owner `!commands`.

## 2. Minecraft 26.3, complex mechanics, learning, trust

**Asked for:**
- Minecraft 26.3 support;
- complex mechanics, plus learning PvP, movement and how to read players;
- changeable command settings (emotion, response, chance to follow instructions), controlled by owners or admins;
- a realistic player.

**Trust:**
- it starts high;
- it drops for kills, malicious hits (repeated weapon hits, hitting it while low), harming pets or players nearby, and broken promises;
- emotions change dynamically;
- refusals must sound like a person, not a bot.

**Done:**
- Versions: Mineflayer tops out at 26.1, so against a 26.3 server it connects as 26.1 (`viaFallback`), which needs ViaBackwards or ViaProxy.
- Learning: a combat-style bandit, danger zones and LLM-written lessons.
- Trust: incidents in `social.js`.
- Settings: in-game `!set` and `!emotion`.
- Voice: the `HUMAN_VOICE` rule, refusal styles and a robot-speak regex guard.

## 3. Compliance depends on the task

**Asked for:** resource favours depend on how much it *likes* the player, not how kind they've been. Kill requests: does it want to, and does it clash with a friend or an earlier commitment? It can forget tasks, or only partly do them. Compliance isn't really an admin thing.

**Done:**
- `tasks.js`: appraisal by task kind, tasks with a patience budget, partial hand-over, forgetting and recall.
- Trust (safety) and affinity (liking) are kept separate.

## 4. Obedience for everyone; advanced PvP; knowledge; building; pacing

**Asked for:**
- **Obedience:** keep the admin obedience controls, but everyone gets an obedience level.
- **PvP:** mace + wind charge (also slimes and other entities), bow combined with other weapons, axe + sword combos, potions and golden apples used tactically.
- **Knowledge:** good knowledge of items.
- **Building:** unique buildings that fit the terrain.
- **Pacing:** useful busy work while the LLM thinks (chests, gathering, parkour); a short pause while typing; only 1–3 words when it's in danger.

**Done:**
- Obedience: `chance = own + (1 − own) × obedience`.
- `combat.js`: ballistics, mace, potions, totems, pearls, cobwebs and per-mob tactics.
- `knowledge.js`: tiered facts and game-data lookups.
- `building.js`: terrain-aware designs.
- Pacing: busy work, stop-to-type, danger-shortened chat.

## 5. Intelligence levels, senses, chests, signs, Bedrock, friends' servers

**Asked for:**
- **Eight levels:** Beginning (learns along the way) … Impossible (niche mechanics), plus a configurable mind.
- **Senses:** sounds and particles in near line of sight, so invisibility works (but not right in front of it); suspicion that known nearby players damp, and investigations.
- **Mace:** only Hardcore, Master and Impossible; *good* mace only Master and Impossible.
- **Skill curve:** concave — each level is better, with diminishing gains.
- **Chests:** tell looted, someone's, community and unlooted chests apart.
- **Signs:** read them.
- **Accounts:** Bedrock accounts, because the user's Java account is their own.
- **Friends' servers:** join without the friends setting anything up.

**Done:**
- `intelligence.js` (`skillAt`), `senses.js`, `containers.js`.
- The Bedrock route through ViaProxy needs Geyser + Floodgate on the server.

## 6. ViaProxy with Bedrock; name tags

**Asked for:** how to set up ViaProxy with a Bedrock account, and name tags recognised and used.

**Done:**
- Setup steps for ViaProxy.
- Name tags follow vanilla rules: they show through walls unless the player sneaks.

## 7. Geyser without Floodgate; the server PC; hardware

**Asked for:** Geyser without Floodgate; how to set everything up on the server PC; whether a GTX 1660 Super with 32 GB of RAM can handle it.

**Done:**
- Geyser without Floodgate can't work with a Bedrock-only account: that's server authentication, and we don't bypass it.
- The hardware notes were written then.
- Later clarification: nobody plays Minecraft on that PC, and the bot is headless, so it needs no GPU.

## 8. Knowledge in the repo; start-to-finish setup

**Asked for:** keep all the knowledge in the repo, and write setup instructions from start to finish.

**Done:** `CLAUDE.md`, `SETUP.md`, a test suite and live-test tools.

## 9. The host offers a plugin, as long as no saves are touched

**Done:**
- Geyser + Floodgate gives Bedrock players their own UUIDs.
- **Never** plain `online-mode=false`: it changes everyone's UUIDs.

## 10. Java first, Bedrock as a backup; no account needed

**Asked for:** Java, because it allows more (mods, a more skilled bot), with Bedrock kept as a backup. Then: the Java route must not require an account; it should use an offline account unless a real Microsoft login is configured.

**Done:**
- Login: `server.auth: "auto"` (offline unless `username` is an email; it drops to offline if sign-in fails).
- Backup: `server.fallback` switches to a backup profile. It never switches back by itself, because that could kick the user.
- Mods: modded-server detection. Mineflayer is a vanilla client.
- For the host: SETUP 6D (FastLogin, keeping premium UUIDs).

## 11. Fast reactions, and which AI

**Asked for:**
- **Reacting fast:** quick, realistic reactions to danger: falls, attacks, lava, drowning, traps.
- **Fall saves by level:**
  - Beginner learns them and can end up past Master;
  - Advanced knows them but sometimes fails;
  - Master knows the complex ones (boat, vine/ladder, mace on an entity, riding);
  - Impossible does insane saves (crouch-clutch, pearl into a wall).
- **Getting hit:** a punch makes it startle and look around (finding the attacker faster at higher levels); a vicious attack makes it draw a weapon and fight back, and it can be talked down.
- **No 2–4 s waits** for these.
- **Models:** which AI is best, local first (6 GB) with options for better cards and hosted ones.

**Done:**
- `reflexes.js`: every physics tick, no LLM, with human reaction delays.
- The LLM wait can be interrupted.
- A fast chat lane (`fastModel`) and OpenAI-compatible providers.
- A model guide in the README.

## 12. Chat linked to actions; stopping fights; dying on purpose; goals; how to configure

**Asked for:**
- **Chat and reactions:** are they still linked?
- **Stopping and dying:** can it still decide to stop attacking, and choose to kill itself?
- **Goals:** a goal hierarchy (overarching → encompassing → goals → subgoals), set or made up as it goes.
- **Docs:** how to set goals, emotions and the rest.

**Done:**
- Chat replies see the last 90 s of events.
- Mid-fight rethinking (`pvp.rethinkSeconds`).
- A `respawn` action (never on hardcore; reflexes stand down).
- `goals.js`.
- `CONFIGURING.md`.

The user also asked about a claim from Google that Qwen 1.7B gives sub-300 ms responses. **The answer given:** reactions are code, so model speed doesn't matter for them. Prompt reading dominates, so sub-300 ms isn't realistic for decisions. 1.7B is fine for chat but weak for decisions; use 4B for decisions plus 1.7B for chat.

## 13. First real setup on the user's PC (Windows)

**The user's experience:**
- They had installed Ollama, Node.js (26) and Git, and pulled `qwen2.5:7b`.
- `npm install` failed because they ran it in their user folder before cloning.
- They found the instructions unclear.

**Done:**
- `START-HERE.md`: one Windows path with exact commands and what to expect at each step.
- `npm run setup`: a questionnaire that writes **`config.local.json`**. That's the user's own settings file, gitignored and merged over `config.json`.
- A `--debug` flag, because the old `VAR=1` npm script syntax fails on Windows.

**What the user's first runs showed, and the fixes:**

| Seen | Meaning | Fixed |
| --- | --- | --- |
| `qwen2.5:7b` at `18%/82% CPU/GPU` | The 7B model doesn't fully fit on the 6 GB card (Windows uses some VRAM for the screen). | Recommend a 4B model. |
| A blank `Connection error:` | Node 26 reports "nothing listening" as an `AggregateError` with an empty message. | `errText()`, plus a "start the server first" hint. |
| Setup ignored a described personality and `[complicated]` | The wizard only took exact preset names. | Brackets stripped, levels matched loosely, custom personalities from a description (`base` key). |
| The doctor seemed to hang, and was Ctrl+C'd | The timing step is slow on this card. | It now says to wait. |
| Plain `qwen3:4b` reasoned for pages, even with `--think=false`, and ended with `</think>` | A thinking-only version. | Use **`qwen3:4b-instruct`**. Setup tests for this, the doctor warns, and the bot strips the reasoning. |
| The user had to type `setx` by hand | The Ollama settings weren't in setup. | Setup explains and applies them (asks first); SETUP.md step 4 has the manual commands with explanations. |
| `qwen3:4b-instruct` answered "Hello! Nice to meet you! 😊" | Small models add emojis anyway. | **No emojis, ever** (user request): stripped from all outgoing chat. |
| `ollama ps` showed "4 minutes from now" after the `setx` | The settings weren't active yet: Ollama hadn't fully restarted. | The docs say how to check (`UNTIL` ≈ 24 h). |
| Doctor: reads **209 tokens/s**, writes 53 tokens/s, 100% GPU (3.6 GB, 8k context); estimate ≈ 14.8 s per decision | The GTX 1660 Super is slow at *reading* prompts, and the fixed decision prompt was ~3,400 tokens. | A **compact decision prompt** (`llm.compactPrompt`, auto for models up to 8B): ~1,540 tokens with the same rules and all tools. The doctor now times real decisions (cold, warm, after a chat reply) instead of estimating, and suggests a separate chat model if chat replies push the decision prompt out of Ollama's cache. |

**The user's answers in setup:**
- owner `EndlessSkys`;
- bot `TheBestWanderer`;
- server `localhost:25565`;
- level `complicated`;
- personality "friendly, slightly cautious, fun PvE, enjoys exploring";
- model `qwen3:4b-instruct`.

**Verdict given:** `qwen3:4b-instruct` alone is enough on that card. Optionally add `qwen3:1.7b` as the chat model later.

## 14. Next request (not built yet): long-term memory and separate bot saves

**Asked for** (the last request, saved for the next session because credits ran low):
- It should pull from chat history for context when there is any.
- It should save **valuable long-term memories** and keep other memories as well, even while learning is switched off.
- It keeps learning unless its save is reset or a different bot save is chosen. **Multiple separate AI players**, each with its own memories.

**Suggested design** (start here):
1. **Bot profiles** — `bot.profile` in config, or `--profile <name>` on the command line:
   - each profile's state lives in `data/profiles/<name>/brain.json`;
   - `npm run setup` asks which profile to use, or makes a new one;
   - reset = delete or rename that folder (`!forget all` could do it for owners).
   - Today there's one file, `learning.file: data/brain.json`. `loadConfig` can rewrite it from the profile. `Learning`/`Store` in `learning.js` already save everything there.
2. **Long-term memory store** (`memory.js`, saved under `memories` in brain.json):
   - entries `{ text, kind: event|person|place|fact|feeling, importance 1-10, people, at, lastRecalled }`;
   - write them from important memory events (deaths, gifts, truces, finished goals, promises, being taught), plus a low-priority LLM "what's worth remembering from the last few minutes?" call (like `learning.reflect`);
   - keep the most important and most recent, with decay;
   - **recall:** pick a few by keyword overlap with the current situation (who's nearby, the goal, what was said) and put them into the decision and chat prompts, like `knowledge.relevantFacts`;
   - keep it short, because the 1660 Super reads prompts slowly.
3. **Chat history:** keep a longer chat log per player (last ~50 lines, saved). Give the reply prompt that player's last few lines from earlier sessions as "earlier with <player>". Today `Memory.chat` holds only the last 30 lines of this session and isn't saved.
4. **"Keep memories even if learning is off":** `intelligence.learn: false` should stop *skill growth only*. Memories, relationships and chat history are always kept, unless `memory.enabled: false`.
5. Add tests and update CONFIGURING.md (a "Memory and bot saves" section), CLAUDE.md and this file.

## 15. First real play session

- **On the server:** the bot joined the user's Paper 26.1 test server (after the whitelist was sorted out: the offline UUID depends on the exact capitals in the name), planned goals and greeted.
- **Every action failed:** Ollama sorts JSON-schema keys alphabetically, so the model filled `action.args` before choosing `action.name` (always `{}`). Fixed: decisions now use plain JSON mode with a filled-in example.
- **It didn't reply to the user:** they didn't say its name. Now it also replies when nobody else is online, or when the speaker is close by.
- **Duplicate chat lines:** each line arrived twice on 26.1; now deduped.
- **Next:** the user runs it again (`git pull`, `npm start`) and pastes the log. Check that actions now have real arguments, then tune from what it does.

## 16. Review pass: log bias, circling, suggestions, chat, real parkour, speed, memory (done; needs live testing)

**Asked for (by the user):** the bot only mined logs, ran in circles ("parkour" was hopping in circles, not real gap jumps), turned suggestions into tasks/agree/reject at random, chatted badly ("gg"). Then: real parkour with a skill ladder per intelligence level (learning by repetition and by failing harder jumps), faster and smarter qwen3:4b (chat and decisions fighting over one model, changing its mind, poor retention), more aggression at higher skill with better gear, and finish section 14 (long-term memory, bot saves).

**Done (first patch, already delivered to the user, tests pass):**
- `index.js` DECISION_EXAMPLES (4 neutral examples, chosen by bot name) replace the single "oak_log" example; `Perception.hints` says when it has enough logs and what comes next; busy-work parkour rare and never twice in a row.
- `actions.js` explore keeps a heading and avoids its own trail (`pickExploreAngle`, `noteExplored`); old random hop action replaced by a short straight line (superseded below).
- `tasks.js` `alignment()` + `ChatResponder.answerAligned`: a request that matches the active task or current goal gets "already on it", no new task, no dice roll. Analysis prompt: suggestions are not requests.
- Chat: "gg" removed from friendly preset and wonFight templates, reaction/small-talk prompts see recent chat, stock phrases discouraged.

**Plan for this pass (tick when done):**
1. [x] `parkour.js`: tier table per level (beginning: basic 1-gap walk jumps; simple: better + a 2-block jump onto a block one higher; mediocre: 2-3 block jumps, sprint jumps (~90%), 2 (sometimes 3) onto a higher block; complicated: 4 block, up to 3 onto a higher block, ceiling ("head-hitter") hopping learned by spamming, timed sprint jumps; advanced: sometimes 5 block, odd-height blocks; hardcore: reliable, diagonals; master: every standard jump; impossible: angle-perfect boosts, speed potions). New intelligence domain `parkour`. Pathfinder `getMoveParkourForward` wrapped to filter by skill and add risk cost. Real jump executor (run-up, edge-timed jump, air steering) used by the `parkour` action and by busy work only when a real gap exists. Jump outcomes give XP (more for failing at harder jumps).
2. [x] Physics test: run the executor on prismarine-physics with a synthetic world (no server needed).
3. [x] Aggression: confidence from gear + skill vs opponent in `fightOrFlight` and in `attackTarget` (lower retreat health, switch to aggressive/comboAxe).
4. [x] Goal stickiness (`goals.onDecision`: no change of mind within ~2 min unless blocked), plan queue (`next` actions), lean decision output (no emotion/taskUpdate tokens in compact mode), preempt a decision for urgent chat when there is no fastModel, previous-thought line.
5. [x] Section 14: `memory.js` long-term memories, profiles (`--profile`, `data/profiles/<n>/brain.json`), persistent chat history, `intelligence.learn:false` stops only skill growth.
6. [x] Docs: CONFIGURING.md (fastModel, Ollama env), CLAUDE.md, this file; tests; cumulative patch `minecraft_bot_improvements.patch`.

**Built so far (this pass):** `parkour.js` (tiers, `findJumps`, `runJump`, `ParkourSkill`: pathfinder wrapper, jump learning, ceiling hopping, `practice`), `test/tools/simbot.js` (fake bot on the real prismarine-physics engine, no server), `test/parkour.test.js`, `test/aggression.test.js`, `test/plan.test.js`. Real-physics findings that shaped the tier table: flat sprint jump max is a 4-block jump, 5 needs a 1-block drop, a walking jump reaches 3, 4-block+1-up works with a full run-up, sprint-jumping a 1-gap hop up a block fails (walk it). `combat.js` got `gearPower/ownPower/opponentPower/boldness`; `fightOrFlight` and `attackTarget` use them (skilled + better gear = lower retreat health, aggressive/comboAxe styles). `goals.js` keeps a fresh goal for 2 min (`COMMIT_MS`). Brain has a follow-up plan (`next` field, `trackPlan/nextPlanned`), compact prompt has lean output (no emotion/taskUpdate), previous thought is fed back, `OllamaClient` cancels a running decision for an urgent chat reply when there is no fast model (`llm.preemptForChat`).

**Section 14 done:** `memory.js` (`LongTermMemory`: `remember` merges near-duplicates, `recall` by keyword/importance/recency, `noteChat/earlierWith`, `consolidate` = a low-priority LLM pass every 8 min), saved in brain.json under `memories`; `Memory.addEvent/addChat` feed it; recalled memories and earlier chats appear in the decision and chat prompts. Profiles: `node index.js --profile alex`, `BOT_PROFILE`, or `profile` in config → `data/profiles/<name>/brain.json`. `memory.enabled:false` keeps nothing; `intelligence.learn:false` only stops skill growth. Test: `test/memory.test.js`.

**Vertical jumps (clarified by the user):** standing on a block and jumping forward to a block ONE higher; the tier field `upD` is the longest such forward jump (simple 2, mediocre 2 (sometimes 3), complicated 3, advanced sometimes 4, hardcore 4). Not pillar/tower climbing; the pathfinder's tower setting is left as the config says.

**Round 2 (from the user's first live log, qwen2.5:7b, no fastModel):** (1) `craftItem` could not turn logs into planks and picked an arbitrary recipe (cherry planks) → now `craftIntermediates` makes planks/sticks from any wood (keeps the plank type it holds), places a carried table or makes one (`placeNearby`), and `describeMissing` names what is really missing. (2) `mineBlock "wood"` matched nothing (no block is called wood) → `LOG_WORDS` aliases = any log, and an `oak_log` request falls back to any log. (3) Mining stone by hand to leave a base: pathfinder `canOpenDoors` was off and digging was cheap → `pathfinding.openDoors: true`, `digCost: 4`. (4) Slow/basic decisions → `basics.js` Autopilot does the early ladder by rules (logs → wooden pickaxe → cobblestone → stone pickaxe; `behavior.autopilot`), explores elsewhere after a failed search, hands back to the model after 5 failures. The model itself was the 7B with a full prompt and no fast model: see README for the config.local.json that fixes speed. Test: `test/basics.test.js` (real recipe data). Known and not fixed: tasks that say "oak logs" count only oak in inventory; the bot sometimes defers an owner's easy request "not in the mood"; promise tracking blames the player for the bot's own promises.

**Round 3 (user request): recipe knowledge by level, and exact "get X".** `recipes.js` (`RecipeBook`): policy from the `knowledge` level (beginning knows nothing, simple: planks/sticks/table, mediocre: + wooden/stone tools, furnace, torch, chest, doors..., complicated and up: everything); learned recipes are saved (`brain.json` → `recipes`). Beginners discover recipes with the new `experimentCrafting` action (puts items into the 2x2 inventory grid or the 3x3 table grid through window clicks and reads the result slot; guesses get smarter with level: `insight`), or `askForHelp` (asks in chat; a player's answer is read by `ChatResponder.recipeAnswer`, checked against real item names and then TRIED in the grid). `craftItem` and `craftIntermediates` refuse recipes it doesn't know (`UNKNOWN_RECIPE`); the autopilot and the task planner turn that into ask/experiment (`Brain.helpStep`). `acquire.js` (`nextAcquireStep`): tasks "get X" are planned deterministically to the EXACT item (block that drops it, pickaxe first if needed, known recipes only); `mineBlock` never substitutes another wood while a task is active or `exact:true`. Test: `test/recipes.test.js` (simulated window on real recipe data). NOT verified on a live server: the window-click sequence of `tryLayout` (mirrors mineflayer's own craft clicks) and whether Paper sends the result slot quickly enough (`wait` 220 ms).

**Round 4 (user's logs):** (1) Tasks were "forgotten too long ago" after restarting: age was wall-clock; now `t.age` counts play minutes (forget after 180). Capacity `maxQueuedTasks` 4 → 12; `next()` ranks by salience, liking, urgent kinds, quick wins, waiting time. (2) Tasks that never finished: progress now also counts what was mined/crafted for the task (`t.made`), so a crafted-then-placed table counts; "craft/make X" is a craft task whatever kind the model said (`itemInText`); self-made placeables (table, furnace, chest...) finish without delivery. (3) Goal backlog in `goals.js` (`enqueue/pickNext/rebalance/score`, cap 12, saved): replaced goals are kept, the model can add `queue: [{goal, priority}]`, urgent survival goals and trusted askers' goals score higher, finishing a goal starts the best waiting one. (4) Promise misreads ("you need to place a table" blamed on the player): a promise now needs first-person wording in the player's own message. (5) Searching: `mineBlock` never searches under 16 blocks, widens to 64 once before NOT_FOUND, "cobblestone" also finds stone (`withDropSources`), exact mining only when a gather task asks for that very item (any task used to make it exact, which blocked crafting with other wood); skips mining when 16+ are already carried. (6) `describeMissing` says "planks (any wood)" (it said cherry_planks because of a tie) and lists what is carried. (7) Prompts: "thought under 20 words" (a 300-token cap truncated JSON), carried-items reminder every turn. (8) `askForHelp` chance: 0.3 base, +0.3 if a player with trust ≥70 is around, +0.35 when just starting. Open: "can't build anymore" (needs a log of the failing `build`), search for things not yet seen is still limited by chunk loading, and a task description like "give_item give_item" from a bad model parse.

**Ideas left:** deterministic block on mining more logs when hints say enough; more parkour moves (neo, wall jumps), hosted chat model for real-world knowledge.

**How to continue:** `git diff` shows everything uncommitted; `npm run check && npm test` must pass; smoke scripts used so far were throwaway (in /tmp), real tests belong in `test/`.

## 17. "Actually make it intelligent"; could we train a model?; items on the ground

**Asked for:**
- **Smarter:** make it actually intelligent.
- **Training:** could we train a Minecraft model that plays like a player, extremely fast?
- **Ground items:** it should recognise items on the ground and pick them up or leave them, depending on the item and the situation.

**Found:** another session (commits `bb8c319`, `34d01fc`, `88f93fe`) had added:
- parkour, long-term memory and bot profiles, aggression;
- an autopilot for the early game, recipe knowledge by level, and exact "get X" planning for tasks.

It also had a stray line that reset the autopilot after nearly every action. That's fixed.

**Done (commit `1cca776`):**
- **The planner learned smelting and hunting** (`acquire.js`): it plans iron ingots from an empty inventory (wood → wooden pickaxe → stone → stone pickaxe → iron ore → furnace → fuel → smelt), and cooked meat (hunt → collect → cook).
- **A new `obtainItem` skill:** one model decision ("get an iron pickaxe", "get food"), then the Brain runs every step without asking the model again, at full speed. Prompts and examples steer the model to use it.
- **The autopilot goes further:** after the stone pickaxe it gets a stone sword, and hunts and cooks when it has no food.
- **Smelting** places a carried furnace if none is nearby.
- **`pickup.js`:** take or leave ground items with a reason. The verdicts appear in `nearbyEntities`, `collectDrops` follows them, and busy work only goes for things worth taking.
- **`TRAINING.md`:**
  - training from scratch isn't realistic (VPT-scale);
  - a LoRA fine-tune of the 4B on recorded good decisions is;
  - `logging.trainingData` records the data.
- **Tests:** smelting and hunting plans (`test/recipes.test.js`), `test/pickup.test.js`.
- **Live (flying-squid + mock):** one `obtainItem` decision became a chain of planned steps with explore-and-retry. The test world has no trees, so it couldn't succeed there.

**Not verified yet:**
- the full `obtainItem` chain on a real server: crafting, furnace placement, smelting, hunting;
- gift-direction detection with real players.

**Ideas for the next skills:**
- night shelter;
- a bed from sheep;
- armor upgrades;
- torch-lit diamond mining at the right depth;
- farming.

## 18. Dropping items, surroundings, doors vs mining, reasonable builds, niche strategies

**Asked:** can it drop items, build reasonable constructions, understand the layout of its surroundings, use doors or mine out (and know what to mine out), and use niche strategies?

**State before:**
- **Dropping:** only `giveItem` (walks to a player and tosses).
- **Surroundings:** just the top 10 block counts.
- **Doors and digging:** the pathfinder already opened doors, avoided digging into liquids, and never broke player-built blocks (`noGrief`).
- **Building:** could plan a stone keep with glass windows on day one.
- **Niche strategies:** in code — clutches, lava, drowning, combat tactics per mob, parkour, truces, mace and pearls.

**Done:**
- `dropItems` (junk filter, valuables only by exact name).
- Making room: when full and something worth having is on the ground, it throws out junk first.
- `Perception.layout()`.
- Building picks practical materials and leaves the windows open until it has glass.

**Live:** `layout: outdoors` on flat ground; `dropItems junk` dropped the dirt and kept the diamonds. flying-squid refuses some tosses, so the rotten flesh stayed.

**Not done yet (situational strategies worth adding as code skills):**
- shelter for the night (dig in, or block yourself in);
- pillaring up away from mobs;
- lighting caves;
- bridging gaps;
- strip mining at the right depth for diamonds;
- getting out of a pit or hole on purpose;
- a bed from sheep.

## 19. All the situational skills, and "under a second"

**Asked:**
- **Skills:** build all the missing situational skills.
- **Speed:** the bot should move and decide in under a second.

**Done:**
- **`skills.js`:** `shelter` (bed, or dig in / cover / wait / climb out), `pillarUp`, `climbOut` (pillar or staircase), `bridge`, `stripMine` (version-aware ore depths, lava/water checks, ores it uncovers, torches, keeps its heading), `placeTorch`.
- **Beds:** `obtainItem bed` makes a bed from sheep, shearing them when it has shears. `sleepInBed` places a carried bed.
- **Automatic use:**
  - **night routine:** bed or shelter, unless skilled and armed;
  - **pillar escape:** when surrounded by zombies and hurt;
  - **torches:** in dark tunnels;
  - **climbing out:** when stuck and walled in.
- **Speed:** the next decision is thought up during the current action (`prethink`); shorter pauses between actions.

**Live (flying-squid):**
- **Shelter:** dug in, covered, saw it was daytime, opened up and climbed out.
- **Pre-thinking:** with a 2 s mock model, 0–1 s gaps between actions.
- **Pillar:** flying-squid never confirmed jump-placed blocks; capped and checked now, unverified on Paper.

**Not verified yet:** `pillarUp`, `bridge`, `stripMine` and night sleeping on a real server.

## 20. Viewer, F3 coordinates, game modes

**Asked:**
- **Viewer:** an optional view of what the bot sees, where you can also chat and give it commands, watch it play, see its inventory and see its coordinates.
- **F3:** it should only see its own coordinates if it knows the F3 key.
- **Game modes:** it should be smart in the different game modes, and move and interact like a real player.

**Done:**
- **The viewer:** `viewer.js` and `web/panel.html` (prismarine-viewer, optional dependency), with 26.x worlds translated to 1.21.4.
- **Coordinates:** F3-gated, with relative positions (`dx/dy/dz`) when it doesn't know them.
- **Game modes:** creative, adventure, spectator and hardcore are handled.

**Tests:** `test/viewer.test.js` checks the translation, including block properties.

**Live (flying-squid 1.21.4 + Chromium):**
- the panel loaded and the first-person view rendered;
- the HUD showed coordinates;
- the status and inventory updated live;
- `!status` sent from the panel came back in the feed.

**Not verified yet:**
- the viewer against the user's real 26.1 server (the translation is tested only in the unit test);
- creative and adventure play on a real server.

## 21. A better viewer page: game-like HUD and inventory, controls, pointing

**The user asked:** the field of view was too high and the page needed scrolling and was too small; the inventory should look like Minecraft's with icons; turning shouldn't be jittery; the chat shouldn't show everything but expand and scroll; from the page they want to see and change its emotion, its tasks and overall goal (add, change, delete), and to highlight or circle things on the screen to point them out to the bot ("or we could have an image detection model do that").

**Done:**
- **Layout:** the page is exactly one screen; each part scrolls inside itself; the side panel can be hidden. On narrow screens it stacks.
- **View:** `web/view-addon.js` loads before prismarine-viewer's own script (our own `/view/` index). It catches `window.THREE` as it's set, patches `PerspectiveCamera.updateProjectionMatrix` (FOV 70, configurable `viewer.fov` and a slider) and takes over `camera.rotation.set` so the camera eases toward each new yaw/pitch every frame. `__botView.snapshot()` gives the camera as drawn, for pointing.
- **HUD:** hearts, food, XP and hotbar from Minecraft's own sprites (prismarine-viewer ships 1.21.4 textures); F3-style text top-left.
- **Inventory:** Minecraft's `inventory.png` with slots at the real positions. `iconResolver` in viewer.js picks `items/<name>.png`, or builds a little 3D block from the block model's faces (up/north/east; parent chain, `#refs`, full-size elements like grass_block, slabs at half height, grass/leaf tints); the page draws it on a canvas. Items newer than the textures (or special-rendered ones: beds, shields) show their name.
- **Chat:** a few fading lines like the game (chat only); T opens the full history with a filter.
- **Feelings / goals / tasks:** `POST /control` (viewer.js `handleControl`) acts as the first owner: set or lock a feeling, set the overall goal, add/edit/finish/drop long-term goals, set/finish/drop the current goal, edit steps, queue/unqueue goals, replan, cancel a task (`TaskManager.cancel`, new), or ask for something (goes through the normal request judgment).
- **Pointing:** `pointing.js` casts rays from the camera through the click (or a grid inside the drawn outline) into the bot's own world (`bot.world.raycast`), and projects creatures onto the screen to see which are inside the circle. No image model is needed: the world data already says what every pixel shows, and a vision model would compete for the 6 GB card. `Agent.onPointedAt` keeps it in `state.pointedOut` for 3 minutes, adds a memory event, and a note arrives as the owner's words with "(pointing at …)". The view outlines what was meant for 20 s (prismarine-viewer `boxgrid` primitives). Coordinates only if it knows F3; otherwise "4 west, 3 north".
- **Turning in game:** `look.js` wraps `bot.look`: big non-forced turns take a few ticks (25–70°/tick by parkour skill, easing in). Instant while the pathfinder is moving, in reflexes, attacks and parkour, and for `force` looks. `behavior.smoothTurning`.

**Verified:** unit tests (`test/pointing.test.js`: camera math against Mineflayer's yaw/pitch, click on a block, click on a cow in front of a wall, circle a wall; icons; smooth turning). Live on flying-squid 1.21.4 with Chromium: page fits 1366×768 with no scrolling, the camera reports FOV 70, the inventory and hotbar render with icons, setting "angry" from the page changed its feelings, goals set from the page showed up in its goal tree, pointing and circling reached the bot.

**Not verified yet:** smooth turning against a real server (others watching it turn); the view addon on other browsers than Chromium.

## 22. "It keeps crafting crafting tables": common sense, picking things back up, all-round player behaviour

**The user said:** in the bot's output it kept trying to craft a crafting table while it had 3. It should pick up useful blocks it placed if it isn't coming back. "Please make sure it's smart… think about everything a hyper-realistic Minecraft player bot could ever need… act, play and move like a Minecraft player", by level.

**Likely cause of the table loop:**
- `craftItem` for a pickaxe places the carried table. If that placement isn't confirmed (a real server: lag, protection, a bad spot), it threw "placed a crafting table but cannot find it".
- The model read "crafting table" in the error and crafted another one.
- One of the decision examples was also literally "craft a crafting table", and small models copy examples.

**Done:**
- **The table loop itself:**
  - `placeNearby` now waits for the block update and tries up to 3 spots.
  - Its error says "You still carry N: don't make another".
  - The crafting-table example was replaced with a torches one.
- **`commonsense.js`:** a check before every non-reflex, non-owner-command action. It stops: "one is enough" items, tool downgrades and duplicates (unless nearly broken), armor no better than what it has, a third try of the same failure, crafting the same thing over and over, over-gathering, eating when full, sleeping in daytime, a second station next to the first, and dropping valuables.
  - A skipped action is recorded as a failed result with the reason, so the model learns from it.
  - "Wanted" means a player's task, a goal someone else set, a build that's short of it, or the current `obtainItem`. Its own goal text doesn't count, or a self-written "craft a crafting table" goal would justify the loop.
- **`places.js` (saved):** placed blocks, home (its bed or a build site), bed, the day it last slept (a phantom warning after 3 nights), and deaths. These go in the prompt as `places`.
  - `Brain.takeThingsFirst`: before explore, a far `moveToBlock`, or following someone far away, it picks up remembered stations within 24 blocks that aren't at home or still cooking. The original decision waits in `this.resume`.
  - Whether it remembers each block is rolled when it's placed: 0.35 + 0.1 × survival level.
  - New action `pickUpBlock`.
- **`habits.js`** (`Brain.choreStep`, each chore with a cooldown, and 5 min after a failure): armor, shield, replacing a tool about to break, junk when full, hotbar layout (new action `organizeHotbar`).
  - Also: a run back to the death spot (`moveToBlock`, then `collectDrops`), and heading home to its bed at dusk.
- **`motion.js`:**
  - Sprint-jumping on straight, flat path stretches at parkour level 3+. In the air it removes the path nodes it has passed; the pathfinder shares its path array, so it would otherwise turn back for them.
  - `adjustLook` (through `look.js`): never into an enderman's eyes (knowledge tier 1+, not while fighting one).
- **Menu time by level** (`ctx.uiPause`): crafting, furnace, chests, armor.

**Verified:**
- Unit tests: commonsense, places, habits, motion.
- On flying-squid 1.16.5:
  - the table was placed and remembered;
  - a third table was refused with the message;
  - exploring first picked the table back up (it came back to the inventory);
  - sprint-jumping: 30 blocks in 5.0–5.3 s with 82–87% in the air and no backtracking. Before the fix it took 11 s and turned back.
- The whole loop ran with the mock without errors. Armor equipping fails on flying-squid only (its inventory transactions are broken), so failed chores now back off.

**Not verified yet:** a real server (craft-table placement on Paper, pickup, armor equip, hotbar moves, death runs); real-model behaviour with the new hints.

## 23. Mouse and keyboard like a person; server rules and manners; redstone and game mechanics

**The user asked:**
- Camera and player movement like someone on a mouse and keyboard, researched.
- Following reasonable rules and requests on community servers (unless the bot is an anarchist).
- Understanding town halls and farms: don't break things or kill the trapped zombie in an iron farm.
- Then (mid-turn, after a worker restart): very high-level bots should understand redstone, build better and more efficient circuits, understand game mechanics players exploit, and copy or improve them.

**Research (what was found):**
- Anti-cheats (Grim, TruthfulAC, VoidAC) check that rotations are multiples of a real sensitivity step (GCD) and look for robotic aim. Mineflayer already rounds rotations to 0.15° (vanilla's default sensitivity: degrees per mouse count = 1.2·f³, f = 0.6·sensitivity + 0.2).
- Human pointing follows Fitts's law. Movements have a bell-shaped speed profile (minimum jerk), usually land short, and are followed by a corrective submovement (arXiv 2002.11596, 2110.00443; the ACC 2008 paper on undershoot).
- Eye tracking in FPS games: players fixate the screen centre most of the time.
- No measured peak flick speeds in °/s were found (only vendor estimates), so speeds are set by skill as reasonable ranges.
- mojira.dev was unreachable from the cloud session.

**Done:**
- **`look.js` rewritten** (`installHumanInput`):
  - Flicks use Fitts timing by skill, a minimum-jerk speed curve, under- or overshoot with a correction, and a slight curve.
  - Fights use smooth pursuit (`combat()`); reflexes stay instant (`precise()`).
  - Paths: the pathfinder's per-tick `look(yaw, 0)` is caught. The camera eases toward a look-ahead point with a walking pitch by skill (beginners look down more). The movement keys are chosen from 8 WASD combos relative to the camera, with hysteresis, and sprint starts a few ticks late.
  - Exact steering is kept for parkour nodes, dig/place nodes, ledges with drops beside them, and water.
  - With `humanKeys` off, the pathfinder looks are passed through raw. A bug where they turned into flicks made the bot unable to walk; fixed.
  - Live on flying-squid, WASD walking arrived as fast as exact steering (4.6–5.3 s for 25–30 blocks) using W, W+A and W+D, and the old 180° one-tick snaps were gone.
- **`etiquette.js`:**
  - Rules with authority (owner > admin/server/sign > trusted > player) and `lawfulness`; personality presets now include it, plus the new `anarchist` preset, and setup understands "anarchist" or "law-abiding".
  - The chat analysis gets a `rule` field, handled by `ChatResponder.handleRule`: keep or ignore it, stop the current action if it breaks the rule, and answer in character.
  - Rules are also read from signs (every 10 s) and from system messages.
  - `check()` runs in `Brain.commonSense` before commonsense.js; owner commands and owner tasks bypass it.
  - `protectedMob`: name tag, pet, villager or golem, in a vehicle, or `contained` (a flood fill of up to 40 cells, closed, with at least 2 player-made wall blocks; "iron farm" when villagers are near).
  - `builtUp`: 30+ player-made blocks within 10 and not its home or build, so no breaking, burning or taking there.
  - Protected mobs are left out of hunting (`mobsAround`) and out of the "too close" defence reflex. `state.rules` and `leaveAlone` on entities go in the prompt; `!rules`.
- **`redstone.js`:**
  - A logic-level simulator in redstone ticks covering dust (decay, steps, cut), strong and weak power, torches (1 tick, attachment), repeaters (delay), comparators (compare/subtract), observers (pulse), levers, buttons and outputs.
  - `analyze` gives the truth table, delay, clock period or latch; `optimize` greedily removes or swaps parts while every input case stays the same.
  - `DESIGNS`: NOT, OR, NOR, AND, NAND and a torch-repeater clock. Also `place` (rotation) and `readFromWorld`.
- **`mechanics.js`:** recognises 14 contraptions with the mechanic, benefit, rate and improvements, by knowledge level; exploits only at level 7.
- **`tech.js`:** actions `inspectRedstone` (4+), `designCircuit` and `buildCircuit` (6+, via `minKnowledge` in `availableTools`).
  - `buildCircuit` aims the camera so vanilla gives each part the right facing (repeaters: look the way the signal flows; observers: look where it should watch; pistons: look at the head side), clicks with `_genericPlace(forceLook: 'ignore')`, checks the facing, and digs and retries if it's wrong. It sets repeater delays and comparator mode by clicking.
  - Then it tests every input combination with real levers against the simulation.
- **Knowledge:** 10 redstone and mechanics facts (tiers 3–7).

**Verified:**
- Unit tests:
  - every design's truth table and timing; the clock's period by repeater delay; rotation;
  - a clumsy OR gate optimised from cost 11.25 to 4, and faster;
  - a backwards repeater detected;
  - a NOR gate built in a prismarine world, read back and recognised;
  - a cobblestone generator and a sugar cane farm recognised;
  - etiquette: authority and lawfulness, rules vs actions, an iron-farm zombie, a cow pen, villagers, a town, sign rules.
- Live on flying-squid: `designCircuit`, and `buildCircuit` placing dust and the lamp.

**Not verified:**
- Oriented placement (repeaters, wall torches, levers) and the in-world lever test. flying-squid derives facing from the player's position and doesn't place wall torches or levers, so this needs a real Paper server.
- Real-model rule extraction from chat.
- Contained-mob detection on real farms.
- WASD walking on real terrain.

## 24. Public servers like The Hive; talking to it by voice

**The user asked:**
- If the bot joined them on a public server like The Hive, could it navigate the server, use menus, join them and play?
- Could a TTS model let them talk to it while playing and hear it answer, since it shouldn't text in public chat?
- Could it explain things by voice in time with showing them in game?
- "Continue and finish everything."

**Research:**
- The Hive is Bedrock-only; its Java server closed on 15 April 2021.
- ViaBedrock lists Bedrock form GUIs among its features, but says it's very early and not for regular use.
- There's no Node client for Simple Voice Chat (only `mineflayer-plasmovoice` for PlasmoVoice). So voice goes through the browser page, not in-game voice chat.

**Done:**
- **`network.js`:**
  - Reading the network (`state.server`): sidebar lines (team prefixes via `displayName`), boss bars, the last title/subtitle and action bar, named hotbar items, the open menu, and commands from `bot.tabComplete('/')`.
  - Network detection by score: sidebar, named items, a store or discord link in the tab list, 30+ players, adventure mode.
  - Menus: `describeWindow` (skips unnamed glass panes) and `findSlot` (fuzzy match).
  - Commands: `allowed` = SAFE_COMMAND, or offered by the server and not DANGEROUS.
  - Owner invites are auto-accepted from system messages only, not lines in the owner's own chat format. It uses the clickEvent `run_command` or the command named in the text (owner name appended only when it follows), then `/tpaccept`, `/party accept <owner>` or `/friend accept <owner>`.
  - Actions `useHotbarItem`, `readMenu`, `clickMenu`, `serverCommand`, `joinOwner`. Menus show only when one is open; lobby tools only on networks.
  - `chat.publicChat: 'auto'`: no public chat on networks.
- **`voice.js`:**
  - Pages check in every 5 s (`/voice/hello`).
  - `say()` queues lines; the page plays them (speechSynthesis, or audio from `voice.ttsUrl`) and posts `/voice/done`; if it doesn't, a time estimate takes over.
  - `heard()`: wake words (its name, the personality name, nicknames, `voice.wakeWords`), a 30 s conversation window, push-to-talk always counts. "Show me / explain / how do I" queues `explainAndShow`; anything else goes to `responder.onMessage(owner, text, { whisper: true, voice: true })`.
  - `transcribe()` posts multipart to `voice.sttUrl`.
  - `ChatManager.deliver` speaks owner-directed lines (and would-be public lines) when a page is active.
- **Viewer:**
  - `viewer.https`: a self-signed cert (node-forge, an optional dependency) cached as `viewer-cert.json` next to the save, with the PC's IPs in the SAN.
  - Routes `/voice`, `/voice-client.js`, `/voice/settings|hello|heard|done|listen|audio/:id`.
  - A Voice button in the panel.
- **`web/voice-client.js`:**
  - Hands-free browser recognition (continuous, restarts on end, paused while speaking so it doesn't hear itself).
  - Whisper mode: a simple level-based voice detector with MediaRecorder.
  - Push-to-talk (button or V); voice picker.
- **`explain.js`:** `explainAndShow`. `Agent.planExplanation` (LLM: 2–6 steps of say/action/look, demo-safe actions only) → each step speaks while doing, looks and highlights, then waits for both. Typed owner messages with "show me…" also trigger it.

**Verified:**
- Unit tests: network (menu reading, slot finding, safe and dangerous commands, invites from the owner vs strangers vs the owner's own chat, network vs plain server); voice (wake words, conversation window, push-to-talk, show-me routing, queued speech waiting for the page, the TTS and STT request formats against a stub server, cleaning planned steps).
- Live on flying-squid + Chromium over https:
  - the page had a secure context and its status said it was listening;
  - "pass me the iron" was ignored and "hey Viewer, how are you doing?" was answered out loud ("hey!");
  - a two-step walkthrough spoke step 1, waited for its action (a slow torch placement on flying-squid), then spoke step 2.

**Not verified:** real speech recognition (headless Chromium has none) and Whisper/Kokoro servers; a real network (menus, invites, `/play`); the Bedrock route on The Hive; real-model walkthrough plans.

## 25. The Hive's menus; local Whisper and Kokoro

**The user said:**
- On The Hive, inventory items open menus where you join and create parties, invite, join games and lobbies. Chat only has notifications and can't be clicked on Bedrock.
- Keep the chat reading for Java, where clicking works.
- "You could use Kokoro TTS or other local models. Is Whisper local and fast?"

**Done:**
- **`navigateMenus`** (network.js): a goal → the hotbar item that fits (name match, plus hints: party/friend → social or profile items, lobby → hub selectors, else the game selector) → each menu read, the best-matching entry clicked (name ×2 + lore, with synonyms such as party/group/squad, accept/join/confirm, lobby/hub, solo/singles) → deeper, back out via "Back" entries, or close and try the next item. Up to 12 steps; reports the path.
  - On a fake Hive-style server in the tests: "play Treasure Wars solo" went Game Selector → Treasure Wars → Solo; "accept EndlessSkys's party invite" went Party & Friends → Invites (1) → EndlessSkys's party; an impossible goal failed cleanly.
- **Invites:**
  - The clickable or named command when there is one (Java).
  - On Bedrock, or with `inviteVia: 'menu'`: queue `navigateMenus("accept <owner>'s <kind> invite")`.
  - On Java with no command in the text: the usual `/party accept`, falling back to menus if the server replies "unknown command".
- **Server notices** (game starting, team, queue, rewards...) go into `state.server.notices`.
- **`scripts/voice-server.py`:** faster-whisper + kokoro-onnx behind OpenAI-compatible endpoints (stdlib server; Kokoro files auto-downloaded). `npm run voice-server`.
- **Speech:** Voice speaks sentence by sentence through a TTS server; the page plays parts in order (a queue) and records 16 kHz mono WAV itself (ScriptProcessor + resampling), so any Whisper server works without ffmpeg.

**Measured:**
- Kokoro fp32 on the cloud box (4 vCPU): a 1.2 s line in 0.46 s; 5.5 s of speech in 1.56 s (about 0.3 of real time). The int8 model was slower than real time there.
- Through the bot and a Chromium page: the first audio was ready in 1.5 s and played.
- The page's push-to-talk upload was RIFF WAV at 16 kHz, transcribed by a stub, and reached the bot as heard speech.
- Whisper itself couldn't be timed (Hugging Face blocked here). The faster-whisper project benchmark: small int8 transcribes 13 min in 1 min 42 s on an i7-12700K with 8 threads (about 7.6× real time); base is faster.

**Not verified:** a real Whisper model; The Hive itself (the Bedrock route through ViaBedrock, whether its form menus arrive as windows); real Java network menus.

## 26. Simple Voice Chat; PvP with the owner; online research

**The user asked:**
- Servers they play use Simple Voice Chat; the bot should talk in it.
- It should play PvP with them on Java servers for fun, with other minigames a bonus. It would have to learn them, or research online how they work on that server.
- Internet access for researching good builds, redstone designs and strategies, only for extremely high-level bots.

**Done:**
- **`svc.js`:** the protocol from henkelmax/simple-voice-chat (branch 1.21.5 on raw.githubusercontent; `voicechat_compatibility_version=21`).
  - **Handshake over plugin channels:** request_secret(int version) → secret (16-byte key, connection UUID, port, player UUID, codec byte, MTU, distance, keep-alive, groups, host string, recording flag); client_state(muted, disabled).
  - **UDP:** every packet is `0xFF`, then the connection UUID (client→server only), then a varint-length payload encrypted with AES-128-GCM (12-byte IV first, 16-byte tag last) whose first byte is the packet id.
  - **Packet ids:** 1 Mic (opus byteArray, long seq, bool whisper), 2 PlayerSound (channel, sender, data, seq, float distance, flags), 3 Group, 4 Location (plus 3 doubles), 5 Authenticate, 6 AuthAck(16-byte nonce), 7 Ping, 8 KeepAlive, 9 ConnectionCheck(nonce), 10 CheckAck.
  - **Codec:** Opus via `opusscript` (an optional dependency; WebAssembly, so no build tools on Windows).
  - **Routing:** `Voice.route` sends speech to voice chat when a player spoke to it there (30 s) or its owner is within voice distance (`svc.preferForOwner`); otherwise the voice page, otherwise typed chat. `ChatManager.deliver` and `explainAndShow` use it.
  - **Hearing:** utterances go to Whisper, then to `responder.onMessage` only when named or mid-conversation. Common Whisper noise on silence is dropped.
- **PvP:**
  - Its owner's spar requests are accepted 95% of the time.
  - `attackTarget` takes `game` and `until`. Outside arenas, sparring stops at `pvp.sparStopHealth` (`combat.fight` checks its own health and the target's metadata health: index 9 on 1.17+, 8 before), with outcomes `spar_won`/`spar_lost` and a "gg".
  - `Network.pvpGame()`: PvP game words in the sidebar, boss bars or title; survival mode; not lobby or countdown. `Network.teammate()`: same team object/name or name colour.
  - `Brain.gameStep` (right after reflexes) attacks the nearest visible non-teammate. `assertMayFightPlayer(…, game)` and `etiquette.check` allow it inside a game.
- **`research.js`:** described in the file table.

**Verified:**
- Unit tests:
  - svc: byte formats and crypto. Against a fake UDP voice server written from the mod's source: the handshake with the nonce, keep-alive echo, 1.00 s of a player's speech assembled as 16 kHz WAV, 0.5 s of speech sent as 25 Opus frames in about 600 ms with sequence numbers and the end packet.
  - pvp: game vs lobby vs countdown vs plain server; teammates.
  - research: a stub search page (ads, redirects), wiki, page text, the notes coming back in a Bed Wars context, no repeat lookups, the level gate.

**Not verified:** a real Simple Voice Chat server; real minigames; real web search (DuckDuckGo may rate-limit; use SearXNG if so).

## 27. The bot couldn't join after the voice chat update; a README that says what it is

**Asked:** "the bot didn't want to join the server this time, it couldn't connect to the local port 25565", and whether the notes on GitHub explain what the bot does, how to configure it and how to use it.

**What happened:**
- The log showed `Connecting to localhost:25565 as Wanderer` and then `Disconnected: socketClosed` again and again, with no kick message.
- The server (26.1, offline mode) was up.

**Cause:**
- The Simple Voice Chat client (§26) called `client.registerChannel('voicechat:secret', ..., true)` as soon as the bot was created.
- With `true`, minecraft-protocol writes a `minecraft:register` packet at once, so it went out before the handshake.
- A capture of the first bytes showed a stray `01 00` packet ahead of the handshake. A real server reads that as a broken handshake and closes the socket.
- flying-squid ignores it, which is why every live test still passed.

**Fix:**
- The channel is registered quietly, and announced with `writeChannel('minecraft:register', ...)` on `login`, in the play state.
- `test/svc.test.js` now fails if anything is written before login.
- Verified with the byte capture: the handshake is the first packet again.

**Docs:**
- The README opening was stale: it said Qwen 2.5 and told people to edit `config.json`. It also didn't mention the viewer, voice, voice chat, networks, manners, redstone or research.
- It now starts with "What it does" (grouped), "Using it" (setup, doctor, start commands, talking to it, `!` commands, updating), "Configuring it" (`config.local.json`, `!set`, CONFIGURING.md, profiles, environment variables) and a table of the other documents.
- Troubleshooting entries for `socketClosed` were added to the README and START-HERE.

## 28. Underground: what it can see and reach, sizing up mobs, owner directions, speed

**Asked (with a log from a real session underground on the local server):**
- It placed a crafting table on the other side of tree leaves, and interacts with things it can't see.
- It should recognise things that are in sight range, not only straight ahead.
- It should judge the danger and the reasons to fight for the creatures around it.
- It takes a long time to think.
- The log: obtainItem cobbled_deepslate repeated with "planning every step myself" and nothing happening; "mine down please", "look for iron", "staircase instead…" ignored; trust 79 → 76 "was rude to you"; mineBlock without a pickaxe failing after two minutes; a fourth crafting table "to make tools".

**Found:**
- **Block sight was broken:** the sight ray went to a block's centre and hit the block's own face, so beyond 3 blocks only leaves and glass ever counted as seen. Distant logs, ores, tables and signs were unknown unless it had been close.
- Placing, opening and using had no line-of-sight check at all.
- `obtainStep` refused to run while any task was active or while any hostile mob within 6 blocks existed, including ones behind walls. Underground that is nearly always, so the plan never ran and the model ordered it again.
- The chat analysis read the owner's directions as rude, so no task and no reply. Nothing caught that.
- The flying-squid test server crashes on the bot's tab-complete and then stops sending it chat, which hid chat problems in tests.

**Built:**
- **Sight:** `canSeeBlock` uses points on the faces turned towards it. `visibleShare` samples five points on a creature's body; partly visible counts. With realistic sight, mineBlock skips blocks sealed in rock.
- **`reach.js` (clicking like a crosshair):**
  - placing picks a support face it can see, else walks to one (GoalPlaceBlock with LOS), else NOT_IN_VIEW; `placeNearby` tries visible spots first;
  - opening, using and crafting tables go through `goNextTo` (GoalLookAtBlock) and click the visible face;
  - crafting puts down its own table when the nearest one can't be reached;
  - mining digs the visible face and punches through leaves or grass in the way.
- **`threat.js`:** danger (expected share of health lost, from mob stats against weapon, armour, shield, skill, totem and knockback) and worth (drops wanted, food, it'll chase anyway, protecting friends, revenge; minus provoking neutral mobs, unneeded animals, babies, protected mobs).
  - Verdicts per creature and for the group go into `status.threats`.
  - The reflexes use them: flee, deal early with one worth fighting, avoid. So does `dangerInfo`.
  - Only perceived mobs count.
- **Owner directions:**
  - `instructionFromText` turns mining directions into a task with a code plan (pickaxe for that ore first via acquire, then stripMine). Follow-ups refine the running task.
  - Directions without insults never cost trust or liking from owners and admins, and at most -1 trust from others.
  - The obtain guard no longer stalls on tasks, and its danger check is the real threat.
  - mineBlock fails at once without a harvesting tool and names the obtainItem to use. The crafting-table guard and hints name the next pickaxe to make.
- **Speed:**
  - Each decision logs `Thought for X s (read N new tokens, wrote M at T/s)`.
  - One-time warnings: chat replies wiping the cache (suggests fastModel or OLLAMA_NUM_PARALLEL), model reloads, a model on the CPU.
  - The state sent to the model drops empty fields, and the thought is under 12 words.
- `network.discoverCommands` (default on; test configs off).

**Tested:**
- Unit tests: `sight.test.js`, `threat.test.js`, `instructions.test.js`.
- Live on flying-squid 1.21.4:
  - the owner's three directions with the mock misreading them as rude gave a task "look for iron" with stripMine after a stone pickaxe, a reply, and unchanged trust;
  - a table asked for behind a leaf wall was placed after walking to a spot with a clear view.

**Then (screenshot from the viewer):**
- The 2x2 crafting grid held 4 + 4 birch planks and 3 birch logs, with nothing made: the bot "placed the logs in the crafting slot but didn't craft".
- Cause: Mineflayer's `bot.craft` never waits for the server. It writes the result into the output slot itself, takes it, and considers the grid empty. The server made nothing and kept the ingredients.
- Fix: `craftVerified` checks the real inventory afterwards, puts grid leftovers back, and crafts by hand when nothing came out (lay out the recipe, wait for the result the server shows, take it).
  - Grid items don't count as carried, so the grid is emptied 3 s after spawning, which clears what's stuck now.
  - Also fixed: the reachable-table fallback had landed in experimentCrafting, where it would crash; it's now in craftItem.
- Tested with `test/craft.test.js` (a fake inventory that behaves like a vanilla server). flying-squid can't do inventory clicks at all.

**Not verified:** real decision timings on the user's PC (the new log line will show them); stripMine and fights against real mobs on Paper; crafting on Paper 26.1 with the new check.

## 29. Faster, smarter, more like a player; which model; fine-tuning

**Asked:**
- "It still takes a really long time to think: how could we make it faster, smarter, and more accurate to a player?"
- "Can it still think while moving? What model would work best, and could we fine-tune it to be really good at Minecraft?"

**Found:** the model was asked after almost every action, because code only drove obtainItem, tasks and the autopilot. Each call costs a few seconds on the 1660 Super: reading the new state, writing about 90 tokens, plus the cache refill after chat replies. The user part of the prompt began with the bot's position and the time of day, which change every decision, so Ollama re-read nearly all of it (8% reusable).

**Built:**
- `routines.js` + `Brain.commit` / `seekStep`:
  - a mining or crafting decision toward a step's amount becomes one obtainItem routine for the whole amount;
  - exploring to find something keeps going until it's in sight;
  - strip mining keeps going until ore turns up.
  - The model is asked again only when the routine is done, stuck or interrupted.
  - Test: a 45 s search made 2 model calls instead of 13.
- `stableFirst`: people, lessons and know-how first, then the state ordered slow → fast-changing, with the time rounded to the hour and feelings last. Reusable share of the state: 8% → ~48%.
- `npm run training-set` (`scripts/training-set.js`): recorded decisions → `train.jsonl` for Unsloth (only decisions that worked; no repeats, waits or emojis).

**Answered:**
- Yes, it thinks while moving (prethink, busy work).
- `qwen3:4b-instruct` stays the best fit for 6 GB, with `qwen3:1.7b` as the fast chat model. Larger models spill onto the CPU; a hosted API through `llm.provider: "openai"` is the only way to get much faster.
- Fine-tuning: collect, then `npm run training-set`, then LoRA on a free Colab GPU (the 1660 is too small for 4B training with these prompt lengths), then GGUF, then Ollama. Optionally first distil from a big hosted model.

## 30. "It didn't get added": settings in config.local.json

**Asked:** "are you sure it should be in config.local.json? It didn't get added."

**Found:**
- The loading is right: `config.local.json` is merged over the defaults, `--viewer` included.
- But nothing caught the usual reasons a hand-made setting does nothing:
  - put on the wrong level (`fastModel` at the top instead of inside `llm`);
  - a misspelling;
  - Notepad's byte-order mark, which made the whole file unreadable;
  - the chat model never downloaded (setup asked for it but didn't pull it).
- The README's speed example still named plain `qwen3:4b` (the thinking-only version).

**Built:**
- `npm run set -- llm.fastModel qwen3:1.7b` (`scripts/set.js`): writes the setting into the right section, checks the name, shows or removes a value.
- At start, `Config: "fastModel" isn't a setting; did you mean llm.fastModel?` for any unknown key.
- `readJson` accepts the BOM and reports a broken file by line and column.
- Setup offers to download the chat model.
- Docs fixed (README, START-HERE troubleshooting).

## 31. A smooth viewport that looks like the game

**Asked:** "the viewport jitters around and isn't smooth. Get as many Minecraft assets in there to feel natural."

**Found:**
- prismarine-viewer starts a new 50 ms tween to the bot's position on every update (up to 20 a second, unevenly). The tweens overlap and fight, so the camera moved in stop-go steps.
- The turning was already smoothed, the position wasn't.
- The scene was a flat light-blue background with no fog, sun, weather, hand or day and night.

**Built (`web/view-addon.js`, fed by a new `/view/env` stream from `viewer.js`):**
- **Smooth camera:** the viewer's tweens only set a target; the drawn camera eases toward it at render time (`updateMatrixWorld` override).
  - Measured over 180 frames while walking: frames with no movement 10 → 0, step variation 105% → 41%.
  - Plus the game's view bobbing, lower eyes when sneaking, the hurt tilt and the death fall.
- **The world, from the textures prismarine-viewer ships:**
  - sky dome coloured by time of day, sunrise and sunset glow on the horizon;
  - sun and moon (correct phase, east to west), stars, a cloud layer at y 192 that drifts and fades out;
  - fog at the view's edge (blue under water, orange in lava, red in the Nether, purple in the End);
  - rain or snow when outside, light scaled by the sky and block light at the eyes, with a floor so nights stay readable.
- **First person:** Steve's arm (skin UVs), or the held item or block, with the swing (constant while digging) and the equip dip. Cracks (destroy stages) on the block being dug. Vignette, underwater tint, pumpkin blur, "You died!".
- **Panel:** **Sky & hand** and **Bobbing** buttons, remembered per browser.

**Tested:** live on flying-squid with headless Chromium, with screenshots at dusk, noon, night, empty hand, a held log, a pickaxe and a sword. The panel still fits 1366×768 and a phone with no scrolling.

**Not verified:** rain and snow and the under-water look (flying-squid has no weather or water here), cracks mid-dig on screen, and how it runs on the user's GPU.

## 32. Get going at once; why thinking was slow; the viewer behind a key; a model trained for this

**Asked:**
- After joining, it shouldn't wait minutes for a task or goal; it should start doing what it needs to.
- From a session: "standing still and thinking took a long time", with a 35.8 s decision in the log.
- The viewport lags when jumping, gets very dark underground, sometimes lags back and gets stuck, moves when the bot doesn't, and turns late.
- (Shared a public TCP-forward address of the viewer.)
- Should we train a model to decide extremely fast and understand Minecraft by level, moving, analysing, acting and building like a player?

**Found:**
- The 35.8 s decision read 3,852 tokens at ~125/s after an 8.7 s model reload. The chat model and the main model didn't both fit in 6 GB and kept pushing each other out; the reading speed means part of it ran on the CPU.
- At join, the early-game routine was off whenever someone had just spoken, or a mob was anywhere near; then everything waited on the model.
- Viewer:
  - a whole-scene light floor of 0.2 underground (the viewer has no per-block light);
  - bobbing from tiny position wobbles;
  - turn easing on top of the bot's own human head movement;
  - server corrections arriving as `forcedMove`, which the view didn't listen to.
- The viewer had no key unless a password was set, and a tunnel arrives from localhost, so anyone with the link had owner control.

**Built:**
- **Joining:**
  - for 3 minutes after joining, the routine runs regardless of chat and of mild danger;
  - a starting goal from the inventory;
  - idle waits replaced with something useful;
  - decisions preempt background planning;
  - models warmed up while connecting;
  - a smaller context for the chat model.
- **Speed:**
  - after 2 reloads the main model takes over chat (one warning);
  - a warning when prompts are read slowly, naming the cause;
  - `llm.numCtx` 6144, and a warning when a prompt nears it.
- **Viewer:**
  - position easing 45 ms, turning twice as fast;
  - bobbing from the bot's real velocity;
  - a cave light floor of 0.6;
  - `forcedMove`/`respawn` listened to, and a 0.5 s resend when stale;
  - always a key (`data/viewer-key.txt`, the link printed with it), with `/voice-client.js` left open so the panel still loads.
- **Trained-model path:**
  - `llm.trained` uses a ~480-token system prompt instead of ~2,600;
  - every recorded decision also stores that short prompt;
  - `npm run training-set -- --short` builds a fine-tuning file with it;
  - TRAINING.md explains the honest split: code for the hands, a trained small model for the head.

**Tested:**
- Unit tests.
- With the key: the panel works with it and answers 401 without it.
- The trained prompt measured at ~480 tokens with the mock.

**Not verified:** the user's PC (whether the fallback kicks in, and real timings) and the viewport fixes in their browser.

## 33. Mouse movement by level; a full guide to fine-tuning qwen3:1.7b

**Asked:**
- "Can it have good mouse movement like a keyboard player (on different levels)? Research that and implement it."
- "Guide me on how we could fine-tune a small qwen3:1.7b on a free Colab GPU and get it to be actually good (at different levels) almost identical to a player."

**Research used:**
- Meyer's stochastic optimised-submovement model:
  - primary endpoints scatter around the target with noise that grows with speed and distance;
  - corrections can go either way;
  - undershoot is more common downward and on small targets.
- An FPS eye-tracking study (experienced vs non-FPS players): experts usually reach a target in one movement, others need extra corrections.
- Catch-up saccades when pursuit falls behind.
- Sensitivity surveys: pros mostly ~35–60 cm/360, arm aiming, a 180 needing a lift.
- On 1.9+ combat, cooldown timing matters more than click speed (combat.js already times it by skill).

**Built:**
- `planFlick` rewritten as submovements:
  - a reaction hold before turns over 40°;
  - swipes with a lift;
  - a noisy primary movement;
  - 1–3 corrections by skill;
  - an exact settle.
- Tracking with a lag, catch-ups and wander; idle glances at players or mobs nearby.
- `test/look.test.js` (measured: corrections 2.1 beginner vs 1.3 master; tracking error at 90°/s 22° vs 6°).
- **Fine-tuning pipeline:**
  - the code's own decisions recorded as examples with the prompt the model would have seen (`decisionMessages` split out of `decide`);
  - levels recorded per example;
  - `training-set`: levels report, `--max-code` (default half), `--level`, shuffle, 5% test file;
  - `training/finetune_qwen3_colab.ipynb`;
  - `npm run eval-model` (valid / same action / same target / seconds per decision);
  - TRAINING.md has the step-by-step guide, with recording per level and distillation from a big model.

**Not verified:** the notebook on Colab (written from Unsloth's current API; cells compile), real fine-tune quality, and the new aim on a real server.

## 34. As smart as possible on a small model

**Asked:** "Currently the existing bot and model aren't too smart, make it as smart as physically possible."

**Reasoning:** on a 6 GB card the model can't get bigger, so the gain has to come from what it's asked. A small model chooses well among a few sensible options and plans badly from a long rulebook. Past stone tools and a sword, the code had no idea what a player does next, so the model was on its own.

**Found while building it** (acquire.js, the item-getter behind obtainItem and tasks):
- **Bed:** it went looking for skeletons. Re-dyeing a bed it doesn't have (bone meal plus a bed) counted as fewer missing items than wool plus planks.
- **Torch:** it planned to mine a `wall_torch`, someone's placed torch. With that fixed, charcoal came from breaking a campfire.
- **Wool:** it came from crafting string mined from cobwebs, with a sheep in sight.
- **Sticks:** it mined dead bushes for them while carrying wood.

**Built:**
- **`strategy.js`:** each decision gets a menu of up to 5 ready actions.
  - Urgent first: flee or fight by threat verdict, eat, cook, food, a bed or shelter at dusk and night, a torch in a dark cave, store or drop when full.
  - Then the next two progression milestones the bot knows about (by knowledge tier), from the first pickaxe to a diamond pickaxe and a base.
  - Then its current step's item.
  - The model answers `choose: n`, or 0 and its own action. Invalid actions and idle waits fall back to the best option.
- **acquire.js:**
  - placed forms and crafted blocks are never sources when there's another way;
  - an animal in sight comes first for its drops; with none in sight, it goes looking for one;
  - it crafts first when everything needed is carried;
  - recipes are weighed by how hard their missing items are.

**Tested:**
- `test/strategy.test.js`: the menus at each stage and the urgent cases, plus the item-planning fixes.
- Live with the mock: the prompt lists the options, and "choose 1" ran obtainItem wooden_pickaxe as a routine.

**Not verified:** how often the real qwen3 uses `choose`, and whether the menu makes its play visibly better in a real session.

## 35. A good model without good data; thinking time by situation; recording the user's play

**Asked:** the user can't train a model on data that isn't good, and the current model is slow and not smart. How to get a model that (A) makes realistic player decisions, (B) plays, moves and acts like a player, and (C) decides fast and changes how long it thinks, acting in under 300 ms for fights and live events.

**Answer given:** one model can't do all three on a 6 GB card. Split it like a player: hands are code at 20 Hz (reflexes, combat, look.js), quick picks are a tiny prompt to the small model, slow thinking is the full decision. Good data comes from the user's own play first, then a big teacher model, then the code's own decisions, all filtered by outcome.

**Built:**
- **Thinking time by situation** (`Brain.thinkingBudget`, `loop.thinking`):
  - **instant:** high danger with an urgent option, or only one sensible option: the best option, no model;
  - **quick:** an urgent option with a real choice: `Brain.quickChoice` sends a tiny prompt (~1 KB) to the fast lane (`llm.chat({ fast: true, maxTokens: 12, signal })`) for `{"choose": n}`, giving up after `quickMs` (1.5 s) and taking options[0];
  - **full:** calm: the normal decision; past `fullMs` (12 s) the best option runs and the late answer becomes `this.prethought`, used right after if nothing changed;
  - while thinking, `dangerLevel() === 'high'` is checked every 200 ms and a reflex interrupts.
  - `OllamaClient.chat` takes `fast`, `maxTokens` and `signal`; a given-up request leaves the queue, or is aborted without retrying.
- **`observe.js`:** one compact description of the moment (~250–500 tokens): health, food, place, time, layout, held and worn items, inventory, notable blocks in sight, creatures with ids, threats, goal and step, task, chat, recent events and actions, options.
  - Used as the user message in `llm.trained` mode.
  - Stored as `compact` with every recorded example.
  - `training-set --short` builds user messages from it.
  - `trainedPrompt()` is the shared short system prompt.
- **`npm run record` (scripts/record.js):** a TCP pass-through on port 25566 to the user's offline-mode server.
  - Bytes are forwarded untouched. Server→client bytes feed a silent minecraft-protocol client plus a mineflayer bot (physics off, writes dropped) for the world, inventory and health. Client→server packets are parsed with its own state machine (login → configuration → play).
  - Acts become the bot's actions: mineBlock (counted), placeBlock (rows of the same block count as one decision), craftItem (result-slot clicks plus the inventory gain), smeltItem, eatFood (use_item, then food going up), attackTarget, storeItems/takeItems (inventory diff when a chest closes), equipItem, useItem, fish, activateBlock (doors, levers), sleepInBed, dropItems, chatMessage, and explore (a long walk with nothing else).
  - Each decision is dated back to when the previous one ended, and the snapshot nearest that moment is used (one a second).
  - `goal: ...` in chat sets the goal annotation.
  - Decisions followed by dying within 15 s are marked bad.
  - Output: `data/training/demos/*.jsonl` and `data/training/motion/*.jsonl` (look/move at packet rate, keys from `player_input`, swings, hits with target positions, nearby players and hostiles every second).
- **`npm run analyze-motion`:** finds flicks (bursts of turning between stills), splits submovements at speed dips, fits Fitts' law on the primary movement, and turns the 60° turn time into an aim skill.
  - The skill comes from a calibration curve made by running the same analysis on look.js's own flicks at skills 0…1. On unseen synthetic flicks it recovers 0.9 → 0.92 and 0.15 → 0.18.
  - It also measures CPS, strafing while hitting, sprinting and jumps.
  - `behavior.aimProfile` feeds `aimSkill` to look.js.

**Gotcha:** minecraft-protocol's `createClient({ stream })` with an offline account emits `connect` before `setProtocol` is attached, so the client stays in the handshaking state. Emit `connect` again after creating it.

**Tested:**
- `test/thinking.test.js`: budgets, the quick pick, its deadline and interruption, the calm deadline and prethought.
- `test/llm.test.js`: fast lane, `num_predict`, giving up while queued or running.
- `test/record.test.js`: frames and compression, the handshake, aim recovery, the compact state, demos in the training set.
- Live on flying-squid 1.21.4: a scripted player through the recorder gave 3 decisions (mine 3 grass, a dirt row, a chat line) with the goal from chat, through the configuration state.
- Live with a 14 s mock: after 12 s it started obtainItem wooden_pickaxe instead of standing still.

**Not verified:** the recorder against Paper 26.1 and a real vanilla client; crafting, furnace and chest detection (flying-squid can't do windows); the quick lane's real speed on the 1660 Super.

## 36. Andy 3.6 and other Mindcraft models: beat them or build on them?

**Asked:** the user hasn't trained a model yet. There's a model called Andy 3.6 (and others): could we beat it in performance and reasoning, or use it and make it better for this bot?

**Found** (model cards on Hugging Face and Ollama; Hugging Face itself is blocked from the cloud session, so this came through search results):
- Andy-3.6: ~7B, Qwen2 / DeepSeek-R1-Distill-Qwen-7B, reasons out loud, ~22k curated Mindcraft prompts, Apache-2.0, Mindcraft only.
- Andy-4: 8B Llama 3.1, 4.9 GB Q4_K_M, 6–8 GB VRAM; trained on the published Andy-4-base and Andy-4-ft datasets, on one RTX 3090 for about three weeks.
- Andy-4-micro: 1.5B Qwen2.5. Andy-4-tiny: 360M SmolLM2.
- No published benchmarks.

**Answer given:**
- Their weights speak Mindcraft's command language and prompt.
- The 7–8B ones don't fit the 1660 Super, and 3.6 thinks before every answer.
- So build on their data, not their weights: fine-tune Qwen3 on our recordings plus their converted examples (check the dataset licences), then measure.

**Built:**
- `mindcraft.js` plus hooks in `parseJsonLoose` and `finishDecision`: an Andy model can run as `llm.model`, and its commands become our actions.
- `npm run compare-models`: the same knowledge, judgment and decision questions for every model, with speed and format rate.
- **Bug found while doing this:** the recorder's layout text didn't match the bot's ("Outdoors." vs "outdoors; blocked to the north…"). `Perception.layout` moved to `observe.layout`, and both use it now.

**Tested:**
- `test/mindcraft.test.js`: command parsing and mapping, commands inside JSON fields of a decision, the questions are deterministic with 4 distinct choices, game-data answers, lenient answer parsing.
- compare-models ran against a fake Ollama: a JSON model and a Mindcraft-text model; the unreachable-Ollama message.

**Not verified:** any real Andy model's output or scores; whether the Andy datasets convert cleanly to this bot's actions (not downloadable from here).

## Where it stands now

**Next for the user:**
1. `git pull`.
2. Restart Ollama so the `setx` settings apply.
3. `npm run doctor`, to see the new real timings with the compact prompt.
4. Set up the local Paper test server (START-HERE step 4: Java 21, Paper 1.21.4, EULA, `online-mode=false` on that fresh world only).
5. `npm start`, then join and talk to it.
6. Measure the models you have, with Andy-4-micro for comparison: `ollama pull sweaterdog/andy-4:micro-q8_0`, then `npm run compare-models -- qwen3:4b-instruct qwen3:1.7b sweaterdog/andy-4:micro-q8_0`.
7. For good training data: `npm run record -- --server localhost:25565 --level advanced`, join `localhost:25566`, play, say `goal: ...` in chat (TRAINING.md). Then `npm run analyze-motion`.

**After that:**
- Watch real play and tune prompts from the real logs. Nothing has run on a real server or with a real model yet; every live test used flying-squid and a mock LLM.
- Then the friend's server: FastLogin (SETUP 6D) or the Bedrock fallback.

**Open questions:**
- How much faster decisions are with the compact prompt on the 1660 Super. Expect roughly 4–8 s when cached, but that's unmeasured.
- Whether chat replies evict the decision prompt from Ollama's cache. The doctor checks this.
- How well a 4B model keeps to the goal tree and the JSON format in real play.

**Working rules:**
- Develop on branch `claude/confident-meitner-1ita5a`, commit and push; no PRs unless asked.
- The user's machine is Windows (Command Prompt).
- Keep CLAUDE.md, this file and the user docs up to date when things change.
