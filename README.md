# Minecraft LLM Bot

A Minecraft Java Edition player that plays on its own and talks like a real person. It's built on **Mineflayer**, and its decisions come from a local LLM through **Ollama** (`qwen3:4b-instruct` fits a 6 GB card fully). Nothing goes to the cloud unless you ask it to.

> **New here?** On Windows, start with [START-HERE.md](START-HERE.md): exact commands, step by step, from an empty PC to the bot walking around your own test server.

## What it does

**Plays the game**
- **Survival:** explores, mines (strip mining at the right depths), crafts, smelts, farms food, builds shelters, sleeps, and keeps its gear and hotbar in order like a regular player.
- **Builds:** designs its own buildings from reusable pieces, fitted to the terrain and different every time.
- **Fights:** bows with ballistics, axe and sword combos, maces, potions, totems, pearls, mob tactics. Plays PvP with you for fun (stops at 3 hearts and says gg), and plays PvP minigames with team awareness.
- **Moves like a person on mouse and keyboard:** human camera flicks and WASD, sprint-jumping, real parkour. Its skill shows: a Beginner fumbles, a Master is smooth.
- **Reflexes without the LLM**, 20 times a second: fall saves (water, blocks, boats, pearls, and clutches at higher levels), lava, drowning, getting hit.

**Thinks for itself**
- **Goals on four levels** (overall → long-term → current → steps), set by you or made up by itself.
- **Its own judgment about requests:** it weighs who's asking and what it would rather do. It may do part of a job, forget one, or say no like a person would. Owners can add obedience on top.
- **Feelings, trust** (is this player safe?) and **liking** (do I enjoy them?), which change with what happens.
- **Common sense:** it won't craft a fourth crafting table, downgrade its tools, eat when full, or retry the same failure forever. It also picks up its stations before it leaves.
- **Memory:** long-term memories, chat history per player, lessons from mistakes, a mental map (home, bed, deaths, what it placed).
- **An intelligence level** from Beginner to Impossible. Beginners learn as they play and can end up better than a Master.
- **Realistic senses:** it sees only what's in line of sight, hears footsteps and mining, gets suspicious and investigates. It needs F3 knowledge to use coordinates.
- **Expert-only knowledge:** at the top levels it understands redstone (simulates, optimises, designs and builds circuits), recognises farms and other contraptions, and can read up online (wiki and guides) on minigames, designs and strategies.

**Gets along with people**
- **A good guest:** no griefing of player builds, it respects private chests, and it follows reasonable server rules ("don't kill the villagers", "no building near spawn"). It leaves iron-farm zombies, pets and farms alone. The `anarchist` personality ignores rules.
- **Public networks:** reads scoreboards and menus, uses lobby items and menus, accepts your party invites, joins you, and stays quiet in public chat.
- **Voice:** talk to it while you play and it answers out loud, through a browser page or **in game with Simple Voice Chat**. It can explain things while showing them ("show me how to make a furnace"). Speech can be fully local (Whisper + Kokoro).
- **A browser viewer:** see what it sees, its inventory and feelings; change its goals and tasks; circle things on screen to point them out.
- **Never** emojis, robot-speak or "As an AI…".

## Using it

On Windows, in Command Prompt, inside the bot folder:

1. **Set it up once** with `npm run setup`. It asks a few questions: your Minecraft name, the server, the bot's name, personality and level, and the model. It writes them to `config.local.json`. It also downloads and tests the model.
2. **Check everything** with `npm run doctor`. It checks Ollama, the model's speed (this step takes a minute) and the server.
3. **Start it**:

   | Command | What it does |
   | --- | --- |
   | `npm start` | the bot on its own |
   | `npm run viewer` | the bot plus the browser page at http://localhost:3007: its view, inventory, feelings, goals, chat, pointing. The voice page is at http://localhost:3007/voice. |
   | `npm run voice-server` | optional, in a second window: local speech recognition and voice (Whisper + Kokoro, needs Python) |
   | `scripts\start-bot.bat` | keeps it running and restarts it if it crashes |

