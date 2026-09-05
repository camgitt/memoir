# Reliability rollout and recovery

This is a review candidate, not a deployed release. Preserve a protected, recoverable copy of existing backups before upgrading.

## Compatibility

| Data | New reader | New writer |
|---|---|---|
| Legacy local/Git encrypted manifest | Yes | No |
| Path-bound manifest version 2 | Yes | Yes |
| Legacy account-ID-keyed/gzip cloud | Yes, with warning | No |
| User-passphrase cloud MEMOIRC2 | Yes | After backend migration |
| Supported old session schema | Migrated; future imports rejected | Archives/metadata retained |
| Legacy workspace tar | Manual inspection only | No |
| Workspace file manifest version 2 | Separate recovery folder | Explicit --workspace |

Upgrade every syncing client before relying on archives, scopes, or tombstones. Old clients lack these semantics and cannot read new encrypted formats. Downgrades need a preserved legacy snapshot or export. Do not point an old writer at the new backup. Migration cannot reconstruct files already overwritten by old collisions.

## Cloud database change

Review and deploy `supabase/migrations/202609050001_backup_versions.sql` normally. It adds encryption/source metadata, a per-user unique version constraint, and an authenticated atomic allocator.

1. Back up metadata and inventory duplicate `(user_id, version)` pairs. The unique index deliberately fails on duplicates; resolve them with a reviewed mapping. The migration never deletes or silently renumbers backups.
2. Confirm production row/storage policies restrict all operations to the authenticated account. This source patch does not establish that.
3. Test simultaneous authenticated allocations: distinct positive versions, anonymous rejection, and no access to another account's state.
4. Exercise upload, download, wrong-key failure, metadata failure, retry, and migration against a disposable hosted account.

The private counter's security-definer function uses `auth.uid()`, an empty search path, and no caller-supplied user ID. Failed uploads can leave version gaps. Allocation is not a distributed transaction across objects, metadata, and retention.

Stop new writes before backend rollback; preserve columns while new metadata exists. Do not delete an object after an ambiguous metadata response: the write may have committed.

## Cloud key migration

Supply a strong secret through the environment without putting it in project files or shell history. Run `memoir cloud migrate` to review the inventory, then `--apply` after confirming another device can recover the secret.

Each replacement must download and compare byte-for-byte before its old object is deleted. Verification failure retains the original; fix access and rerun. Independently restore on another device afterward. Provider snapshots/logs may retain copies beyond client deletion authority.

Random vault-key wrapping, enrollment, cross-device rotation, hardware-backed storage, and independent protocol review are not implemented by this change.

## Release gates

- Full tests/audit regressions and installed-tarball save/read/resume/encrypted recovery pass.
- CI confirms the declared OS/Node matrix; a local macOS run cannot establish Windows readiness.
- Real Claude Code, Codex, and Cursor installations accept configuration and complete save/recall/restart.
- Hosted migration and account-isolation tests pass.
- The package owner configures npm's trusted publisher for `camgitt/memoir`, workflow `publish.yml`. The old publication auth failure is not fixed by this source branch.
- Select and synchronize the release version across package.json, lockfile, and server.json. Publish only the reviewed commit/tag, then repeat the smoke check against the registry artifact.

No database deployment, npm version bump, package publication, or independent security certification is implied.

## Operational limits

Local locks fail when busy. A crash while reaping can leave a `.reaper` file requiring inspection after confirming no live writer. Git conflicts require retry. Native adapter restore still uses file modification times and is not a multi-directory transaction.

Cloud merges retained states, increasing download cost. It cannot recover versions already removed by retention. Strong concurrent-cloud consistency needs a server-side conditional commit/merge protocol and race-tested retention.

Legacy scope migration, renamed projects, unusual remote aliases, and profile isolation remain work. Concurrent hostile parent-directory replacement requires further filesystem review: current validation/no-follow opens are not an openat-based sandbox.
