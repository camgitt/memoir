Title: Show HN: Memoir – Sync your AI coding memory across tools and machines, zero config

URL: https://github.com/camgitt/memoir

Text:

I got tired of re-explaining my codebase to Claude every session. "We use Zustand, not Redux." "The auth middleware is in src/middleware." "We decided on Prisma last week." Every conversation starts from zero.

So I built memoir — an MCP server + CLI that gives AI coding tools long-term memory. One command, zero config:

    npx memoir-cli

Auto-detects your GitHub, creates a private repo, backs up everything. No wizard, no account creation.

It works as an MCP server with 6 tools your AI calls automatically:

    you: how does auth work in this project?

    # memoir_recall("auth") runs in the background
    # Found 3 memories

    claude: Based on your previous sessions — JWT auth with
    refresh tokens, middleware in src/middleware/auth.ts,
    you chose Zustand for auth state (decided March 12).

No re-explaining. It just remembers.

It also syncs across machines and translates between tools:

    npx memoir-cli restore                     # restore on a new machine
    memoir migrate --from cursor --to claude    # AI-powered translation

Supports 13 tools: Claude Code, Cursor, Windsurf, Gemini CLI, ChatGPT, Codex, Copilot, Zed, Cline, Continue.dev, Aider, and more. E2E encryption available, secret scanning built in, MIT licensed.

Website: https://memoir.sh

Would love feedback — especially on what MCP tools would be most useful, and whether the recall search is good enough (currently keyword-based, considering semantic search).