4. **Talk to it in game** like a person ("can you get me some iron?", "come here", "don't break that"). Say its name if other people are around. Owner commands start with `!`: `!status`, `!stop`, `!resume`, `!goal <text>`, `!goals`, `!emotion`, `!tasks`, `!set <setting> <value>`, `!help`. The full list is in [Commands](#commands).

To update it, run `git pull` and then `npm install`. Your `config.local.json` and the bot's memories in `data/` are never touched.

## Configuring it

- **`config.local.json`** holds your settings. `npm run setup` writes it, and you can edit it by hand. Anything in it overrides the defaults in `config.json` (don't edit that one; it's regenerated). Every option and its default is listed in `DEFAULT_CONFIG` at the top of `index.js`.
- **Without editing JSON:** `npm run set -- llm.fastModel qwen3:1.7b` writes one setting into `config.local.json` (it makes the section if it's missing and checks the name). `npm run set -- llm.fastModel` shows the current value; `--remove` goes back to the default. When the bot starts, it warns about any setting in your files it doesn't know, with a guess ("fastModel" isn't a setting; did you mean llm.fastModel?). It also says where a broken file is broken (line and column).
- **In game**, `!set <key> <value>` changes many settings live, and they're remembered until `!settings reset` ([Live settings](#commands)).
- **[CONFIGURING.md](CONFIGURING.md)** explains, with examples:
  - goals, feelings and personality (or the presets in `personalities/`: friendly, grumpy-miner, hype-builder, shy-explorer, anarchist);
  - intelligence level, chat style and reactions;
  - fighting and PvP, reflexes;
  - rules and manners, voice, voice chat, public networks and research.
- **Several bots or several servers**: `--profile <name>` gives a bot its own memories (`data/profiles/<name>/`), and `--server <name>` picks a server from `servers` in the config.

Environment variables also override the config, which is handy for scripts:
- connection: `MC_HOST`, `MC_PORT`, `MC_USERNAME`, `MC_AUTH`, `MC_VERSION`, `MC_PASSWORD`, `BOT_SERVER` (profile name);
- model: `OLLAMA_URL`, `OLLAMA_MODEL`;
- bot: `BOT_PERSONALITY`, `BOT_CHAT_MODE`, `BOT_INTELLIGENCE`;
- `BOT_DEBUG=1` for verbose logs.

## The other documents

| Document | For |
| --- | --- |
| [START-HERE.md](START-HERE.md) | first setup on Windows, with exact commands |
| [SETUP.md](SETUP.md) | everything else: hardware and models, friends' servers, online-mode servers (FastLogin), Bedrock accounts, running it all the time, voice from another PC |
| [CONFIGURING.md](CONFIGURING.md) | making the bot yours |
| this README | how each part works, every command and option, troubleshooting |
| [TRAINING.md](TRAINING.md) | fine-tuning the small model on the bot's own good decisions |
| [HISTORY.md](HISTORY.md) | how it was built, request by request |
| [CLAUDE.md](CLAUDE.md) | design notes and lessons learned, for whoever works on the code |

```
Perception (every 2s) ──► state + feelings + relationships + memories ──► LLM ──► {thought, emotion, goal, action}
        ▲                                                                              │
        └──────── result fed back into the next prompt ◄──── ActionExecutor (one action at a time)
Reflexes (every tick, no LLM): falls, lava, drowning, hits
```

## Running it on your server computer

The bot runs alongside Ollama on any PC that can reach the Minecraft server; it can be the same machine as the server. The bot draws nothing on screen, so it needs no graphics card itself; the GPU is for the LLM.

### Windows

1. Install:
   - [Node.js 22 LTS](https://nodejs.org);
   - [Git](https://git-scm.com);
   - [Ollama](https://ollama.com/download);
   - an up-to-date NVIDIA driver.
2. Download the model (`npm run setup` can do this for you and sets it in `config.local.json`):
   ```bash
   ollama pull qwen3:4b-instruct
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
   Install Node.js 22 and git with your package manager or NodeSource, then pull the model (or let `npm run setup` do it):
   ```bash
   ollama pull qwen3:4b-instruct
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

### Which model, and making it fast

**How the speed works:**
- **Danger never waits for the model** (see [Reflexes](#reflexes-reflexes)).
- **While it thinks, it keeps playing** (busy work).
- **Chat gets its own lane** with `llm.fastModel`: a small model answers chat while the big one plans, so a reply never sits behind a 4-second decision. That also keeps the big model's prompt cache warm: Ollama reuses the unchanged start of the decision prompt instead of re-reading ~3,400 tokens every time.
- **A compact decision prompt** (`llm.compactPrompt`, on automatically for models up to 8B): the same rules and tools in ~1,500 tokens instead of ~3,300. A GTX 1660 Super reads only ~200 tokens/s, so this alone saves ~9 s whenever the prompt isn't cached.
- **Settings:**
  - `llm.maxTokens` caps rambling;
  - `llm.keepAlive: "24h"` stops reloads;
  - `llm.think: false` turns off the slow "thinking" step of models like Qwen3.

**Speed settings that matter most (in `config.local.json`):** `{ "llm": { "model": "qwen3:4b-instruct", "think": false, "compactPrompt": true, "maxTokens": 300, "fastModel": "qwen3:1.7b" } }`. A 7B model with the full prompt and no fast model takes 15-20 s per decision. Run `ollama pull qwen3:4b-instruct` and `ollama pull qwen3:1.7b`, set `OLLAMA_MAX_LOADED_MODELS=2`, and `npm run set -- llm.fastModel qwen3:1.7b`. Not plain `qwen3:4b`: in Ollama that's a thinking-only version that reasons for pages before every answer.

**Smarter and faster on a small model:** set `llm.fastModel` (`qwen3:1.7b`) and `OLLAMA_MAX_LOADED_MODELS=2` so chat never waits for a decision (without it, a chat reply now cancels a running decision and the decision restarts after). The decision prompt asks for fewer tokens, the model can promise up to 2 follow-up actions that run without asking again (`next`), a fresh goal is kept for 2 minutes, and its previous thought is fed back to it. A 4B model cannot know real-world events: for that use a hosted model as `fastModel` (see below).

**Parkour skill (`parkour` domain, raised by practice):** beginning = basic 1-gap hops; simple = cleaner, plus a 2-block jump forward onto a block one higher; mediocre = 2-3 block jumps with sprint jumps, 2 (sometimes 3) onto a higher block; complicated = up to 4 block jumps, up to 3 onto a higher block, ceiling hopping, timed sprint jumps; advanced = sometimes 5 (with a drop) and sometimes 4 onto a higher block, odd-height blocks; hardcore = reliable, diagonals; master = every standard jump; impossible = Speed potions and perfect execution. A jump only gains 1 block of height, so "vertical" always means a forward jump onto a block one higher.

**Recipes by level:** the `knowledge` skill decides what it knows how to craft: beginning knows none (it experiments in the crafting grid or asks players), simple knows planks/sticks/table, mediocre adds wooden and stone tools and common blocks, complicated and above know everything. Whatever it works out is saved. To watch a beginner learn, set `intelligence.level` to `beginning`. "Get me <item>" now plans that exact item (cherry logs means cherry logs).

**Memory and saves:** `memory.*` in config; `node index.js --profile alex` keeps a separate bot save in `data/profiles/alex/`.

**On a GTX 1660 Super (6 GB):**

| Setup | VRAM | What to expect |
| --- | --- | --- |
| `qwen2.5:7b` alone (the default) | ≈ 5.5 GB | Good decisions, 4–8 s each; chat replies wait when a decision is running. |
| **`qwen3:4b-instruct` + `fastModel: "qwen3:1.7b"`, `think: false`** (recommended) | ≈ 4.5 GB together | Both lanes on the GPU: roughly 2–4 s decisions and about a second for chat. Measured: `qwen3:4b-instruct`-sized models sit 100% on a 1660 Super under Windows, `qwen2.5:7b` only ~80%. |
| `qwen2.5:3b` + `fastModel: "qwen2.5:1.5b"` | ≈ 3.5 GB | The fastest; a bit simpler in its choices. |

These are estimates: `npm run doctor` measures both lanes on your card. Pull the models with `ollama pull`. For two models at once, set `OLLAMA_MAX_LOADED_MODELS=2` alongside the other Ollama variables in SETUP.md step 4.

**Bigger cards:**

| VRAM | Main model | Chat model |
| --- | --- | --- |
| 8 GB (RTX 3060 Ti, 4060, 3070) | `qwen3:8b` or `qwen2.5:7b` | `qwen3:1.7b` |
| 12 GB (RTX 3060 12 GB, 4070) | `qwen3:14b` or `gemma3:12b` | `qwen3:4b-instruct` |
| 16 GB (RTX 4060 Ti 16 GB, 4070 Ti Super, 4080, 5070 Ti) | `gpt-oss:20b` or `qwen3:14b` | `qwen3:4b-instruct` |
| 24 GB+ (RTX 3090, 4090, 5090) | `qwen3:30b-a3b` (fast: only 3B active), `qwen3:32b`, `gemma3:27b` | `qwen3:4b-instruct` |

**Thinking-only versions:** some models think out loud before every answer and can't be switched off. Plain `qwen3:4b` is one; it ends its answers with `</think>`. In the bot that means slow decisions, so use the `-instruct` version. `npm run setup` tests a model for this, the doctor warns about it, and the bot strips the reasoning and logs a warning if it happens anyway.

New open models come out all the time, so check [ollama.com/library](https://ollama.com/library) for newer ones in these sizes. Compare them with the doctor (`OLLAMA_MODEL=<name> npm run doctor`). The model has to follow a JSON format and stay in character, and the Qwen and Gemma families are good at both.

**Not on your PC:**
- **Ollama cloud models** (tags ending in `-cloud`, after `ollama signin`) work with no other change.
- **Any OpenAI-compatible API** works with `"provider": "openai"`, the full `.../v1/chat/completions` URL, and `apiKey` (or the `LLM_API_KEY` environment variable):
  - fast open-model hosts: Groq, Cerebras;
  - OpenRouter (almost any model);
  - OpenAI's small models;
  - Anthropic's Claude Haiku 5.5 (`claude-haiku-5-5`) through its OpenAI-compatible endpoint. Its JSON mode isn't enforced there, but the bot's prompts and parser cope.

  Hosted models usually answer in well under a second.
- **Watch the bill:** decisions send ~5,000 tokens every few seconds, which is millions of tokens per hour of play. The cheap split is **decisions on your GPU, chat on a hosted model**:
  ```json
  "llm": { "model": "qwen3:4b-instruct", "think": false,
           "fastModel": "<hosted model>", "fastProvider": "openai",
           "fastUrl": "https://api.groq.com/openai/v1/chat/completions", "fastApiKey": "..." }
  ```
  Chat is a few hundred tokens a message.

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
| `index.js` | Config, perception, the LLM client (Ollama or OpenAI-compatible, with a fast chat lane), the decision loop, chat, reactions, commands, reconnects |
| `actions.js` | The tool API the LLM can call (including the PvP combat engine), plus the `ActionExecutor` |
| `emotions.js` | The emotion engine: six core feelings with decay, temperament and behaviour modifiers |
| `social.js` | Per-player trust and liking, intent reading, promises, body language |
| `tasks.js` | Judging requests by task type (plus obedience levels), and running them: progress, patience, partial hand-overs, forgetting |
| `combat.js` | The fight engine: weapons, projectiles, potions and consumables, per-mob tactics |
| `reflexes.js` | The fast layer (every tick, no LLM): fall prediction and clutches, lava/fire/drowning/TNT escapes, flinching and drawing a weapon when hit |
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

### Common sense, habits and a mental map

A small model forgets what it carries and repeats itself, so some things are checked in code before any action runs (`commonsense.js`). It won't:
- craft or fetch a second crafting table, furnace, bed, shield or other "one is enough" item (unless a player's task or a goal someone set asks for one);
- craft a tool it already has at least as good (a wooden pickaxe next to an iron one), unless the old one is nearly broken;
- craft armor no better than what it has;
- try the same failing action a third time;
- craft the same thing over and over;
- gather wood, stone or dirt when it already carries far more than it needs;
- eat on a full stomach, sleep in the daytime, or place a second furnace right next to the first;
- throw away valuables on its own.

The model is told why ("you already carry 3 crafting tables, and one is all anyone needs…"), and the prompt lists its stations and best tools.

**Habits** it does without asking the model (`habits.js`):
- puts on better armor and a shield;
- makes a new pickaxe, sword or axe before the old one breaks (Simple level and up; beginners let tools break);
- tosses junk when its pockets are full;
- keeps a tidy hotbar (sword, pickaxe, axe, shovel, blocks, torches, bucket, food; Advanced and up);
- lights dark tunnels;
- climbs out when stuck;
- heads home to its bed at dusk;
- runs back for its things after dying (not after lava or the void).

**Mental map** (`places.js`, saved): home, its bed, where it died, and the blocks it placed. When it's about to leave an area (exploring, a long walk), it first goes back for the crafting table, furnace or bed it set down there, unless that's home or a furnace is still cooking. Whether it remembers each block depends on skill: a Beginner often forgets its crafting table, a Master never does. `pickUpBlock` does the same on request.

**Moving and handling items like a player of its level:**
- Experienced players (parkour level 3+) sprint-jump along straight, flat stretches; beginners just walk (`behavior.sprintJump`).
- It never looks an enderman in the eyes once it knows about them.
- Crafting, furnaces, chests and putting on armor take menu time: about 2 s for a beginner, a fraction of a second for a master (`behavior.menuTime`).
- It turns its head smoothly (`behavior.smoothTurning`).

### Mouse and keyboard like a person (`look.js`)

How it looks around and walks is modelled on how people use a mouse and WASD:
- **Flicks:** a look at something new takes as long as Fitts's law predicts, so farther turns take longer and better players are quicker. The turn speeds up and then slows down (a minimum-jerk curve). It usually lands slightly short (sometimes a bit past) and makes a small correction, and the path bends slightly instead of being a perfect line.
- **Mouse steps:** turns come in Minecraft's own mouse steps (0.15°, the default sensitivity). A resting hand doesn't jitter.
- **Fights:** the crosshair tracks the target smoothly, always a little behind, and closer behind for better players.
- **Walking a path:**
  - The camera eases toward where it's going, a few steps ahead, looking a little down at the ground (beginners look down more).
  - The movement keys make up the difference: W, W+A, A, S+A, S, S+D, D or W+D, whichever heads closest to the next step. Players curve around corners with W+A/D while the mouse catches up.
  - Keys don't flicker, and sprinting starts a moment after walking does.
  - On narrow ledges, parkour jumps and blocks to dig it lines up exactly instead.
- **Instant:** reflex saves (clutches) stay instant: that's muscle memory.
- **Settings:** `behavior.humanKeys` and `behavior.smoothTurning`.

### Server manners and rules (`etiquette.js`, `etiquette`)

- **Rules people give it:** "don't kill my cows", "stop mining here", "no pvp" and "always close the door" become standing rules. It also reads rules from signs ("no griefing", "keep out") and from server announcements.
  - It decides whether to keep each one, like a person: its owner always; staff and signs unless it's an anarchist; ordinary players when the rule protects their own stuff, or when it likes them and the request is reasonable. Never someone hostile.
  - Kept rules are checked before every action. If what it's doing breaks one, it stops.
  - `!rules` lists them, `!rules forget <n>` and `!rules clear` remove them.
- **Understanding without being told:** it leaves alone:
  - mobs kept in player-made boxes or pens (the zombie in an iron farm, cows in a pen);
  - named mobs, pets, mobs in boats or minecarts;
  - villagers and golems.

  It won't dig, burn or loot inside someone's town or base (an area with lots of player-made blocks, not its own home). Signs naming a place (town hall, spawn, shop) mark it as public.
- **How law-abiding it is:** the personality's `lawfulness` (0 anarchist .. 1 by the book; default 0.75), or `etiquette.lawfulness`.
  - `etiquette.serverType`: `auto` (anarchy if the server's address says so), `community`, `smp` or `anarchy`.
  - The `anarchist` personality preset ignores all of it, except its owner.

### Redstone and game mechanics (`redstone.js`, `mechanics.js`, `tech.js`)

Experienced bots understand redstone and the contraptions players build.

**By knowledge level:**
- **2+:** recognises simple things (cobblestone generators, water sources).
- **3–4:** names farms and machines.
- **5+:** explains which mechanic each one uses and what it gives.
- **Master (6):** also judges how efficient they are and how to improve them, and can design, improve and build circuits.
- **Impossible (7):** also spots exploits (TNT duplication and the like) and warns that servers often ban them.

**What it can do:**
- **Simulate:** a redstone simulator (dust, torches, repeaters, comparators, observers, levers, buttons, lamps, pistons, in redstone ticks) works out what a circuit does: its truth table, timing, clock period or memory.
- **`inspectRedstone`:** reads the circuit around it out of the world and says what it computes, how fast, and what it costs. It also finds a cheaper circuit that does exactly the same job, testing every input combination, and lists the contraptions nearby.
- **`designCircuit` / `buildCircuit`:** NOT, OR, NOR, AND, NAND and a clock, or `copy` (with `improve: true`) to rebuild the circuit it just inspected in its cheaper form.
  - Building aims each part so the game gives it the right facing, checks it, and fixes wrong ones.
  - Then it tests the circuit by flipping the levers and comparing the real lamp with the simulation.
- **Recognises:** cobblestone generators, infinite water, observer crop farms (sugar cane, bamboo, kelp, pumpkin, melon, cactus), auto-smelters, item sorters, iron farms, trading halls, mob farms, chicken cookers, bubble elevators, ice-boat roads, piston doors, flying machines and TNT duplicators.

**Limits:**
- The simulator is logic-level: no quasi-connectivity, update order, container signal strength or moving blocks.
- It builds only the circuits it knows; farms it recognises and explains but doesn't build from a template.

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
  - **Any part counts:** a block is seen if any part of a face it's turned towards is in view (the top of a chest over a low wall, a log behind a gap in the leaves), anywhere within range, not only what it looks straight at. A creature is seen if its head, middle, feet or either side shows (a zombie's legs under a leaf canopy). Barely visible things far away are easier to miss for weaker players.
  - It only knows about ores and other blocks it has actually seen. A block sealed in rock with no open side is unknown to it (mineBlock skips it; stripMine digs to find ores).
  - **Seeing isn't reaching** (`reach.js`): to place, open, use or mine something it needs a clear line from its eyes to a face of it, like a crosshair. It never places a table through leaves or opens a chest through a wall. It walks to where it can see the spot, punches through leaves and grass when they're in the way of something it's mining, and otherwise says what's blocking it.
  - Impossible tracks every entity the server sends, even through walls.
  - Players' name tags also show through walls unless they sneak (see [Name tags](#name-tags)).
- **Hearing** (`hearing`): every sound the server sends (about 16 blocks, through walls) is sorted into mob noises, footsteps, chests/barrels/doors opening, blocks breaking or being placed, combat (bows, crits, shields, splash potions), anvils, spawners, and the **creeper hiss**. A hiss makes it back away even if it can't see the creeper. World-wide sounds (a wither spawning, the dragon dying) are noticed too.
- **Particles** (`particles`): crits, mining dust, cracks spreading on a block, smoke, portal particles, hearts and potion splashes — when close, roughly in front of it, and in line of sight.
- **Suspicion:** a player-type sound or particle with no visible source (footsteps, a chest opening, mining) makes it suspicious.
  - Knowing other players are around greatly reduces that. If someone just walked behind a wall, a chest opening back there barely registers.
  - Past `suspicionThreshold` it gets nervous and **goes to investigate** (more likely when curious).
  - Tested live: with nobody known nearby, a chest opening behind a wall pushed suspicion to "high" and set an investigation at that spot. With a player who had just gone behind the wall, the same sound stayed below the threshold.

`!senses` shows what it has heard and noticed recently.

### Sizing up creatures (`threat.js`)

For every creature it perceives, it works out two things and a verdict, the way a player glances at a mob and knows whether to swing or back off:

- **Danger:** how much of its health it would expect to lose killing it, from the creature's damage, attack speed and health against its own weapon, armour, shield, health, totem and skill. Several at once add up: they all hit while it kills them one by one. A creeper is judged by its blast (a bow makes it safe), and a warden is never worth it.
- **Worth:** what a fight gets it:
  - drops it wants (for its task or what it's getting), food when it's hungry or out of food;
  - ending a threat that will chase it anyway, protecting a friend nearby, getting back at what hit it.
  - Fights it would only start are not worth it: neutral mobs it would provoke (endermen, piglins when it wears gold, iron golems, wolves), animals it doesn't need, babies, and anything protected (pets, named mobs, farm mobs: "leave").
- **Verdict:** fight, hunt, avoid (keep away), flee (get out now), leave, or ignore. Braver personalities (`mind.riskTolerance`), anger and fear move the line.

The verdicts go into the decision prompt (`status.threats`, e.g. `zombie 4m: danger some, worth fighting (it will come for you anyway) → fight`). The instant reactions use them too:
- it deals with a zombie it can easily take before the first hit;
- it keeps away from one it can't (bare hands, low health);
- it gets out when there are too many;
- danger in chat (short replies) is about real danger, so one zombie against full iron isn't an emergency.

Only creatures it actually perceives count, never ones hidden behind a wall.

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

**Directions from owners and admins** that the code knows how to do itself are never lost to a misread. "mine down", "look for iron", "go find diamonds" and "staircase down" become a task even when the model takes them for small talk. The task first gets the pickaxe that ore needs, then runs `stripMine`: a staircase down to the best depth, then tunnels. A follow-up like "staircase instead" or "look for iron while you're at it" updates the task it's on. Being told what to do, or how to do it, is never counted as rude from someone in charge (only real insults are), and from others it costs at most a little trust.

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

## Watch it in a browser (`viewer`, off by default)

Start it with `npm run viewer` (or `npm start -- --viewer`), or type `!viewer on` in game. Then open **http://localhost:3007**. The page fits the window (no scrolling):
- **Its view:** first person, live, at Minecraft's normal field of view (70; a slider changes it).
  - **Smooth:** the camera glides between the positions and head turns the bot reports, instead of jumping in steps (the **Smooth** button).
  - **Like the game** (the **Sky & hand** button), all from Minecraft's own textures:
    - the sky by time of day, with sunrise and sunset colours;
    - the sun, the moon in its current phase, stars, drifting clouds;
    - fog at the edge of the view, rain or snow when it's outside;
    - darker nights and caves; blue fog under water, orange in lava, red in the Nether;
    - Steve's arm or the item or block it holds, with the swing and the equip dip;
    - cracks on the block it's breaking;
    - the vignette, the pumpkin blur, the camera tilting when it's hit, and "You died!".
  - **View bobbing** while walking, as in the game (the **Bobbing** button), and lower eyes when sneaking.
  - Worlds newer than 1.21.4, like 26.1, are translated block by block so they still render.
- **The game's HUD:** hearts, food, the XP bar and the hotbar with the selected slot, drawn with Minecraft's own textures. In the corner, like F3: coordinates, facing, dimension, game mode, day and time, what it's doing and its goal. You always see the coordinates; the page says when the bot itself can't.
- **Chat like the game's:** the last few lines fade out over the view. **T** (or the Chat button) opens the whole history to scroll through, filtered by chat, thoughts or actions, with the message box:
  - **Talk to it:** a message from you as its owner.
  - **!command:** any owner command (**/** opens it in this mode).
  - **Make it say:** it says your text in game chat.
- **Side panel** (the **Panel** button hides it for a full-screen view):
  - **Inventory:** Minecraft's inventory screen with item icons, armor, off-hand, the crafting grid, counts and durability bars; hover for names.
  - **Feelings:** how it feels now and the six feelings underneath, its last thought, and buttons to set a feeling (with a strength, and a lock to keep it).
  - **Goals & tasks:** the overall goal, long-term goals, the current goal and its steps, goals waiting for later, and players' tasks. Add, edit, finish, drop or reorder them; call off a task; or ask it to do something (it decides, like a person).
- **Point things out:** **Point** (P) and click something in the view, or **Circle** (C) and draw around things, then add a note if you like ("mine these", "stay away from that"). It works out exactly which blocks and creatures you meant from its own copy of the world, outlines them in the view, remembers them for a few minutes, and gets your note as if you had said it while pointing.

It only listens on your PC. To watch from another device, set `viewer.host` to `"0.0.0.0"` **and** a `viewer.password`, then open `http://<pc>:3007/?key=<password>`. `viewer.viewDistance` (chunks, default 4) controls how much the browser draws.

## Talking to it out loud (`voice`)

Start it with `npm run viewer` and open **`/voice`** (e.g. http://localhost:3007/voice) on the PC you play on, or on a phone with earbuds. Press Start and leave it open.
- **Hands-free:** say its name ("hey Wanderer, come here"). For 30 seconds after that, or after it speaks, follow-ups need no name, like a conversation. Push-to-talk works on the page itself (the button, or V).
- **Its answers are spoken** on that page, never typed in game chat. Its replies to its owner go to voice whenever a voice page is open.
- **"Show me how…", "explain…", "how do I…":** it explains in a few spoken steps and does each one in the game as it says it (`explainAndShow`). It looks at what it's talking about and outlines it in the viewer, and the next line only starts when the step is done.
- **Engines:**
  - **Browser (default):** Chrome or Edge recognition (your audio goes to Google or Microsoft) and the PC's voices. Nothing to install.
  - **Local (recommended):** `npm run voice-server` runs Whisper (faster-whisper) and Kokoro on the bot's PC, on the CPU so the graphics card stays free for Ollama (SETUP.md → "Fully local speech"). Set `voice.stt`/`voice.tts` to `"server"` with the URLs.
  - Any other OpenAI-compatible server works too: `/v1/audio/transcriptions` (whisper.cpp's server, speaches) and `/v1/audio/speech` (Kokoro-FastAPI, openedai-speech).
  - The page records 16 kHz WAV, so servers don't need ffmpeg. Long answers are spoken sentence by sentence, so the first sentence plays while the next is being made.
- **From another PC:** browsers only allow the microphone on https or on the same PC. Set `viewer.host` to `"0.0.0.0"`, a `viewer.password`, and `viewer.https: true`, then open `https://<bot-pc>:3007/voice?key=<password>`. Click through the certificate warning once (it's the bot's own certificate).
- **In-game voice chat** (Simple Voice Chat, PlasmoVoice) isn't supported: there's no Node client for Simple Voice Chat, and public servers rarely have it.

## In-game voice chat (Simple Voice Chat, `svc`)

On servers with the Simple Voice Chat mod or plugin, the bot joins voice chat by itself and talks and listens like a player with a microphone.
- **Speaking:** its words are spoken through Kokoro (the local voice server) and sent as proximity voice. People near it hear it in game.
- **Hearing:** what players say near it goes through Whisper. It answers when someone says its name, or keeps talking with whoever is already talking with it, in voice. People talking to each other are left alone.
- **You:** when you're close enough to hear it in game, it talks to you there instead of in chat or on the voice page (`svc.preferForOwner`).
- **"Show me how…" by voice** works here too: it explains in voice chat while doing it.
- **Needs:** the voice server (`npm run voice-server`), with `voice.stt` and `voice.tts` set to `"server"`. Nothing to install on the Minecraft server beyond the mod it already has.
- **How:** it implements the mod's own protocol (version 21, the 2.6/2.7 releases): the secret over the Minecraft connection, then encrypted UDP with Opus audio. If a server runs a newer release that refuses it, raise `svc.compatibilityVersion`.
- **Tested** against a fake voice server written from the mod's source code. Not yet on a real server.

## Public servers and minigame networks (`network`)

- **What it notices:** when it's on a minigame network (sidebar scoreboard, named hotbar items like "Game Selector", a store link in the tab list, lots of players).
- **What it reads:** the sidebar, boss bars, titles, the action bar, the named hotbar items and any open menu, plus the commands the server offers (tab completion). All of this goes into its view of the game (`state.server`).
- **Actions:**
  - `useHotbarItem` (open the game selector), `readMenu`, `clickMenu` ("Bed Wars", "Solo", or a slot);
  - `serverCommand`: player commands only (/play, /hub, /party, /friend, /tpa...). Never admin ones.
  - `joinOwner`: walk to you if you're here, or ask you to invite it.
- **`navigateMenus`:** gets somewhere through the menus by itself: "play Treasure Wars solo", "accept EndlessSkys's party invite", "create a party", "go to the hub".
  - It picks the hotbar item that fits (game selector, party/friends menu...) and reads each menu.
  - It clicks the entry that matches best and goes deeper, or backs out and tries another item when an entry leads nowhere.
  - It reports the path it took: "Game Selector → Treasure Wars → Solo".
- **Following you:** party, friend and teleport invites **from its owners** are accepted by themselves:
  - **Java:** it uses the clickable [ACCEPT] or the command the message names, falling back to the menus if the server doesn't know the command.
  - **Bedrock (The Hive), where chat can't be clicked:** it accepts through the menus (`network.inviteVia`: `auto`, `chat` or `menu`).
- **Server notices:** "game starts in 10 seconds", your team, the queue, rewards. They go into its view of the game, so it knows what's happening on servers whose chat is just notifications.
- **Quiet in public:** on a network it doesn't talk in public chat (`chat.publicChat: "auto"`). It talks to you privately, or out loud on the voice page.
- **Limits:**
  - **Accounts:** public servers check accounts, so the bot needs its own Microsoft account with Minecraft (an offline account can't join), and many networks forbid bots, which can get its account banned.
  - **Bedrock networks:** The Hive is Bedrock-only and would go through the Bedrock route. That route can't break blocks or use inventories, and its menu support is early.
  - **Minigames:** the model is slow for fast PvP minigames; its reflexes fight, but it won't play like a skilled player.

## PvP for fun

- **Friendly spars:** "1v1 me", "let's pvp". It always takes its owner up on it (others depending on how it likes them).
  - On a normal server it fights for real (its combat skills, by level) but stops when either side drops to 3 hearts, says "gg", and nobody loses their stuff.
  - "to the death" (or an arena) fights it out. `pvp.sparStopHealth` sets where it stops.
- **PvP minigames:** duels, SkyWars, Bed Wars, The Bridge, sumo, FFA, UHC, Treasure Wars... It recognises them from the scoreboard, boss bars and titles, but not in the lobby or while waiting in the cage.
  - Once the game is on, it goes after the nearest enemy it can see, including you if you're on the other side.
  - It never attacks a teammate (read from the scoreboard teams and name colours).
  - Server PvP rules don't stop it inside the game.
  - The model still decides the rest: objectives, loot, bridging, beds. Master and Impossible bots also read up on the minigame (below).

## Reading up online (`research`, Master and Impossible only)

The best bots look things up like a dedicated player reading the wiki and guides:
- **Lookups:** how a server's minigame works, good redstone designs, building ideas, strategies.
- **Sources:** DuckDuckGo (no key needed; or your own SearXNG with `research.searxngUrl`, or Brave Search with `research.braveKey`) and the Minecraft Wiki's API.
- **What it keeps:** it reads the top pages and keeps a few short practical notes, with sources. They're saved, and the ones that fit what it's doing go into its decisions from then on.
- **How:** the `research` action, plus the first time it plays a minigame on a network it reads up on it by itself (`research.autoMinigames`).
- **Queries** only contain the topic (and a public server's address for its minigames), never anything about you.
- **Only for Master and Impossible**, by configured level (`research.minLevel`); `research.enabled: false` turns it off.
- **Limit:** a redstone design or a build it reads about becomes notes for the model. Building it in code still only works for the designs it knows (see Redstone).

## Game modes and coordinates

**Game modes:** it reads the game mode and plays accordingly.
- **Creative:** no reflexes or survival routines; `obtainItem` takes things straight from the creative inventory; it builds freely.
- **Adventure:** no breaking or placing blocks, and no digging while walking.
- **Spectator:** it only looks, follows and talks.
- **Hardcore:** it's told it has one life, and it never dies on purpose.

**Turning:** it turns its head over a few ticks like a person (faster at higher skill), instead of snapping. Walking a path, fighting, reflexes and aimed placements stay instant. `behavior.smoothTurning: false` turns this off.

**Coordinates (F3):** it only knows its own coordinates if it knows the F3 screen.
- **Simple and up** know it from the start. **Beginners** learn it when someone tells them ("press f3 to see your coords").
- **Servers can hide them:** when a server hides F3 coordinates (`reducedDebugInfo`), it doesn't see them, however smart it is.
- **Without F3** it thinks in "6 east, 2 down" from itself, and its actions take `dx, dy, dz`.
- **Override:** `perception.coordinates: true/false`.

## Goals (`goals`)

It always knows what it's working toward, on four levels:
- an **overall goal** ("become the best builder on the server");
- a few **long-term goals** that serve it ("build a castle on the hill");
- the **current goal** ("gather 64 cobblestone");
- the **steps** for that ("craft a stone pickaxe → find a cave → mine cobblestone").

**Where goals come from:**
- **Set** in your config (`config.local.json`) or by an owner in chat (`!goal`). Set goals stay until they're done or an owner changes them.
- **Made up by the bot** from its personality, ambitions and situation, if `goals.selfDirected` is on. It changes its own goals as it goes.

**How it works toward them:**
- Every decision aims at the current step, and reports progress: step done, goal done, stuck, or "changed my mind".
- Something urgent becomes a **detour** (eat, flee, help someone) and the plan waits, so it comes back to what it was doing.
- A detour that lasts a few minutes means it really did change its mind (its own goals only).
- Now and then, and whenever a goal finishes or gets stuck, a low-priority planning call steps back and revises the whole tree. It never blocks playing.

All of it is saved in `data/brain.json` and shows in every decision prompt. **How to set it:** [CONFIGURING.md → Goals](CONFIGURING.md#goals).

## Reflexes (`reflexes`)

The LLM is far too slow for danger: even a fast model takes most of a second, and on a 6 GB card a decision takes seconds. So falls, lava and getting hit never go through it. `reflexes.js` checks the body **20 times a second** and acts after a human reaction time (≈420 ms for a Beginner, ≈70 ms for Impossible). It stops the current action, and the LLM hears about it afterwards ("you fell 22 blocks and water-bucket clutched").

**Falls.** Every tick it simulates the fall (gravity, drag, what's below). That gives where it will land, how many ticks it has, and the damage, counting Feather Falling, Protection, jump boost, slow falling, and soft landings like water, slime, hay, beds and powder snow. If the fall will hurt, it scores every save it knows and has the items for. The score is the chance of pulling it off × the damage it prevents, minus what it costs. Then it does the best one:

| Save | Known from | Notes |
| --- | --- | --- |
| Steer onto water / slime / hay | Simple | air-strafes toward it; shallow water from very high up doesn't count |
| Block against the edge it slipped off | Mediocre | lands one to three blocks down instead of at the bottom |
| Slime block / cobweb / hay bale | Mediocre | placed on the landing spot (hay only takes 80% off) |
| Water bucket | Complicated | not in the Nether; scoops the water back up |
| Totem to the off-hand | Complicated | when the fall would kill and nothing else is sure |
| Ender pearl at the ground | Advanced | costs the pearl's 5 damage |
| Elytra | Advanced | opens it and glides, keeping the descent slow enough that the game resets the fall |
| Powder snow bucket, slow falling | Advanced | |
| Crouch at the edge against knockback | Hardcore | so a hit can't push it off a ledge |
| Ladder / vine on a wall, scaffolding | Master | caught on the way down |
| Boat clutch | Master | places a boat, gets in before landing, breaks it after |
| Mace smash on a mob below | Master | a mace hit resets fall damage; never a player or someone's pet |
| Jump onto a mount or a cart | Master | |
| Crouch-clutch | Impossible | a block under its feet the instant it slips, with no reaction delay |
| Wall / ledge pearl | Impossible | pearls into a wall or onto a ledge low down; works over lava or the void |
| Frame-perfect timing | Impossible | no penalty for windows under a tick (falls from 50+ blocks) |

**How well it does them** comes from survival skill and practice. A Complicated player water-clutches a 20-block fall ~90% of the time and an Advanced one ~97%. An Advanced player who has learned the boat clutch only lands it ~60% of the time, a Master ~87%. Very long falls leave less than a tick with the ground in reach, so they're hard for everyone except Impossible. A miss is acted out like a real fumble: the click comes a moment too late.

**Learning saves.** A Beginner knows none of these. After a fall that hurts, it may realise what would have helped, if it was carrying the item and the trick isn't far beyond it. A player can also teach it in chat ("place a water bucket right before you land"). With enough practice a Beginner keeps growing past the Advanced level and can end up better than a Master, but it takes a long time. Learned saves and practice are saved in `data/brain.json`.

**Other dangers:**
- **Lava:** pours water if it can, then jumps and sprints to the nearest cool block; drinks fire resistance if it's stuck.
- **Fire:** water bucket, or the nearest water.
- **Drowning:** sharper players react to the air bar sooner. It swims straight up if there's air, otherwise to the nearest surface; it drinks water breathing, and Masters place a door for an air pocket.
- **Suffocation:** digs out, or moves.
- **Lit TNT:** runs.
- The pathfinder avoids tripwires, magma, berry bushes, powder snow, campfires, cactus and wither roses.

**Getting hit:**
- **One punch:** it flinches, stops for a moment and turns toward the hit. Sharp players look straight at the attacker. A Beginner turns roughly the right way and then looks around ("where did that come from?").
- **A real attack** (a weapon, repeated hits, or someone it already distrusts): weapon in hand and shield to the off-hand. The fight-or-flight decision follows at once, even if the LLM is in the middle of thinking (that answer is thrown away).
- **Talking it down:** a player can talk it out of a fight ("ok ok sorry, truce"). It decides on the spot, from how much it likes and trusts them, its forgiveness, how hard they hit it, and whether they're still swinging. Someone who breaks a truce won't get another one easily.
- **The mind still decides:** reflexes start fights fast, but every `pvp.rethinkSeconds` (6) during a fight with a player, the LLM is asked whether to keep going, stop or run. The fight carries on while it thinks, so it doesn't lag. It can stop because they apologised, it's pointless, or they're a friend, and it can say something while doing it.
- **Chat and actions stay in step:** what just happened (fights, saves, truces, goal changes, deaths) goes into every chat reply. So when it says "fine, truce", it really has stopped, and it can tell people how it survived that fall.

| Option | Default | |
| --- | --- | --- |
| `reflexes.enabled` / `falls` / `hazards` / `hitReactions` / `truce` | `true` | switch parts off (all settable in game with `!set`) |
| `reflexes.reactionMs` | `null` | a fixed reaction time instead of the skill-based one |
| `reflexes.learnSaves` | `true` | learn saves from experience and chat |

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

- **It keeps at what it decided** (`routines.js`), so the model isn't asked again after every block:
  - When the step it's on names an amount ("chop 20 logs", "mine 8 cobblestone") and it starts mining or crafting toward it, getting all of it becomes one routine (any kind of log counts for wood).
  - When it sets off to find something ("find trees", "look for a village", "find cows"), it keeps exploring until that's in sight.
  - When it goes strip mining, it keeps tunnelling until ore turns up.
  - It thinks again when the routine is done or stuck, or something happens: danger, a request, the plan changing.
- **Thinking while moving:** while an action runs, it already works out the next one (`loop.prethink`) and uses that answer if nothing changed meanwhile. Busy work fills the rest.
- **Fast to re-read:** the decision prompt puts what changes slowly first and what changes every second last, so Ollama reuses most of it from its cache. In a test, the reusable share of the state went from 8% to about half.

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
| `shelter` | — get through the night: sleeps in a bed (places a carried one), otherwise digs in two blocks, covers its head, waits for morning and climbs out. Done by itself at nightfall unless it's a skilled, armed player (`behavior.nightShelter`). |
| `pillarUp` | `height?` — jump-place blocks under itself. Done by itself when surrounded by zombies and hurt. |
| `climbOut` | `maxHeight?` — out of a pit or hole: pillars up with blocks, or digs a staircase without. Done by itself after two failed moves while walled in. |
| `bridge` | `direction, length?` — crosses a gap crouched, placing blocks in front. |
| `stripMine` | `ore?, minutes?` — goes to the best depth for the ore (1.18+ or older worlds), tunnels 2 high, avoids lava and water, mines ores it uncovers, places torches; continues in the same direction next time. |
| `placeTorch` | — lights up where it is. Done by itself in dark tunnels when it carries torches. |
| `dropItems` | `itemNames, keep?` — throw items on the ground (`"junk"` = rotten flesh, seeds, dirt, gravel...; valuables only when named exactly). `collectDrops` also throws out a stack of junk by itself when the inventory is full and something better is lying there. |
| `obtainItem` | `itemName, count?` — get any item by doing the whole chain itself: wood, the tools it needs, mining with the right pickaxe, crafting, smelting (furnace and fuel included) and hunting. `"food"` = a cooked meat the animals around give. One model decision, then every step runs at full speed without asking the model again; it looks elsewhere when something isn't found and gives up after a few tries. |
| `collectDrops` | `radius?, itemName?, everything?` — picks up what's worth having: valuables, what its goal or task needs, useful things, its own items where it died. Leaves things another player dropped for themselves or lost when they died, junk, and anything next to a monster or in lava (`pickup.js`). Each item in `nearbyEntities` shows `pickUp: take/leave` with the reason. |
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
| `respawn` | `reason` — die on purpose to respawn (stuck, trapped, lost with nothing valuable). Uses `behavior.respawnCommand` if set, otherwise lava or a big drop nearby; the reflexes stand down while it does. Never on hardcore worlds, at most once per 10 minutes, off with `behavior.allowRespawnOnPurpose: false`. |

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
| `!goals`, `!goal life\|add\|done\|drop\|steps\|replan …` | admin (setting: owner) | the whole goal tree, and changing any level of it — see [CONFIGURING.md](CONFIGURING.md#goals) |
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

**Java is the main route, and it needs no account.** `server.auth` defaults to `"auto"`:
- a player name as `username` → an **offline account** (the same thing as a PrismLauncher offline account);
- a Microsoft email as `username` → it signs in with that **Java account** (once, in a browser; the token is cached in `data/auth`);
- if that sign-in fails → it plays as the offline account instead (`server.offlineName`, default: the part of the email before the `@`).

`"offline"` or `"microsoft"` force one of them.

| Server type | What the bot needs |
| --- | --- |
| **Offline-mode** (`online-mode=false`, often with a login plugin) | Nothing: the default offline account. Set `server.password` and it answers `/register` and `/login` prompts automatically (AuthMe, nLogin, ...). |
| **Online-mode, with FastLogin** installed by the host | The offline account + `server.password`. FastLogin keeps paid players on their own UUIDs, so their saves stay; see SETUP.md 6D. |
| **Normal (online-mode) Java server** | Its own Java account (email as `username`), or the Bedrock route below. |
| **Realms** | A Java account invited to the Realm: `"realm": "Realm name"`. |

- **Your own Java account** works, but one account can only be online once. If you log in while the bot is on, it's kicked with "logged in from another location". It then **stops reconnecting** (or switches to its `fallback` route), so it never kicks you back off. Use it when you aren't playing.
- **Bedrock accounts can't sign into Java servers directly.** Mineflayer only speaks the Java protocol. The route that works is through ViaProxy and a server running Geyser + Floodgate — see [Using a Bedrock account (ViaProxy)](#using-a-bedrock-account-viaproxy).
- PrismLauncher "offline" accounts are just offline mode: they only work on offline-mode servers.
- Note: Minecraft for PC has been sold as "Java & Bedrock Edition" since 2022 — if you bought it on PC since then, you already own Java (on your own account, which you're using).

### Backup route (`server.fallback`)

Keep Java as the main route and a Bedrock (or any other) profile as a backup: set `server.fallback` to the name of a `servers` profile. The bot switches to it when the server refuses the offline account, when a forced Microsoft sign-in fails, or when someone logs in with the same Java account (then it keeps playing as the backup account instead of kicking you). It never switches back by itself; restart to try the main route again. `npm run doctor` checks that the backup answers. Example in SETUP.md 6C.

### Modded servers

The bot is a vanilla Java client: it can't load mods. It joins servers whose mods are **server-side** (Fabric with Lithium and the like, Paper plugins, datapacks), and it can't join Forge/NeoForge modpacks that need the mods on the player's side. When a server's ping lists Forge/NeoForge mods, the bot and the doctor warn about it. If it's kicked for missing mods, it says so and stops retrying.

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
    "sam": { "host": "sam.example.net", "port": 25565, "username": "botaccount@example.com" },
    "lan": { "host": "192.168.1.20", "port": 25565, "username": "Wanderer", "password": "s3cret" }
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

- **`Disconnected: socketClosed` right after "Connecting…"**, with no kick message: the server closed the connection during login. If the server is running and other clients can join, update the bot (`git pull`). The update that added Simple Voice Chat (18 November 2026) sent a packet before the handshake, and real servers drop that. Otherwise check `server.version` (leave it empty to auto-detect) and that the port is the Minecraft server's, not a proxy's.
- **`ECONNREFUSED` / "Nothing is running at …"**: the server isn't up yet or the port is wrong. The bot keeps retrying.
- **"Cannot reach Ollama"**: start it with `ollama serve`, or set `llm.url` / `OLLAMA_URL`.
- **"Server version … is not supported" / "Outdated client"**: see [Minecraft 26.3 and other newer versions](#minecraft-263-and-other-newer-versions).
- **Slow decisions**: every decision logs `Thought for 4.1 s (read 820 new tokens, wrote 95 at 45/s)`.
  - **Many tokens read each time**, with "the cache was wiped by a chat reply": chat replies on the same model push the decision prompt out of Ollama's cache. Set `llm.fastModel` to `qwen3:1.7b` (with `OLLAMA_MAX_LOADED_MODELS=2`), or set `OLLAMA_NUM_PARALLEL=2`. The bot says so once in the log when it sees this happening.
  - **A low writing speed** (under ~15/s): the model is partly on the CPU (`ollama ps`).
  - **"had to load the model again"**: something pushed the model out of the graphics card.
  - Otherwise use a smaller model, lower `llm.numCtx`, or raise `loop.minLlmIntervalMs`.
- **Kicked for spam**: raise `chat.minSecondsBetweenMessages` and lower `chat.maxMessagesPerMinute`.
- **Builds stall** with "missing materials": give it the materials, or let it gather them. `!build` shows what's left, and `!build cancel` drops the plan.
- **Online-mode servers** ("Failed to verify username"): the offline account was refused. Use a Java account email as `username`, ask the host about FastLogin (SETUP.md 6D), or set a Bedrock `server.fallback`.
- **Start relationships over**: stop the bot and delete `data/brain.json`, or use `!forget <player>` / `!trust <player> reset`.
