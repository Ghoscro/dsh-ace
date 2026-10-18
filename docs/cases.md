# ACE cases

These are illustrative cases, not a controlled benchmark. Each one asks the
same acceptance question:

> Compared with the next line I would type by reflex, what does this add, and is
> it worth sending?

## 1. The retry may be hiding the race

- Context: a test fails intermittently; the assistant changed to fake timers and
  asks whether to run the full suite.
- Reflex: “Run the full suite.”
- ACE Move: “Remove the retry and run this test once; if it fails, the retry was
  masking the race.”
- Added value: tests the mechanism instead of increasing the sample size.
- Risk: it may fail for an unrelated reason; keep the log.
- Why it is not just “more risk”: it advances the diagnosis with one concrete
  experiment.

## 2. Use the tool already on the machine

- Context: a batch transformation is being discussed.
- Reflex: “Write a small script.”
- ACE Move: “Use the existing CLI's `--json` output and pipe it; no new script
  to maintain.”
- Added value: smaller surface area, faster path to the same result.
- Risk: the CLI may not expose the needed field.

## 3. The task is drifting

- Context: a card is being polished while fresh-profile installation still fails.
- Reflex: “Keep polishing the card.”
- ACE Move: “The card is not the bottleneck; install still fails on a fresh
  profile. Fix that before the visual polish.”
- Added value: names the real constraint and changes the order of work.
- Risk: the install failure may be environment-specific.

## Acceptance used before a public release

1. Ten real tasks are recorded with the obvious line and the ACE Move.
2. A blind reviewer answers: “Did this make you think of something you had not?”
   and “Would you send it?”
3. At least one case per direction (advance, tool, reframe) is represented.
4. Failures are kept in the report; the examples above are not presented as
   measured results.
