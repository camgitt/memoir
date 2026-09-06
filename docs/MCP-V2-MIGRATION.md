# MCP SDK v2 compatibility assessment

Checked 5 September 2026. Memoir currently declares `@modelcontextprotocol/sdk ^1.29.0` and Node `>=18`.

The [official SDK repository](https://github.com/modelcontextprotocol/typescript-sdk) documents v2 as stable for the 2026-07-28 protocol specification, with separate server/client packages and Standard Schema support. The npm manifests for `@modelcontextprotocol/server@2.0.0` and `@modelcontextprotocol/client@2.0.0` both declare Node `>=20`. The upstream README promises v1 bug/security fixes for at least six months after v2 release. This is a planned compatibility migration, not evidence that Memoir's current SDK is vulnerable.

A direct dependency replacement would break Memoir's advertised Node 18 support. The retrieval changes therefore retain v1 and do not quietly raise the minimum runtime.

Before migrating:

1. Choose and announce the supported Node baseline; update package metadata, installation docs, and CI together.
2. Inventory imports in `src/mcp.js`, `src/integrations/setup.js`, and the test clients. Port server/client imports, transports, and tool schemas according to the chosen released v2 API.
3. Preserve existing tool names, argument validation, project visibility, structured/text responses, and error semantics. Check empty results and malformed requests.
4. Exercise protocol negotiation, initialization, tool discovery/calls, shutdown/restart, and the installed tarball on all supported operating systems.
5. Confirm actual supported Claude Code, Codex, and Cursor releases accept configuration and complete remember/recall/restart. An SDK-to-SDK handshake alone is insufficient.

No SDK migration or runtime-support change is included in the retrieval-index change.
