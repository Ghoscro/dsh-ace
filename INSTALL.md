# Install DSH ACE

## Status

- Package: `@ghoscro/dsh-ace` (the unscoped npm name `dsh-ace` is already taken by an unrelated project).
- npm publish: pending owner credentials. Use the local package or a packed tarball until then.
- Verified host: **DSH 0.2.1-rc.2**. Other versions are unverified.

## Local package (verified path)

1. Close DSH.
2. Copy this directory to `<profile>/sakura/packages/dsh-ace`.
3. Edit the profile `package.json`:

   ```json
   {
     "dependencies": {
       "@ghoscro/dsh-ace": "file:./sakura/packages/dsh-ace"
     },
     "dsh": {
       "profile": {
         "bundles": [
           "@ghoscro/dsh-ace"
         ]
       }
     }
   }
   ```

4. Materialize the dependency in the profile (`pnpm install` or the DSH plugin page).
5. Start DSH. The composer toolbar should show **✦ ACE** (**✦ 深度预测** in the Chinese UI).
6. Finish an assistant turn, or click **✦ ACE**. Press `Tab` on the card to fill the draft.

Do not add both `dsh-composer-predict` and `@ghoscro/dsh-ace` to the bundle list. See [MIGRATION.md](MIGRATION.md).

## Tarball

```bash
npm pack
```

The tarball contains only the explicit `files` list. Inspect it before sharing:

```bash
tar -tf ghoscro-dsh-ace-0.1.0.tgz
```

It must not contain sessions, diagnostics, credentials, live profile files, backups, or internal handoff documents.

## Where the button is

- `✦ ACE` sits in the composer tool row.
- The card appears above the composer after a completed turn when automatic ACE is on, or after clicking `✦ ACE`.
- `Tab` fills the draft. ACE does not send.

## Uninstall / rollback

1. Remove `@ghoscro/dsh-ace` from `dsh.profile.bundles` and from `dependencies`.
2. Materialize the profile again.
3. Restart DSH.
4. Delete `<profile>/sakura/packages/dsh-ace`.

For the old package rollback, follow [MIGRATION.md](MIGRATION.md). The old route and settings key are intentionally kept, so removing ACE does not delete the previous settings.

## Compatibility note

A package-manager success is not a runtime acceptance. Verify the health route, the composer button, one real ACE Move, `Tab` fill, and the old plugin being absent after migration.
