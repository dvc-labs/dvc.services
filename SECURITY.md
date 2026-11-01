# Security policy

## Supported versions

Security fixes target the latest `0.2.x` release on `main`. Older pre-release versions and development branches are not maintained separately. Use a supported Node.js 24.x LTS runtime and review dependency update pull requests promptly.

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
- Grant View Channels, Send Messages, Embed Links, Read Message History, Manage Roles, and View Audit Log. Administrator is unnecessary. Grant history access in all three configured channels.
- Put the bot above the ordinary member verification role and below privileged team roles. Do not configure a staff role as the verification role; the bot rejects administrative/moderation role permissions it recognises.
- Keep the logs channel private and choose an appropriate retention period for provider console logs and Discord messages. IDs identify people even when usernames and message content are absent.
- Restrict access to host configuration and deployment controls. Only trusted changes should reach production; reviews and branch protection are recommended.
- v0.2.0 explicitly requests every Gateway intent supported by the installed library. Enable Presence, Server Members, and Message Content in the Developer Portal before deployment. Members and presence support the welcome/logging and lookup features; ordinary chat content is not archived or forwarded. Requesting unavailable intents can prevent login. Future dependency upgrades must review changes to the supported intent list.
- Run a single bot process. Keep the health listener internal unless the host requires a public probe; it exposes fixed status objects only.

## Verification scope and data

The Verify button grants the configured access role with one click. This is a lightweight server access acknowledgement, not a CAPTCHA, proof of identity, age, account ownership beyond the current Discord interaction, or resistance to automated raids. A single button press does not reliably prevent automation. Configure Discord's own moderation, rules screening, and raid protections as appropriate.

The bot only adds the configured access role to the member who clicks Verify. The button checks the active panel's guild, channel, author, message ID, and component ID. It validates role safety, Manage Roles permission, and hierarchy, preserves other roles, refuses pending membership screening, and limits repeated role-award requests. Submissions from forms opened before an upgrade are ignored.

Roles and the verification message are stored by Discord. The bot maintains no local member database. All intents permit the Gateway to supply normal message content, but this release does not handle or archive ordinary chat messages or incoming DMs. Message caching is disabled; member/user and presence caches are bounded. Activity logs contain timestamps, member/channel/role references, command names, outcomes, membership changes, Discord audit reasons, safe error codes, and locally authored setup-error messages. Setup details stay in operator logs; interaction failure replies show generic guidance. Components V2 cards use native references with notification parsing disabled; console logs retain exact IDs. Raw Discord errors, request bodies/headers, interaction tokens, and chat content are deliberately not logged. The configured bot token is redacted from structured console output.

`/member` is intentionally public and available to every server member in the commands channel. It exposes bot-accessible account and guild profile fields, roles, server permissions, screening/boost/timeout status, and observed activity. It cannot expose emails, IPs, private messages, or distinguish invisible users from offline users. Private voice-channel names and IDs are omitted unless the channel's base @everyone permissions include View Channel. Pagination is bound to the original requester, guild, channel, and bot-authored message. Query/page cooldowns, a shared token budget, and a two-report concurrency cap limit API pressure. Only `/verification` requires Manage Server; public lookups never change a member or role.

New human joins receive a fixed welcome template with server verification and GitHub links. There is no startup/backfill campaign or user-supplied DM command. The pending queue is limited to 50, duplicate join deliveries are suppressed within the process, and bot accounts are skipped. Closed/blocked DMs are logged as delivery failures and do not affect verification. The queue and deduplication state are in memory; delivery is best effort, not a durable exactly-once guarantee.

Discord log delivery is best effort and bounded in memory; console logs provide diagnostics when Discord delivery fails. Cooldown, in-progress, and connection-resume diagnostics stay in the console and do not enter the Discord log queue. This is operational logging, not a durable or tamper-proof audit ledger. Host/provider and Discord access policies govern retention and availability.
