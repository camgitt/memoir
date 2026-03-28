Title: Show HN: Memoir – Persistent memory for AI coding tools via MCP

URL: https://github.com/camgitt/memoir

Text:

I got tired of re-explaining my codebase to Claude every session. "We use Zustand, not Redux." "The auth middleware is in src/middleware." "We decided on Prisma last week." Every conversation starts from zero.

So I built memoir — an MCP server that gives AI coding tools long-term memory. You add it to Claude Code, Cursor, or Windsurf, and your AI can search, read, and save memories across sessions automatically.

    you: how does auth work in this project?

    # memoir_recall("auth") runs in the background
    # Found 3 memories

    claude: Based on your previous sessions — JWT auth with
    refresh tokens, middleware in src/middleware/auth.ts,
    you chose Zustand for auth state (decided March 12).

No re-explaining. It just remembers.

The MCP server exposes 6 tools: memoir_recall (search memories), memoir_remember (save context), memoir_list, memoir_read, memoir_status, memoir_profiles. Your AI calls these as part of the conversation — you don't do anything manually.

It also works as a CLI for cross-machine sync:

    memoir push      # back up all AI tool configs
    memoir restore   # restore on a new machine in 60 seconds
    memoir migrate --from cursor --to claude   # AI-powered translation

Supports 11 tools: Claude Code, Cursor, Windsurf, Gemini CLI, ChatGPT, Codex, Copilot, Zed, Cline, Continue.dev, Aider. E2E encrypted (AES-256-GCM), secret scanning built in, MIT licensed.

    npm install -g memoir-cli

Website: https://memoir.sh

Would love feedback — especially on what MCP tools would be most useful, and whether the recall search is good enough (currently keyword-based, considering semantic search).
