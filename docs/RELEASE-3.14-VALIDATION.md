# 3.14.0 deployment validation

Observed September 6, 2026. Package publication and database deployment are separate operations: check the [publish workflow](https://github.com/camgitt/memoir/actions/workflows/publish.yml) and [npm package](https://www.npmjs.com/package/memoir-cli) for package availability.

## Hosted database

Applied `supabase/migrations/202609050001_backup_versions.sql` to the existing Memoir service through its authenticated SQL editor. Before deployment, the service was healthy and reported a scheduled backup four hours earlier. The metadata inventory contained no duplicate account/version pairs. Existing backup IDs matched after the complete test and cleanup.

Verified the unique version index, counter row-level security, authenticated allocator access, and anonymous denial. Existing metadata policies match `auth.uid()` to `user_id`; storage policies restrict the backup bucket to the authenticated user's folder. No existing policies or customer backups were replaced.

The live test used two temporary accounts created through the admin API without sending email, and synthetic files. Real user tokens exercised:

- Twelve simultaneous allocations with distinct positive versions, plus independent numbering for a second account.
- Anonymous allocator rejection and denial of direct access to the counter table.
- Concurrent encrypted uploads, byte-matched restore, and wrong-passphrase rejection.
- Cross-account metadata read, update, delete and insert denial; storage read, write and delete denial.
- A locally injected metadata-response failure after a real object upload, followed by a successful new upload and restore. This checks client recovery; it does not simulate a committed-but-lost backend response.
- Legacy account-key encryption migration, including replacement download and byte comparison before deleting the synthetic original.

The first live run exposed an incorrect Storage deletion endpoint that permissive mocks had accepted. `deleteBackup` now uses the bucket endpoint with a JSON `prefixes` array, matching [Supabase's client contract](https://github.com/supabase/storage-js/blob/master/src/packages/StorageFileApi.ts). Retention and migration regression tests enforce that request shape. The corrected live run passed every check above. Temporary accounts, metadata and stored objects were removed.

An immediate repeat download could return a cached original after deletion. Storage listing, metadata lookup and a fresh uncached download confirmed removal. Provider caches and snapshots may outlive client deletion; this release does not promise immediate provider-wide erasure.

## Local workflow and release checks

The project handoff, recovery interface and adversarial tests are included in the 24-suite runner. Actual Codex → Cursor → Codex observations are in [local handoff validation](LOCAL-HANDOFF-VALIDATION.md). The [browser recovery report](PROJECT-VIEW-DEBUG.md) explains the bugs fixed before release. Local regression checks after the hosted deletion fix passed all 59 cloud assertions and 26 audit groups. GitHub CI runs the full suite and evaluations on Node 18, 20 and 22 across Linux, macOS and Windows; its Ubuntu/Node 22 job also checks the installed package.

Project ledgers, personal memory, local client configuration, deployment credentials and raw deployment logs are excluded from GitHub and the package. The release adds an explicit dependency on the already installed Zod version used by the handoff server.

External settings must be checked again when changed. Passing source tests does not prove npm publishing permission, client MCP approval or hosted policies remain unchanged. Receipt input hashes also become stale when the package manifests change for a release.

## Publication

The existing GitHub publisher was failing authentication before this release. npm requires security-key verification to inspect and repair the trusted-publisher settings. Source and server readiness alone must not be described as a published npm version. The completed workflow and registry version are the publication evidence.
