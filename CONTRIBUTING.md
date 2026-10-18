# Contributing

Thanks for trying DSH ACE. Contributions use the **Developer Certificate of
Origin (DCO)**, not a CLA.

## Before a PR

```bash
npm test
```

- Keep the host/client split: `index.js` is the Node half, `client.js` is the
  browser half.
- Do not add telemetry, session writes, a second model call, or a new network
  destination without a measured reason.
- Do not commit credentials, `.env`, sessions, diagnostics, profile backups, or
  private transcripts.
- New model-visible text needs a test and a README/CHANGELOG update.
- Keep the `files` list explicit; run `npm pack --dry-run` and inspect the
  tarball when packaging changes.

## DCO sign-off

Sign every commit:

```text
Signed-off-by: Your Name <you@example.com>
```

Use `git commit -s`. The sign-off certifies you have the right to submit the
change under the project's MIT license.

## Scope

Good first issues: prompt fixtures, selection scoring, single-card UX, Windows
and macOS path handling, evidence-pack redaction, token measurement. Large
architecture changes (subagents, cross-session learning) need an issue first.
