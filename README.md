# DSH ACE

**Beyond the obvious.**

An AI next-move advisor for **DeepSeek Harness**. It reads the recent conversation, looks for a better next step than the one you would type by reflex, and shows **one** card. Press `Tab` to make it yours. Nothing is sent automatically.

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Tests](https://github.com/Ghoscro/dsh-ace/actions/workflows/test.yml/badge.svg)](https://github.com/Ghoscro/dsh-ace/actions/workflows/test.yml)

[简体中文](README.zh-CN.md)

![ACE Move example](docs/demo.svg)

> Example ACE Move. The card shows what it adds over the obvious next line, not just a longer autocomplete.

## What it does

Most next-message tools optimize for **what you would probably type**. ACE optimizes for **what is worth sending next**.

- It generates 3–5 different directions internally: advance, use an existing tool, reframe, verify, clarify, constrain, close.
- It scores them for `value`, `novelty`, `worth_extra_step`, and action type.
- It shows **one** move, with `why`, `evidence`, and `risk`.
- If nothing beats the obvious “continue”, it shows **nothing**. A quiet card is a feature.
- `Tab` fills the draft. You can edit it. ACE never sends for you.

## Demo

The card above is the intended loop:

1. The assistant asks, “run the full suite?”
2. The obvious next line is “run it”.
3. ACE proposes: “remove the retry and run it once, to see whether the retry was masking the race.”
4. The card shows why that is more informative, the evidence it used, and the risk.
5. `Tab` inserts it; you decide whether to send.

A real screen recording will replace the illustrative card after the first beta. The current image is a rendered example, not a benchmark result.

## Quick start

**Status:** local package / source install. The npm name `dsh-ace` is already taken by an unrelated project; the scoped package is `@ghoscro/dsh-ace`. npm publishing is pending credentials.

Verified host: **DSH 0.2.1-rc.2**. Other versions may work; they are not verified yet.

1. Put the package at `<profile>/sakura/packages/dsh-ace`.
2. Add the dependency to the profile `package.json`:

   ```json
   "@ghoscro/dsh-ace": "file:./sakura/packages/dsh-ace"
   ```

3. Add `"@ghoscro/dsh-ace"` to `dsh.profile.bundles`.
4. Materialize it in the profile (`pnpm install` or the DSH plugin page), then restart DSH.
5. Open a conversation. The composer toolbar shows **✦ ACE**. Click it, or wait for the next completed turn if automatic ACE is enabled.
6. Press `Tab` on the card to fill the draft.

If you are migrating from `dsh-composer-predict`, read [MIGRATION.md](MIGRATION.md) first. Do not load both packages at once.

## Three cases

These are examples, not a controlled benchmark. They show the kind of added value ACE is aiming for.

### 1. A test that may be hiding the bug

- **Obvious:** “Run the full suite.”
- **ACE Move:** “Remove the retry and run this one test once; if it fails, the retry was masking the race.”
- **What it adds:** it tests the mechanism instead of increasing the sample size.
- **Risk:** the test may fail for an unrelated reason.

### 2. A cheaper implementation path

- **Obvious:** “Write a small script to batch this.”
- **ACE Move:** “Use the existing CLI’s `--json` output and pipe it; no new script to maintain.”
- **What it adds:** a smaller surface area and a faster path to the same outcome.
- **Risk:** the CLI may not expose the field you need.

### 3. A task that is drifting

- **Obvious:** “Keep polishing the current card.”
- **ACE Move:** “The card is not the bottleneck; the install step still fails on a fresh profile. Fix that before the visual polish.”
- **What it adds:** it names the real constraint and changes the order of work.
- **Risk:** the install failure may be environment-specific.

## How it works

1. The browser sends the recent transcript and the session `cwd` to the host route.
2. The host builds a bounded, read-only evidence pack from `git` (status, diff stat, last commit, a bounded diff).
3. A deterministic situation block is built from the last user goal, the assistant’s last offer, and explicit constraints. There is no separate situation-model call.
4. **One** model call returns 3–5 line-delimited JSON candidates plus a selection line.
5. The host scores and selects exactly one move. Fixed slot order is gone; `verify`/`constrain` candidates are penalized so “check again” cannot win by default.
6. If the best score is below the threshold, the plugin returns no card.
7. `Tab` fills the draft. The card’s `why`/`evidence`/`risk` are not sent with the message.

The parser scans balanced JSON objects and skips a truncated or malformed line while keeping valid earlier candidates. A bad line does not discard the whole response.

## Settings and cost

- **Automatic ACE:** one ACE suggestion after each completed turn. You can turn it off in the ACE settings.
- **Pause:** stops automatic suggestions; `✦ ACE` still works on demand.
- **Model:** uses the active DSH agent default, or the plugin’s configured route.
- **Privacy:** the recent transcript and the local evidence pack go to the selected model. Nothing is written to the session, and there is no cross-session learning.
- **Cost:** one model call per ACE suggestion. A token table with fast/expert and short/long contexts will be published before the first public release. Automatic ACE is the expensive mode; pause it if you only want it on demand.

## Development

```bash
npm test
```

Measure real provider token usage against a running DSH instance. macOS and Linux:

```bash
COMPOSER_PREDICT_BASE=http://127.0.0.1:13770 node scripts/token-tiers.mjs
```

Windows (PowerShell):

```powershell
$env:COMPOSER_PREDICT_BASE='http://127.0.0.1:13770'
node scripts/token-tiers.mjs
```

The suite covers prompt/parser behavior, JSONL bad-line salvage, selection scoring, no-card behavior, route envelopes, and the single-card UI interactions.

Compatibility is declared in `package.json.dsh.compatibility`. Treat a version not listed there as unverified; do not assume a package-manager success is a runtime acceptance.

## Uninstall

Remove the bundle and dependency from the profile, restart DSH, and delete the package directory. The old `composer-predict` route and settings key are kept for migration; removing the new package does not delete your local settings.

## Author

**米哈游关卡灯光艺术家 Micker Wenyu.Yang的DSH插件作品。**

## License

[MIT](LICENSE). Contributions use DCO sign-off; no CLA. See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).
