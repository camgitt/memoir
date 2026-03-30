# Contributing to memoir

Thanks for your interest in contributing! memoir is open source and welcomes contributions.

## Quick start

```bash
git clone https://github.com/camgitt/memoir.git
cd memoir
npm install
node bin/memoir.js status
```

## What to work on

- **New tool adapters** — add support for more AI tools in `src/tools/`
- **MCP improvements** — enhance the MCP server in `src/mcp.js`
- **Bug fixes** — check [open issues](https://github.com/camgitt/memoir/issues)
- **Documentation** — improve README, add examples

## Submitting changes

1. Fork the repo
2. Create a branch (`git checkout -b feature/my-feature`)
3. Make your changes
4. Test locally: `npm test`
5. Commit and push
6. Open a PR with a clear description

## Code style

- ES modules (`import`/`export`)
- No TypeScript (plain JS)
- Keep dependencies minimal

## Adding a tool adapter

See `src/tools/claude.js` for an example. Each adapter exports:
- `name` — display name
- `icon` — emoji
- `source` — path to the tool's config directory
- `files` — specific files to sync (if `customExtract` is true)
- `filter` — function to include/exclude files

## Questions?

Open an issue or start a discussion.
