Title: Show HN: Memoir – Sync your AI coding memory across devices and tools

URL: https://github.com/camgitt/memoir

Text:

I switch between a Mac and a PC daily. Every time, my Claude Code rules, Gemini instructions, Cursor settings — gone. Trapped in hidden dotfiles on whichever machine I used last.

Memoir is a CLI that backs up, restores, and translates your AI memory across devices and tools. Supports 10 tools: Claude Code, Gemini CLI, OpenAI Codex, Cursor, GitHub Copilot, Windsurf, Zed, Cline, Continue.dev, and Aider.

    memoir push      # back up AI configs to GitHub
    memoir restore   # restore on a new machine
    memoir migrate --from claude --to gemini

The migrate command is the interesting part — it uses AI to actually translate your instructions between tools, not just copy files. Your Claude CLAUDE.md becomes a proper .cursorrules or GEMINI.md that follows each tool's conventions.

It also scans your projects for per-project AI configs (CLAUDE.md, GEMINI.md, .cursorrules, AGENTS.md) and syncs those too. Handles cross-platform path differences automatically.

Security-first: only syncs config and instruction files. Never touches credentials, auth tokens, or .env files. Run `memoir doctor` to verify what gets synced.

    npm install -g memoir-cli

Built with Node.js, MIT licensed. ~100kb installed. Would love feedback — especially on what tools or workflows to support next.
