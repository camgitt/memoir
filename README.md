<div align="center">

# 🧠 memoir
**Your AI Remembers Everything. Sync It Everywhere.**

[![npm version](https://img.shields.io/npm/v/memoir-cli.svg?style=flat-square)](https://npmjs.org/package/memoir-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://opensource.org/licenses/MIT)

*Never lose your AI's context again. Sync Gemini CLI, Claude Code, and more across all your devices instantly.*

</div>

---

## 💡 The Problem

You spend weeks teaching your local AI CLI exactly how you like your code formatted, your preferred architectural patterns, and your project's unique context.

Then, you switch laptops. Or you want to share that setup with your team.

Suddenly, you're starting from scratch. Your AI's "memory" is trapped in hidden `.gemini` or `.claude` folders on a single machine.

## 🚀 The Solution

`memoir` is a zero-friction CLI tool that seamlessly extracts, backs up, and restores your AI's memory across any computer. You bring your own storage (a private GitHub repo or an iCloud/Dropbox folder), and `memoir` handles the rest safely and securely.

No locked-in SaaS, no lost context, no complex shell scripts.

### Supported Integrations
- [x] **Gemini CLI**
- [x] **Claude CLI**
- [ ] *Cursor (Coming Soon)*
- [ ] *GitHub Copilot (Coming Soon)*

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

---

## 🔒 Security First

Your AI memory files often sit right next to sensitive API keys and OAuth tokens. **`memoir` is designed to be paranoid.**

Our specialized adapters intelligently filter your directories. We **only** sync configuration files, custom prompts, and markdown memory (`GEMINI.md`, `CLAUDE.md`). We will never touch, copy, or push `.env` files, `.key` files, or credential caches.

---

## 🗺️ Roadmap: The Future of Data Portability

We believe developers shouldn't be locked into a single AI ecosystem.

**Coming in v2.0: The Migration Engine**
Currently, `memoir` backs up your files exactly as they are. Soon, you will be able to run `memoir migrate --from claude --to gemini`. The CLI will automatically translate your Claude Code instructions into Gemini CLI facts, allowing you to fluidly swap AI providers without losing a drop of context.

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
