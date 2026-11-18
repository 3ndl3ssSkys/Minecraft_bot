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
2. **Keep the good ones:** run `npm run training-set`. It keeps the decisions that worked and leaves out failures, repeats, plain waiting, broken answers and emojis. It writes `data/training/train.jsonl`, one chat per line (system, user, assistant), the format Unsloth's notebooks read. Skim it and delete anything you wouldn't want it to learn.
3. **Fine-tune with LoRA.**
   - [Unsloth](https://github.com/unslothai/unsloth) has free Colab notebooks for Qwen3 models.
   - Use the `messages` plus the `answer` from each line as one chat example.
4. **Export to GGUF** (`q4_k_m`) from the notebook, and download the file.
5. **Load it into Ollama:** make a file named `Modelfile` containing `FROM ./your-model.gguf`, run `ollama create minecraft-bot -f Modelfile`, then set `"model": "minecraft-bot"` with `npm run setup`.
6. **Compare it:** `npm run doctor` for speed, and watch a session for quality. Keep the old model as a fallback.

**Privacy:** the training file contains what players said in chat. Keep it on your PC, and ask your friends before uploading it anywhere.

## The fast, Minecraft-trained model: what's realistic

Asked for: a model that decides very fast and understands Minecraft at its level, and moves, analyses, acts and builds like a player.

**Split it the way players' brains do:**
- **Hands (moving, aiming, mining, clutches, parkour, building block by block):** code, 20 times a second, already tuned per level. No language model can steer a body that fast on a home graphics card. A small trained movement network would need tens of thousands of hours of recorded play (OpenAI's VPT used 70,000), so code stays in charge of the hands.
- **Head (what to do next, what's worth a fight, how to build, what to say):** that's what can be trained, and it's where the slowness is.

**Why a trained model is faster, not only smarter.** On a GTX 1660 Super most of each decision is spent reading the prompt, and most of the prompt is the rulebook: about 2,600 tokens of rules and action descriptions. A model fine-tuned on the bot's own good decisions has learned those, so it only needs a ~480-token prompt (`llm.trained: true`): who it is, the actions available now, and the answer format. It reads about 1,500 tokens per decision instead of about 4,000.

**Make it small.** Fine-tune `qwen3:1.7b` for decisions: about twice as fast as the 4B at reading and writing, and the training makes up for most of the size. Keep the 4B as a fallback.

**Recipe:**
1. Record with the current model, or better, for a few hours with a big hosted model as the teacher (`llm.provider: "openai"`): `npm run set -- logging.trainingData true`. Every decision is saved with both the long and the short system prompt.
2. `npm run training-set -- --short` writes `data/training/train-short.jsonl`: the good decisions, each with the short prompt.
3. Fine-tune `Qwen3-1.7B` (or 4B) with LoRA in Unsloth's free Colab notebook on that file. Export to GGUF `q4_k_m`.
4. `ollama create minecraft-bot -f Modelfile` (`FROM ./your-model.gguf`), then `npm run set -- llm.model minecraft-bot` and `npm run set -- llm.trained true`.
5. Watch the `Thought for … s` lines, and compare its play with the old model's.

**Levels:** one model serves every level. The level is in its prompt ("a beginner player") and in the code that runs its choices (skill, reaction times, what it knows). To make the model itself play more like a beginner or a master, record with bots of different levels and keep the level line in each example; the training then learns the difference.

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
