# dvc.services

The Discord service bot for **dvc.labs** — a home for dvc. projects, experiments, and a look behind the scenes.

[![CI](https://github.com/dvc-labs/dvc.services/actions/workflows/ci.yml/badge.svg)](https://github.com/dvc-labs/dvc.services/actions/workflows/ci.yml)
![Version](https://img.shields.io/badge/version-0.1.2-26bcc5)
![Node.js](https://img.shields.io/badge/Node.js-24_LTS-26bcc5)
[![MIT](https://img.shields.io/badge/license-MIT-26bcc5)](LICENSE)

## v0.1.2

- A welcome embed and **Verify** button that opens a form. Type **verify** to receive the configured access role; capitalisation and surrounding spaces are ignored.
- Private verification replies, duplicate-click protection, and checks for Discord membership screening.
- A persistent panel: startup finds and refreshes the existing message, including across older history pages. No database is required.
- `/about` with bot information, version, uptime, links, and a hosting credit to [loon.host](https://loon.host).
- `/verification` for team members with **Manage Server** to create or refresh the panel.
- Informative Discord embeds with readable member, channel, and role references, plus structured console logs for startup, command use and denials, verification outcomes, panel updates, reconnection, and graceful shutdown.
- Docker support with a non-root runtime, a 256 MB JavaScript heap limit, and small health endpoints.

This is a lightweight access acknowledgement, **not a CAPTCHA or identity check**. Typing a fixed word adds a confirmation step but does not reliably stop automated accounts. Use Discord's own moderation and raid protections as appropriate.

The bot registers its own **guild commands** on startup, updating them only when definitions change. There is no separate registration command. Run one instance for this application/server.

## Commands and verification

| Action | Who can use it | Where | Result |
| --- | --- | --- | --- |
| **Verify** button and form | Human server members | Current panel in `VERIFICATION_CHANNEL_ID` | Opens a form; submitting **verify** grants `VERIFICATION_ROLE_ID` and replies privately |
| `/about` | Members with access to application commands | `COMMANDS_CHANNEL_ID` | Public information embed |
| `/verification` | Members with **Manage Server** | `COMMANDS_CHANNEL_ID` | Creates or refreshes the panel; replies privately |

The button works after process restarts without collectors or expiry timers. Startup refreshes the existing panel with the latest instructions. Button and form requests are restricted to the configured server, channel, and current bot-authored message; each form is bound to the member who opened it. Clicking the button alone or submitting an incorrect word never grants a role. Incorrect answers receive private retry guidance. The bot fetches only the submitting member and adds one role without replacing their other roles. Already verified members receive a friendly acknowledgement. Members with pending Discord rules screening must finish that first.

Role assignability is checked at startup and before each new award. The bot refuses `@everyone`, integration-managed roles, and roles with administrative or moderation permissions. Put the bot's highest role **above** the ordinary verification/member role.

## Environment variables

Copy [`.env.example`](.env.example) for local or Docker Compose use. On your hosting service, enter the same values in its environment/secret settings. Never put the token in GitHub, a Dockerfile, an image build argument, or a public screenshot.

| Variable | Required | Value / default | Purpose |
| --- | --- | --- | --- |
| `DISCORD_TOKEN` | Yes, secret | Obtain from Developer Portal → Bot | Raw bot token; no `Bot ` prefix |
| `GUILD_ID` | Yes | `x` | dvc.labs server |
| `APPLICATION_ID` | Yes | `x` | Discord application |
| `VERIFICATION_ROLE_ID` | Yes | `x` | Ordinary member/access role |
| `VERIFICATION_CHANNEL_ID` | Yes | `x` | Welcome and verification text channel |
| `COMMANDS_CHANNEL_ID` | Yes | `x` | Slash-command text channel |
| `LOGS_CHANNEL_ID` | Yes | `x` | Preferably private team logs text channel |
| `VERIFICATION_MESSAGE_ID` | No | Empty | Select an existing bot-authored verification panel explicitly |
| `PORT` | No | `8080` | Internal health server, bound to `0.0.0.0`; use the host's assigned port if needed |
| `LOG_LEVEL` | No | `info` | `debug`, `info`, `warn`, or `error`; filters console output only |
| `NODE_ENV` | No | `production` in Docker | Standard Node environment; does not select another bot/server |
| `TZ` | No | `Europe/Brussels` in Docker | Process timezone; structured log timestamps remain UTC |
| `NODE_OPTIONS` | No | `--max-old-space-size=256` in Docker | Set the same value for a managed panel that runs the main file directly |

The seven Discord variables must be supplied at runtime; replace the example's ID placeholders with your server's IDs. No client secret, public key, OAuth redirect URI, webhook URL, privileged intent, database, or persistent volume is needed. The brand colour is defined in source.

Leave `VERIFICATION_MESSAGE_ID` empty for automatic discovery. If set, it must reference an existing panel from this application in the configured verification channel. A missing or invalid explicit ID stops startup rather than creating a duplicate. Clear it to allow recovery or use the correct ID.

## Logs and data

Discord activity embeds show clickable member, channel, and role references, with notification parsing disabled. The hosting console keeps the exact IDs in structured JSON for diagnostics. Discord resolves references according to the viewer's access; references to unavailable or deleted resources may not display a name.

Verification state is the member's Discord role. The panel lives in Discord message history. The application writes no local member database. Logs contain personal identifiers, so restrict access and set retention appropriately in Discord and your hosting provider. See [SECURITY.md](SECURITY.md).

## TypeScript and JavaScript

The maintained source is TypeScript in `src/`. `npm run build` checks the code and emits JavaScript into `dist/`; `npm start` runs `dist/index.js`. The `.js` import specifiers in TypeScript match the filenames that Node loads after compilation. Generated JavaScript is not maintained or committed separately.

TypeScript catches mismatched Discord API types and data handling mistakes during development. The Dockerfile performs compilation automatically, so the production process runs ordinary JavaScript without a TypeScript loader.
