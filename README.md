# dvc.services

The Discord service bot for **dvc.labs** — a home for dvc. projects, experiments, and a look behind the scenes.

[![CI](https://github.com/dvc-labs/dvc.services/actions/workflows/ci.yml/badge.svg)](https://github.com/dvc-labs/dvc.services/actions/workflows/ci.yml)
![Version](https://img.shields.io/badge/version-0.2.0-26bcc5)
![Node.js](https://img.shields.io/badge/Node.js-24_LTS-26bcc5)
[![MIT](https://img.shields.io/badge/license-MIT-26bcc5)](LICENSE)

## v0.2.0

- Teal **Components V2** cards with the dvc. application emoji, clear sections, links, and native member, channel, and role references. Verification logs read **Member verified → Result: Awarded**.
- A welcome panel and **Verify** button that grants the configured access role with one click. No form or typed word is required. The old panel is upgraded in place, and restarts recognise its nested V2 button.
- Private verification replies, duplicate-click protection, and checks for Discord membership screening.
- A persistent panel: startup finds and refreshes the existing message, including across older history pages. No database is required.
- `/about` with bot information, version, uptime, links, and a hosting credit to [loon.host](https://loon.host).
- `/verification` for team members with **Manage Server** to create or refresh the panel.
- Public `/member user:@someone` for **all members**, with pages for identity, join dates, verification/screening/boost/timeout status, badges, roles, server permissions, observed presence/activities/voice status, and public profile images.
- Join/leave and member-update logs, native Discord audit entries with the actual actor, and voice-channel join/move/leave logs. Join logs use `<:dvc:1566457051465388194>`.
- A friendly welcome DM for new human joins with a verification link and **Follow dvc.labs on GitHub** button. Existing members are not contacted on startup. Blocked DMs do not interrupt the bot.
- All Gateway intents supported by the installed discord.js version, with bounded caches and no ordinary chat-message archiving. **Enable all three privileged intent toggles before upgrading.**
- Structured logs for startup, command use/denials, verification, panel updates, reconnection, and shutdown. Cooldown, pagination, and reconnection diagnostics stay in the console to preserve space for useful Discord activity logs.
- Actionable runtime setup errors in operator logs with generic private failure replies, command comparison that handles nested Discord options, a container version check derived from `package.json`, and configurable ID placeholders in `.env.example`.
- Docker support with a non-root runtime, a 256 MB JavaScript heap limit, and small health endpoints.

This is a lightweight access acknowledgement, **not a CAPTCHA or identity check**. A single button press does not reliably stop automated accounts. Use Discord's own moderation and raid protections as appropriate.

The bot registers its own **guild commands** on startup, updating them only when definitions change. There is no separate registration command. Run one instance for this application/server.

## Commands and verification

| Action | Who can use it | Where | Result |
| --- | --- | --- | --- |
| **Verify** button | Human server members | Current panel in `VERIFICATION_CHANNEL_ID` | Grants `VERIFICATION_ROLE_ID` and replies privately |
| `/about` | Members with access to application commands | `COMMANDS_CHANNEL_ID` | Public information card |
| `/member user:@someone` | All members with access to application commands | `COMMANDS_CHANNEL_ID` | Public, paginated member information |
| `/verification` | Members with **Manage Server** | `COMMANDS_CHANNEL_ID` | Creates or refreshes the panel; replies privately |

The button works after process restarts without collectors or expiry timers. Startup refreshes the existing panel with the latest instructions, reusing the same button ID (`dvc:verify:v1`). Requests are restricted to the configured server, channel, and current bot-authored message. The bot replies privately, fetches only the clicking member, and adds one role without replacing their other roles. Already verified members receive a friendly acknowledgement. Members with pending Discord rules screening must finish that first.

Stop the old instance before upgrading. Forms opened on older releases are ignored; close the old form and press **Verify** again. The existing panel is converted to V2 with its legacy fields cleared. Discord does not allow reverting that message to legacy format, so rolling back to a pre-v0.2.0 build requires a new legacy panel.

Role assignability is checked at startup and before each new award. The bot refuses `@everyone`, integration-managed roles, and roles with administrative or moderation permissions. Put the bot's highest role **above** the ordinary verification/member role.

`/member` fetches only the selected member and their public user profile. Lookups are limited to once per user every **10 seconds**; page changes to once every **2 seconds**. A shared token bucket allows five initial reports, refills one every two seconds, and permits two concurrent reports. Discord.js also handles Discord's REST rate limits. Limit notices are private; successful reports are public. Only the original requester can turn their report's pages, with guild, channel, and bot-authorship checks on each click.

Missing presence is shown as **not observed**, rather than inferred offline. A voice channel is named only if its base `@everyone` permissions allow View Channel; otherwise its name and ID are omitted from the public report. Permissions are server-wide; channel overrides still apply. Email addresses, IPs, and MFA settings are not available through the lookup.

v0.2.0 requires **Presence**, **Server Members**, and **Message Content** intents in the Developer Portal. Its server permissions are View Channels, Send Messages, Embed Links, Read Message History, Manage Roles, and View Audit Log (combined value `268520576`). The install scopes remain `bot` and `applications.commands`; sending DMs needs no extra OAuth scope. Administrator is unnecessary. Keep the log channel private and grant history access in all three configured channels.

## Environment variables

Copy [`.env.example`](.env.example) for local or Docker Compose use. On your hosting service, enter the same values in its environment/secret settings. Never put the token in GitHub, a Dockerfile, an image build argument, or a public screenshot.

| Variable | Required | Value / default | Purpose |
| --- | --- | --- | --- |
| `DISCORD_TOKEN` | Yes, secret | Obtain from Developer Portal → Bot | Raw bot token; no `Bot ` prefix |
| `GUILD_ID` | Yes | Your server ID | dvc.labs server |
| `APPLICATION_ID` | Yes | Your application ID | Discord application |
| `VERIFICATION_ROLE_ID` | Yes | Your role ID | Ordinary member/access role |
| `VERIFICATION_CHANNEL_ID` | Yes | Your channel ID | Welcome and verification text channel |
| `COMMANDS_CHANNEL_ID` | Yes | Your channel ID | Slash-command text channel |
| `LOGS_CHANNEL_ID` | Yes | Your channel ID | Preferably private team logs text channel |
| `VERIFICATION_MESSAGE_ID` | No | Empty | Select an existing bot-authored verification panel explicitly |
| `PORT` | No | `8080` | Internal health server, bound to `0.0.0.0`; use the host's assigned port if needed |
| `LOG_LEVEL` | No | `info` | `debug`, `info`, `warn`, or `error`; filters console output only |
| `NODE_ENV` | No | `production` in Docker | Standard Node environment; does not select another bot/server |
| `TZ` | No | `Europe/Brussels` in Docker | Process timezone; structured log timestamps remain UTC |
| `NODE_OPTIONS` | No | `--max-old-space-size=256` in Docker | Set the same value for a managed panel that runs the main file directly |

The seven Discord variables must be supplied at runtime; replace the example's ID placeholders with your server's IDs. No new environment variables are required for v0.2.0. No client secret, public key, OAuth redirect URI, webhook URL, database, or persistent volume is needed. The brand colour and application emoji are defined in source.

Leave `VERIFICATION_MESSAGE_ID` empty for automatic discovery. If set, it must reference an existing panel from this application in the configured verification channel. A missing or invalid explicit ID stops startup rather than creating a duplicate. Clear it to allow recovery or use the correct ID.

## Logs and data

Discord activity cards show clickable member, channel, role, audit actor, and lookup target references, with notification parsing disabled. Results use readable capitalisation. The hosting console keeps exact IDs in structured JSON. Discord resolves references according to the viewer's access; unavailable or deleted resources may not display a name. Audit entries also retain a recorded target name when Discord provides it.

Cooldown and in-progress results are explicitly marked for console-only logging, as are connection resumes. Discord audit delivery is best effort with at most 100 queued events. Locally authored setup errors retain their corrective messages in operator logs; other logged errors expose only safe names and numeric codes/statuses. Private failure replies show generic retry guidance without setup details.

Unhandled promise rejections and uncaught exceptions deliberately shut the bot down with a nonzero exit code. Configure a host restart policy (Docker Compose uses `unless-stopped`). Expected interaction, audit-send, and connection errors are handled locally; an unhandled rejection indicates an uncontained failure that needs investigation.

Verification state is the member's Discord role. The panel lives in Discord message history. The application writes no local member database. Welcome delivery uses a bounded queue of 50 pending DMs and per-process join deduplication. Native Discord audit entries record actual administrative actions without guessing an actor for unrelated join/leave events. Our own verification role-award audit copy stays in the console to avoid a duplicate Discord post. Logs include identifiers, membership changes, and native audit reasons, so restrict access and choose retention appropriately. See [SECURITY.md](SECURITY.md).

## TypeScript and JavaScript

The maintained source is TypeScript in `src/`. `npm run build` checks the code and emits JavaScript into `dist/`; `npm start` runs `dist/index.js`. The `.js` import specifiers in TypeScript match the filenames that Node loads after compilation. Generated JavaScript is not maintained or committed separately.

TypeScript catches mismatched Discord API types and data handling mistakes during development. The Dockerfile performs compilation automatically, so the production process runs ordinary JavaScript without a TypeScript loader.
