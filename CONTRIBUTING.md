# Contributing to dvc.services

Small, focused improvements are welcome. Open an issue to discuss larger features before spending time on them. For vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Development setup

Use Node.js 24.x LTS, at least 24.17.0, and npm. Create a **separate Discord application and test server**; never use the production token while another instance is online. Replace every Discord ID in your local environment with the corresponding test-server value.

```bash
git clone https://github.com/dvc-labs/dvc.services.git
cd dvc.services
cp .env.example .env
npm ci --ignore-scripts
npm run check
npm run dev
```

Configure guild installation with the `bot` and `applications.commands` scopes. Give the bot access to the configured channels and place its role above the ordinary verification role. Keep all privileged intents off. Do not commit `.env`, tokens, raw error objects, or private logs.

## Changes

- Branch from current `main`, using a short name such as `fix/verification-retry` or `feat/status-command`.
- Keep changes scoped to one problem. Explain the trigger and resulting behavior in the pull request.
- Use TypeScript with strict typing, two-space indentation, single quotes, and ESM `.js` import specifiers.
- Preserve the `#26bcc5` brand colour and concise, readable Discord embeds.
- Keep Discord-specific code at the edges. Verification and panel policy should remain testable without a token or live server.
- Validate guild/channel/permission boundaries before taking action. A command's default permissions do not replace runtime authorization checks.
- Acknowledge interactions promptly; defer before network-dependent work. Do not let logging failures change a successful role-award result.
- Keep caches, queues, and rate-limit state bounded. Avoid introducing a database, privileged intent, heavy dependency, or host-specific integration without discussing the need.
- Update `.env.example`, README tables, and deployment/setup guides when behavior or configuration changes.
- Commit `package-lock.json` for dependency changes. Do not commit `node_modules`, `dist`, credentials, or generated logs.

## Validation

```bash
npm run check
npm audit --omit=dev --audit-level=high
docker build -t dvc-services:test .
```

The test suite uses mocks and a local HTTP server; it requires no Discord token. Add meaningful tests for changes to authorization, role assignment, repeated-click handling, panel recovery, configuration, or log/error behavior. Tests should check outcomes and failure boundaries rather than repeat implementation details.

For Discord-facing changes, manually test in the separate server:

- A normal member verifies and receives only the intended role.
- Repeated clicks do not cause duplicate awards; already verified members get an acknowledgement.
- Pending screening and invalid role hierarchy are handled safely.
- `/about` works in the configured commands channel.
- `/verification` requires Manage Server permission and reuses the panel.
- Restarting keeps a usable panel without adding another.
- Discord and console logs show correct outcomes without secrets or message content.

Describe what you checked in the pull request, including anything you could not run. CI also builds the image and checks the non-root production runtime. No production secrets should be added to GitHub Actions.

## Release notes

Document user-visible changes in the README's release section. The bot reads its version from `package.json`; keep the lockfile, README badge, and release documentation consistent when bumping it. The container smoke check reads the expected version from the checkout's `package.json` automatically.

By contributing, you agree that your contribution is licensed under the repository's [MIT licence](LICENSE).
