# Could we train our own Minecraft model?

Short answer: **not a "plays like a player at super speed" model from scratch, but a small fine-tune of the model you already use is realistic, and worth it once the bot has played for a while.** Most of the speed and skill come from code, and that part is already built.

## What each part of "playing like a player" needs

| Part | What does it | Speed |
| --- | --- | --- |
| Reacting: falls, lava, getting hit, dodging, fighting moves, parkour jumps | Code (`reflexes.js`, `combat.js`, `parkour.js`), 20 times a second | Human-like reaction times (≈420 ms Beginner → ≈70 ms Impossible) |
| Doing a job: "get an iron pickaxe", "get food", early-game basics | Code: `obtainItem` and the autopilot plan every step (wood → tools → ore → furnace → smelt → craft, hunt → cook) | As fast as the game allows; no model call between steps |
| Choosing what to do, talking, judging people | The language model (Qwen) | A few seconds per decision on a GTX 1660 Super |

A model can't help with the first two: no model can think 20 times a second on a home GPU, and code does those parts better anyway. The model's job is the third row, and that's where training can help.

## Option 1: train a model from scratch — not realistic

OpenAI's VPT learned Minecraft from about 70,000 hours of gameplay video, on hundreds of datacenter GPUs, for weeks. Even then it played slowly and clumsily compared to a person. That's far beyond a home PC and far beyond any sensible budget.

## Option 2: fine-tune the small model on the bot's own good decisions — realistic

You teach `qwen3:4b-instruct` to answer the way the bot needs, using examples of decisions that worked:

- **Smarter:**
  - fewer wrong arguments and fewer pointless actions;
  - better Minecraft habits;
  - it keeps its personality.
- **Faster:** the long rules section of the prompt can shrink, because the model has learned them. On your card, reading the prompt is the slow part, so a shorter prompt means faster decisions.
- **Cost:** a LoRA fine-tune of a 4B model takes about an hour on a free Google Colab GPU, or a dollar or two on a rented one. It needs a few thousand good examples.

**How:**

1. **Collect examples.** Turn on `"logging": { "trainingData": true }` in `config.local.json` and let the bot play, ideally with people around. Every decision is written to `data/training/decisions.jsonl` (or the bot save's own folder): the prompt, the answer, and whether the action worked.
   - Optional: use a much bigger model as a "teacher" for a few hours (a hosted one through `llm.provider: "openai"`) to get better examples. That's called distillation.
2. **Keep the good ones.** Lines with `"ok": true` whose action made sense. Drop failures, and drop decisions that repeat the same thing.
3. **Fine-tune with LoRA.**
   - [Unsloth](https://github.com/unslothai/unsloth) has free Colab notebooks for Qwen3 models.
   - Use the `messages` plus the `answer` from each line as one chat example.
4. **Export to GGUF** (`q4_k_m`) from the notebook, and download the file.
5. **Load it into Ollama:** make a file named `Modelfile` containing `FROM ./your-model.gguf`, run `ollama create minecraft-bot -f Modelfile`, then set `"model": "minecraft-bot"` with `npm run setup`.
6. **Compare it:** `npm run doctor` for speed, and watch a session for quality. Keep the old model as a fallback.

**Privacy:** the training file contains what players said in chat. Keep it on your PC, and ask your friends before uploading it anywhere.

## Option 3 (what the bot does now): skills in code, model for choices

This gives the biggest gain for the least effort, and every new skill makes the bot smarter immediately, without training:
- `obtainItem`: one decision, then the whole chain runs itself.
- The autopilot: early-game basics, a sword and food.
- Reflexes, combat and parkour.
- Take-or-leave judgment for items on the ground.

Ideas for more skills:
- night shelter;
- a bed from sheep;
- armor upgrades;
- torch-lit mining at the right depth for diamonds;
- farming.

Fine-tuning (option 2) is the next step once there's a few hours of real play to learn from.
