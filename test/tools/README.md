# Test tools

Unit tests run without Minecraft or Ollama:

```bash
npm test
```

These tools are for **live** checks against a local test server.

| File | What it is |
| --- | --- |
| `mock-ollama.js` | A stand-in for Ollama. It replays decisions from a JSON script, gives canned chat answers, returns realistic timing fields, and logs every prompt to `mock-ollama.log`. |
| `test-server.js` | A throwaway local server (flying-squid): superflat world, everyone is op. |
| `test-player.js` | A second player, "Tester", with modes `idle`, `sneak`, `dig` and `chat`. |
| `harness.js` | Drives the real Agent through the scenarios `typing`, `sight`, `hearing` and `nametags`. |

## Running a scenario

1. Install the test server (it is not a dependency of the bot):
   ```bash
   npm install --no-save flying-squid@1.12.0
   ```
2. Write a config that points at the test server, e.g. `test-config.json`:
   ```json
   { "server": { "host": "localhost", "port": 25599, "username": "Typer", "version": "1.16.5", "reconnect": false },
     "llm": { "url": "http://localhost:11499/api/chat" }, "learning": { "file": "test-brain.json" } }
   ```
3. Start these, each in its own terminal, in this order:
   ```bash
   node test/tools/test-server.js 1.16.5 25599
   ```
   ```bash
   node test/tools/mock-ollama.js
   ```
   ```bash
   node test/tools/harness.js nametags test-config.json
   ```
   Then, about 5 seconds after the harness starts:
   ```bash
   node test/tools/test-player.js 25599 1.16.5 idle
   ```

To run the whole bot with scripted decisions instead:

```bash
node test/tools/mock-ollama.js my-script.json
```
```bash
node index.js test-config.json
```

Here `my-script.json` is a list of actions like `[{ "name": "mineBlock", "args": { "blockType": "dirt", "count": 2 } }]`.

## Expected results (as of the last run)

| Scenario | Result |
| --- | --- |
| typing | Walking at ~5.6 blocks/s, then a ~6 s plateau while a long message is typed, then it continues. |
| sight | Seen in the open → "last seen" right after the wall goes up → not perceived after 20 s. |
| hearing | After the Tester is forgotten, a chest opening behind the wall → suspicion "high" and an investigation at that spot. If the Tester was just seen going behind the wall, it stays low (known players damp suspicion). |
| nametags | Identified in the open → "name tag through wall" while standing → "last seen" then gone when sneaking → not perceived when invisible. |

## flying-squid quirks (what it can't test)

flying-squid is a partial server, so some things need a real server.

- **Player visibility:** a player only sees players who join **after** them. Start the Tester after the bot.
- **No PvP damage, no item tossing:** fights run, but outcomes, gifts and hand-overs can't be tested.
- **No sneak or invisibility metadata, and no block-break world events or sounds.** The harness plays the vanilla packets itself where needed.
- **On 1.21.4:**
  - `/tp` crashes the connection;
  - other players' entities are never sent;
  - inventories get corrupted when items move between slots;
  - `/give` of the same item twice concatenates counts as text ("64" + "64" = 6464).
  
  Use 1.16.5 for live tests unless you specifically need 1.21 items (mace, wind charges); `/give` and block placement do work on 1.21.4.
- **Teleport timing:** `/tp` lands a moment late, so scripts that depend on positions should wait after teleporting.
