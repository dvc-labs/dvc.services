# Deployment on loon.host

dvc.services is designed for a small, always-on Discord-bot service: one process, one guild, no database, and no required persistent disk. The target plan is **512 MB RAM / 5 GB SSD**. The Docker image caps Node's JavaScript heap at 256 MB and includes production dependencies only; total RAM usage still includes Node and native overhead.

[Loon's bot-hosting page](https://loon.host/discord-bot-hosting) advertises Git-based deployment, runtime secrets, automatic restarts, and a 0.5 GB / 5 GB Hobby tier. Its detailed guides require a portal login. The observed **Docker image**, **Additional Node packages**, and **Main file** fields match a managed Node runtime; use **Option B** for that panel. Option A applies only if your service separately supports building a repository Dockerfile.

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

For the Loon startup fields **Docker image**, **Additional Node packages (`NODE_PACKAGES`)**, and **Main file (`MAIN_FILE`)**, use:

| Field | Value |
| --- | --- |
| Docker image | **Node.js 24**, at least **24.17.0**; `ghcr.io/parkervcp/yolks:nodejs_24` |
| Additional Node packages / `NODE_PACKAGES` | Leave empty; use the project's `package.json` and lockfile |
| Main file / `MAIN_FILE` | `dist/index.js` |
| Runtime environment | Required Discord variables, plus `NODE_OPTIONS=--max-old-space-size=256` |

The upstream image also publishes `ghcr.io/pelican-eggs/yolks:nodejs_24`. Select the host-approved Node.js 24 option; if the dropdown offers only Node.js 21, ask Loon to enable the Node.js 24 image. Save the selection and restart for it to take effect. Node.js 21 is end-of-life and does not meet this project's runtime requirement. The panel's Minecraft/Java help text does not apply to this bot.

`MAIN_FILE` is a file path, so do not enter `npm start` there. `index.ts` is not the project's entrypoint, and pointing the field at `src/index.ts` bypasses the supported TypeScript compilation workflow. Run the compiled JavaScript instead. Likewise, do not add `discord.js` separately to `NODE_PACKAGES`; it is already pinned in `package.json` and the lockfile.

### Build before starting

**A fresh Git checkout has no `dist/index.js`: `dist/` is deliberately ignored.** The managed runtime image does not build the repository Dockerfile, and selecting a main file does not compile the project.

If your service has a build hook or an actual shell, run these commands in the project root before the first start and after each source update:

```bash
npm ci --include=dev --ignore-scripts
npm run build
npm prune --omit=dev --ignore-scripts
```

Compilation needs TypeScript, so do not omit development dependencies until **after** the build. Keep these commands in the build/install hook; `MAIN_FILE` remains `dist/index.js`. A bot's input console is not necessarily a shell and may not accept npm commands.

If only the three startup fields are available, or compilation exceeds the hosting plan's memory budget, build on a development machine or separate runner with Node.js 24:

```bash
npm ci --include=dev --ignore-scripts
npm run build
```

Upload the complete resulting **`dist/` folder**, **`package.json`**, **`package-lock.json`**, and **`LICENSE`** into the service's file root using its file manager or SFTP. The root must contain `package.json` alongside `dist/`; do not leave another project folder wrapped around them. Use files from the same reviewed commit. Do not upload your Mac's `node_modules` or token file.

The standard generic Node template installs dependencies from `package.json` during startup. If Loon's template does not, have its install hook or host support run `npm ci --omit=dev --ignore-scripts` in the uploaded project root. An empty `NODE_PACKAGES` field does not replace that dependency-install step. Then start the service with `MAIN_FILE=dist/index.js` and the runtime variables set.

If the host instead offers a full start-command field, `npm start` remains supported after the same build/install steps. It sets the heap limit itself and loads `.env` if present. The direct main-file path uses host-supplied environment variables, so explicitly set `NODE_OPTIONS=--max-old-space-size=256` there.

Keep one instance running and configure automatic restarts. For Git auto-updates, ensure the build hook reruns on each deployed commit. Without a build hook, disable automatic source pulls and upload a fresh matching build on each update so stale JavaScript is never started with newer source/package files.

References: [Node.js release status](https://nodejs.org/en/about/previous-releases), [upstream Node.js 24 runtime](https://github.com/pelican-eggs/yolks/blob/master/nodejs/24/Dockerfile), [published image tags and legacy alias](https://github.com/pelican-eggs/yolks/blob/master/.github/workflows/nodejs.yml), and [standard generic Node template](https://eggs.pterodactyl.io/egg/generic-node-js-generic/). Loon may customize the template's dependency-install/startup commands.

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
NODE_OPTIONS=--max-old-space-size=256
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
