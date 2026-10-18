# Changelog

## Unreleased

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
