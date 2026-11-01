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

## Where it stands now

**Next for the user:**
1. `git pull`.
2. Restart Ollama so the `setx` settings apply.
3. `npm run doctor`, to see the new real timings with the compact prompt.
4. Set up the local Paper test server (START-HERE step 4: Java 21, Paper 1.21.4, EULA, `online-mode=false` on that fresh world only).
5. `npm start`, then join and talk to it.

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
