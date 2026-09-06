# Project handoff adversarial audit — 2026-09-06

**Status: local preview, not a public deployment or a security-certified product.**
The original functional tests were not a dedicated adversarial audit. This
follow-up exercised the new project handoff, its MCP interface, CLI, settings
writer, ledger parser and Git metadata helper using synthetic attack fixtures.
It found real gaps and changed the implementation. All changes remain local.

## Findings and fixes

| Finding | Impact | Fix |
|---|---|---|
| MCP check tool accepted arbitrary host commands | A memory-tool call could read server environment values and write outside the project using server privileges | Disabled command execution over MCP completely. Existing tool name returns a refusal. Checks use the CLI under the coding client's ordinary terminal permissions |
| Reading Git status executed a configured fsmonitor hook | A resume operation could execute repository-controlled code | Removed dirty-status execution from the shared repository metadata helper. Dirty status is now unknown; per-file freshness still works |
| JSON serialization hid some secrets from the scanner | Field-leading environment assignments and embedded JSON credentials could be saved | Scan decoded strings, normalize common invisible obfuscation for detection, and reject recognized credentials before storage |
| Rendered record data could create Markdown structure and image links | A stored answer could imitate a new evidence section or contain active image markup | Escape rendered fields and keep them on one line; explicitly label all stored text untrusted |
| A file named `__proto__` disappeared from input evidence | Changes to a declared file could fail to invalidate a check | Use dictionaries without an object prototype and validate original input maps without schema normalization dropping that key |
| Maximum-size check input lists broke subsequent reads | 100 explicit inputs plus automatic manifests created a ledger the old reader rejected | Validate the combined maximum consistently |
| Incomplete receipt/history validation | Incorrectly typed evidence, reordered history and malformed retractions could be accepted | Strict receipt, metadata, revision-order and history-completeness validation; preserve and refuse malformed data |
| Non-object Cursor settings could be rewritten | Setup could replace an unexpected existing configuration shape | Reject before any planned settings/instruction edits are applied |
| Unbounded CLI stdin | Oversized input was buffered and parsed | Enforce a 16 KiB limit while reading and before parsing |

Additional hardening sanitizes parser and filesystem errors so damaged-file
contents are not returned to an MCP client. Unsafe controls and direction
overrides are rejected after decoding. The memory interface remains local stdio.
The later project-view feature adds an opt-in HTTP listener bound only to
127.0.0.1, with a per-process capability, strict Host/Origin validation and no
command execution. It adds no telemetry, cloud upload or background daemon.
See [the project-view validation](PROJECT-VIEW-VALIDATION.md) for its separate
browser and request-security checks. The counts below describe the earlier audit.

## Adversarial evidence

`test-work-adversarial.mjs` contains **19 scenarios**. The first baseline had
14 failed assertions. Further probing then reproduced execution of a synthetic
Git fsmonitor hook and caught a normalization issue in the first prototype-key
fix. These are regression probes, not 14 independent vulnerability ratings.
No real credentials, personal home files or external attack targets were used.

The final suite passes all 19 assertions. Eighteen scenarios verify defenses;
one deliberately demonstrates the remaining valid-receipt-tampering boundary
and verifies that it is explicitly disclosed. A passing test count must not be
interpreted as proof that every attack is blocked.

Covered attacks include host command/environment access through MCP, Git-hook
execution during resume, damaged-file error leakage, multiple secret formats,
invisible and directional text, Markdown spoofing, special dictionary keys,
input limits, malformed and reordered history, configuration clobbering,
oversized stdin, symlink escape, shell metacharacters and personal-scope requests.

Run the dedicated suite with:

```sh
node test-work-adversarial.mjs
```

`npm test` includes it alongside the existing functional suites. The dependency
audit against the npm advisory data reported **zero known vulnerabilities** in
the production dependency tree at the time of this audit. That result does not
cover application logic or prove the absence of undisclosed dependency bugs.

After the final fixes, **22 full test suites passed** and the installed-package
smoke test passed. The new 19-scenario adversarial suite and the existing
17-group handoff suite are included in that result.

The live Cursor app connection was reloaded and tested in the existing
“Memoir project continuation” conversation. A harmless `memoir_work_check`
request returned the explicit MCP-execution refusal. A subsequent
`memoir_work_resume` still returned both saved answers and the unauthenticated
receipt warning. No fallback command was run for this denial probe. This verifies
the active client received the hardened server, not only an isolated test copy.

## What this does not secure

- **Valid local receipt forgery remains possible.** A process with ledger write
  access can change a failed exit code to zero and construct valid-looking
  metadata. The suite demonstrates this. Receipts are local, unauthenticated
  observations, not signed attestation or release authorization.
- **Semantic prompt injection is not solved.** Escaping blocks structural
  spoofing and active Markdown, but an AI can still mishandle hostile text.
  Stored claims and source labels never grant authority.
- **The CLI is not an independent sandbox.** It executes the authorized command
  with the terminal client's permissions and environment. Declared input hashes
  are evidence scope, not restrictions on what that process can read or write.
- **Same-user hostile filesystem races are outside the boundary.** Stable
  symlinks and traversal are rejected, but this is not OS-level isolation from
  a process that can concurrently alter the project, server installation or
  ancestor directories. A stronger boundary needs OS-enforced isolation and
  separately protected evidence signing.
- **Privacy detection is heuristic.** Arbitrary personal sentences and every
  encoded credential cannot be identified automatically. Local files/backups
  are plaintext, and connected AI clients receive the project context they use.
- **Scope is the new handoff.** This is a focused source and local adversarial
  audit, not an independent penetration test of all legacy Memoir commands,
  hosted APIs, cloud authorization or cross-tenant isolation. Those were not
  exercised against a live service here.

## Local audit trail

Baseline and rerun logs are beside this checkout:
`../memoir-adversarial-before.log`,
`../memoir-adversarial-additional-before.log`,
`../memoir-adversarial-after.log`, and
`../memoir-security-full-tests.log`. The dependency result is
`../memoir-handoff-npm-audit.json`. Current execution receipts and the saved audit
decision are in the ignored `.memoir/work.json`; none of these logs were published.
