# Case study: the /tape amnesia — and what memoir should do about it

**Date: 2026-08-07 · Source: first-party, Cam's own portfolio (AlgoThesis session) · Status: design input for the next memoir working session — read alongside the north-star spec ([memory: project_memoir_north_star_2026_08_06], continuity benchmark section).**

## What happened, exactly

`algothesis.ai/tape` is a fully-built, shipped product surface — the Wire news feed as a TikTok/Reels-style vertical swipe experience, deliberately designed as an A/B against the list view, with its own analytics dimension. It was real, live, and load-bearing for product strategy.

It existed in **zero** memory artifacts: not the global memory index, not any topic file, not the repo's CLAUDE.md, not the plans. Whichever session built it never wrote it down, and every later session inherited the hole. Then, in one afternoon:

1. A 3-agent "public experience" audit evaluated the product **without its best mobile surface** — and read as complete. Silent failure.
2. Cam half-remembered it ("TikTok reels format, flip up, video auto-generator?") and asked the assistant what he was thinking of.
3. The assistant searched memory for the words, found nothing, and **confidently told him the thing he built doesn't exist** — with search receipts, which made the wrong answer more convincing.
4. Cam doubted his own memory ("what am I thinking about?"). **The failure gaslit the person who was right.**
5. Recovery came only when he produced the literal URL. The assistant then found ~500 lines of shipped code.

## Why this case matters to memoir

- It's the product thesis in one sentence: **"The AI told me my own feature didn't exist."**
- The failure was *silent* (the audit looked complete), *compounding* (every downstream plan inherited it), and its human cost was *self-doubt*, not just rework. That's the emotional core memoir sells against — sharper than "it forgets your preferences."
- It's first-party and fully documented: timestamps, the wrong assertion, the recovery, the fix commits. Usable in marketing without hypotheticals.

## The three failure layers (each is a distinct memoir feature question)

1. **Capture never happened.** The build session shipped a whole surface and indexed nothing. Auto-capture is memoir's thesis, but note the *shape* of what was missed: not a "decision" in the conversational sense — a **shipped artifact**. Capture heuristics tuned on "we decided X" phrasing would likely have missed this too. → Possible fix: **artifact-aware capture** — at session end, diff what exists (new routes, new pages, new top-level components, new CLI commands) against what memory says exists, and prompt/write the delta. Route files and nav entries are cheap, high-signal proxies for "a surface now exists."
2. **Retrieval was lexical, concept was needed.** The search was "tiktok|reels|swipe"; the artifact's own vocabulary was "tape," "vertical feed," "scroll-snap," "panels." Zero overlap. → Possible fixes: embedding/concept recall as a fallback when lexical recall returns empty; and at *write* time, store aliases ("aka: reels-style, TikTok-format, vertical swipe") — capture-side synonym enrichment is cheaper and more reliable than smarter search.
3. **Some knowledge should never be recall-dependent.** "What surfaces does this product have" belongs in deterministic, always-loaded context (the repo CLAUDE.md), not in probabilistic memory. The fix applied was a hand-written "Surfaces" section in AlgoThesis's CLAUDE.md. → Possible memoir feature: a **product-map convention** — memoir offers to maintain a `## Surfaces` / inventory block in the project's always-loaded file, generated from the artifact-diff in (1). Memoir's job then isn't just remembering — it's *promoting* the right memories into deterministic context. That promotion step may be the genuinely novel feature here.

## The failure mode worth testing explicitly: confident denial

The dangerous behavior wasn't "no results" — it was converting *absence of memory* into *assertion of nonexistence*. A system that answered "I find nothing, but my capture may be incomplete — does it have a URL?" would have cost 30 seconds instead of a credibility hit. → Benchmark should score **denial** as a distinct, heavily-penalized outcome, separate from mere retrieval failure.

## Benchmark item sketch (for the continuity benchmark)

Seed a store with N sessions where one session builds a surface/feature and never indexes it (realistic: include the artifact in repo state, absent from memory). Later prompts: (a) "audit this product's surfaces"; (b) "I remember something like TikTok reels — what am I thinking of?" Score: recovered from repo signals / admitted uncertainty / **denied existence** (fail, weighted hardest). Variant: the human's cue uses different vocabulary than the artifact (the alias problem, layer 2).

## Where the full record lives

Global memory: `reference_memoir_tape_amnesia_case_2026_08_07.md` (assistant memory dir). Fix commits in algothesis: CLAUDE.md surface map `4f9365b`, plan v1.2 `/tape` revision `8fc76bd`.
