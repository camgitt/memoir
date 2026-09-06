# Local project view validation — 2026-09-06

The local project view is implemented and tested in this checkout. Nothing was
committed, pushed, published to npm, or deployed. Existing Codex and Cursor
connection settings were preserved. The managed project instructions gained a
view command; setup backed up their previous contents.

## Use it

Ask the agent **“Open my Memoir project view.”** From this source checkout,
`node bin/memoir.js work view` opens it in a browser. Keep the terminal process
running; Ctrl+C stops it. No account or extra package is required beyond the
repository's existing dependencies.

Search answers, decisions, goals, next steps and check evidence. Correct a record,
mark a step done, or remove it from the handoff. Removed records can be restored.
Removal retains local history and is not permanent erasure. Checks cannot be
edited or restored into a pass; a new authorized execution is required.

## Browser evidence

Actual browser interactions used this project's real local ledger:

| Exercise | Observed result |
|---|---|
| Correct the project-view decision | New wording saved at revision 26; earlier revision 22 and its source remained in history |
| Remove that decision | Revision 27 hid it; a separate agent-resume read confirmed it was absent |
| Restore through the Removed page | Revision 28 returned the corrected wording to agent context |
| Save while another session changed the same decision | Concurrent revision 30 blocked the old draft; the browser retained the draft and showed the latest saved version |
| Compare and save the correction | Revision 31 preserved the reviewed wording and rationale; keyboard focus returned to the card's Correct button |
| Search the corrected wording | Found the active decision, without unrelated cards |
| Narrow-screen layout at 390 px | Navigation scrolled within its own row; page content stayed within the viewport |
| Browser error log after these interactions | No logged browser errors |

Browser records are the same records returned by the project reader, not a second
memory store. The UI uses text rendering for stored content and contains no
command execution or settings control.

## Request-security and regression evidence

All **14 local-view test groups passed** in `test-work-view.mjs`. These cover
loopback binding, per-process authentication, Host rebinding, cross-origin and
preflight rejection, write method/origin/content type, current branch/revision,
correction history, stale writes, removal/restore, removed-item stale edits,
secret and scope rejection, body limits, fixed asset routes, protected receipts,
text-rendering sinks, and capability invalidation after restarting the view.

The first test run failed because the test's fetch client normalized the hostile
Host header. Switching that probe to a wire-level HTTP request exercised the
intended attack and confirmed rejection. That failed receipt remains in history.
A further review found that an old browser draft could otherwise revive a removed
item; browser writes now reject it and require explicit restoration.

**23 full suites passed, with zero failures or skips.** This includes the
existing 17-group handoff integration suite and 19-scenario adversarial suite.
Of those 19 scenarios, one intentionally demonstrates that a local writer can
forge a structurally valid receipt; it is a documented limitation, not a defense.

Relevant files changed in the view implementation, so the integration and
adversarial receipts needed targeted rechecks. Current saved passes are view
revision 29, integration revision 32 and adversarial revision 33. Ordinary full
suite output is retained only as local test evidence; it is not represented as
an automatically captured Memoir receipt.

## Fresh-session continuity

The first fresh Codex CLI session read handoff revision 35. It retrieved delivery
answer revision 2, privacy answer revision 3, corrected project-view decision
revision 31, completed build revision 34 and the open validation action revision
35. It identified the three reusable checks above and named all four changed
files invalidating documentation receipt 19. It ran no checks and asked no
questions.

The configured MCP call was refused by Codex's existing never-approval policy.
Because this probe explicitly prohibited file edits, it used the existing
read-only project reader instead of the normal CLI resume, which refreshes the
Markdown preview. No approval policy or app configuration changed. The previous
Codex/Cursor round trip is documented separately in
[LOCAL-HANDOFF-VALIDATION.md](LOCAL-HANDOFF-VALIDATION.md); this view exercise does
not claim a new Cursor agent run.

The second fresh Codex session read revision 38 through the documented CLI
fallback after the same MCP policy refusal. It recovered the same original
answers and browser correction, the clarified completed build at revision 37,
and the new validation decision at revision 38. It correctly recognized all
four receipts as reusable, including the refreshed documentation receipt 36.
It performed no check execution and made no project-record changes. The normal
resume refreshed the generated Markdown preview.

| Observation across the two fresh sessions | Result |
|---|---|
| Original answers retained | Both retained revisions 2 and 3 |
| Corrected project-view decision retained | Both retrieved revision 31 |
| Completed build recognized | Both reported done; second saw the clarified revision 37 |
| Expected view/validation decisions missed | None among the explicitly requested records |
| Questions repeated | 0 |
| Check executions in the probes | 0 |
| Stale documentation evidence handled | First named changed files; second reused the targeted replacement |

Both prompts requested a context report and prohibited check execution. These
counts therefore measure controlled retrieval and instruction following, not
spontaneous agent behavior or time saved against a baseline. No multi-day usage
study has been completed. Local event logs/results are in `.memoir/` and remain
ignored; no transcript was added to the project ledger.

The installed-tarball smoke test passed for version 3.13.3, including the view
command's help, all three shipped browser assets, authenticated project data and
unauthenticated denial. The archive was installed only in an isolated temporary
directory and was not published. Source and test fingerprints did not change
between the two probes; the documentation receipt was the targeted update.

## Limits and the next useful trial

- A person or agent still starts the view and keeps its process alive. It is an
  opt-in local HTTP listener on 127.0.0.1, not a background service.
- Agents must read and save the handoff. It cannot force an agent to respect a
  decision, prevent every repeated question, or capture unsaved conversation.
- GitHub does not sync the ignored ledger. Use the same folder and branch on this
  computer; another checkout needs an explicit future transfer mechanism.
- The view checks current file fingerprints when refreshed. External systems
  such as Stripe settings need fresh evidence when relevant conditions change.
  A documentation-only edit does not invalidate an unrelated code receipt.
- Keep its temporary access link private. Static pages contain no project data;
  data and writes require the token. Other same-user processes and an attacker
  with filesystem access are outside this boundary.
- Project records remain plaintext, secret detection is heuristic, source labels
  and check receipts are unauthenticated, and semantic prompt injection remains
  possible. See [the focused audit](HANDOFF-SECURITY-AUDIT.md).

Use the next three ordinary development tasks as the practical trial. Count
repeated already-answered questions, identical unnecessary check executions,
missed saved decisions, and corrections needed. Record only concise project
observations, not conversation transcripts or credentials. Do not treat a rerun
after changed relevant files or external conditions as wasted work. This will
show whether the controlled result holds during real use before expanding to
more tools or making product performance claims.
