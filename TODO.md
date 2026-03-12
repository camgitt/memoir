# memoir Roadmap & TODO

This list tracks planned features, identified bugs, and architectural improvements for the `memoir` CLI.

## 🔴 High Priority: Security, Reliability & Bug Fixes
- [ ] **`memoir doctor` Command:** Implement a diagnostic utility to verify:
    - [ ] Correct installation of supported AI tools (Claude, Cursor, etc.).
    - [ ] File permissions for all memory directories.
    - [ ] Git connectivity and API key validity (Gemini).
    - [ ] Environment variable health.
- [ ] **Secret & PII Guard:** Add a pre-push scan to detect API keys or PII in memory files. Implement a `redact` flag.
- [ ] **Linux Path Support:** Add path detection for Cursor and Windsurf on Linux (currently macOS/Windows only).
- [ ] **Aider Local Discovery:** Update the Aider adapter to look for `.aider/` in the current project repo, not just global config.
- [ ] **Robust Claude Pathing:** Replace fragile string-replacement in `src/tools/claude.js` with more reliable hashing/matching for `~/.claude/projects`.
- [ ] **Add `-y` / `--yes` Flags:** Enable non-interactive mode for `push`, `restore`, and `migrate` to support automation.

## 🟡 Medium Priority: UX & Workflow
- [ ] **Local LLM Migration (Privacy):**
    - [ ] Add support for **Ollama** and **LM Studio** as translation engines in `migrate`.
    - [ ] Add a `--local` flag to `migrate` to bypass external APIs.
- [ ] **`memoir watch` (Background Sync):** Create a lightweight daemon to detect changes in local memory files and trigger auto-sync.
- [ ] **Project Bootstrapping (`memoir init --template`):** Seed new projects with "Golden Rule" templates (e.g., "Strict TypeScript," "React/Tailwind Best Practices").
- [ ] **Interactive Merge/Diff:** Replace "Overwrite/Append" in `migrate` with a side-by-side diff view.
- [ ] **Silent Mode:** Add a `--silent` flag to suppress all output except errors.

## 🟢 Low Priority: Intelligence & Advanced Features
- [ ] **Unified Memory Format (UMF):** Architect an internal JSON schema to represent "Coding Context" to simplify adding new tool adapters.
- [ ] **Cross-Tool Search:** Implement `memoir search <query>` to find specific instructions across all tool backups.
- [ ] **Context Compression:** AI-powered `memoir optimize` command to summarize long instruction files and save tokens.
- [ ] **Organization Sync:** Support for shared "Team Memories" stored in a central repository.
- [ ] **Memory Analytics:** `memoir stats` to visualize the growth and "personality" of your AI instructions over time.

---

## 📝 Technical Observations & Bug Log
*   **Circular Dependency:** `package.json` lists `memoir-cli` as its own dependency. Needs cleanup.
*   **Git Performance:** `push` currently clones the entire repo every time. Optimize with `git clone --depth 1` or local cache.
*   **Performance:** Refactor `fs.readFileSync` inside loops (e.g., in `src/tools/claude.js`) to use `fs.promises` for better handling of large projects.
*   **CLI Friction:** The `migrate` command's interactive prompt for multiple files can be tedious; batching confirmations would improve UX.
