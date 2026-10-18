# Migrate from dsh-composer-predict

The brand and package move from `dsh-composer-predict` to **DSH ACE**
(`@ghoscro/dsh-ace`). Only one package may be loaded at a time.

## Identifier mapping

| Old | New | Notes |
|---|---|---|
| package `dsh-composer-predict` | `@ghoscro/dsh-ace` | unscoped `dsh-ace` is taken on npm |
| host export `name` | `dsh-ace` | |
| client ModuleLoader id | `dsh-ace` | |
| locale namespace | `dsh-ace` | |
| dock slot id `composer-predict` | `ace` | |
| right slot id `composer-predict-deep` | `ace-deep` | |
| bundle row id `composer-predict` | `ace` | verify the old row is gone |
| route `/composer-predict/*` | **kept** | avoids breaking the client during migration |
| settings key `dsh.composer-predict.settings.v1` | **kept** | preserves pause/auto settings |
| CSS prefix `dcp-` | **kept** | reduces unrelated churn |
| UI “深度预测” | **ACE** | card title `ACE Move` |

The old route and settings key are compatibility choices, not a promise to keep
them forever. Removing them requires a separate migration.

## Steps

1. Back up the profile `package.json`, `cordis.patch.yml`, and the old plugin
   directory. Treat the profile as startup-critical.
2. Install `@ghoscro/dsh-ace` in the profile as a local package.
3. Remove `dsh-composer-predict` from `dsh.profile.bundles` and from
   `dependencies`.
4. Materialize the profile; do not run both packages.
5. Restart DSH.
6. Verify:
   - health reports `version: 0.1.0` and `expertTimeoutMs: 25000` on the
     existing `/composer-predict/health` route;
   - exactly one `✦ ACE` button appears;
   - one real ACE Move renders as a single card;
   - `Tab` fills the draft and does not send;
   - the old settings (pause/auto) still apply;
   - the old `composer-predict` bundle row is not active.
7. If startup fails, restore the backup and remove the new package before
   retrying. Do not “restart and see” repeatedly.

## Cordis row id

A stable row id does not prove the old instance is unloaded. Check the composed
profile roster and the live GUI. If both rows appear, remove the old package
from `dsh.profile.bundles` and restart; do not keep both “just in case”.

## Rollback

Restore the backed-up profile files and old plugin directory, then restart.
The new package can stay on disk; it must not be in the active bundle list.
