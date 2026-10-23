# dvc.services

The Discord service bot for **dvc.labs** — a home for dvc. projects, experiments, and a look behind the scenes.

[![CI](https://github.com/dvc-labs/dvc.services/actions/workflows/ci.yml/badge.svg)](https://github.com/dvc-labs/dvc.services/actions/workflows/ci.yml)
![Version](https://img.shields.io/badge/version-0.1.0-26bcc5)
![Node.js](https://img.shields.io/badge/Node.js-24_LTS-26bcc5)
[![MIT](https://img.shields.io/badge/license-MIT-26bcc5)](LICENSE)

## v0.1.0

- A welcome embed and **Verify** button that gives the clicking member the configured access role.
- Private verification replies, duplicate-click protection, and checks for Discord membership screening.
- A persistent panel: startup finds and refreshes the existing message, including across older history pages. No database is required.
- `/about` with bot information, version, uptime, and links.
- `/verification` for team members with **Manage Server** to create or refresh the panel.
- Informative Discord embeds and structured console logs for startup, command use and denials, verification outcomes, panel updates, reconnection, and graceful shutdown.
- The dvc. accent colour, **`#26bcc5`**, across embeds.
- Docker support with a non-root runtime, a 256 MB JavaScript heap limit, and small health endpoints.

This is a lightweight access acknowledgement, **not a CAPTCHA or identity check**. Anyone who can press the button can receive the member role. Anti-raid protection remains Discord's responsibility. OptiPlex monitoring integrations are planned; this release does not collect or expose host metrics.

## Setup

1. Follow [the Discord Developer Portal and server guide](docs/discord-setup.md).
2. Configure [the environment variables](#environment-variables), keeping the token secret.
3. Deploy with [the loon.host and Docker guide](docs/deployment.md).
4. Check for the `bot_online` console event and the online embed in your logs channel.
5. Test verification with a normal member account, then restart once to confirm the panel is reused.

The bot registers its own **guild commands** on startup, updating them only when definitions change. There is no separate registration command. Run one instance for this application/server.

## Commands and verification

| Action | Who can use it | Where | Result |
| --- | --- | --- | --- |
| **Verify** button | Human server members | Current panel in `VERIFICATION_CHANNEL_ID` | Grants `VERIFICATION_ROLE_ID`; replies privately |
| `/about` | Members with access to application commands | `COMMANDS_CHANNEL_ID` | Public information embed |
| `/verification` | Members with **Manage Server** | `COMMANDS_CHANNEL_ID` | Creates or refreshes the panel; replies privately |

The button works after process restarts without collectors or expiry timers. Requests are restricted to the configured server, channel, bot-authored message, and component ID. The bot fetches only the clicking member and adds one role without replacing their other roles. Already verified members receive a friendly acknowledgement. Members with pending Discord rules screening must finish that first.

Role assignability is checked at startup and before each new award. The bot refuses `@everyone`, integration-managed roles, and roles with administrative or moderation permissions. Put the bot's highest role **above** the ordinary verification/member role.

## Environment variables

Copy [`.env.example`](.env.example) for local or Docker Compose use. On loon.host, enter the same values in the service's environment/secret settings. Never put the token in GitHub, a Dockerfile, an image build argument, or a public screenshot.

| Variable | Required | Value / default | Purpose |
| --- | --- | --- | --- |
| `DISCORD_TOKEN` | Yes, secret | Obtain from Developer Portal → Bot | Raw bot token; no `Bot ` prefix |
| `GUILD_ID` | Yes | `1562082957022204006` | dvc.labs server |
| `APPLICATION_ID` | Yes | `1562644412570538006` | Discord application |
| `VERIFICATION_ROLE_ID` | Yes | `1562110350734790696` | Ordinary member/access role |
| `VERIFICATION_CHANNEL_ID` | Yes | `1562263151960006736` | Welcome and verification text channel |
| `COMMANDS_CHANNEL_ID` | Yes | `1562240268659462185` | Slash-command text channel |
| `LOGS_CHANNEL_ID` | Yes | `1562628586584932454` | Preferably private team logs text channel |
| `VERIFICATION_MESSAGE_ID` | No | Empty | Select an existing bot-authored verification panel explicitly |
| `PORT` | No | `8080` | Internal health server, bound to `0.0.0.0`; use the host's assigned port if needed |
| `LOG_LEVEL` | No | `info` | `debug`, `info`, `warn`, or `error`; filters console output only |
| `NODE_ENV` | No | `production` in Docker | Standard Node environment; does not select another bot/server |
| `TZ` | No | `Europe/Brussels` in Docker | Process timezone; structured log timestamps remain UTC |

The seven Discord variables must be supplied at runtime; the IDs above are prefilled in the example, not hard-coded into the bot. No client secret, public key, OAuth redirect URI, webhook URL, privileged intent, database, or persistent volume is needed. The brand colour is defined in source.

Leave `VERIFICATION_MESSAGE_ID` empty for automatic discovery. If set, it must reference an existing panel from this application in the configured verification channel. A missing or invalid explicit ID stops startup rather than creating a duplicate. Clear it to allow recovery or use the correct ID.

## Local development

Use Node.js **24.17.0 or newer within the 24.x LTS line** and npm.

```bash
git clone https://github.com/dvc-labs/dvc.services.git
cd dvc.services
cp .env.example .env
```

Edit `.env` locally, then:

```bash
npm ci --ignore-scripts
npm run check
npm run dev
```

For a production-style local run:

```bash
npm run build
npm start
```

`npm start` and `npm run dev` load `.env` if present; host-supplied environment variables take precedence. The Docker entrypoint uses only its runtime environment and contains no `.env` file. Never run a local production-token instance alongside the hosted instance. For development, use a separate application and test server with their own IDs.

## Docker

```bash
docker compose up -d --build
docker compose logs -f bot
docker compose exec bot node dist/healthcheck.js
```

The Compose example caps runtime memory at **512 MB**, drops Linux capabilities, uses a read-only filesystem, and rotates console logs. A JavaScript heap limit leaves room for Node and native memory, but is not a guarantee of total memory usage. Build-time resources are separate from runtime limits.

There is no public web page. `/healthz` reports process liveness and `/readyz` returns HTTP 200 only after setup is complete and the Discord client is ready. Both return a fixed status object without secrets or server/member details. Docker's healthcheck uses `/readyz`; publishing a port to the internet is unnecessary. An unhealthy Docker status alone does not restart a container; configure host supervision as appropriate.

See [deployment instructions](docs/deployment.md) for Dockerfile settings, managed Node hosting, updates, and troubleshooting.

## Logs and data

Console output is newline-delimited JSON with UTC timestamps and event names. Discord logs use teal embeds with a timestamp, outcome, and relevant IDs. Successful verification includes both the member and awarded role ID. Command logs include successful, denied, rate-limited, and failed uses. The bot does not read ordinary chat messages or log message content, command arguments, tokens, or raw Discord request/error objects.

Discord log delivery is best effort: a bounded queue prevents an outage or rate limit from consuming unbounded memory. Failed or dropped Discord copies are reported in the console; the queue is not persisted or replayed after restart. Log delivery failure does not roll back a successful role assignment. Hard crashes, forced termination, host outages, and kills may prevent a final shutdown embed.

Verification state is the member's Discord role. The panel lives in Discord message history. The application writes no local member database. Logs contain personal identifiers, so restrict access and set retention appropriately in Discord and your hosting provider. See [SECURITY.md](SECURITY.md).

## Repository

```text
src/        Bot lifecycle, interactions, verification, panel, logs, and health checks
tests/      Authorization, concurrency, panel recovery, logging, and HTTP tests
docs/       Discord setup and hosting guides
.github/    CI, dependency updates, and contribution templates
```

CI type-checks, tests, compiles, audits production dependencies, builds the Docker image, and checks that it runs as a non-root user with production dependencies only. CI needs no Discord token and does not contact your server.

Contributions: [CONTRIBUTING.md](CONTRIBUTING.md). Vulnerabilities: [SECURITY.md](SECURITY.md). Changes: [CHANGELOG.md](CHANGELOG.md). Licensed under [MIT](LICENSE).
