# Start here (Windows)

One path, in order, from "I installed Ollama, Node.js and Git" to "the bot is playing". Every step says what you should see. Do them in a **Command Prompt** (Start → type `cmd` → Enter).

When this works, [SETUP.md](SETUP.md) has everything else (friends' servers, Bedrock, running it 24/7), and [CONFIGURING.md](CONFIGURING.md) has goals, feelings and personality.

---

## Step 1 — Make Ollama use your graphics card well (once)

Paste these three lines into the Command Prompt, one at a time:

```bat
setx OLLAMA_FLASH_ATTENTION 1
```
```bat
setx OLLAMA_KV_CACHE_TYPE q8_0
```
```bat
setx OLLAMA_KEEP_ALIVE 24h
```

Each one should say `SUCCESS: Specified value was saved.`

Then **restart Ollama**:
1. Right-click the llama icon by the clock → **Quit Ollama**.
2. Start → **Ollama** to open it again.
3. **Close the Command Prompt and open a new one**, so it sees the new settings.

**Check that the model runs on the GPU:**
```bat
ollama run qwen2.5:7b "say hi in five words"
```
The first time takes 5–20 seconds while it loads, then it answers. Now run:
```bat
ollama ps
```
The `PROCESSOR` column should say **100% GPU**:
- **Something like `18%/82% CPU/GPU`:** the model is a little too big for a 6 GB card. Windows uses part of the card's memory for your screen, so `qwen2.5:7b` (5.2 GB) doesn't quite fit, and the part on the CPU makes every answer several times slower. Use a model that fits entirely:
  ```bat
  ollama pull qwen3:4b
  ```
  ```bat
  ollama run qwen3:4b "say hi in five words"
  ```
  ```bat
  ollama ps
  ```
  This one should say **100% GPU**. Choose `qwen3:4b` as the model in step 3 (setup turns its slow "thinking" mode off for you).
- **Mostly or all CPU, even for qwen3:4b:** update the NVIDIA driver (nvidia.com or GeForce Experience), restart the PC, and check again.
- **About the slow test earlier:** typing to the model with `ollama run` is only a test. You don't need to chat with it. The bot talks to Ollama by itself.

---

## Step 2 — Download the bot

```bat
cd %USERPROFILE%
```
```bat
git clone -b claude/confident-meitner-1ita5a https://github.com/3ndl3ssSkys/Minecraft_bot.git
```
If GitHub asks you to sign in, do it in the browser window that opens. You should end up with a new folder, `Minecraft_bot`.

```bat
cd Minecraft_bot
```
```bat
npm install
```
That takes a minute and ends with something like `added 92 packages`.
- **Warnings** about `uuid` being deprecated or "moderate severity vulnerabilities" are normal: they come from the Minecraft libraries.
- **Don't run `npm audit fix --force`.** It swaps in versions that break the bot.

> **Every bot command runs inside this folder.** If you open a new Command Prompt later, first type `cd %USERPROFILE%\Minecraft_bot`.
> The error `Could not read package.json` means you're not in that folder.

---

## Step 3 — Answer a few questions

```bat
npm run setup
```

It asks:
- **your Minecraft name**, so the bot takes `!commands` from you;
- **the server address**: use `localhost` for the test server in step 4;
- **the bot's name**, e.g. `Wanderer`;
- **its personality and skill level**;
- **which model to use**: `qwen3:4b` if step 1 showed the 7B model partly on the CPU, otherwise `qwen2.5:7b`.

Type plain words, without the `[brackets]`. Press Enter alone to keep what's in brackets. For the personality you can pick a preset, or describe one ("friendly, a bit cautious, loves exploring"); it builds a custom personality from your words.

Your answers go into `config.local.json` in the bot folder. Run `npm run setup` again any time to change them.

---

## Step 4 — A server to test on

The bot joins as an **offline account**, so it doesn't need a Minecraft account of its own. Normal servers (and singleplayer "Open to LAN") check accounts with Microsoft, so they refuse it. For a first test, run a small server of your own on this PC, which takes about 5 minutes:

1. **Install Java 21:** https://adoptium.net → *Temurin 21 (LTS)* → Windows installer, default options.
2. **Make a folder,** e.g. `C:\mcserver`.
3. **Download Paper** from https://papermc.io/downloads/paper. Pick **1.21.4** (any version up to 26.1 works with the bot). Put the `.jar` in that folder and rename it to `paper.jar`.
4. **Start it once.** In a new Command Prompt:
   ```bat
   cd C:\mcserver
   ```
   ```bat
   java -Xmx4G -jar paper.jar nogui
   ```
   It stops quickly and asks you to accept the EULA.
5. **Accept the EULA:** open `C:\mcserver\eula.txt` in Notepad, change `eula=false` to `eula=true`, and save.
6. **Allow offline accounts:** open `C:\mcserver\server.properties`, change `online-mode=true` to `online-mode=false`, and save.
   - This is fine for **your own fresh test world**.
   - Never do this on a server where other people already have saves: it changes everyone's player IDs. For friends' servers, see SETUP.md step 6D.
7. **Start it again** with the same `java` command. When it says `Done`, it's ready. Leave this window open.

You can join it yourself from your normal Minecraft: Multiplayer → Direct Connection → `localhost`.

---

## Step 5 — Check everything

Back in the bot's Command Prompt (in the `Minecraft_bot` folder):
```bat
npm run doctor
```
You want green ✓ marks for Node, the config, Ollama, the model, and the server ("localhost:25565 answers"). It also times the model on your card, e.g. `≈ 5.0s per decision`, and checks it fits in VRAM.

**The timing step can take a minute or two, so let it finish.** Pressing Ctrl+C stops it, and Command Prompt then asks `Terminate batch job (Y/N)?` (that's normal; answer Y).

**Anything with a red ✗ comes with a hint.** The common ones:

| It says | Fix |
| --- | --- |
| Can't reach Ollama | Start Ollama from the Start menu. |
| Model isn't downloaded | `ollama pull qwen2.5:7b` (or whatever name you gave in setup). |
| Only part of the model is on the GPU | Step 1, then close other programs that use the GPU. |
| The server doesn't answer | Is the server window from step 4 still running and showing `Done`? |

---

## Step 6 — Start the bot

```bat
npm start
```

You'll see it connect, then lines like:
```
Spawned in overworld at (12, 64, -8)
MIND [curious 5/10] Nobody's around. I'll punch a tree to get started.
▶ mineBlock({"blockType":"oak_log","count":4})
```
- **`MIND`:** what it's thinking.
- **`▶`:** what it does.
- **`CHAT`:** what it says.

**Talk to it:**
- **In game:** join the server and say `hey Wanderer` (its name) in chat.
- **Commands:** as its owner, `!status`, `!goals`, `!stop`, `!help`.
- **From the bot's window:** type a message to make it talk, or a `!command`.

**Stop it** with **Ctrl+C** in its window. It saves what it learned first.

---

## What next

| You want to… | Go to |
| --- | --- |
| Make it faster (smaller models, a fast chat model) | README → "Which model, and making it fast" |
| Set its goals, feelings, personality | [CONFIGURING.md](CONFIGURING.md) |
| Join a friend's server | [SETUP.md](SETUP.md) step 2 (which route fits) and step 6 |
| Keep it running all the time | SETUP.md step 11 (`scripts\start-bot.bat` restarts it if it crashes) |
| Get updates | `git pull`, then `npm install` (your `config.local.json` is never touched) |

## If something goes wrong

| Problem | Fix |
| --- | --- |
| `Connection error: connect ECONNREFUSED` and "Nothing is running at localhost:25565" | The Minecraft server isn't running (yet). Start it (step 4); the bot keeps retrying and joins once it's up. |
| `Could not read package.json` | You're not in the bot folder: `cd %USERPROFILE%\Minecraft_bot` |
| `'git' / 'node' / 'ollama' is not recognized` | Close the Command Prompt and open a new one (installers only take effect in new windows). |
| Answers are very slow | `ollama ps` while the bot runs: it must say 100% GPU (step 1). |
| `Failed to verify username` | That server checks Microsoft accounts. Use the test server from step 4, or see SETUP.md step 2 for other servers. |
| `Kicked: You are not white-listed` | On your test server, type `whitelist add Wanderer` in the server window. |
| It doesn't answer in chat | Say its name in the message. |
