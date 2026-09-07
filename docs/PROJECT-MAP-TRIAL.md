# Project map trial — 2026-09-06

The map is functional, but this trial does not establish that it is faster than
the Records view. It is useful for following explicit references to check
evidence. Direct answers are already easy to find in Records, and keyword
suggestions still include weak connections.

## Actual browser tasks

Tested against this checkout's real project record in the Codex in-app browser.
The starting ledger was revision 70, with 27 active entries. Existing answers and
check evidence were read before starting; no setup questions were repeated.

| Task | Map | Records | Finding |
| --- | --- | --- | --- |
| Find the saved privacy boundary | One node selection from the default map | Answer already present in Overview | No advantage for the map on this direct lookup |
| Read the complete saved publication blocker | One node selection | One **Read full entry** activation from Overview | Both expose the same saved blocker; external account state was not reverified |
| Find checks covering `docs/PROJECT-HANDOFF.md` | Evidence filter plus file search | Checks category plus file search | Records initially returned no result; fixed to search covered files too |
| Follow the documentation decision to its check | Search for the document, select the decision, follow **Recorded link** | Category/file search finds the check separately | The map exposes the reference and explains the file relationship |
| Decide which checks need another look | Linked receipt named changed UI files | The same receipt named the same changes | Changed inputs were visible; unchanged CLI/MCP receipts were reused |

These are observed control activations, excluding scrolling, switching views and
test resets. They are not timed human measurements or a randomized comparison.
The tester already knew the project. Repeated questions: zero in this task;
that observation is not proof of an improvement against an unassisted baseline.

## Problems reproduced and fixed

1. **Detail panel blocked the map and Reset.** At the actual 742px window width,
   the fixed panel overlapped Reset; a hit test returned the panel. Below 950px,
   details now follow the map in normal flow. Selecting a node focuses its
   heading; Back returns focus to the project. Reset was retested successfully.
2. **Filtering lost keyboard focus.** After a category click, focus was on the
   document body because the filter had been replaced. Focus now moves to the
   replacement active filter. Verified in the real browser and regression test.
3. **File search disagreed between views.** Records omitted check input paths and
   source text. Both views now use the same searchable fields. The actual
   documentation-file search returns the same check in both views.
4. **A newly saved entry disappeared into the overview.** A real browser save
   succeeded but did not select the new record; focus fell back to the body.
   A regression test reproduced it. Map saves now select the saved entry and
   return focus to its visible correction control. A second real creation and
   correction verified this behavior. Long entries exposed another case: the
   first button was a hidden expansion control. Focus now targets card actions
   explicitly; the regression test includes a long entry.
5. **Confirmation text had poor contrast.** The dark map inherited light text
   on the old pale notification background. Map success/error notices now have
   explicit dark backgrounds and contrasting text. The success message's
   computed text/background contrast was 10.70:1 in the actual browser.

## Persistence and boundaries

Two project-only trial observations were saved through the actual editor. The
result record was corrected, temporarily removed and restored through Records.
A separate process read agent resume after removal and confirmed the result was
absent. After restoration it recovered the corrected version and preserved
history. The original privacy and delivery answers remained at revisions 3 and
50. Existing project decisions, settings and private memory were not rewritten
for this test.

The map was checked at 390px, the normal 742px window, and 1280px. Details no
longer overlap the map, and no horizontal overflow was observed. Wide windows
retain a side panel. This is a focused layout/keyboard check, not a full
accessibility audit.

At this initial trial, the UI regression suite contained 21 scenarios, including map focus, saving,
consistent search, exact versus suggested links, older-entry search, and literal
rendering of synthetic hostile markup. The existing 14 API/security groups cover
authentication, cross-origin access, stale edits, removal/restore, secret/scope
rejection and unavailable execution routes. These targeted checks and the guide
check were captured in the local ledger after the relevant files changed.
Matching CLI/MCP and adversarial handoff receipts were reused. This was not a new
production penetration test or a fresh Cursor round trip.

## What remains to establish

- Keyword suggestions are noisy. The privacy answer was linked through generic
  words such as “user”, “evidence” and “handoff”; the labels explain the match but
  cannot make it useful. Evaluate suggestions against human-labeled relevant
  pairs before treating the map as an intelligent project model.
- The graph computes relationships within at most 120 entries.
  Search covers all active entries, but connections are not exhaustive.
- There is no saved relationship editor, automatic impact analysis, natural
  language retrieval, or measured reduction in time/repeated work from the map.
- Keep both views available. Next, test unfamiliar users on real project
  questions and count successful answers, mistaken interpretations and time.

The trial used local, uncommitted changes. No publication, server deployment,
new account setup or personal-memory import was needed to perform it.

## Follow-up: reduce graph clutter

The user found the graph messy after this trial. The observed overview contained
24 lines and 11 nodes. The revised view shows six entries around the project,
with six straight membership lines and no lines between the surrounding entries.
Selecting an entry moves it to the center and shows only its direct neighbors,
with at most six links. Labels have larger type and a two-line limit; full text
remains in the inspector. Suggested links are now off by default and explicitly
enabled with **Suggested links**. The graph and inspector apply the same filter.

The actual browser showed six lines and seven nodes in the new overview. A check
with eight recorded connections displayed six; selecting an answer with no
recorded references showed zero links, then six dashed links after enabling
suggestions. At 390px, the seven node boxes did not overlap and the page had no
horizontal overflow. Two new regression cases cover the overview limit and
direct-neighbor filtering with opt-in suggestions, bringing the UI suite to 23
scenarios. The underlying keyword-matching quality is unchanged by this cleanup.
# Shared workspace follow-up — 6 September 2026

Further feedback was that even the unified page required too much reading.
The overview now shows all open actions as short rows with a **Details** button.
Saved answers and recent decisions start collapsed; matching check receipts are
available through the summary and Checks category. Only checks needing review
appear in the overview. Existing action text was shortened and the explanation
moved into its rationale; previous full text remains in local history. The npm
action now reflects the observed password-confirmation screen in Chrome.

The user reported that Map and Records still looked incoherent. The browser now
opens Records first and uses one header, search, category navigation, color
palette and correction dialog for both views. Records have a single column of
readable rows. The former separate sidebar, duplicate introductions and light
card grid are removed.

Switching views preserves search and category. **Connections** opens the same
record in the map; **Open in Records** returns to its category. A successful save
reveals the saved entry and clears filters that could hide it. Overview search
now includes every matching entry, including goals and completed actions.

Observed in the actual local browser:

- Found the existing privacy answer, opened its correction dialog and cancelled
  without changing the answer, followed Connections and returned to Records.
- Searched `src/work/ui/style.css` and found the same three check receipts in
  Records and Map, including specific changed-input warnings.
- A search with no results stayed empty after switching views.
- Created the actual workspace-design decision while an empty search was active.
  Saving cleared the search, opened Decisions and showed the saved entry.
- Corrected that decision from Map and confirmed keyboard focus returned to
  the visible Correct button. Returning to Records showed the correction and
  its earlier version. Focus restoration now scopes itself to the active view.
- Inspected Records at the normal window width and 390px, Map at 1280px, and the
  shared dark editor at 1280px. At 390px the seven overview node boxes did not
  overlap; the document had no horizontal overflow. Narrow category navigation
  scrolls horizontally, and map details follow the graph in normal flow.

The changed UI requires targeted UI/API and documentation rechecks. Unchanged
CLI/MCP handoff and adversarial receipts remain reusable. This is local design
and functional validation; it adds no independent-user or timed utility study.
The npm publishing step remains separate from this local preview.
