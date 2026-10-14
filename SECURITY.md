# Security Policy

Agentic OS works with your notes, connected repositories and AI agents, so security reports are taken seriously.

## Reporting a vulnerability

**Please do not open a public issue, discussion or pull request for a vulnerability.**

Report it privately through GitHub: [**Report a vulnerability**](https://github.com/sasha2011polyakov-dot/Agentic-Os/security/advisories/new) (Security tab → Advisories).

Please include:

- what an attacker can do and under which conditions (for example: a malicious document, web page, connected repository, extension package or agent output);
- steps to reproduce, ideally a minimal test case;
- the commit or version you tested.

What to expect:

- an acknowledgement within **7 days**;
- an assessment and a plan, or questions, within **14 days**;
- credit in the advisory and release notes, unless you prefer to stay anonymous.

This is a volunteer project in alpha, so there is no bug bounty.

## Supported versions

Until the first stable release, only the latest commit on `main` receives security fixes.

## In scope

Especially interesting:

- **Agents.** Escaping the agent permission model: tools beyond grants or run scope, or permissions raised by text.
- **Connected projects.** Writing to a connected project without the review gates. This covers access modes, change-set review, checks and verified backups.
- **Sandbox.** Escaping the sandbox for project checks or the restricted process for extension plugins.
- **Secrets.** Leaking API keys or secrets to logs, journals, exports, models or extensions.
- **Local API.** Bypassing authentication, Host/Origin/CSRF checks or the CSP.
- **Isolation.** Reading or changing one knowledge system from another without explicit selection.
- **Network.** SSRF through web research or plugin fetches.
- **Integrity.** Tampering with the append-only security journal without detection.

## Known limitations (not vulnerabilities by themselves)

These are documented in [docs/architecture/security.md](docs/architecture/security.md) and [docs/architecture/extensions.md](docs/architecture/extensions.md):

- Without bubblewrap (Linux), project checks run in a "limited" mode without OS-level isolation. The app says so in every check report.
- Network isolation of extension plugins without bubblewrap is enforced by the Node.js runtime (permission model + module guard), not by the operating system.
- A person with full control of the computer can change the application itself. The goal is to prevent unauthorized changes through the interface, agents, extensions and connected content.
