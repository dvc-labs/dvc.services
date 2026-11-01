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
- Public `/member user:@someone` for **all members**, with identity, join dates, verification, boost status, badges, roles, and profile images. **Staff details** opens an ephemeral view of permissions, hierarchy, screening/timeout status, and observed presence/devices/activities/voice; it requires Manage Server or Moderate Members.
- Join/leave and member-update logs, native Discord audit entries with the actual actor, and voice-channel join/move/leave logs. Join logs use `<:dvc:1566457051465388194>`.
- A friendly welcome DM for new human joins with a verification link, **Follow dvc.labs on GitHub** button, and a brief logging notice. Attempts start at least 1.5 seconds apart. Existing members are not contacted on startup; blocked DMs do not interrupt the bot.
- Five explicitly selected Gateway intents: Guilds, Guild Members, Guild Moderation, Guild Voice States, and Guild Presences (bitfield **391**). Enable **Server Members** and **Presence** in the Portal; Message Content is not requested.
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

`/member` fetches only the selected member and their public user profile. Lookups are limited to once per user every **10 seconds**. Public profiles remain in the commands channel. Page changes use a stable **two-minute per-message snapshot**, are limited to once every **two seconds**, and **do not refetch member/profile data**. The snapshot cache holds at most 100 reports; expired/evicted reports ask for a new lookup. Lookups, page edits, and private detail requests share a token bucket with five initial operations, one refill every two seconds, and a two-operation concurrency cap. Private-detail requests share the two-second per-user page interval. Discord.js also handles Discord's REST rate limits.

Only the original requester can turn a report's pages. Guild, channel, bot authorship, message/target binding, and ownership are checked on every click. Expired cards explicitly ask for a fresh `/member` lookup. Staff can open an ephemeral detail report from a public card; staff permissions are checked again on every private page click. Public snapshots never retain staff-only fields. A target missing from Discord's resolved member data is rejected privately before deferring or calling the API. Rare API failures or departure races use a non-empty temporary acknowledgement followed by a private error and placeholder removal. Member-controlled text neutralises links, Markdown/subtext, quotes, mentions, and bidi controls. Source text is truncated by Unicode code point before escaping, preserving complete emojis and escape sequences.

Missing presence is shown as **not observed**, rather than inferred offline. Presence, devices, activities, voice state, effective permissions, and the bot's hierarchy capabilities appear only in the private staff view. Restricted voice-channel names/IDs remain omitted there too. Permissions are server-wide; channel overrides still apply. Email addresses, IPs, and MFA settings are not available through the lookup.

v0.2.0 requires **Presence** and **Server Members** intents in the Developer Portal. **Message Content can remain disabled.** Intent hints are logged only for a DisallowedIntents error or close code 4014. Its server permissions are View Channels, Send Messages, Embed Links, Read Message History, Manage Roles, and View Audit Log (combined value `268520576`). The install scopes remain `bot` and `applications.commands`; sending DMs needs no extra OAuth scope. Administrator is unnecessary. Keep the log channel private and grant history access in all three configured channels.

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
| `DVC_EMOJI` | No | `<:dvc:1566457051465388194>` | Application-owned emoji for headings/buttons; use your test app's emoji or `none` to disable |
| `NODE_ENV` | No | `production` in Docker | Standard Node environment; does not select another bot/server |
| `TZ` | No | `Europe/Brussels` in Docker | Process timezone; structured log timestamps remain UTC |
| `NODE_OPTIONS` | No | `--max-old-space-size=256` in Docker | Set the same value for a managed panel that runs the main file directly |

The seven Discord connection variables must be supplied at runtime; replace the example's ID placeholders with your server's IDs. `DVC_EMOJI` is optional: unset or blank keeps the official dvc. branding, including when copying `.env.example`. Explicitly set it to `none` to disable branding, or to an application-owned emoji for a separate test app. No client secret, public key, OAuth redirect URI, webhook URL, database, or persistent volume is needed. The brand colour is defined in source.

Leave `VERIFICATION_MESSAGE_ID` empty for automatic discovery. If set, it must reference an existing panel from this application in the configured verification channel. A missing or invalid explicit ID stops startup rather than creating a duplicate. Clear it to allow recovery or use the correct ID.

## Logs and data

Discord activity cards show clickable member, channel, role, audit actor, and lookup target references, with notification parsing disabled. Results use readable capitalisation. The hosting console keeps exact IDs in structured JSON. Discord resolves references according to the viewer's access; unavailable or deleted resources may not display a name. Audit entries also retain a recorded target name when Discord provides it.

Cooldowns, denied member-card clicks, welcome DM results, and connection resumes are explicitly console-only. Discord audit delivery uses three explicit tiers: **critical** for failures/errors and lifecycle events, **important** for verification successes, and **routine** for other activity. At most 100 records wait; routine records are capped at 60, and routine plus success records at 80. This reserves capacity for successes over routine bursts and 20 slots for failures/lifecycle events over success bursts. Higher tiers are sent first and may evict lower tiers. Console copies are retained; saturation by critical events can still drop records. Locally authored setup errors retain corrective messages in operator logs; other errors expose safe names and numeric codes/statuses. Failure replies show generic private guidance.

Unhandled promise rejections and uncaught exceptions deliberately shut the bot down with a nonzero exit code. Configure a host restart policy (Docker Compose uses `unless-stopped`). Expected interaction, audit-send, and connection errors are handled locally; an unhandled rejection indicates an uncontained failure that needs investigation.

Verification state is the member's Discord role. The panel lives in Discord message history. The application writes no local member database. Welcome delivery uses a queue of 50 pending DMs, 1.5-second pacing, shutdown cancellation, and per-process join deduplication. A first member update without a cached prior state records current values explicitly as a snapshot. Native audit entries record actual administrative actions without guessing an actor for unrelated join/leave events. Our own verification role-award audit copy stays in the console to avoid a duplicate Discord post. Logs include identifiers, membership changes, and native audit reasons, so restrict access and choose retention appropriately. See [SECURITY.md](SECURITY.md).

## TypeScript and JavaScript

The maintained source is TypeScript in `src/`. `npm run build` checks the code and emits JavaScript into `dist/`; `npm start` runs `dist/index.js`. The `.js` import specifiers in TypeScript match the filenames that Node loads after compilation. Generated JavaScript is not maintained or committed separately.

TypeScript catches mismatched Discord API types and data handling mistakes during development. The Dockerfile performs compilation automatically, so the production process runs ordinary JavaScript without a TypeScript loader.
