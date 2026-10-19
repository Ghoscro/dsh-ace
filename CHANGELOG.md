# Changelog

## 0.5.0 — 2026-10-19

- The card is a four-beat "举一反三" instead of one smart next line: X restates
  the concrete thing in the user's own words, Y names the relation behind it in
  one human sentence, Z gives one other place the same relation shows up, and W
  is the checkable action `Tab` fills. A card carries one new idea, not more
  information.
- `relation` is judged by the host, not scored by the model. A surface-alike
  example needs no mapping line; a surface-unlike example must carry a sentence
  naming the shared mechanism. A missing relation, a rewrite of X or Z, or a
  sentence with no "same kind of thing" connector drops the card before
  selection. No model-provided score is used for this beat.
- `falsify` makes the card testable: what result would prove it wrong.
- The technical-grounding rule is relaxed from "name a file or command" to
  "carry one checkable thing", so a non-engineer can get "refresh and look
  whether the red badge is still there". A novice test locks it.
- `why` falls back to the Y beat, so a four-beat answer without `why` is not
  discarded.
- Type sizes are three CSS variables (`--dsh-fs-w` / `--dsh-fs-meta` /
  `--dsh-fs-x`) with one slider in the settings panel. The value is stored in
  `chrome.storage.local` when the container exposes the extension API
  (`localStorage` otherwise) and applied to `document.documentElement.style`,
  so changing the size never needs a rebuild. `client.js` may not contain a raw
  `font-size: Npx`; a host test fails the suite if one reappears.

## 0.4.0 — 2026-10-19

- The card adapts to the user's technical level, inferred from their own
  messages (code blocks, paths, commands, domain terms) or forced with `level`:
  non-engineers get everyday language and one action at a time, engineers get
  shorthand and judgement.
- The default (`standard`) mode now predicts the line the user actually wanted to
  send: every candidate carries `reply_to`, a verbatim fragment of the
  assistant's last message, and the scorer rewards a quote that really appears
  there. Text, voice rules and insight scoring are unchanged.

## 0.3.2 — 2026-10-19

- Fix the self-check job: `npm pack --pack-destination` needs the directory to
  exist, so both staging directories are created first. 0.3.1's release job
  failed on exactly that step; its tarball was still published.

## 0.3.1 — 2026-10-19

- The release workflow now verifies itself: after publishing, it downloads the
  asset it just uploaded and compares it file by file against a fresh `npm pack`
  of the tagged commit. A stale release (v0.2.0 shipped one) fails the build.

## 0.3.0 — 2026-10-19

- Fixed: the host half is a single file again. Adding a sibling module
  (`ledger.js`) broke the pnpm-materialized copy, which hard-links existing files
  but does not receive new ones, so the plugin failed to import and disappeared
  from the composer after a restart.
- Cards must carry an architectural or domain insight (`insight` 0-10, scored
  separately): boundary erosion, concepts that should split, known failure
  modes, cost curves. Mechanical steps score at most 3 unless they expose a
  structural conclusion.
- The evidence pack now includes the project tree and dependency/script names,
  so an architectural claim can be grounded in real structure instead of only a
  git diff. Card text may be up to 600 characters (was 90).
- Every card is now grounded as a technical next prompt: the prompt asks for a
  named file, command, flag, test or acceptance check plus the inference behind
  it, and the scorer gives concrete steps a small bonus over vague prose.

## 0.2.0 — 2026-10-19

- The fourth mode is named 王牌预测 in the Chinese UI and ACE in the English
  UI; the internal id stays `wild` so saved settings keep working.
- A per-session cognitive ledger (`diagnostics/ledger/*.jsonl`) records what the
  predictor saw; the expert prompt is rebuilt from it instead of the browser
  window, so the prefix only grows. Past `ledgerMaxEntries` the oldest rows are
  archived to a separate file and replaced by a deterministic digest.
- The last 50 expert predictions are captured locally (moves, raw answer,
  last user line, bounded) so the score threshold can be swept offline with
  `npm run sweep` instead of experimenting in live chats. `captureSamples:
  false` turns it off.
- No placeholder sentence when there is no move: a quiet card is now actually
  quiet. Silent turns are logged as `no-card` so the quiet rate is measurable.
- Usage rows also carry `sessionId`, `turnIndex`, `sessionTurns` and the
  session's running `sessionCost`, so a multi-day curve can be plotted; the
  counters rebuild from the file after a restart.
- Usage rows now carry `cost`, `currency`, `hitRate` and hit/miss token counts,
  priced with the configurable `pricing` block (USD per 1M tokens by default).
- The expert prompt is ordered for provider prefix caching: identical head,
  append-only transcript trimmed in blocks (with an 8k-character budget), mode
  and evidence moved to the volatile tail. Each prediction also writes one
  numbers-only usage row to `diagnostics/dsh-ace-usage.jsonl`.
- The banned-word rule covers the whole card (text, why, risk); a field that
  cleans down to nothing drops the move instead of showing an empty card.
- The voice sample is the owner's own messages, pasted verbatim, instead of
  invented good/bad examples.
- Hard rule: a card text containing 建议 / 首先 / 综上 / 可以考虑 is sent back
  once for a rewrite in the user's voice; if that rewrite fails, the offending
  phrase is removed deterministically so the card is never dropped. The prompt
  marks this as a style rule, not a safety rule, so the model does not refuse.
- The card speaks in the user's own voice before it expands: vocabulary,
  sentence length and punctuation are taken from their recent messages, and
  headings/bullets/consultant phrasing are banned in `text`. Wild ideas still
  sound like the user wrote them.
- A model answer that arrives as prose or truncated JSON is salvaged into one
  card with an explicit note, instead of failing the turn and falling back to a
  fast suggestion. The output contract is now restated after the mode prompt so a
  long `wild` prompt cannot bury it.
- Four equal-status modes: `safe`, `standard`, `brainstorm`, `wild`. Each mode
  carries its own prompt policy and output budget, the card shows the mode that
  produced it, and the settings panel switches it. Unknown or missing modes fall
  back to `standard`; no mode collapses into `safe`.
- The Chinese UI reads 深度预测 instead of `ACE` on the dock card, buttons, and
  settings; the English UI is unchanged.
- Development docs show the macOS/Linux shell form and keep the Windows one.
- CI runs the suite on macOS as well as Windows and Linux.

## 0.1.0 — 2026-10-19

- First public ACE release.
- One `ACE Move` card per turn; `Tab` fills the draft, nothing is sent automatically.
- 3–5 internal candidate directions, scored by value, novelty, worth-extra-step,
  and action type; exactly one is shown.
- No card when nothing clears the value threshold.
- Deterministic situation block; one model call per ACE suggestion.
- Line-delimited JSON parser with bad-line salvage and legacy array/object support.
- Read-only bounded git evidence pack.
- Provider usage capture in the host response.
- MIT license; DCO contributions.

## Prehistory

The code originated as the `dsh-composer-predict` prototype (0.2.0). See
`PROVENANCE.md` for the source snapshot and hashes.
