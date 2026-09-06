// Rebuildable, process-local postings. Canonical files remain authoritative;
// nothing is persisted or trusted across a filesystem refresh or scope change.
export class LexicalIndex {
  constructor() { this.clear(); }

  clear() {
    this.documents = new Set();
    this.postings = new Map();
    this.tokensByDocument = new Map();
    this.vocabulary = null;
  }

  sync(documents) {
    const current = new Set(documents);
    for (const doc of this.documents) {
      if (current.has(doc)) continue;
      for (const token of this.tokensByDocument.get(doc)) {
        const posting = this.postings.get(token);
        posting.delete(doc);
        if (!posting.size) { this.postings.delete(token); this.vocabulary = null; }
      }
      this.tokensByDocument.delete(doc);
    }
    for (const doc of current) {
      if (this.documents.has(doc)) continue;
      const tokens = new Set(Object.values(doc.tf).flatMap(field => [...field.keys()]));
      this.tokensByDocument.set(doc, tokens);
      for (const token of tokens) {
        if (!this.postings.has(token)) { this.postings.set(token, new Set()); this.vocabulary = null; }
        this.postings.get(token).add(doc);
      }
    }
    this.documents = current;
  }

  lookup(terms) {
    if (!this.vocabulary) this.vocabulary = [...this.postings.keys()].sort();
    const documents = new Set();
    const matches = new Map();
    for (const term of terms) {
      const tokens = new Map();
      if (this.postings.has(term)) tokens.set(term, 1);
      if (term.length >= 4) {
        // Binary seek to query-prefix matches; no full vocabulary scan.
        let lo = 0, hi = this.vocabulary.length;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if (this.vocabulary[mid] < term) lo = mid + 1; else hi = mid;
        }
        for (let i = lo; i < this.vocabulary.length && this.vocabulary[i].startsWith(term); i++) {
          const token = this.vocabulary[i];
          if (token !== term) tokens.set(token, .6);
        }
        // The reference scorer also allows a document token to prefix the query.
        for (let n = 4; n < term.length; n++) {
          const token = term.slice(0, n);
          if (this.postings.has(token)) tokens.set(token, .6);
        }
      }
      matches.set(term, tokens);
      for (const token of tokens.keys()) for (const doc of this.postings.get(token)) documents.add(doc);
    }
    return { documents, matches };
  }
}
