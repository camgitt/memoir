#!/bin/bash
# memoir-cli local integration test
# Uses a fake HOME dir so your real configs are never touched

set -e

BOLD="\033[1m"
GREEN="\033[32m"
YELLOW="\033[33m"
CYAN="\033[36m"
RED="\033[31m"
RESET="\033[0m"

FAKE_HOME=$(mktemp -d)
BACKUP_DIR="$FAKE_HOME/memoir-backup"
MEMOIR_BIN="$(cd "$(dirname "$0")" && pwd)/bin/memoir.js"

echo -e "\n${BOLD}${CYAN}=== memoir-cli integration test ===${RESET}"
echo -e "${YELLOW}Fake HOME:${RESET} $FAKE_HOME"
echo -e "${YELLOW}Backup dir:${RESET} $BACKUP_DIR\n"

cleanup() {
  echo -e "\n${YELLOW}Cleaning up $FAKE_HOME${RESET}"
  rm -rf "$FAKE_HOME"
}
trap cleanup EXIT

# ── Step 1: Create mock AI tool configs ──
echo -e "${BOLD}Step 1: Creating mock AI tool data${RESET}\n"

# Gemini CLI
mkdir -p "$FAKE_HOME/.gemini"
cat > "$FAKE_HOME/.gemini/settings.json" << 'EOF'
{ "theme": "dark", "model": "gemini-2.5-pro", "sandboxMode": true }
EOF
cat > "$FAKE_HOME/.gemini/GEMINI.md" << 'EOF'
# Gemini Instructions
Always use TypeScript. Prefer functional patterns. Keep responses concise.
EOF
cat > "$FAKE_HOME/.gemini/projects.json" << 'EOF'
{ "recent": ["/Users/test/myproject"] }
EOF

# Claude CLI
mkdir -p "$FAKE_HOME/.claude/projects/-Users-testuser/myproject/memory"
cat > "$FAKE_HOME/.claude/settings.json" << 'EOF'
{ "permissions": { "allow": ["Read", "Write", "Bash"] } }
EOF
cat > "$FAKE_HOME/.claude/settings.local.json" << 'EOF'
{ "theme": "dark" }
EOF
cat > "$FAKE_HOME/.claude/projects/-Users-testuser/myproject/CLAUDE.md" << 'EOF'
# Project Instructions
This is a Next.js app with Supabase backend.
Always use server components where possible.
EOF
cat > "$FAKE_HOME/.claude/projects/-Users-testuser/myproject/memory/MEMORY.md" << 'EOF'
# Memory
- User prefers Tailwind CSS
- Database is on Supabase project xyz123
EOF

# OpenAI Codex
mkdir -p "$FAKE_HOME/.codex"
cat > "$FAKE_HOME/.codex/config.json" << 'EOF'
{ "model": "codex-1", "approval": "auto" }
EOF
cat > "$FAKE_HOME/.codex/instructions.md" << 'EOF'
Use Python 3.12. Follow PEP 8. Prefer pathlib over os.path.
EOF

# Aider
cat > "$FAKE_HOME/.aider.conf.yml" << 'EOF'
model: claude-opus-4-20250514
auto-commits: true
dark-mode: true
EOF

# Copilot
mkdir -p "$FAKE_HOME/.config/github-copilot"
cat > "$FAKE_HOME/.config/github-copilot/settings.json" << 'EOF'
{ "editor.enableAutoCompletions": true }
EOF

# Per-project AI configs
mkdir -p "$FAKE_HOME/mywebapp"
cat > "$FAKE_HOME/mywebapp/CLAUDE.md" << 'EOF'
# Webapp Rules
Use Next.js 15 with App Router. Deploy to Vercel.
EOF
cat > "$FAKE_HOME/mywebapp/GEMINI.md" << 'EOF'
# Webapp Gemini
Same project, Gemini instructions here.
EOF

mkdir -p "$FAKE_HOME/pyserver"
cat > "$FAKE_HOME/pyserver/AGENTS.md" << 'EOF'
# Python Server
FastAPI backend. Use SQLAlchemy for ORM.
EOF

echo -e "  ${GREEN}Created mock configs for: Gemini, Claude, Codex, Aider, Copilot + 2 projects${RESET}\n"

# ── Step 2: Set up memoir config (local provider) ──
echo -e "${BOLD}Step 2: Configuring memoir (local provider)${RESET}\n"

mkdir -p "$FAKE_HOME/.config/memoir"
cat > "$FAKE_HOME/.config/memoir/config.json" << EOF
{ "provider": "local", "localPath": "$BACKUP_DIR" }
EOF
mkdir -p "$BACKUP_DIR"

echo -e "  ${GREEN}Config written to $FAKE_HOME/.config/memoir/config.json${RESET}\n"

# ── Step 3: Run memoir status ──
echo -e "${BOLD}Step 3: memoir status${RESET}\n"
HOME="$FAKE_HOME" node "$MEMOIR_BIN" status

# ── Step 4: Run memoir push ──
echo -e "${BOLD}Step 4: memoir push${RESET}\n"
HOME="$FAKE_HOME" node "$MEMOIR_BIN" push

# ── Step 5: Verify backup was created ──
echo -e "${BOLD}Step 5: Verify backup contents${RESET}\n"
echo -e "  Files in backup dir:"
find "$BACKUP_DIR" -type f | sort | while read f; do
  echo -e "    ${CYAN}${f#$BACKUP_DIR/}${RESET}"
