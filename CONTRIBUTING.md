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

Configure guild installation with `bot` and `applications.commands`. Give the bot access to configured channels, Read Message History, and View Audit Log; place its role above the ordinary verification role. Enable Presence and Server Members; leave Message Content disabled. Use `DVC_EMOJI=none` or an emoji owned by your test application. Do not commit `.env`, tokens, raw error objects, or private logs.

## Changes

- Branch from current `main`, using a short name such as `fix/verification-retry` or `feat/status-command`.
- Keep changes scoped to one problem. Explain the trigger and resulting behavior in the pull request.
- Use TypeScript with strict typing, two-space indentation, single quotes, and ESM `.js` import specifiers.
- Preserve the `#26bcc5` brand colour, application emoji, and concise Components V2 cards. V2 messages cannot contain legacy embeds/content. Keep old and nested V2 panel discovery working across restarts.
- Keep Discord-specific code at the edges. Verification and panel policy should remain testable without a token or live server.
- Validate guild/channel/permission boundaries before taking action. A command's default permissions do not replace runtime authorization checks.
- Acknowledge interactions promptly; defer before network-dependent work. Do not let logging failures change a successful role-award result.
- Keep caches, queues, and rate-limit state bounded. Review intent/dependency changes and avoid adding heavy dependencies, persistence, or host-specific integrations without discussing the need.
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
- Verify acknowledges existing verification and configured admin roles without writing roles. Remove both roles and confirm the normal verification path works again.
- Pending screening and invalid role hierarchy are handled safely.
- With `BULLETIN_ROLE_ID` set: confirm both verification channel cards survive restart without duplicates. Open preferences from each, change the role in Discord, and check the live status. Only the owner can use the private card. Verify opt-in, opt-out after access is removed, and rejection of replaced or legacy buttons.
- With Hall configured: test public and private `/ask question`, a long answer, reset and `/ask forget`. Verify private continuations and that no transcript or integration secret is logged. Missing configuration and upstream errors should leave the rest of the bot available.
- With Cherry Creek configured: submit a Java name, check private moderation delivery, review a decline and then a separate acceptance. Confirm only the approved member is pinged. Restart before reviewing a pending request, and check that an already reviewed request cannot notify twice.
- `/about` works in the configured commands channel.
- `/member user:@someone` works publicly for ordinary members without publishing sensitive pages. Staff details are ephemeral and require Manage Server or Moderate Members. Revoke that permission and confirm further private pages are denied. Verify snapshot expiry, no repeated member/profile fetches on page changes, shared API limits, and voice-channel redaction.
- Hostile nicknames/statuses cannot create links, subtext, formatting, quotes, or mentions. Check bidi removal and code-point truncation. Denied clicks, join/DM bursts, and success floods cannot displace failure/lifecycle records.
- Known non-members get private replies before a public defer; expired cards ask for a fresh lookup. Test rare API failures after deferring separately.
- A new human join is logged and receives the fixed welcome DM; disabled DMs are handled without a crash. Existing members receive no startup DMs.
- Native Discord audit entries identify the actual actor and render role/member/channel references without notifications.
- `/verification` requires Manage Server permission and reuses the panel.
- Restarting keeps a usable panel without adding another.
- Discord and console logs show command timing, Cherry Creek decisions and delivery, and observed boost count and level changes without secrets, usernames from whitelist forms, or ordinary message content.

Describe what you checked in the pull request, including anything you could not run. CI also builds the image and checks the non-root production runtime. No production secrets should be added to GitHub Actions.

## Release notes

Document user-visible changes in the README's release section. The bot reads its version from `package.json`; keep the lockfile, README badge, and release documentation consistent when bumping it. The container smoke check reads the expected version from the checkout's `package.json` automatically.

By contributing, you agree that your contribution is licensed under the repository's [MIT licence](LICENSE).
