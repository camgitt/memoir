#!/bin/bash
# Scripted demo for asciinema recording
# Usage: asciinema rec demo.cast -c "bash demo.sh"

# Simulate typing with a delay
type_cmd() {
  local cmd="$1"
  echo ""
  echo -ne "\033[1;32m❯\033[0m "
  for ((i=0; i<${#cmd}; i++)); do
    echo -n "${cmd:$i:1}"
    sleep 0.04
  done
  echo ""
  sleep 0.3
  eval "$cmd"
  sleep 1.5
}

narrate() {
  echo ""
  echo -e "\033[1;33m# $1\033[0m"
  sleep 1
}

export FAKE_HOME=$(mktemp -d)
export BACKUP_DIR="$FAKE_HOME/memoir-backup"
MEMOIR_BIN="$(cd "$(dirname "$0")" && pwd)/bin/memoir.js"

# Pre-setup: create mock configs and memoir config silently
mkdir -p "$FAKE_HOME/.gemini"
echo '{ "theme": "dark", "model": "gemini-2.5-pro" }' > "$FAKE_HOME/.gemini/settings.json"
cat > "$FAKE_HOME/.gemini/GEMINI.md" << 'EOF'
# My Gemini Instructions
Always use TypeScript. Prefer functional patterns. Keep responses concise.
Never use `any` type. Always handle errors explicitly.
EOF
echo '{ "recent": ["/home/dev/webapp"] }' > "$FAKE_HOME/.gemini/projects.json"

mkdir -p "$FAKE_HOME/.claude/projects/-home-dev/memory"
echo '{ "permissions": { "allow": ["Read", "Write", "Bash"] } }' > "$FAKE_HOME/.claude/settings.json"
cat > "$FAKE_HOME/.claude/projects/-home-dev/memory/MEMORY.md" << 'EOF'
# Memory
- User prefers Tailwind CSS v4
- Auth is handled by Supabase Auth with Google OAuth
- Deploy target: Vercel
- Current project: SaaS dashboard with Stripe billing
EOF

mkdir -p "$FAKE_HOME/.codex"
echo '{ "model": "codex-1", "approval": "auto" }' > "$FAKE_HOME/.codex/config.json"
echo 'Use Python 3.12. Follow PEP 8. Prefer pathlib.' > "$FAKE_HOME/.codex/instructions.md"

cat > "$FAKE_HOME/.aider.conf.yml" << 'EOF'
model: claude-opus-4-20250514
auto-commits: true
EOF

mkdir -p "$FAKE_HOME/.config/memoir"
echo "{ \"provider\": \"local\", \"localPath\": \"$BACKUP_DIR\" }" > "$FAKE_HOME/.config/memoir/config.json"
mkdir -p "$BACKUP_DIR"

export HOME="$FAKE_HOME"

clear
echo ""
echo -e "\033[1;36m  memoir — Your AI remembers everything.\033[0m"
echo -e "\033[0;90m  npm install -g memoir-cli\033[0m"
sleep 2

narrate "See what AI tools are on this machine"
type_cmd "memoir status"

narrate "Back up everything in one command"
type_cmd "memoir push"

narrate "Simulate switching to a new machine..."
sleep 1
rm -rf "$FAKE_HOME/.gemini" "$FAKE_HOME/.claude" "$FAKE_HOME/.codex"
rm -f "$FAKE_HOME/.aider.conf.yml"
echo -e "\033[1;31m  [wiped all AI configs]\033[0m"
sleep 1.5

narrate "Restore on the new machine"
type_cmd "memoir restore --yes"

narrate "Done. All AI memory restored in seconds."
sleep 1
echo ""
echo -e "\033[1;32m  npm install -g memoir-cli\033[0m"
echo -e "\033[0;90m  10 tools supported. Free and open source.\033[0m"
echo ""
sleep 3

rm -rf "$FAKE_HOME"
