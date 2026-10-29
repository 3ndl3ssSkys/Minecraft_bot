# Minecraft LLM Bot

An autonomous Minecraft Java Edition player built on **Mineflayer** + **mineflayer-pathfinder**, with decisions made by a local LLM (**Ollama** running **Qwen 2.5**). It explores, mines, crafts, fights, chats, and reacts to what happens in the world. Personality, chat behaviour and event reactions are all configurable.

```
Perception (every 2s) ──► state JSON ──► Ollama /api/chat ──► {thought, emotion, goal, action}
        ▲                                                              │
        └──────── result fed back into the next prompt ◄── ActionExecutor (one action at a time)
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
3. Edit `config.json`: set `server.host`, `server.port` and `server.username`. For a local test world, open a singleplayer world to LAN and use the port it prints.
4. Run the bot:
   ```bash
   npm start
   ```
   To use a different config file:
   ```bash
   node index.js my-config.json
   ```

Environment variables override the config: `MC_HOST`, `MC_PORT`, `MC_USERNAME`, `MC_AUTH`, `MC_VERSION`, `OLLAMA_URL`, `OLLAMA_MODEL`, `BOT_PERSONALITY`, `BOT_CHAT_MODE`, and `BOT_DEBUG=1` for verbose logs.

> **Model size:** `qwen2.5:7b` is a good default. `qwen2.5:3b` is faster on weak hardware but makes more mistakes; `qwen2.5:14b` plans noticeably better. Ollama 0.5+ is recommended for strict JSON-schema output. Older versions fall back to plain JSON mode automatically.

## Files

| File | Purpose |
| --- | --- |
| `index.js` | Config loading, perception, the Ollama client, the decision loop, chat, reactions, reconnects |
| `actions.js` | The tool API the LLM can call, plus the `ActionExecutor` (validation, timeouts, cancellation) |
| `config.json` | All settings (every key has a default in code, so you can delete the ones you don't change) |
| `personalities/*.json` | Personality presets: `friendly`, `grumpy-miner`, `shy-explorer`, `hype-builder` |

## How it thinks

1. **Perceive.** Every `perception.intervalMs` (default 2s) the bot builds a JSON snapshot: position, health, hunger, equipment with durability, inventory, nearby entities (with ids), notable blocks nearby (ores, logs, crafting tables...) with the nearest coordinates and whether they are visible, the block it is looking at and standing on, time, weather, its current goal and mood, recent actions with their results, recent events, recent chat, and short hints ("It is dark: hostile mobs spawn").
2. **Decide.** The state goes to `http://localhost:11434/api/chat`. A JSON schema makes the model reply with:
   ```json
   {"thought": "I need a pickaxe before I can mine stone.", "emotion": "determined", "emotionIntensity": 6,
    "goal": "craft a wooden pickaxe", "action": {"name": "mineBlock", "args": {"blockType": "oak_log", "count": 3}}}
   ```
3. **Act.** The action runs to completion or failure. The result (for example `NO_SUITABLE_TOOL: Mining stone by hand drops nothing`) is stored and shown in the next prompt so the model can adapt.
4. **Throttle.** The loop waits at least `loop.minLlmIntervalMs` between decision calls. All LLM requests go through one priority queue (chat replies first, then reactions, then decisions, then small talk), so only one request is ever in flight.

**Reflexes** run without the LLM. They fight back when attacked, flee from creepers or when health is low, and eat when hungry. This saves LLM calls and reacts instantly.

## Actions (tools)

| Action | Args |
| --- | --- |
| `moveToBlock` | `x, y, z, range?` |
| `moveToPlayer` / `followPlayer` | `playerName, range? / durationSeconds?` |
| `explore` | `distance?, direction?` |
| `mineBlock` | `blockType, count?, maxDistance?`: finds the block, paths to it, equips the best tool, mines it, collects the drops |
| `placeBlock` | `blockType, x, y, z`: finds a face to place against and avoids standing in the target cell |
| `chatMessage` | `text` |
| `equipItem` | `itemName, destination?`: armor slots are detected automatically |
| `attackTarget` | `entityId, maxSeconds?` |
| `retreat` | `entityId, distance?` |
| `eatFood` | `foodName?` |
| `collectDrops` | `radius?` |
| `craftItem` | `itemName, count?`: uses a nearby crafting table automatically |
| `emote` | `gesture`: wave, jump, nod, shake_head, crouch, spin, look_around |
| `wait` | `seconds` |

**Error handling:** every action is validated and has a distance-scaled timeout and a global hard timeout (`loop.maxActionMs`). Every action can be cancelled (on death, an owner command, taking damage, or a new task from chat). Pathfinding failures come back as clear codes: `NO_PATH`, `PATH_TIMEOUT`, `STUCK` (no movement for 8s), `PATH_INTERRUPTED`, `TOO_FAR`. Tools are handled carefully: nearly broken tools are swapped for a healthier one, blocks that need a proper tool are refused (`NO_SUITABLE_TOOL`), and a tool breaking mid-action is reported (and can trigger a reaction). Fuzzy names work, so `"log"`, `"Oak Log"` and `"minecraft:oak_log"` all resolve.

Use `behavior.enabledActions` (a whitelist) or `behavior.disabledActions` to limit what the LLM can do.

## Personalization

### Personality

Set `"personality"` to a preset name from `personalities/`, or write the personality inline:

```json
"personality": {
  "name": "Grimrock",
  "nicknames": ["grim"],
  "description": "A grumpy veteran miner who secretly cares.",
  "traits": ["grumpy", "sarcastic"],
  "speakingStyle": "terse and dry",
  "quirks": ["calls everyone 'kid'"],
  "likes": ["diamonds"], "dislikes": ["daylight"],
  "ambitions": ["dig a huge mine"],
  "chatTopics": ["complaining about something"],
  "catchphrases": ["back to the mines"],
  "lowercase": true,
  "baselineMood": "annoyed",
  "admitsBeingBot": true,
  "reactions": { "death": { "templates": ["typical."] } }
}
```

`nicknames` (plus the username and `name`) are the words that count as talking to the bot. `ambitions` steer what it does when it has no task. `baselineMood` is the mood it drifts back to. With `admitsBeingBot`, it answers honestly if someone sincerely asks whether it is a bot. A preset's `reactions` block overrides the global reaction settings, so each personality can react in its own voice.

To make your own preset, copy a file in `personalities/` and switch to it live with `!persona <name>`.

### Chat modes (`chat.mode`)

| Mode | Replies when spoken to | Unprompted messages | Event reactions |
| --- | --- | --- | --- |
| `silent` | no | no | no (gestures still play) |
| `respond` | **yes** | no | only if `chat.reactionsInRespondMode` is true |
| `unprompted` | no | **yes** | yes |
| `both` | **yes** | **yes** | yes |

In `respond` and `silent` modes, the `chatMessage` tool is removed from the LLM's tool list, so it cannot slip a message past the setting.

Other chat options:
- `respondTo`: `mentions` (default: name/nickname mentioned, a whisper, or a follow-up in an ongoing conversation), `everyone` (also chimes in on other chat with `unaddressedReplyChance`), or `whitelist`.
- `ignore`: players the bot never replies to.
- `replyDelayMs`, `typingCharsPerSecond`: human-like delays.
- `minSecondsBetweenMessages`, `maxMessagesPerMinute`: anti-spam limits. Duplicate messages are dropped too.
- `unprompted.intervalSeconds`, `chance`, `minSilenceSeconds`, `requirePlayersOnline`, `requirePlayersNearby`: control the small-talk timer.
- `goalChangeInterrupts`: when a player asks for something and the bot agrees, it drops what it's doing and works on the request.

The LLM decides whether to accept a task (in character). `behavior.obeyPlayers` controls who may give tasks at all: `everyone`, `owners` or `nobody`.

### Event reactions (`reactions.events`)

Each event has these settings:

```json
"playerJoined": { "enabled": true, "chance": 0.7, "cooldownSec": 15, "perTarget": true,
                  "style": "template", "gesture": "wave", "templates": ["hey {player}!", "welcome back {player}"] }
```

- `style`: `template` (a random template), `llm` (the model writes a reaction in character, falling back to a template if it fails), `gesture` (body language only), or `silent` (only remembered).
- `gesture`: wave, jump, nod, shake_head, crouch, spin or look_around. It plays when the bot is idle.
- `perTarget`: the cooldown applies per player instead of globally.
- Placeholders: `{player}`, `{mob}`, `{item}`, `{level}`, `{health}`, `{food}`, `{cause}`, `{name}`.

Events: `spawn`, `playerJoined`, `playerLeft`, `playerNearby`, `death`, `hurt`, `lowHealth` (has a `threshold`), `hungry` (has a `threshold`), `playerDied`, `killedMob`, `hostileNearby`, `toolBroke`, `nightfall`, `daybreak`, `rainStart`, `levelUp`, `itemPickup`.

Every event is also written to the bot's memory, even when its reaction is disabled, so the decision loop knows what happened (for example "Steve died: Steve was blown up by Creeper").

## Owner commands

Add your username to `behavior.owners`. Owners can type these in game; the terminal running the bot can always use them. Anything else typed in the terminal is said in chat.

```
!stop        stop the current action          !mode <silent|respond|unprompted|both>
!pause       pause the brain                  !goal <text|clear>   set or clear the goal
!resume      resume                           !come / !follow      come to / follow you
!persona <name>   switch personality          !reactions <on|off>
!status      health, food, action, goal, mood !help
```

## Safety switches

- `behavior.allowPvp` (default `false`): the bot refuses to attack players. `protectedPlayers` are never attacked, even when PvP is on.
- LLM chat output is sanitized: messages can't start with `/` (no server commands), and control characters and `§` codes are stripped.
- The pathfinder will never dig through chests, barrels, furnaces or crafting tables.
- `behavior.maxTravelDistance` limits how far a single move can go.

## Troubleshooting

- **"Cannot reach Ollama"**: start it with `ollama serve`, or set `llm.url` / `OLLAMA_URL`.
- **Slow decisions**: use a smaller model, lower `llm.numCtx`, or raise `loop.minLlmIntervalMs`. Replies to players always jump ahead of decisions in the queue.
- **Kicked for spam**: raise `chat.minSecondsBetweenMessages` and lower `chat.maxMessagesPerMinute`.
- **Online-mode servers**: set `"auth": "microsoft"` and use your account email as `username`. Mineflayer will prompt you to sign in.
- **Version issues**: pin `server.version` (e.g. `"1.21.4"`) instead of auto-detecting.
