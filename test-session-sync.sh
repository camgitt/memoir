#!/bin/bash
# End-to-end test: session.json syncs across machines.
# Machine A (Mac-style) sets a goal + note, pushes. Machine B (Win-style) has
# its own local session, runs restore. Verify both machines' state is merged.

set -e

BOLD="\033[1m"; GREEN="\033[32m"; YELLOW="\033[33m"; CYAN="\033[36m"; RED="\033[31m"; RESET="\033[0m"

MEMOIR_BIN="$(cd "$(dirname "$0")" && pwd)/bin/memoir.js"

HOME_A=$(mktemp -d)
HOME_B=$(mktemp -d)
BACKUP_DIR="$(mktemp -d)/memoir-backup"
mkdir -p "$BACKUP_DIR"

cleanup() { rm -rf "$HOME_A" "$HOME_B" "$BACKUP_DIR"; }
trap cleanup EXIT

echo -e "\n${BOLD}${CYAN}=== session.json cross-machine sync test ===${RESET}\n"
echo -e "${YELLOW}Machine A HOME:${RESET} $HOME_A"
echo -e "${YELLOW}Machine B HOME:${RESET} $HOME_B"
echo -e "${YELLOW}Shared backup:${RESET} $BACKUP_DIR\n"

# Configure memoir on both fake machines (local provider, no encryption)
for h in "$HOME_A" "$HOME_B"; do
  mkdir -p "$h/.config/memoir"
  cat > "$h/.config/memoir/config.json" <<EOF
{ "version": 2, "activeProfile": "default", "profiles": { "default": { "provider": "local", "localPath": "$BACKUP_DIR", "encrypt": false } } }
EOF
  # Seed a minimal AI tool so push has something to scan
  mkdir -p "$h/.claude"
  echo '{}' > "$h/.claude/settings.json"
done

# ── Machine A: set goal + note, push ──
echo -e "${BOLD}Machine A: record session + push${RESET}\n"
HOME="$HOME_A" node "$MEMOIR_BIN" goal "Ship session sync" > /dev/null
HOME="$HOME_A" node "$MEMOIR_BIN" note "Use atomic writes" --why "crash safety" > /dev/null
HOME="$HOME_A" node "$MEMOIR_BIN" next "Test cross-machine merge" > /dev/null
HOME="$HOME_A" node "$MEMOIR_BIN" push > /dev/null 2>&1 || true
echo -e "  ${GREEN}Machine A pushed${RESET}"

# Verify session.json landed in backup
if [ -f "$BACKUP_DIR/session.json" ]; then
  echo -e "  ${GREEN}PASS${RESET} session.json present in backup"
else
  echo -e "  ${RED}FAIL${RESET} session.json missing from backup"
  find "$BACKUP_DIR" -type f | head -10
  exit 1
fi

# ── Machine B: set different goal, then restore ──
echo -e "\n${BOLD}Machine B: record own session + restore${RESET}\n"
HOME="$HOME_B" node "$MEMOIR_BIN" goal "Different local goal" > /dev/null
HOME="$HOME_B" node "$MEMOIR_BIN" next "Local-only action" > /dev/null
HOME="$HOME_B" node "$MEMOIR_BIN" restore 2>&1 | grep -E "merged|up to date|Done" || true

# ── Assertions ──
echo -e "\n${BOLD}Verify merged state on Machine B${RESET}\n"

PASS=0; FAIL=0
merged_session="$HOME_B/.config/memoir/session.json"

check_json() {
  local jq_expr="$1"
  local desc="$2"
  local expected="$3"
  local actual=$(node -e "const s=require('$merged_session'); process.stdout.write(String($jq_expr))" 2>/dev/null)
  if [ "$actual" = "$expected" ]; then
    echo -e "  ${GREEN}PASS${RESET} $desc"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}FAIL${RESET} $desc — got: '$actual', expected: '$expected'"
    FAIL=$((FAIL + 1))
  fi
}

# Both goals should exist after merge
HAS_BOTH=$(node -e "const s=require('$merged_session'); const texts=s.current.goals.map(g=>g.text.toLowerCase()); process.stdout.write(texts.includes('ship session sync') && texts.includes('different local goal') ? 'yes' : 'no')")
if [ "$HAS_BOTH" = "yes" ]; then
  echo -e "  ${GREEN}PASS${RESET} both machines' goals present after merge"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} goals not merged"
  FAIL=$((FAIL + 1))
  cat "$merged_session" | head -40
fi

# Machine A's decision should be on Machine B
HAS_DECISION=$(node -e "const s=require('$merged_session'); process.stdout.write(s.current.decisions.some(d=>d.text.includes('atomic writes')) ? 'yes' : 'no')")
if [ "$HAS_DECISION" = "yes" ]; then
  echo -e "  ${GREEN}PASS${RESET} Machine A's decision synced to Machine B"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} decision not synced"
  FAIL=$((FAIL + 1))
fi

# Both machines are registered in machines{}
MACHINE_COUNT=$(node -e "const s=require('$merged_session'); process.stdout.write(String(Object.keys(s.machines).length))")
if [ "$MACHINE_COUNT" = "2" ]; then
  echo -e "  ${GREEN}PASS${RESET} both machines registered ($MACHINE_COUNT total)"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} expected 2 machines, got $MACHINE_COUNT"
  FAIL=$((FAIL + 1))
fi

# Machine B's CLAUDE.md should have the merged block
if [ -f "$HOME_B/.claude/CLAUDE.md" ]; then
  if grep -q "Ship session sync" "$HOME_B/.claude/CLAUDE.md" && grep -q "Different local goal" "$HOME_B/.claude/CLAUDE.md"; then
    echo -e "  ${GREEN}PASS${RESET} Machine B's CLAUDE.md shows merged goals"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}FAIL${RESET} CLAUDE.md not re-rendered"
    FAIL=$((FAIL + 1))
  fi
else
  echo -e "  ${RED}FAIL${RESET} Machine B's CLAUDE.md not created by restore"
  FAIL=$((FAIL + 1))
fi

echo ""
if [ $FAIL -eq 0 ]; then
  echo -e "${BOLD}${GREEN}  ALL $PASS SESSION SYNC CHECKS PASSED${RESET}\n"
else
  echo -e "${BOLD}${RED}  $FAIL FAILED${RESET}, ${GREEN}$PASS passed${RESET}\n"
fi

exit $FAIL
