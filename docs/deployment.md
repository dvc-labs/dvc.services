# Deployment on loon.host

dvc.services is designed for a small, always-on Discord-bot service: one process, one guild, no database, and no required persistent disk. The target plan is **512 MB RAM / 5 GB SSD**. The Docker image caps Node's JavaScript heap at 256 MB and includes production dependencies only; total RAM usage still includes Node and native overhead.

[Loon's bot-hosting page](https://loon.host/discord-bot-hosting) advertises Git-based deployment, runtime secrets, automatic restarts, and a 0.5 GB / 5 GB Hobby tier. Its detailed guides require a portal login. The settings below describe what this project requires; dashboard labels and whether your plan accepts a custom Dockerfile must be confirmed in the actual service panel.

## Before deploying

- Complete [Discord setup](discord-setup.md), including role ordering and channel permissions.
- Have the bot token ready in a password manager.
- Deploy a branch that contains this implementation. Once reviewed and merged, use `main`.
- Run exactly **one replica/instance**. Stop any local or previous hosted process using this token before starting another.

## Option A: build the repository Dockerfile

Use this when the service supports a custom Dockerfile/repository build.

| Setting | Value |
| --- | --- |
| Repository | `https://github.com/dvc-labs/dvc.services` |
| Branch | `main` after merging; otherwise the implementation branch |
| Build context | Repository root (`.`) |
| Dockerfile | `Dockerfile` |
| Runtime/start command | Use the image default: `node dist/index.js` |
| Instances | `1` |
| Memory limit | `512 MB` |
| Environment | All required variables from `.env.example`, token stored as a secret |
| Health probe, if supported | HTTP `GET /readyz` on `PORT` (default `8080`), with at least 90 seconds startup grace |
| Restart policy | On crash / automatic restart |
| Stop timeout | At least 10 seconds; 15 seconds recommended |
| Persistent storage | Not required |
| Public domain or inbound Discord port | Not required |

The bot opens an outbound TLS Gateway connection to Discord and uses Discord's REST API over HTTPS. The internal health listener is available on `0.0.0.0:8080` unless `PORT` is changed. If Loon injects an assigned `PORT`, let that value take precedence. The Dockerfile's `EXPOSE 8080` is metadata; its healthcheck reads the actual runtime `PORT`.

Set secrets at **runtime**, not during image builds. The Docker build context uses an allowlist so local environment files, credentials, source-control metadata, tests, and logs are excluded. The image has a non-root user and a direct Node entrypoint; npm and development tooling are not used to start the container.

Do not enable a public web proxy just to make this bot work. If the panel requires a health URL, point it at `/readyz` and the assigned internal port. There is no web frontend at `/`.

## Option B: managed Node.js service

If the panel offers a Node runtime rather than a Dockerfile build:

1. Select **Node.js 24.x**, at least **24.17.0**.
2. Connect the repository and set the runtime environment variables.
3. Build/install with:

   ```bash
   npm ci --include=dev --ignore-scripts
   npm run build
   npm prune --omit=dev --ignore-scripts
   ```

4. Set the start command to:

   ```bash
   npm start
   ```

5. Enable automatic restarts and keep the instance count at one.

Compilation needs TypeScript, so do not omit development dependencies until **after** the build. These are build-time commands, not a command to rerun on every process restart. If your panel has only one startup field, configure its build/install hook if available, or ask Loon which Node deployment workflow it supports.

If building within the plan's 512 MB limit fails, build on your development machine or a separate build runner. Upload the resulting `dist/`, `package.json`, and `package-lock.json`, then run `npm ci --omit=dev --ignore-scripts` on the Linux host and use `npm start`. Do not upload your Mac's `node_modules` or token file. Keep the build from the same reviewed commit as the package files.

## Environment block

Enter these in the panel's environment/secret editor. `DISCORD_TOKEN` is the **only missing required value**; obtain it from the Developer Portal and never paste it into a public issue or chat.

```dotenv
DISCORD_TOKEN=PASTE_TOKEN_IN_HOST_SECRET_SETTINGS
GUILD_ID=1562082957022204006
APPLICATION_ID=1562644412570538006
VERIFICATION_ROLE_ID=1562110350734790696
VERIFICATION_CHANNEL_ID=1562263151960006736
COMMANDS_CHANNEL_ID=1562240268659462185
LOGS_CHANNEL_ID=1562628586584932454

VERIFICATION_MESSAGE_ID=
NODE_ENV=production
TZ=Europe/Brussels
PORT=8080
LOG_LEVEL=info
```

If the panel provides `PORT`, use that instead of overwriting it with `8080`. `VERIFICATION_MESSAGE_ID` can be omitted entirely. Node's built-in environment loading needs no extra `dotenv` dependency.

## First startup

Look for these JSON console events and corresponding logs embeds:

1. `bot_starting`
2. `commands_synced`
3. `verification_panel_ready`
4. `bot_online`

An ID, permission, or role-hierarchy problem stops startup with a safe diagnostic. Discord/API failures show their error name and numeric code/status without dumping request data. Common Discord codes include `50013` (missing permissions), `50001` (missing access), and `10008` (unknown message).

After startup, verify with a normal member account and run `/about` in the commands channel. Restart once: the existing welcome panel should be reused. Startup logs include its message ID, which you can optionally set as `VERIFICATION_MESSAGE_ID` to skip future history discovery.

## Docker Compose on a Docker host

The included Compose file is for hosts where you control Docker. A managed bot panel may supply its own limits and restart controls instead.

```bash
git clone https://github.com/dvc-labs/dvc.services.git
cd dvc.services
cp .env.example .env
chmod 600 .env
```

Edit the ignored `.env` locally, then:

```bash
docker compose up -d --build
docker compose logs -f --tail=100 bot
```

Check readiness and resource usage:

```bash
docker compose exec bot node dist/healthcheck.js
docker compose ps
docker stats --no-stream
```

For a clean stop:

```bash
docker compose stop
```

No database backup is required for v0.1.0. Keep your host settings, secret recovery information, and deployment commit in your own secure records. The welcome panel and member roles live in Discord.

## Updates and rollback

For a Git-linked Loon service, deploy the reviewed commit through the service panel. Auto-deploys should target the reviewed production branch. Use a stop-then-start/recreate strategy: overlapping replicas can duplicate panels or activity logs.

On a Docker Compose host:

```bash
git pull --ff-only
docker compose up -d --build
docker compose logs --tail=100 bot
```

Keep the previous deployment commit/image available for rollback. Redeploy that version through your host if needed. Configuration changes require a restart. Guild commands sync automatically; this bot owns the command set for its application in `GUILD_ID`.

## Resource and operations notes

- No message-content intent, full member download, filesystem database, scheduled polling, or public frontend is enabled.
- Discord message caching is disabled; the member cache is limited, and repeated-click tracking and log queues are bounded.
- Panel history is scanned in pages of 100 without caching. A dedicated read-only verification channel makes this fast; set an explicit message ID for a busy channel.
- Console logs must be rotated by the hosting service. The Compose example keeps at most three 5 MB log files.
- Role writes and log delivery depend on Discord availability; the bot reconnects through discord.js. `/readyz` reflects readiness while `/healthz` only confirms the process is running.
- Docker marks a container unhealthy when its healthcheck fails, but restart policies respond to exits rather than health status alone. Use your host's health supervision if it supports that, with enough grace to avoid restart loops during short Discord outages.
- A graceful stop attempts a final log and drains queued logs within an eight-second total shutdown deadline. Forced kills, out-of-memory termination, and host failures cannot guarantee a shutdown message.
- If the service repeatedly exits, fix the console's setup diagnostic before increasing restart frequency.