done
echo ""

BACKUP_COUNT=$(find "$BACKUP_DIR" -type f | wc -l | tr -d ' ')
echo -e "  ${GREEN}$BACKUP_COUNT files backed up${RESET}\n"

# ── Step 6: Wipe the fake AI configs (simulate new machine) ──
echo -e "${BOLD}Step 6: Simulating new machine (wiping AI configs)${RESET}\n"
rm -rf "$FAKE_HOME/.gemini" "$FAKE_HOME/.claude" "$FAKE_HOME/.codex" "$FAKE_HOME/.config/github-copilot"
rm -f "$FAKE_HOME/.aider.conf.yml" "$FAKE_HOME/.aider.system-prompt.md"
# Wipe project AI configs too
rm -f "$FAKE_HOME/mywebapp/CLAUDE.md" "$FAKE_HOME/mywebapp/GEMINI.md"
rm -f "$FAKE_HOME/pyserver/AGENTS.md"
echo -e "  ${YELLOW}All AI tool configs + project configs deleted${RESET}\n"

# ── Step 7: Run memoir restore (auto-yes via echo) ──
echo -e "${BOLD}Step 7: memoir restore${RESET}\n"
HOME="$FAKE_HOME" node "$MEMOIR_BIN" restore --yes

# ── Step 8: Verify restoration ──
echo -e "\n${BOLD}Step 8: Verify restored files${RESET}\n"

PASS=0
FAIL=0

check_file() {
  local filepath="$1"
  local desc="$2"
  if [ -f "$filepath" ]; then
    echo -e "  ${GREEN}PASS${RESET} $desc"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}FAIL${RESET} $desc — file missing: $filepath"
    FAIL=$((FAIL + 1))
  fi
}

check_file "$FAKE_HOME/.gemini/settings.json" "Gemini settings.json"
check_file "$FAKE_HOME/.gemini/GEMINI.md" "Gemini GEMINI.md"
check_file "$FAKE_HOME/.gemini/projects.json" "Gemini projects.json"
check_file "$FAKE_HOME/.claude/settings.json" "Claude settings.json"
check_file "$FAKE_HOME/.claude/settings.local.json" "Claude settings.local.json"
# Claude remaps project paths to current machine's home dir
# e.g. -Users-testuser -> -var-folders-... (in tmp) or -Users-camarthur (on real machine)
REMAPPED_HOME=$(echo "$FAKE_HOME" | sed 's|^/||' | tr '/' '-')
check_file "$FAKE_HOME/.claude/projects/-${REMAPPED_HOME}/myproject/CLAUDE.md" "Claude project CLAUDE.md (path remapped)"
check_file "$FAKE_HOME/.claude/projects/-${REMAPPED_HOME}/myproject/memory/MEMORY.md" "Claude project MEMORY.md (path remapped)"
check_file "$FAKE_HOME/.codex/config.json" "Codex config.json"
check_file "$FAKE_HOME/.codex/instructions.md" "Codex instructions.md"
check_file "$FAKE_HOME/.aider.conf.yml" "Aider config"
check_file "$FAKE_HOME/.config/github-copilot/settings.json" "Copilot settings.json"

# Verify content integrity
echo ""
GEMINI_CONTENT=$(cat "$FAKE_HOME/.gemini/GEMINI.md" 2>/dev/null || echo "")
if echo "$GEMINI_CONTENT" | grep -q "Always use TypeScript"; then
  echo -e "  ${GREEN}PASS${RESET} Content integrity — Gemini instructions preserved"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} Content integrity — Gemini instructions corrupted"
  FAIL=$((FAIL + 1))
fi

CLAUDE_CONTENT=$(cat "$FAKE_HOME/.claude/projects/-${REMAPPED_HOME}/myproject/CLAUDE.md" 2>/dev/null || echo "")
if echo "$CLAUDE_CONTENT" | grep -q "Next.js app"; then
  echo -e "  ${GREEN}PASS${RESET} Content integrity — Claude project memory preserved"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} Content integrity — Claude project memory corrupted"
  FAIL=$((FAIL + 1))
fi

# Project-level AI config tests
echo ""
echo -e "  ${BOLD}Per-project configs:${RESET}"
check_file "$FAKE_HOME/mywebapp/CLAUDE.md" "Project mywebapp/CLAUDE.md"
check_file "$FAKE_HOME/mywebapp/GEMINI.md" "Project mywebapp/GEMINI.md"
check_file "$FAKE_HOME/pyserver/AGENTS.md" "Project pyserver/AGENTS.md"

PROJ_CONTENT=$(cat "$FAKE_HOME/mywebapp/CLAUDE.md" 2>/dev/null || echo "")
if echo "$PROJ_CONTENT" | grep -q "Next.js 15"; then
  echo -e "  ${GREEN}PASS${RESET} Content integrity — project CLAUDE.md preserved"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} Content integrity — project CLAUDE.md corrupted"
  FAIL=$((FAIL + 1))
fi

# ── Results ──
echo -e "\n${BOLD}═══════════════════════════════════${RESET}"
if [ $FAIL -eq 0 ]; then
  echo -e "${BOLD}${GREEN}  ALL $PASS TESTS PASSED${RESET}"
else
  echo -e "${BOLD}${RED}  $FAIL FAILED${RESET}, ${GREEN}$PASS passed${RESET}"
fi
echo -e "${BOLD}═══════════════════════════════════${RESET}\n"

exit $FAIL
