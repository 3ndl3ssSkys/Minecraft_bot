# Setup guide — start to finish

This walks through everything, in order, from an empty PC to the bot playing on a server. For what each feature does, see [README.md](README.md).

**Contents**
1. [What you're setting up](#1-what-youre-setting-up)
2. [Decide how the bot joins](#2-decide-how-the-bot-joins)
3. [Install the software](#3-install-the-software)
4. [Download the AI model](#4-download-the-ai-model)
5. [Get the bot](#5-get-the-bot)
6. [Connect it to a server](#6-connect-it-to-a-server)
7. [Configure the bot](#7-configure-the-bot)
8. [Give it a personality](#8-give-it-a-personality)
9. [Check everything and start it](#9-check-everything-and-start-it)
10. [Talking to it in game](#10-talking-to-it-in-game)
11. [Keep it running](#11-keep-it-running)
12. [Updating and backups](#12-updating-and-backups)
13. [Troubleshooting](#13-troubleshooting)

---

## 1. What you're setting up

```
          your server PC
 ┌─────────────────────────────────┐
 │  Ollama (AI model, uses the GPU)│
 │        ▲                        │
 │        │                        │          Minecraft server
 │  the bot (Node.js, no GPU) ─────┼──────►  (yours or a friend's)
 │        │                        │
 │  [ViaProxy — only for the       │
 │   Bedrock-account route]        │
 └─────────────────────────────────┘
```

- **Ollama** runs the AI (Qwen 2.5). This is the only part that uses the graphics card.
- **The bot** is a headless Minecraft player. It doesn't open the game, draw anything or use the GPU.
- **ViaProxy** is only needed if the bot uses a Bedrock account (see step 2).
- **The Minecraft server** can be on the same PC or anywhere else.

**Hardware.** For example, a GTX 1660 Super (6 GB) with 32 GB RAM:

| | |
| --- | --- |
| `qwen2.5:7b` | Fits in 6 GB (comfortably with the Ollama settings in step 4). About 4–8 s per decision, 2–5 s per chat reply. |
| `qwen2.5:3b` | ≈ 2 GB, about twice as fast, a bit less clever. Use it if the GPU is shared with something else. |
| RAM | 32 GB is plenty for Ollama + the bot + a Minecraft server (give the server 4–8 GB). |

`npm run doctor` (step 9) measures your real speed.

---

## 2. Decide how the bot joins

**The bot plays Java by default and doesn't need an account.** With the default `"auth": "auto"`:
- if `username` is a **name** (like `Wanderer`), it joins as an **offline account** — no Microsoft login, nothing to buy;
- if `username` is a **Microsoft account email**, it signs in with that Java account instead;
- if that sign-in fails (the account doesn't own Java, or the login expired), it drops back to the offline account.

Offline accounts are accepted by **offline-mode** servers. Normal (online-mode) servers check every login with Microsoft, so there the host either installs FastLogin (step 6D, keeps everyone's saves) or the bot uses another route. Pick the first row that fits:

| Situation | Route | Bot features |
| --- | --- | --- |
| Server is **offline-mode** (no Microsoft login), with or without a login plugin like AuthMe | Java, offline account — the default (+ `password` for the plugin) | everything |
| Online-mode server whose host installed **FastLogin + a login plugin** (step 6D) | Java, offline account + `password` | everything |
| You have a **spare Java account** for the bot | Java, its email as `username` | everything |
| Server has **Geyser + Floodgate**, and you have a **Bedrock account** | **ViaProxy** with your Bedrock account (step 6B), e.g. as the **backup route** (step 6C) | no mining, chests, crafting or building (translation limits); walking, chatting, fighting and items work |
| A **Realm** your bot's Java account is invited to | `"realm": "Name"`, email as `username` | everything |
| Server has **Geyser without Floodgate**, and you only have Bedrock | Not possible: Geyser asks every Bedrock player for a Java login. Ask for Floodgate, or use a Java route. | — |
| Your own Java account, only when you're **not** playing | your email as `username` | everything (it backs off, or switches to its backup route, when you log in) |

**Java is the better route** whenever it's possible: the bot can mine, use chests, craft and build there, and every skill works. Keep Bedrock as the backup (step 6C).

**Modded servers:** the bot is a vanilla Java client and can't load mods. It joins Fabric or Paper servers whose mods and plugins are server-side (most performance mods, plugins, datapacks), but not Forge/NeoForge modpacks that need the mods installed on the player's side. The doctor and the bot's log say when a server is like that.

**Not sure which kind of server it is?** After step 5, run `npm run doctor -- --probe-login`. It tells you if the server is online- or offline-mode.

**It's your own server?** You control it, so the easiest options are:
- install **Geyser + Floodgate** plugins and use the Bedrock route; or
- give the bot a Java account.

(Running your server in offline mode works too, but then anyone can join as any name, so add a login plugin like AuthMe if you do.)

---

## 3. Install the software

### Windows

1. **NVIDIA driver:** update it (GeForce Experience or nvidia.com).
2. **Node.js 22 LTS:** https://nodejs.org. Use the installer with default options.
3. **Git:** https://git-scm.com. Default options.
4. **Ollama:** https://ollama.com/download. It runs in the background after installing (tray icon).
5. **Java 21+:** only if you'll use ViaProxy or host a Minecraft server on this PC (https://adoptium.net).

Check in a new terminal (PowerShell):
```bash
node -v
```
```bash
git --version
```
```bash
ollama -v
```

### Linux

1. Install Ollama, which also installs a service:
   ```bash
   curl -fsSL https://ollama.com/install.sh | sh
   ```
2. Install Node.js 22 (from your distribution, or https://github.com/nodesource/distributions) and git.
3. Java 21+ only if needed (e.g. `sudo apt install openjdk-21-jre-headless`).

---

## 4. Download the AI model

```bash
ollama pull qwen2.5:7b
```

**Recommended for 6 GB cards:** these settings make the model's working memory smaller and keep it loaded.

| Variable | Value | Why |
| --- | --- | --- |
| `OLLAMA_FLASH_ATTENTION` | `1` | |
| `OLLAMA_KV_CACHE_TYPE` | `q8_0` | about halves the memory the conversation context takes |
| `OLLAMA_KEEP_ALIVE` | `24h` | no reload delay between calls |

- **Windows:** Start → "Edit environment variables for your account" → New, for each one. Then quit Ollama from the tray and start it again.
- **Linux:** run `sudo systemctl edit ollama`, add the following, then `sudo systemctl restart ollama`:
  ```
  [Service]
  Environment="OLLAMA_FLASH_ATTENTION=1" "OLLAMA_KV_CACHE_TYPE=q8_0" "OLLAMA_KEEP_ALIVE=24h"
  ```

---

## 5. Get the bot

```bash
git clone -b claude/confident-meitner-1ita5a https://github.com/3ndl3ssSkys/Minecraft_bot.git
```
```bash
cd Minecraft_bot
```
```bash
npm install
```

(Once this branch is merged you can drop `-b claude/confident-meitner-1ita5a`.)

Optionally check that it's healthy (no Minecraft or AI needed):
```bash
npm test
```

---

## 6. Connect it to a server

Everything goes in `config.json`. You can keep several servers as **profiles** and pick one when starting (`node index.js --server <name>`).

### 6A. Java (offline account, Java account, or Realm)

```json
"servers": {
  "home":   { "host": "127.0.0.1", "port": 25565, "username": "Wanderer" },
  "authme": { "host": "play.example.net", "port": 25565, "username": "Wanderer", "password": "pick-a-password" },
  "sam":    { "host": "sam.example.net", "port": 25565, "username": "bot-account@example.com" },
  "realm":  { "realm": "Our Realm", "username": "bot-account@example.com" }
}
```

- **`username`:** a player name plays offline. A Microsoft email signs in with that Java account: the first start prints a code to enter at microsoft.com/link, and the sign-in is then remembered in `data/auth`.
- **`offlineName`:** the name it uses offline when `username` is an email and the sign-in fails (default: the part before the `@`).
- **`auth`:** leave it out (`"auto"`). Set `"offline"` or `"microsoft"` only to force one.
- **`password`:** for login plugins. The bot answers `/register` and `/login` prompts itself (`loginCommand`/`registerCommand` if the server uses different commands).
- **Server version:** detected automatically. If the server is newer than the bot supports (26.2+), it connects as 26.1, so the server needs ViaVersion + ViaBackwards, or you put ViaProxy in between (6B, with a Java target).

### 6B. Bedrock account through ViaProxy (server has Geyser + Floodgate)

1. Download the latest ViaProxy jar: https://github.com/ViaVersion/ViaProxy/releases/latest. Put it in its own folder, e.g. `C:\ViaProxy`.
2. Run it (double-click, or `java -jar ViaProxy-<version>.jar`). A window opens.
3. **Accounts** tab → **Add Bedrock account** → sign in with your Bedrock Microsoft account (code in the browser).
4. **General** tab:
   - **Server address:** `friend.example.net:19132` — the server's **Geyser port** (19132 is the default; ask your friend).
   - **Server version:** the **Bedrock** entry.
   - **Minecraft account:** select your Bedrock account.
   - **Proxy online mode:** leave it off.
5. Click **Start**. ViaProxy now listens on port **25568**.
6. Add a profile for the bot:
   ```json
   "servers": {
     "friend-bedrock": { "host": "127.0.0.1", "port": 25568, "auth": "offline", "username": "Wanderer", "version": "1.21.4", "platform": "bedrock" }
   }
   ```
   `auth: offline` is correct: ViaProxy does the real login with your Bedrock account. `platform: bedrock` tells the bot what doesn't work over this route (mining, chests, crafting, building).
7. In game the bot appears as your **gamertag with a dot in front** (Floodgate's prefix), e.g. `.YourGamertag`.

**Without the window** (for running it in the background), after adding the account once in the GUI:
1. Run this; the first time, it creates `viaproxy.yml` and exits:
   ```bash
   java -jar ViaProxy-<version>.jar config viaproxy.yml
   ```
2. In `viaproxy.yml` set:
   - `target-address: friend.example.net:19132`
   - `target-version:` the Bedrock version
   - `auth-method: account`
   - `minecraft-account-index: 0` (the first account in the GUI list)
3. Run the same command again: now it starts the proxy with those settings.

### 6C. Java first, Bedrock as the backup

Keep the Java route as the main one and the Bedrock route (6B) ready in case Java gets refused. Set `fallback` to the name of the backup profile:

```json
"server": { "host": "friend.example.net", "port": 25565, "username": "Wanderer", "fallback": "friend-bedrock" },
"servers": {
  "friend-bedrock": { "host": "127.0.0.1", "port": 25568, "auth": "offline", "username": "Wanderer", "version": "1.21.4", "platform": "bedrock" }
}
```

It switches to the backup, a few seconds later, when:
- the server refuses the offline account (it's online-mode);
- the Java sign-in fails with `"auth": "microsoft"` (with `"auto"` it first tries the offline account, then the backup if that's refused too);
- someone logs in with the same Java account — probably you — so it keeps playing as the Bedrock account instead of fighting you for yours.

It never switches back on its own (that could kick you): restart the bot to try Java again. ViaProxy only has to be running when the backup is actually needed; `npm run doctor` says whether it answers. To go straight to Bedrock, start it with that profile: `node index.js --server friend-bedrock`.

### 6D. Offline Java bot on an online-mode server (for the server host)

An online-mode server checks every login with Microsoft, so an offline account gets "Failed to verify username". If the host is willing to install plugins, there are two options that leave other players' saves alone. **Either way: back up the server first.**

**Option 1 — FastLogin (full Java bot).** The server lets offline accounts in with a password, but still verifies paid accounts with Microsoft and keeps their normal UUIDs. Each player's save (`world/playerdata/<uuid>.dat`) is tied to that UUID, so nobody loses anything.
1. Install a login plugin ([AuthMe Reloaded](https://www.spigotmc.org/resources/authmereloaded.6269/) or nLogin), [FastLogin](https://www.spigotmc.org/resources/fastlogin.14153/), and FastLogin's requirement ([ProtocolLib](https://www.spigotmc.org/resources/protocollib.1997/) on Paper/Spigot). On a Velocity/BungeeCord network, install FastLogin on the proxy as its page describes.
2. In FastLogin's `config.yml`, make sure paid players keep their **premium UUID** (the `premiumUuid` setting). **This is the setting that protects the saves.** If it's off, Java players get new offline UUIDs and arrive with empty inventories.
3. Set `online-mode=false` in `server.properties` and restart.
4. **Test before anyone else joins:** one Java player logs in and checks that their inventory and position are still there. If not, set `online-mode=true` again (nothing is lost; the old save is still under the old UUID) and fix the FastLogin setting.
5. Give the bot a name that isn't a paid Minecraft account name (FastLogin asks paid names for a Microsoft login), and its password in the bot's profile:
   ```json
   "friend": { "host": "friend.example.net", "port": 25565, "username": "WandererBot", "password": "pick-a-password" }
   ```
   The bot answers `/register` and `/login` itself.

This changes how the server checks logins, so it's the host's call. Option 2 doesn't touch login checking at all.

**Option 2 — Geyser + Floodgate (Bedrock backup only).** Install Geyser and Floodgate (geysermc.org/download), keep `auth-type: floodgate`, and open UDP port 19132. Bedrock players get their own UUIDs and `.`-prefixed names, so Java saves are never touched. The bot then joins through ViaProxy (6B) with the Bedrock limits. Don't link the bot's Bedrock account to a Java account at link.geysermc.org: a linked Bedrock player plays as that Java profile and shares its save.

---

## 7. Configure the bot

Open `config.json`. Every option has a sensible default, so you only need what you want to change. The important ones:

### Who you are

```json
"behavior": { "owners": ["YourName"], "admins": [] }
```
Owners can use every `!command` and their requests get the owner obedience level. Use your in-game name exactly as it appears in chat.

### The AI

```json
"llm": { "model": "qwen2.5:7b", "numCtx": 8192 }
```
Use `qwen2.5:3b` if it's slow. Lower `numCtx` to `6144` if the doctor says the model doesn't fit on the GPU.

### How good a player it is

```json
"intelligence": { "level": "mediocre", "learn": true }
```
Levels: `beginning`, `simple`, `mediocre`, `complicated`, `advanced`, `hardcore`, `master`, `impossible`. Beginners learn as they go. Mace PvP starts at `hardcore`.

### How it thinks

```json
"mind": { "thinkLike": "a friendly builder", "playstyle": "builder", "riskTolerance": 0.4, "curiosity": 0.6, "instructions": ["always share food with friends"] }
```

### Chat

```json
"chat": { "mode": "both", "respondTo": "mentions" }
```
Modes: `silent`, `respond` (only answers), `unprompted` (only starts conversations), `both`.

### Following requests

```json
"obedience": { "levels": { "owner": 0.5, "admin": 0.3, "trusted": 0.15, "player": 0 } }
```
0 means purely its own judgment; 1 means it does whatever it can.

### Fighting

```json
"pvp": { "mode": "defensive" }
```
`never`, `defensive` (fights people who attack it), or `always`.

### Senses and manners

```json
"senses": { "realisticSight": true, "hearing": true },
"behavior": { "noGrief": true, "respectPrivateChests": true }
```

### Chat speed

`chat.typingCharsPerSecond` (default 9) — it stands still while typing, like a player with chat open.

**Everything else** (feelings, trust, liking, reactions, building, learning) is explained in the README. **Many settings can also be changed in game** without editing the file: `!set <key> <value>`, `!iq`, `!mind`, `!obey`, `!mode`. Those changes are saved in `data/brain.json` and win over `config.json` until you reset them (`!settings reset`).

---

## 8. Give it a personality

```json
"personality": "friendly"
```

The presets are `friendly`, `grumpy-miner`, `shy-explorer` and `hype-builder`. To make your own:
1. Copy one of the files in `personalities/` to `personalities/mybot.json`.
2. Edit the name, description, speaking style, likes, ambitions, temperament, forgiveness, helpfulness, fight-or-flight and refusal style.
3. Set `"personality": "mybot"`, or switch live with `!persona mybot`.

---

## 9. Check everything and start it

1. If you use ViaProxy, start it first.
2. Run the doctor (add `--server <profile>` if you use profiles):
   ```bash
   npm run doctor -- --probe-login
   ```
   It checks Node, your config, Ollama and the model, measures how fast the model is on your GPU and whether it fits in VRAM, pings the server, and tells you whether the server is online- or offline-mode. Fix anything with a red ✗ before continuing.
3. Start the bot by hand the first time, so you can see the Microsoft sign-in code if one is needed:
   ```bash
   node index.js --server home
   ```
   (or `npm start` to use the `server` section directly).
4. Watch the log. It shows `Spawned in overworld…`, then `MIND` lines (what it's thinking), `▶` actions, `CHAT` lines, and trust/task events. Press **Ctrl+C** to stop it; it saves first.

In the terminal you can type `!status` (or any `!command`) to control it, or type normal text to make it say something.

---

## 10. Talking to it in game

- **Talk to it:** say its name in chat, e.g. "Wanderer, how's it going?". It answers like a player (after a short "reading and typing" pause).
- **Ask for things:** "Wanderer can you get me 10 logs", "come here", "help me fight". It decides whether it wants to, may only do part of a job, or say later — and sometimes forgets.
- **Owner commands:**

| Command | What it does |
| --- | --- |
| `!status` | health, food, current action, goal, feeling |
| `!stop` / `!pause` / `!resume` | control what it's doing |
| `!come` / `!follow` / `!goal <text>` | direct instructions |
| `!mode <silent\|respond\|unprompted\|both>` | chat mode |
| `!iq <level>` | intelligence level |
| `!mind like <text>` | how it thinks |
| `!obey <role\|name> <0-1>` | obedience levels |
| `!trust <player>` | its relationship with someone (`!trust <player> <0-100>` to set) |
| `!tasks`, `!build`, `!chests`, `!senses`, `!lessons` | what it's doing, building, knows and has learned |
| `!persona <name>` | switch personality |
| `!emotion` / `!emotion lock happy` | feelings |
| `!help` | everything |

---

## 11. Keep it running

### Windows

- `scripts\start-bot.bat --server home` runs it and restarts it if it crashes.
- **Start with Windows:**
  1. Open Task Scheduler → **Create Task**.
  2. General: "Run whether user is logged on or not".
  3. Triggers: **At startup**.
  4. Actions: Start a program → `C:\path\to\Minecraft_bot\scripts\start-bot.bat`, arguments `--server home`, **Start in** `C:\path\to\Minecraft_bot`.
  5. For ViaProxy, make a second task the same way: program `java`, arguments `-jar ViaProxy-<version>.jar config viaproxy.yml`, start in the ViaProxy folder. Give it a 30-second delay on the bot's task trigger so ViaProxy is up first.
- Ollama already starts with Windows.

### Linux

1. Edit `scripts/minecraft-bot.service` (user, folder, `--server` profile).
2. Install and start it:
   ```bash
   sudo cp scripts/minecraft-bot.service /etc/systemd/system/
   ```
   ```bash
   sudo systemctl daemon-reload
   ```
   ```bash
   sudo systemctl enable --now minecraft-bot
   ```
3. Follow its logs:
   ```bash
   journalctl -u minecraft-bot -f
   ```

Do the Microsoft sign-in once by hand (step 9) before running it as a service; a service can't show you the code.

---

## 12. Updating and backups

**Update:**
```bash
git pull
```
```bash
npm install
```
Then restart the bot. If a new version adds options, they get defaults automatically; your `config.json` keeps working.

**Back up:** `data/brain.json` holds everything it has learned and remembers (relationships, lessons, skills, chests, tasks, building plans, in-game settings). `data/auth` holds the Microsoft sign-in.

**Start fresh:** stop the bot and delete `data/brain.json` (or use `!forget <player>` for one person).

---

## 13. Troubleshooting

| Problem | Fix |
| --- | --- |
| "Cannot reach Ollama" | Start Ollama, or check `llm.url`. |
| The doctor says the model is only partly on the GPU | Set the step 4 variables, lower `llm.numCtx` to 6144, close other GPU programs, or use `qwen2.5:3b`. |
| Very slow decisions | Same as above; also raise `loop.minLlmIntervalMs`. |
| "Server version … not supported" / "Outdated client" | The server is newer than 26.1: it needs ViaVersion + ViaBackwards, or use ViaProxy in between. |
| "Failed to verify username" / it stops after one try | The server is online-mode and refused the offline account: ask the host about step 6D, use a Java account email as `username`, or set a Bedrock `fallback` (6C). |
| "The server wants client mods" | A Forge/NeoForge modpack server: the bot is a vanilla client and can't join it. |
| Kicked with a Geyser message about Java accounts | That Geyser has no Floodgate; a Bedrock-only account can't join it. |
| "Logged in from another location" | Someone (probably you) logged in with the same account. The bot stops reconnecting on purpose, or switches to its `fallback` route if it has one. |
| Whitelist / banned | The server owner has to whitelist or unban the bot's name. |
| It doesn't answer chat | Check `chat.mode`; say its name in the message; on plugin servers add a pattern to `server.chatPatterns` if the format is unusual. |
| `!commands` don't work | Your name must be in `behavior.owners` (or admins) exactly as it appears in game (Bedrock players have a `.` in front). |
| Over ViaProxy it can't mine or open chests | Expected — ViaBedrock can't translate that yet. |
| It forgot a task | That happens on purpose (`judgment.forgetting`). Remind it ("did you forget my logs?"), or set `personality.forgetfulness` lower. |
| Spam kicks | Raise `chat.minSecondsBetweenMessages`, lower `chat.maxMessagesPerMinute`. |
