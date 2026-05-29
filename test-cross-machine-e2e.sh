#!/bin/bash
# End-to-end test: simulate cross-machine restore with stale foreign dirs present
# on the "local" machine. Verifies cleanup + remap work together.
#
# Uses a fake HOME to isolate from real ~/.claude. Sets encrypt=false to skip prompt.

set -e

BOLD="\033[1m"; GREEN="\033[32m"; YELLOW="\033[33m"; CYAN="\033[36m"; RED="\033[31m"; RESET="\033[0m"

FAKE_HOME=$(mktemp -d)
BACKUP_DIR="$FAKE_HOME/memoir-backup"
MEMOIR_BIN="$(cd "$(dirname "$0")" && pwd)/bin/memoir.js"

echo -e "\n${BOLD}${CYAN}=== memoir cross-machine e2e test ===${RESET}"
echo -e "${YELLOW}Fake HOME:${RESET} $FAKE_HOME\n"

cleanup() { rm -rf "$FAKE_HOME"; }
trap cleanup EXIT

# The local home key that memoir will compute for our fake HOME on this platform
LOCAL_KEY="-$(echo "$FAKE_HOME" | sed 's|^/||' | tr '/' '-')"
FOREIGN_WIN_KEY="C--Users-WinUser"

# ── Step 1: Seed "local" machine state — has a Mac-style home key AND a stale Windows dir ──
echo -e "${BOLD}Step 1: Seed local machine with stale foreign dir${RESET}\n"
mkdir -p "$FAKE_HOME/.claude/projects/$LOCAL_KEY/memory"
echo "# Mac memory" > "$FAKE_HOME/.claude/projects/$LOCAL_KEY/memory/MEMORY.md"
echo "local-only" > "$FAKE_HOME/.claude/projects/$LOCAL_KEY/memory/mac-note.md"

# Stale Windows-encoded dir that older memoir versions might have left
mkdir -p "$FAKE_HOME/.claude/projects/$FOREIGN_WIN_KEY/memory"
echo "# Stale foreign MEMORY.md" > "$FAKE_HOME/.claude/projects/$FOREIGN_WIN_KEY/memory/MEMORY.md"
echo "from-windows-only" > "$FAKE_HOME/.claude/projects/$FOREIGN_WIN_KEY/memory/win-note.md"

cat > "$FAKE_HOME/.claude/settings.json" <<'EOF'
{ "permissions": { "allow": ["Read", "Write"] } }
EOF

echo -e "  ${GREEN}Local state:${RESET}"
ls "$FAKE_HOME/.claude/projects/"
echo ""

# ── Step 2: Build a "backup" that simulates a push from Windows ──
echo -e "${BOLD}Step 2: Build backup that simulates push-from-Windows${RESET}\n"
PUSHER_HOME=$(mktemp -d)
mkdir -p "$PUSHER_HOME/.claude/projects/$FOREIGN_WIN_KEY/memory"
echo "# Windows backup MEMORY.md (newer)" > "$PUSHER_HOME/.claude/projects/$FOREIGN_WIN_KEY/memory/MEMORY.md"
echo "winthing-from-backup" > "$PUSHER_HOME/.claude/projects/$FOREIGN_WIN_KEY/memory/win-backup-only.md"
cat > "$PUSHER_HOME/.claude/settings.json" <<'EOF'
{ "permissions": { "allow": ["Read", "Write"] } }
EOF

# Memoir config on the "pusher": local provider, no encryption
mkdir -p "$PUSHER_HOME/.config/memoir"
cat > "$PUSHER_HOME/.config/memoir/config.json" <<EOF
{ "version": 2, "activeProfile": "default", "profiles": { "default": { "provider": "local", "localPath": "$BACKUP_DIR", "encrypt": false } } }
EOF
mkdir -p "$BACKUP_DIR"

# Push from the pusher side
HOME="$PUSHER_HOME" node "$MEMOIR_BIN" push > /dev/null 2>&1 || true
rm -rf "$PUSHER_HOME"

echo -e "  ${GREEN}Backup created:${RESET}"
find "$BACKUP_DIR" -type f | sed "s|$BACKUP_DIR/|    |" | head -10
echo ""

# ── Step 3: Configure the "local" machine's memoir config ──
mkdir -p "$FAKE_HOME/.config/memoir"
cat > "$FAKE_HOME/.config/memoir/config.json" <<EOF
{ "version": 2, "activeProfile": "default", "profiles": { "default": { "provider": "local", "localPath": "$BACKUP_DIR", "encrypt": false } } }
EOF

# ── Step 4: Run restore ──
echo -e "${BOLD}Step 4: memoir restore${RESET}\n"
HOME="$FAKE_HOME" node "$MEMOIR_BIN" restore 2>&1 | tail -40
echo ""

# ── Step 5: Assertions ──
echo -e "${BOLD}Step 5: Verify final state${RESET}\n"

PASS=0; FAIL=0
check() {
  if eval "$1"; then
    echo -e "  ${GREEN}PASS${RESET} $2"; PASS=$((PASS + 1))
  else
    echo -e "  ${RED}FAIL${RESET} $2"; FAIL=$((FAIL + 1))
  fi
}

# Stale foreign dir should be archived (not in projects/ as a home-key dir anymore)
check "[ ! -d \"$FAKE_HOME/.claude/projects/$FOREIGN_WIN_KEY/memory\" ] || [ -d \"$(find $FAKE_HOME/.claude/projects -name '.memoir-archived-*' -type d | head -1)/$FOREIGN_WIN_KEY\" ]" \
  "stale foreign dir archived (not live as home-key)"

# Archive dir exists
check "[ -n \"$(find $FAKE_HOME/.claude/projects -name '.memoir-archived-*' -type d 2>/dev/null)\" ]" \
  ".memoir-archived-* created"

# Local memory still has original files
check "[ -f \"$FAKE_HOME/.claude/projects/$LOCAL_KEY/memory/mac-note.md\" ]" \
  "local mac-note.md preserved"

# Windows backup content merged into local home key (NOT left in separate foreign dir)
check "[ -f \"$FAKE_HOME/.claude/projects/$LOCAL_KEY/memory/win-backup-only.md\" ]" \
  "Windows backup file merged into local home key"

# Stale foreign content also merged into local
check "[ -f \"$FAKE_HOME/.claude/projects/$LOCAL_KEY/memory/win-note.md\" ]" \
  "stale foreign content rescued into local via cleanup"

echo ""
if [ $FAIL -eq 0 ]; then
  echo -e "${BOLD}${GREEN}  ALL $PASS E2E CHECKS PASSED${RESET}\n"
else
  echo -e "${BOLD}${RED}  $FAIL FAILED${RESET}, ${GREEN}$PASS passed${RESET}\n"
fi

exit $FAIL
