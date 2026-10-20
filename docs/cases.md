# ACE cases

These are illustrative cases, not a controlled benchmark. Each one asks the
same acceptance question:

> Compared with the next line I would type by reflex, what does this add, and is
> it worth sending?

## 1. The retry may be hiding the race

- Context: a test fails intermittently; the assistant changed to fake timers and
  asks whether to run the full suite.
- X (what you said): "run the full suite?" is the assistant's line.
- Y (the line behind it): the retry swallows the flake, so a full run only
  spreads the odds.
- Z (where else it shows up): upload retries and CI flaky reruns are the same
  mechanism — a hidden retry turning a real failure into a probability.
- W (try this): "remove the retry and run this test once".
- Weakening observation: repeated comparable runs without retries show no higher
  failure rate. One clean run alone cannot rule out intermittent masking.
- Risk: it may fail for an unrelated reason; keep the log.

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

This is an acceptance protocol, not a claim that these checks have been
completed. See [trial feedback](trial-feedback.md) for current evidence and gaps.

1. Ten real tasks are recorded with the obvious line and the ACE Move.
2. A blind reviewer answers: “Did this make you think of something you had not?”
   and “Would you send it?”
3. At least one case per direction (advance, tool, reframe) is represented.
4. Failures are kept in the report; the examples above are not presented as
   measured results.
5. After reading a card, the reviewer can restate it in their own words **and**
   name a second example of the same relation. If they cannot, the card is
   showing off rather than transferring.
