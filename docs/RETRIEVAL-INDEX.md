# Retrieval index and verification

Memoir uses a process-local inverted index to find lexical candidates and reuse field-token matches. Markdown and session records remain the source of truth. The index is rebuilt from those sources when the process starts or the search cache is cleared; it is not another copy to back up or synchronize.

See [matched measurements and the memory tradeoff](RETRIEVAL-RESULTS.md) for the checked implementation.

The index preserves the existing field weights, conservative English normalization, bidirectional prefix matching, Unicode/CJK tokens, coverage multiplier, scoped IDF, passage extraction, and result budget. It adds no embedding model, remote call, native binary, or runtime dependency. This is a performance and consistency change, not a new semantic-retrieval algorithm or evidence of better task completion.

## Read path

1. Inventory the registered adapters and canonical current records. Inspect file metadata on each query. Canonical revision history is not searched.
2. Reuse a parsed document only if its modification time, change time, inode, device, and size still match. Cache identity includes the exposed path and adapter, so two adapters cannot borrow each other's labels.
3. Reevaluate project and lifecycle visibility. Resolve repeated project identities once per query. Hidden, expired, superseded, and unrelated records do not enter the query's postings or IDF population.
4. Remove absent documents and add changed documents to the postings. Resolve exact/prefix token matches once against the sorted vocabulary, then retain the existing ranking formula.
5. Validate each returned source's full path and metadata again before releasing a cached passage. If the source disappeared, became a symlink, or changed during the query, skip it; a later query refreshes the content.

Filesystem inventory shares parent-directory checks only within one refresh. Actual content reads still use the validated, no-follow file reader. The parent-check cache is never retained between queries and is never used for writes. This does not establish an atomic filesystem snapshot or eliminate the previously documented hostile parent-directory replacement races.

Current project instructions are discovered from the requested active checkout in normal recall, including checkouts deeper than three directories below the home directory. Explicit discovery-root and all-project diagnostic calls retain their broader discovery scope. Traversal remains limited to three levels beneath the discovery root with existing directory exclusions. Directory entries are cached by metadata, so new instruction files are discovered on the next query without the former 60-second delay.

## Consistency and limits

Save, edit, hide, purge, restore, and external file changes are reflected by the next inventory refresh. Stale backups still go through the canonical store's existing purge/merge rules. A refresh removes missing/unreadable parse entries and evicts outdated postings; clearing the cache cannot resurrect a record that the current sources exclude.

The index is held in memory, so restart and first-query construction are more expensive than warm queries. Every query still inventories source files; latency is not independent of corpus size. Filesystem metadata resolution, network filesystems, corpus size, record length, common versus rare terms, and machine load affect performance. No watcher event is treated as proof that nothing changed. Process memory grows with the parsed corpus and token postings; this implementation is not a disk-backed database for arbitrarily large archives.

The indexed engine and exhaustive reference share the same reader, scope rules, and ranking formula. Their agreement checks index correctness; they are not two independent memory products. Canonical documents now use their source file modification time for tie-breaking, consistently with adapter documents. A tied ranking can therefore differ from the prior branch, which rebuilt canonical documents with a zero modification time.

## Reproduce checks and measurements

`npm test` includes the retrieval-index integration suite. It checks scoring equivalence, same-size external edits with restored modification time, project switching, validity windows, purge plus stale restore, additions/deletions/renames, adapter identity, new project instructions, symlinks, source disappearance during a query, budgets, and source-line parity.

`npm run eval` retains the small development retrieval fixture and adds an exhaustive scoped reference. That fixture is not held out. `searchMemories(query, { engine: 'scan' })` is available internally for diagnostic comparison; MCP continues to use the indexed default.

`npm run bench:retrieval -- --output /absolute/path/report.json` runs synthetic adapter and canonical corpora at 1,000 and 10,000 records. Each corpus has one cold query and 120 warm queries in a fixed mixed cycle. The output includes fixture/harness/source hashes, machine/runtime information, all query timings, median/p95, and process RSS. The fixture has multilingual text and both common- and rare-term queries. It checks a required result and an empty-result case but does not score completed coding tasks.

To compare with an earlier checkout using the same harness and fixtures:

```sh
node evals/retrieval-performance.mjs --repo /absolute/path/earlier-checkout --kinds adapter --sizes 1000,10000 --samples 120 --output /absolute/path/before.json
```

That checkout must have its own compatible dependencies available. Run competing measurements sequentially on the same machine. Do not compare a warm API call with a cold process startup or combine different sample counts without labeling them. RSS is process-wide and includes allocations from preceding corpus runs; it is not isolated index memory.

See [the continuity evaluation protocol](../evals/CONTINUITY-PROTOCOL.md) for the separate work required to establish product utility.
