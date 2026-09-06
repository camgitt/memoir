# Matched retrieval measurements

Measured 5 September 2026 on macOS arm64, Node 26.7.0, Apple M4 Pro. The earlier audit remediation candidate (`bf30217`) is the baseline; this is not a competitor or published-release comparison. The measured source hashes match implementation commit `a5af53e11e4beb9022e065f7a219ccf309df4d7d`.

Each corpus contains roughly 1 KB of multilingual coding notes per record. Runs used the same harness and normalized fixture hashes, one cold query and 120 warm queries per corpus, with a fixed cycle of common terms, rare terms, prefixes, and a no-match query. Runs were sequential. Timings include the public in-process search API, filesystem inventory/validation, ranking, and passage generation.

| Source | Records | Before median ms | Indexed median ms | Before p95 ms | Indexed p95 ms | Median speedup |
|---|---:|---:|---:|---:|---:|---:|
| adapter | 1,000 | 53.6 | 8.4 | 57.9 | 10.0 | 6.4× |
| adapter | 10,000 | 516.8 | 77.3 | 545.6 | 109.7 | 6.7× |
| canonical | 1,000 | 359.2 | 9.9 | 368.0 | 11.2 | 36.1× |
| canonical | 10,000 | — | 92.3 | — | 124.8 | — |

The 10,000-record indexed warm p95 measurements are below the proposed 250 ms budget on this fixture and machine. They are not a universal latency guarantee. Cold indexed queries still took about 1.34 seconds for adapter records and 1.52 seconds for canonical records. There is no matched 10,000-canonical-record baseline in this run.

## Memory tradeoff

A separate fresh-process probe at 10,000 adapter records, after 24 warm queries and an explicit garbage collection, retained 95.5 MiB of JavaScript heap before and 163.8 MiB with the index (about 68.3 MiB extra). Process RSS was 311.2 versus 386.2 MiB. These include the parsed corpus and other process allocations, not only the postings. The longer multi-corpus run had higher transient RSS; its per-corpus snapshots are in the raw evidence.

The speed gain therefore has a memory cost. Large-archive support still needs a memory budget and potentially a disk-backed index. This change does not add semantic search, a native database dependency, or a claim of improved coding outcomes.

## Validation

Twenty local suites passed, including the 26 audit regression groups and 12 retrieval-index groups. The installed tarball passed 11 workflow checks. All 16 development cases agreed with the exhaustive scoped reference, and the dependency audit reported no advisories. Hosted CI is checked separately on the final PR head.

See [raw measurements](../evals/results/retrieval-2026-09-05.json), [implementation and reproduction instructions](RETRIEVAL-INDEX.md), and the [future coding-continuity protocol](../evals/CONTINUITY-PROTOCOL.md).
