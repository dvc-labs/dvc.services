# Security policy

## Supported versions

Security fixes target the latest `0.1.x` release on `main`. Older pre-release versions and development branches are not maintained separately. Use a supported Node.js 24.x LTS runtime and review dependency update pull requests promptly.

## Reporting a vulnerability

Do not disclose an exploitable issue, bot token, or private Discord logs in a public GitHub issue or pull request.

Use GitHub's **Security → Report a vulnerability** feature for this repository when available:

https://github.com/dvc-labs/dvc.services/security/advisories/new

If private reporting is not enabled, contact Dave privately through dvc.labs or the contact options on [the dvc. website](https://www.davevancauwenberghe.be). Ask for a private reporting channel before sending sensitive material. Do not post a vulnerability publicly merely to get attention.

Include the affected commit/version, a concise description, expected impact, and minimal reproduction steps using a test application/server. Remove tokens, personal data, and private channel content. Please allow time for investigation and a fix before public disclosure; no guaranteed response time or paid bounty is offered.

## Operational security

- Keep `DISCORD_TOKEN` in the host's runtime secret store or an ignored, access-restricted local `.env`. Never use Docker build arguments or commit credentials.
- If exposed, reset the token in Discord immediately, update the hosted secret, and restart the service. Removing a leaked file is insufficient.
- Install the bot only into the intended guild. The code also restricts interactions to `GUILD_ID`.
- Grant only View Channels, Send Messages, Embed Links, Read Message History, and Manage Roles. Administrator is unnecessary.
- Put the bot above the ordinary member verification role and below privileged team roles. Do not configure a staff role as the verification role; the bot rejects administrative/moderation role permissions it recognises.
- Keep the logs channel private and choose an appropriate retention period for provider console logs and Discord messages. IDs identify people even when usernames and message content are absent.
- Restrict access to host configuration and deployment controls. Only trusted changes should reach production; reviews and branch protection are recommended.
- Keep all privileged intents disabled. This release does not need ordinary message content or bulk member access.
- Run a single bot process. Keep the health listener internal unless the host requires a public probe; it exposes fixed status objects only.

## Verification scope and data

The Verify button opens a form requiring the word `verify`, ignoring capitalisation and surrounding spaces. This is a lightweight server access acknowledgement, not a CAPTCHA, proof of identity, age, account ownership beyond the current Discord interaction, or resistance to automated raids. A fixed word does not reliably prevent automation. Configure Discord's own moderation, rules screening, and raid protections as appropriate.

The bot only adds the configured access role to the member who submits the correct word. Both the button and form check the active panel's guild, channel, author, message ID, and component ID. Form IDs are bound to that panel and the submitting member; forms without an originating message are rejected. It validates role safety, Manage Roles permission, and hierarchy, preserves other roles, refuses pending membership screening, and limits repeated role-award requests. Opening or cancelling the form cannot award a role.

Roles and the verification message are stored by Discord. The bot maintains no local member database and does not read normal messages. Activity logs contain timestamps, member/channel/role references, command names, outcomes, and safe error codes. Discord embeds use native references with notification parsing disabled; console logs retain the exact IDs. Submitted form text, raw Discord errors, request bodies/headers, interaction tokens, and chat content are deliberately not logged. The configured bot token is also redacted from structured console output.

Discord log delivery is best effort and bounded in memory; console logs provide diagnostics when Discord delivery fails. This is operational logging, not a durable or tamper-proof audit ledger. Host/provider and Discord access policies govern retention and availability.
