# Release checklist

memoir-cli ships to npm. Follow this every time so git and npm never drift
(the 3.6.1 publish-without-commit incident is what this prevents).

1. **Clean tree** — `git status` shows nothing uncommitted.
2. **Tests green** — `npm test` exits 0 (also enforced automatically by the
   `prepublishOnly` hook, so a broken build cannot be published).
3. **Bump + tag in one step** — `npm version <patch|minor|major>`. Never
   hand-edit the `version` field; `npm version` creates the commit *and* the
   matching `vX.Y.Z` tag so they can't diverge.
4. **Push with tags** — `git push origin main --follow-tags`.
5. **Publish** — `npm login` (if `npm whoami` 401s), then `npm publish`.
   `prepublishOnly` reruns the suite first.
6. **Verify** — `npm view memoir-cli version` matches `git describe --tags`.

The published tarball is an allowlist (`files` in package.json: `bin/`, `src/`,
README, LICENSE). Anything outside those — tests, marketing docs, the
`mcp-publisher` binary — never ships. Add new runtime paths to `files`.
