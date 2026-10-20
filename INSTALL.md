# Install DSH ACE

## Status

- Package: `@ghoscro/dsh-ace` (the unscoped npm name `dsh-ace` is already taken by an unrelated project).
- npm publish: pending owner credentials. Until then, the tarball attached to a GitHub release is the install path.
- Verified host: **DSH 0.2.1-rc.2**. Other versions are unverified; a package-manager success is not a runtime acceptance.

## 1. Release tarball (recommended)

1. Download `ghoscro-dsh-ace-0.5.23.tgz` from the repository's releases page.
2. Close DSH.
3. In the profile directory (`<DSH_HOME>/profiles/<name>`):

   ```bash
   pnpm add file:/absolute/path/to/ghoscro-dsh-ace-0.5.23.tgz
   ```

4. Add `"@ghoscro/dsh-ace"` to `dsh.profile.bundles` in the profile `package.json`.
5. Materialize the profile again (`pnpm install` or the DSH plugin page), then start DSH.
6. Open a conversation: the composer row shows **✦ ACE** (**✦ 深度预测** in the Chinese UI). Finish an assistant turn or click it; press `Tab` on the card.

## 2. Developer install (copy the directory)

Use this when you are changing the code, not for a normal install.

1. Close DSH.
2. Copy this directory to `<profile>/sakura/packages/dsh-ace`.
3. In the profile `package.json`:

   ```json
   {
     "dependencies": {
       "@ghoscro/dsh-ace": "file:./sakura/packages/dsh-ace"
     },
     "dsh": {
       "profile": {
         "bundles": ["@ghoscro/dsh-ace"]
       }
     }
   }
   ```

4. Materialize the dependency (`pnpm install` or the DSH plugin page), then start DSH.

Do not add both `dsh-composer-predict` and `@ghoscro/dsh-ace` to the bundle list. See [MIGRATION.md](MIGRATION.md).

## Building your own tarball

```bash
npm pack
tar -tf ghoscro-dsh-ace-0.5.23.tgz
```

The tarball contains only the explicit `files` list. Inspect it before sharing: it must not contain sessions, diagnostics, credentials, profile files, backups, or internal documents.

## Updating an existing installation

A restart loads the package already installed in the profile; it does not
download a new release. Download the target release tarball, close DSH, repeat
the profile install/materialization steps above, then restart. Check the
package version, `/composer-predict/health`, and `<html data-ace-version>` agree.
The install examples target the published 0.5.23 release; source on `main` may
be newer. Unreleased changes in the changelog are not an installed update.

## Where the button is

- `✦ ACE` sits in the composer input row.
- The card appears above the composer after a completed turn when automatic ACE is on, or after clicking the button.
- `Tab` fills the draft. ACE does not send.

## If a release breaks the composer

A broken plugin does not stop DSH from booting: the entry fails to activate and the
rest of the harness starts normally. Recovery takes one edit and one restart.

1. Remove `"@ghoscro/dsh-ace"` from `dsh.profile.bundles` in the profile `package.json`.
   Leave the dependency in place; this disables ACE without touching anything else.
2. Restart DSH and confirm the composer is back.
3. Install a known-good tarball (or remove the dependency entirely once you no longer
   want it).

When reporting the problem, include the build id from `<html data-ace-version>` and the
last lines of `<DSH_HOME>/diagnostics/dsh-ace-errors.jsonl`; both are written without
transcript content.

## Uninstall / rollback

1. Remove `@ghoscro/dsh-ace` from `dsh.profile.bundles` and from `dependencies`.
2. Materialize the profile again.
3. Restart DSH.
4. Delete `<profile>/sakura/packages/dsh-ace` if you copied it.

For the old package rollback, follow [MIGRATION.md](MIGRATION.md). The old route and settings key are intentionally kept, so removing ACE does not delete the previous settings.

## Compatibility note

Verify the health route, the composer button, one real ACE Move, `Tab` fill, and the absence of the old plugin after migration. Do not infer runtime success from `pnpm` output alone.
