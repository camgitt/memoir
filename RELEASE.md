# Release checklist

memoir-cli ships to npm. Follow this every time so git and npm never drift
(the 3.6.1 publish-without-commit incident is what this prevents).

1. **Clean tree** — `git status` shows nothing uncommitted.
2. **Tests green** — `npm test` exits 0 (also enforced automatically by the
   `prepublishOnly` hook, so a broken build cannot be published).
3. **Bump + tag in one step** — `npm version <patch|minor|major>`. Never
   hand-edit the `version` field; `npm version` creates the commit *and* the
   matching `vX.Y.Z` tag so they can't diverge.
4. **Push with tags** — `git push origin main --follow-tags`. **This is the
   release.** The tag push runs `.github/workflows/publish.yml`, which
   first requires the full OS/Node CI matrix (including installed-package recovery), then publishes with provenance via npm trusted
   publishing — no local token, no OTP. Watch it at
   https://github.com/camgitt/memoir/actions/workflows/publish.yml and
   verify with step 6. (One-time setup on npmjs.com is described at the
   top of the workflow file; until it exists the job fails harmlessly at
   `npm publish` and you fall back to step 5.)
5. **Manual publish (fallback only)** — `npm whoami` FIRST. It 401s more often than not between
   releases (the token silently expires — 3.10.1, 3.11.0, 3.12.0 all hit
   it), and a dead token makes `npm publish` run the whole suite and then
   fail with a misleading `404 Not Found - PUT .../memoir-cli`. If it 401s:
   `npm login` (browser approval), then `npm publish` (asks for the
   authenticator OTP). `prepublishOnly` now checks `whoami` before the suite
   and says so plainly (`scripts/check-clean-for-publish.mjs`).
6. **Verify** — `npm view memoir-cli version` matches `git describe --tags`.

The published tarball is an allowlist (`files` in package.json: `bin/`, `src/`,
README, LICENSE, docs/, supabase/migrations/ and evals/). Tests at the
repository root, local project memory, generated client settings and the
`mcp-publisher` binary do not ship. Add new runtime paths to `files`.

Project recovery changes must pass `test-work-recovery.mjs`, the complete suite,
and `npm run test:packed`. After publication, run
`MEMOIR_TEST_PACKAGE=memoir-cli@X.Y.Z npm run test:packed` against the exact
registry artifact. Verify its provenance and latest tag separately.
