# Configuring the bot

How to set **goals, feelings, personality, how it thinks, chat, reactions, requests, fighting and reflexes**. For installing everything, see [SETUP.md](SETUP.md); for what each feature does in depth, see [README.md](README.md).

**Contents**
1. [Where settings live](#where-settings-live)
2. [Goals](#goals)
3. [Feelings](#feelings)
4. [Personality](#personality)
5. [Skill level and how it thinks](#skill-level-and-how-it-thinks)
6. [Chat and reactions](#chat-and-reactions)
7. [Requests, obedience, trust and liking](#requests-obedience-trust-and-liking)
8. [Fighting](#fighting)
9. [Reflexes and dying on purpose](#reflexes-and-dying-on-purpose)
10. [Example config](#example-config)

---

## Where settings live

There are four places to set things. A later one overrides an earlier one:

| Where | What it's for | How |
| --- | --- | --- |
| `config.json` | The defaults for everything | Leave it as it is: updates change this file. |
| `config.local.json` | **Your** settings, in the same shape | Written by `npm run setup`; add anything else by hand, then restart the bot. Git never touches it. You only need the keys you change. |
| `personalities/<name>.json` | Who it is: voice, likes, temperament | `"personality": "<name>"` in `config.local.json`, or `!persona <name>` in game. |
| Environment variables | Quick overrides when starting it | `MC_HOST`, `MC_USERNAME`, `BOT_PERSONALITY`, `BOT_INTELLIGENCE`, `BOT_CHAT_MODE`, `OLLAMA_MODEL`, `LLM_FAST_MODEL`, `LLM_API_KEY`… |
| In game, as an owner | Changing things while it plays | `!goal`, `!emotion`, `!mind`, `!iq`, `!set <key> <value>` … These are saved in `data/brain.json` and **win over `config.json`** until you `!set <key> reset` or `!settings reset`. |

**Who can use commands:**
- **Owners:** your in-game names in `behavior.owners`. They can use everything.
- **Admins:** `behavior.admins`, or `!admin add <name>`. They can use most commands.
- **The terminal** running the bot counts as an owner: type `!goals` there.
- **Everyone else:** typing `!stop` is just chat to the bot.

Every snippet below goes inside `config.local.json`, e.g. `{ "goals": { ... }, "emotions": { ... } }` (create it with `npm run setup`). Restart the bot after editing it.

---

## Goals

The bot always has something it's working toward, on four levels:

```
overall goal ─── "become the best builder on the server"
  long-term goals ─── "build a castle on the hill", "get full diamond armor"
    current goal ─── "gather 64 cobblestone"
      steps ─── [x] craft a stone pickaxe  [>] find a cave  [ ] mine cobblestone
```

**How it behaves with them:**
- **Each decision** aims at the current step, and reports how it's going: step done, goal done, stuck, or "changed my mind".
- **Something urgent** (a creeper, hunger, nightfall, a friend asking for help) becomes a *detour*. Once that's dealt with, it goes back to the goal.
- **Planning:** every few minutes, and whenever a goal is finished or stuck, it steps back and revises the whole plan. This is a slow, low-priority call that never holds up playing. Each level is aimed at the one above it.

### Three ways to use goals

**1. Let it decide everything** (the default): leave the goals empty. It makes up an overall goal from its personality's `ambitions` and likes, picks long-term goals, and works out the steps, then changes them as it plays.
```json
"goals": { "selfDirected": true }
```

**2. Give it a direction, let it fill in the rest:**
```json
"goals": {
  "overarching": "become the best builder on the server",
  "longTerm": ["build a castle on the hill", "start a wheat and carrot farm"],
  "current": "gather 64 cobblestone"
}
```
Goals you set are kept until they're done, or until you change them. It still adds its own goals and steps around them.

**3. Only what you give it:** it plans steps toward your goals, but makes up no new ones of its own.
```json
"goals": { "longTerm": ["beat the ender dragon"], "selfDirected": false }
```

### All goal options

| Key | Default | Meaning |
| --- | --- | --- |
| `goals.overarching` | `""` | The point of it all. Empty = it makes one up (if `selfDirected`). |
| `goals.longTerm` | `[]` | Big goals that serve it (up to 4 active). |
| `goals.current` | `""` | What to start with. (`behavior.startingGoal` still works as the old name.) |
| `goals.selfDirected` | `true` | Make up its own goals and steps where none are set, and change them as it goes. |
| `goals.keepSetGoals` | `true` | Goals from `config.json` or an owner can't be replaced by the bot; something urgent only puts them on hold. |
| `goals.plan` | `true` | Step back now and then and revise the whole plan (an extra LLM call every few minutes). |
| `goals.replanMinutes` | `10` | How often it reviews the plan anyway (`0` = only when a goal finishes or gets stuck). |

Goals in your config are applied when the bot starts, **if you changed them** since the last run. If you didn't, it carries on with the plan as it had evolved, which is saved in `data/brain.json`.

### Goal commands (in game or in the terminal)

| Command | What it does |
| --- | --- |
| `!goals` | Show the whole tree: overall, long-term (numbered), current goal, steps. |
| `!goal` | Show the current goal (and any detour). |
| `!goal gather 64 cobblestone` | Set the current goal. |
| `!goal clear` | Clear the current goal (it will pick or plan a new one). |
| `!goal life become the best builder on the server` | Set the overall goal (`!goal life clear` to clear it). |
| `!goal add build a castle on the hill` | Add a long-term goal. |
| `!goal done` / `!goal drop` | Mark the current goal finished, or give it up. |
| `!goal done 2` / `!goal drop 2` | The same for long-term goal #2 (numbers from `!goals`). |
| `!goal steps craft a pickaxe; find a cave; mine stone` | Set the steps for the current goal (separate them with `;`). |
| `!goal replan` | Make it rethink its plans now. |

Only **owners** set goals directly. An admin's or player's `!goal …` is treated as a *request*, and the bot judges it like any other ask. Players can also ask in normal chat ("can you build a bridge?"). Those requests become **tasks**, which come before its own goals.

Live switches: `!set goals.selfDirected false`, `!set goals.plan false`, `!set goals.replanMinutes 20`, `!set goals.keepSetGoals false`.

---

## Feelings

It has six core feelings: **joy, anger, fear, sadness, boredom, surprise**. Things that happen push them up: getting hit, gifts, insults, dying, winning, being bored, its own reading of the moment. They fade back to the personality's resting mood. The strongest one becomes a label like "annoyed (6/10), mostly because Steve hit you". That label colours how it talks, whether it does favours, and whether it fights or runs.

### In `config.json`

```json
"emotions": {
  "enabled": true,
  "volatility": 1.0,
  "decayPerMinute": 0.2,
  "lock": null,
  "lockIntensity": 6
}
```

| Key | Meaning |
| --- | --- |
| `volatility` | How strongly events move it: `0` stoic, `1` normal, `2`+ dramatic. |
| `decayPerMinute` | How fast it calms back down to its resting mood. |
| `lock` | Force one feeling permanently, e.g. `"annoyed"` for a grumpy bot. `null` = feelings move freely. |
| `lockIntensity` | How strong the locked feeling is (1-10). |
| `enabled` | `false` = no feelings at all (flat and neutral). |

### In the personality file (who it is underneath)

```json
"baselineMood": "happy",
"temperament": { "joy": 0.45, "anger": 0.03, "fear": 0.1, "sadness": 0.05, "boredom": 0.1, "surprise": 0 },
"sensitivity": { "anger": 0.8, "joy": 1.2 }
```

- **`temperament`:** the resting level of each feeling (0-1), where it returns when nothing is happening.
- **`sensitivity`:** multiplies how strongly each feeling reacts. A shy bot might have `"fear": 1.6`; a calm one `"anger": 0.5`.
- **`baselineMood`:** the label it starts with.

### In game

| Command | What it does |
| --- | --- |
| `!emotion` | How it feels right now and why. |
| `!emotion angry 8` | Make it feel that way now (then it fades naturally). |
| `!emotion lock happy 7` / `!emotion unlock` | Hold a feeling until unlocked. |
| `!emotion volatility 0.5` / `!emotion decay 0.4` | Change how it reacts and calms down. |

Feeling names it understands: happy, excited, calm, curious, bored, focused, proud, amused, annoyed, frustrated, angry, scared, nervous, sad, tired, surprised, confused, determined.

---

## Personality

A personality is a JSON file in `personalities/`. The presets are `friendly`, `grumpy-miner`, `shy-explorer` and `hype-builder`. To make your own:

1. Copy `personalities/friendly.json` to `personalities/mybot.json`.
2. Edit it.
3. Set `"personality": "mybot"` in `config.local.json`, or type `!persona mybot` in game.

You can also put the whole object inline: `"personality": { "name": "...", ... }`.

| Field | What it does |
| --- | --- |
| `name`, `nicknames` | What it calls itself, and names it answers to. |
| `description`, `traits` | Who it is, in a sentence and a few words. |
| `speakingStyle`, `language`, `lowercase`, `catchphrases`, `quirks` | How it types. |
| `likes`, `dislikes`, `chatTopics` | What it enjoys, avoids and talks about. Liking also affects who it likes ("chemistry"). |
| `ambitions` | What it dreams of. Used to make up its overall and long-term goals when you don't set them. |
| `baselineMood`, `temperament`, `sensitivity` | Feelings (above). |
| `forgiveness` | How quickly it forgives (0-1). Also how easily it accepts a truce. |
| `trustSensitivity` | How much bad behaviour hurts trust. |
| `fightOrFlight` | Below 0.5 tends to run, above tends to fight. |
| `helpfulness`, `generosity` | How willing it is to do favours and give things away. |
| `patience` | How long it keeps at a task for someone before handing over what it has. |
| `forgetfulness` | How likely it is to forget a task (0 = never). |
| `violence` | How willing it is to fight someone *for* another player. |
| `restlessness` | How much it fidgets and does parkour while thinking. |
| `refusalStyle`, `fallbackRefusals` | How it says no, like a person ("ah not rn, maybe after this?"). |
| `admitsBeingBot` | If someone sincerely asks, whether it admits being an AI. |
| `reactions` | Per-event overrides for this personality (same format as `reactions.events`). |

---

## Skill level and how it thinks

```json
"intelligence": { "level": "mediocre", "learn": true, "learnRate": 1 },
"mind": {
  "thinkLike": "a careful hardcore player",
  "playstyle": "builder",
  "priorities": { "survival": 1, "social": 1, "building": 1.5, "exploring": 1, "combat": 0.5, "gathering": 1 },
  "riskTolerance": 0.3,
  "curiosity": 0.7,
  "instructions": ["always carry a water bucket", "never go to the Nether at night"]
}
```

- **`intelligence.level`:**
  - the levels are `beginning`, `simple`, `mediocre`, `complicated`, `advanced`, `hardcore`, `master` and `impossible`;
  - it sets what it knows, how well it fights, moves and builds, and which saves its reflexes know;
  - with `learn` on it improves with practice. A beginner can eventually pass a master, slowly.
  - in game: `!iq master`, `!iq learn off`.
- **`mind.thinkLike`:** a free-text role model ("a speedrunner", "a cautious farmer").
- **`mind.playstyle`:** one of `balanced`, `survivalist`, `builder`, `explorer`, `fighter`, `helper`, `trader` or `miner`.
- **`priorities`:** above 1 matters more, below 1 less, 0 not at all.
- **`riskTolerance`** and **`curiosity`:** 0-1.
- **`instructions`:** standing rules it always follows.
- **In game:** `!mind like a speedrunner`, `!mind style explorer`, `!mind risk 0.2`, `!mind curious 0.9`, `!mind add always sleep at night`, `!mind clear`.

---

## Chat and reactions

```json
"chat": {
  "mode": "both",
  "respondTo": "mentions",
  "whitelist": [],
  "ignore": [],
  "typingCharsPerSecond": 9,
  "unprompted": { "intervalSeconds": 90, "chance": 0.35 }
}
```

| Key | Meaning |
| --- | --- |
| `mode` | `silent` (never talks) · `respond` (only answers) · `unprompted` (only starts conversations and reacts) · `both`. In game: `!mode respond`. |
| `respondTo` | `mentions` (when its name is said or it's whispered to) · `everyone` (also joins in sometimes, `unaddressedReplyChance`) · `whitelist` (only `whitelist` players). |
| `ignore` | Players it never answers. |
| `typingCharsPerSecond`, `stopToType` | It stands still and "types" at this speed; in danger it types 1-3 words or answers later. |
| `unprompted.intervalSeconds` / `chance` | How often it starts small talk. |

**No emojis:** it types like a player. The prompts forbid emojis, and anything a model slips in is removed before sending (text faces like `:)` stay).

**Chat and what it does are linked.** Every reply sees what just happened: a fight it started or stopped, a truce, a clutch save, a death, a finished goal. So when it says "fine, truce", it really has stopped. A request in chat ("get me 10 logs") becomes a task, which it may accept, put off, half-do or refuse, in character.

### Reactions to events

Each game event can trigger a reaction:

```json
"reactions": {
  "enabled": true,
  "gestures": true,
  "globalCooldownSec": 6,
  "events": {
    "death":   { "enabled": true, "chance": 1, "cooldownSec": 10, "style": "llm", "templates": ["noooo", "ugh. died."] },
    "hurt":    { "chance": 0.25, "style": "template", "templates": ["ow!", "hey!"] },
    "clutch":  { "chance": 0.6, "templates": ["that was close", "clutch"] },
    "truce":   { "style": "llm", "templates": ["fine. truce"] },
    "playerJoined": { "templates": ["hey {player}!", "welcome back {player}"] }
  }
}
```

- **`style`:**
  - `template`: picks one of `templates`, which is instant;
  - `llm`: writes one in character, using the templates as examples;
  - `gesture`: waves or nods instead of talking.
- **`chance` and `cooldownSec`:** keep it from overdoing it. `perTarget: true` puts the cooldown per player.
- **Placeholders:** `{player}`, `{mob}`, `{item}`, `{level}`, `{name}`, `{promise}`, `{victim}`.
- **Events:** spawn, playerJoined, playerLeft, playerNearby, death, hurt, lowHealth, hungry, playerDied, killedMob, hostileNearby, toolBroke, nightfall, daybreak, rainStart, levelUp, itemPickup, attackedByPlayer, killedByPlayer, gift, promiseKept, promiseBroken, harmNearby, crouchGreeting, wonFight, lostFight, taskDone, taskPartial, taskAbandoned, buildDone, clutch, truce.
- **In game:** `!reactions off` / `!reactions on`.

---

## Requests, obedience, trust and liking

**Requests:** when someone asks for something, it judges it like a person would.
- Favours depend mostly on how much it **likes** them.
- Fights depend on grudges, friendships, promises and whether it could win.

**Obedience** adds on top: `chance = its own willingness + (1 − willingness) × obedience`.

```json
"obedience": {
  "levels": { "owner": 0.5, "admin": 0.3, "trusted": 0.15, "player": 0 },
  "players": { "Steve": 0.8 },
  "whoCanInstruct": "everyone",
  "overrideConscience": false
},
"judgment": { "ownerLoyalty": 0.3, "forgetting": true, "requestedFights": true }
```
In game: `!obey`, `!obey Steve 0.8`, `!obey player 0.2`, `!obey who trusted`, `!obey conscience on`.

**Trust** (is this person safe?) starts at `trust.initial` (75). It drops for hits, kills, hurting pets or players nearby, and broken promises. It recovers slowly, and with gifts, kept promises and apologies. All the amounts are in `trust.penalties` and `trust.rewards`.

**Liking** (do I enjoy them?) starts at `affinity.initial` (50; owners `ownerInitial` 75). It grows with good chemistry and time together, and drops if they're boring, bossy or rude.

- **In game:** `!trust` lists everyone; `!trust Steve` shows the relationship; `!trust Steve 60` or `!trust Steve reset` sets it; `!forget Steve` starts over.

---

## Fighting

```json
"pvp": { "mode": "defensive", "allowSparring": true, "neverAttackOwners": true, "rethinkSeconds": 6 },
"behavior": { "protectedPlayers": ["MyFriend"], "selfDefense": true }
```

- **`mode`:**
  - `never`: always runs;
  - `defensive`: fights players who attack it;
  - `always`: may pick fights.
- **`rethinkSeconds`:** reflexes start fights instantly, but during a fight with a player, every N seconds the AI decides whether to **keep going, stop or run**. The fight continues while it thinks. `0` = let fights run their course.
- **Talking it out of a fight:** players can say "sorry", "stop" or "truce". It decides on the spot from liking, trust, forgiveness and whether they're still swinging (`reflexes.truce`).
- **`protectedPlayers`:** never attacked, no matter what.

---

## Reflexes and dying on purpose

Falls, lava, drowning and being hit are handled instantly in code, at its skill level (see the README's Reflexes section).

```json
"reflexes": { "enabled": true, "falls": true, "hazards": true, "hitReactions": true, "reactionMs": null, "learnSaves": true, "truce": true },
"behavior": { "allowRespawnOnPurpose": true, "respawnCommand": "" }
```

- **`reactionMs`:** a fixed reaction time instead of the skill-based one (≈420 ms beginner → ≈70 ms impossible).
- **`learnSaves`:** it works out new saves from bad falls and from what players tell it ("use a water bucket when you fall").
- **Dying on purpose:** the AI can decide to die to respawn when it makes sense: hopelessly stuck, trapped, or lost far from home with nothing valuable on it.
  - It uses `respawnCommand` (e.g. `"/kill"`, if the server allows it), otherwise lava or a big drop nearby. The reflexes stand down while it does.
  - Never on hardcore worlds, at most once every 10 minutes.
  - `allowRespawnOnPurpose: false` turns it off.

---

## Example config

A builder with a direction, a personality, steady feelings and no PvP:

```json
{
  "server": { "host": "friend.example.net", "port": 25565, "username": "Wanderer" },
  "personality": "hype-builder",
  "intelligence": { "level": "advanced" },
  "goals": {
    "overarching": "build the coolest base on the server",
    "longTerm": ["build a castle on the hill", "start a wheat and carrot farm"],
    "selfDirected": true
  },
  "emotions": { "volatility": 0.7, "decayPerMinute": 0.3 },
  "mind": { "playstyle": "builder", "riskTolerance": 0.3, "instructions": ["sleep when it gets dark"] },
  "chat": { "mode": "both", "respondTo": "mentions" },
  "pvp": { "mode": "never" },
  "behavior": { "owners": ["EndlessSkys"] }
}
```
