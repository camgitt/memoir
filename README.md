<div align="center">

# 🧠 memoir
**Your AI Remembers Everything. Sync It Everywhere.**

[![npm version](https://img.shields.io/npm/v/memoir-cli.svg?style=flat-square)](https://npmjs.org/package/memoir-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://opensource.org/licenses/MIT)

*Never lose your AI's context again. Sync and translate your AI memory across every device and tool.*

</div>

---

## 💡 The Problem

You spend weeks teaching your local AI CLI exactly how you like your code formatted, your preferred architectural patterns, and your project's unique context.

Then, you switch laptops. Or you want to share that setup with your team.

Suddenly, you're starting from scratch. Your AI's "memory" is trapped in hidden `.gemini` or `.claude` folders on a single machine.

## 🚀 The Solution

`memoir` is a zero-friction CLI that extracts, backs up, restores, and **translates** your AI's memory across any computer and any tool. Bring your own storage (a private GitHub repo or an iCloud/Dropbox folder), and `memoir` handles the rest.

No locked-in SaaS, no lost context, no complex shell scripts. Switch from Claude to Gemini in one command.

### Supported Integrations
- [x] **Gemini CLI**
- [x] **Claude Code**
- [x] **OpenAI Codex CLI**
- [x] **Cursor**
- [x] **GitHub Copilot**
- [x] **Windsurf**
- [x] **Aider**

---

## 🛠️ Installation

Install globally via npm so you can use it anywhere on your machine:

```bash
npm install -g memoir-cli
```

## ⚡ Quick Start

### 1. Initialize
Run the setup wizard. We'll help you securely link a private GitHub repository or a local sync folder.

```bash
memoir init
```

### 2. Backup Your Memory
Just had a great session? Save your AI's learned context to the cloud:

```bash
memoir push
# or simply use the alias:
memoir remember
```

### 3. Restore Anywhere
Got a new machine? Pull your brain down instantly:

```bash
memoir restore
# or:
memoir pull
```

### 4. Translate Between Tools
Switch AI tools without losing context. Memoir uses Gemini AI to intelligently rewrite your memory files for any supported tool:

```bash
memoir migrate --from claude --to gemini
# or run interactively:
memoir migrate
```

Your Claude instructions become a proper `GEMINI.md` — not a copy-paste, but a real translation that follows each tool's conventions.

---

## 🔒 Security First

Your AI memory files often sit right next to sensitive API keys and OAuth tokens. **`memoir` is designed to be paranoid.**

Our specialized adapters intelligently filter your directories. We **only** sync configuration files, custom prompts, and markdown memory (`GEMINI.md`, `CLAUDE.md`). We will never touch, copy, or push `.env` files, `.key` files, or credential caches.

---

## 🗺️ Roadmap

**What's next:**
- Team sharing — sync a shared memory repo across your whole team
- Auto-detect new AI tools as they appear
- Two-way merge — combine memories from multiple tools into one

---

## 🤝 Contributing

We welcome contributions! Whether it's adding an adapter for a new AI CLI, improving the UI, or helping build the Migration Engine.

1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the Branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## 📄 License

Distributed under the MIT License. See `LICENSE` for more information.
