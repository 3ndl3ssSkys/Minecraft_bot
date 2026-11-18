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

## Step by step: a fine-tuned `qwen3:1.7b` that plays like a player, at each level

A fine-tune copies the examples it's given, so how good it gets depends almost entirely on what you record. Plan on two weekends: one to record, one evening to train and test.

### 1. Record good examples (the part that matters)

Turn recording on: `npm run set -- logging.trainingData true`. Every decision goes to `data/training/decisions.jsonl` (or the profile's folder) with:
- the long prompt and the short one (`llm.trained`);
- the bot's level, and whether it worked.

The code's own good decisions are recorded too (the early-game routine, obtainItem's steps, finished searches).

- **How many:** about 2,000 usable examples for a first try, 5,000–10,000 for a good one. A bot makes roughly one model decision every 5–15 s, so that's hours of play: leave it running.
- **Variety:** the model only learns situations it has seen. Give it:
  - day and night, caves, a village, mobs, a death or two;
  - chat with you: requests, refusals, small talk;
  - building, and a fight now and then.
  
  Move it around (`!goal` …) instead of letting it sit at spawn.
- **Better than your current model (distillation):** for the best examples, let a big model decide while recording, then train the small one on its choices.
  - Any OpenAI-compatible API works: `"llm": { "provider": "openai", "url": "…/v1/chat/completions", "model": "…", "apiKey": "…" }`.
  - A few hours of play is a few million prompt tokens, so check the provider's prices or free tier first.
  - The prompts contain your friends' chat: ask them, or record when you're alone.
- **Levels:** run one bot per level you care about, each with its own save and name, for example:
  - `node index.js --profile rookie` with `intelligence.level` beginning;
  - `--profile pro` with master.
  
  Each example is tagged with its level, and the short prompt says it ("a beginner player"). So one model learns all levels and plays the one it's told. Record roughly the same amount at each level.

### 2. Build the training file

```
npm run training-set -- --short
```

This writes `data/training/train-short.jsonl` and holds back 5% as `test-short.jsonl`. Along the way it:
- keeps only decisions that worked;
- drops repeats, plain waiting and broken answers;
- shuffles the rest;
- keeps code decisions to at most half (`--max-code 0.3` for less);
- prints how many examples there are per level.

`--level master` keeps one level only.

Open the file and skim a few lines; delete anything you wouldn't want it to copy.

### 3. Train on a free Colab GPU

1. Open [training/finetune_qwen3_colab.ipynb](training/finetune_qwen3_colab.ipynb) in Google Colab: File → Upload notebook.
2. Runtime → Change runtime type → **T4 GPU**.
3. Run the cells top to bottom. They:
   - install Unsloth;
   - ask for the two files;
   - load Qwen3-1.7B in 4-bit with LoRA adapters;
   - train on the answers only, 1 epoch;
   - test on the held-back decisions;
   - export a `q4_k_m` GGUF (~1.1 GB) and download it.

A few thousand examples take about 30–90 minutes. Free Colab sessions end after a few hours, so start with 1 epoch.

**What good looks like at the test step:**
- valid answers ~100%;
- the same action as the recorded decision 60–80% (other good choices exist, so 100% isn't the goal).

Below that:
- record more, or more varied, examples;
- train a 2nd epoch (`num_train_epochs=2`);
- try `r=64`;
- or start from `unsloth/Qwen3-4B` (slower in the game, smarter).

### 4. Use it at home

1. Next to the downloaded `.gguf`, make a file `Modelfile` with one line: `FROM ./<file>.gguf`.
2. Run `ollama create minecraft-bot -f Modelfile`.
3. Compare: `npm run eval-model -- minecraft-bot` against `npm run eval-model -- qwen3:4b-instruct` (same held-back decisions; it reports validity, same action, same target, seconds per decision).
4. Switch: `npm run set -- llm.model minecraft-bot`, `npm run set -- llm.trained true`, `npm run set -- llm.fastModel ""`.
5. Restart, play, watch the `Thought for … s` lines.

To go back: `npm run set -- llm.model qwen3:4b-instruct` and `npm run set -- llm.trained false`.

### 5. Make it better over time

- Keep recording with the new model, and add your old examples.
- Delete its bad decisions before the next run (anything it did that you didn't like); `training-set` already drops failed ones.
- Retrain every few thousand new examples. Each round is a bit better, and it picks up your server's habits.

**What it won't do:** it won't steer the body. Aiming, walking, mining, clutching and building block by block stay in code at every level, at 20 times a second. The model's job is the head: what to do next, whether a fight is worth it, what to build, what to say.

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
