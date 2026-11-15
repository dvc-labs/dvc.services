# dvc.services

The Discord service bot for **dvc.labs** — a home for dvc. projects, experiments, and a look behind the scenes.

[![CI](https://github.com/dvc-labs/dvc.services/actions/workflows/ci.yml/badge.svg)](https://github.com/dvc-labs/dvc.services/actions/workflows/ci.yml)
![Version](https://img.shields.io/badge/version-0.2.5-26bcc5)
![Node.js](https://img.shields.io/badge/Node.js-24_LTS-26bcc5)
[![MIT](https://img.shields.io/badge/license-MIT-26bcc5)](LICENSE)

## Commands and verification

| Action | Who can use it | Where | Result |
| --- | --- | --- | --- |
| **Verify** button | Human server members | Current panel in `VERIFICATION_CHANNEL_ID` | Grants the access role and offers a private Bulletin choice if configured |
| **Bulletin preferences** button | Human server members | Current verification panel | Opens private subscription controls when `BULLETIN_ROLE_ID` is set |
| `/ask prompt:… [private] [reset]` | Members with access to application commands | `COMMANDS_CHANNEL_ID` | Question and Hall's answer on V2 cards; public by default |
| `/ask reset:true [private]` (omit the prompt) | Members with access to application commands | `COMMANDS_CHANNEL_ID` | Clears Hall context without asking a new question; confirms privately |
| **Forget** button | Original requester | Each `/ask` answer card | Clears the requester's Hall context for this channel and reply mode; confirms privately |
| `/cherrycreek` | Verified members or holders of `ADMIN_ROLE_ID` | Minecraft or commands channel | Opens a Minecraft Java whitelist form, submitted privately to staff |
| `/about` | Members with access to application commands | `COMMANDS_CHANNEL_ID` | Public information card |
| `/member user:@someone` | All members with access to application commands | `COMMANDS_CHANNEL_ID` | Public, paginated member information |
| `/verification` | Members with **Manage Server** | `COMMANDS_CHANNEL_ID` | Creates or refreshes the verification panel; replies privately |

The server permissions remain View Channels, Send Messages, Embed Links, Read Message History, Manage Roles, and View Audit Log (combined value `268520576`), with `bot` and `applications.commands` install scopes. There is no need to reinvite for this release. Give the bot View Channel in the rooms it should observe, and keep the moderation and logs channels private. AutoMod reporting uses View Audit Log. Boost count and level use Discord's [guild data](https://docs.discord.com/developers/resources/guild#guild-object).

## Environment variables

Copy [`.env.example`](.env.example) for local or Docker Compose use. On your hosting service, enter the same values in its environment/secret settings. Never put the token in GitHub, a Dockerfile, an image build argument, or a public screenshot.

The seven Discord connection variables must be supplied at runtime; replace the example's ID placeholders with your server's IDs. `DVC_EMOJI` is optional: unset or blank keeps the official dvc. branding, including when copying `.env.example`. Set it to `none` to disable branding, or to an application-owned emoji for a separate test app. SQLite runs in the Node process, so there is no separate database service to configure.

Leave `VERIFICATION_MESSAGE_ID` empty for automatic discovery. If set, it must reference an existing panel from this application in the configured verification channel. A missing or invalid explicit ID stops startup rather than creating a duplicate. Clear it to allow recovery or use the correct ID.

## Cherry Creek whitelist

Set both channel IDs and the Minecrafter role in your host's runtime environment:

```env
MOD_CHANNEL_ID=YOUR_PRIVATE_MODERATION_CHANNEL_ID
MINECRAFT_CHANNEL_ID=YOUR_MINECRAFT_CHANNEL_ID
MINECRAFTER_ROLE_ID=YOUR_MINECRAFTER_ROLE_ID
```

Use separate standard text channels. Allow the bot to view, send, read history, and embed links in both channels; keep the moderation channel visible only to staff and the bot. Use an ordinary Minecrafter role below the bot's highest role, without access to the moderation channel. Applicants need Use Application Commands in the Minecraft or commands channel and must be able to read the Minecraft channel to see an approval. The existing app scopes and **Manage Roles** permission cover the role grant.

1. A verified member runs `/cherrycreek` and submits their Java username. The bot validates the name, sends the request to staff, and confirms submission privately.
2. Staff with **Manage Server** or **Moderate Members** can review it. To approve, copy the complete `whitelist add <username>` command from the card's code block into the Paper console and wait for confirmation, then click **Accept**.
3. **Accept** checks that the applicant still has server access and that the bot can assign Minecrafter. It then saves the approval, grants Minecrafter, closes the staff card, and posts one approval mentioning only the applicant. It includes the Java address `play.cherrycreek.app` and buttons for the [website](https://cherrycreek.app/), [player guide](https://cherrycreek.app/guide), and [map](https://map.cherrycreek.app/). **Decline** closes the request without awarding a role or posting publicly. Previous approvals are unaffected.

## Persistent storage

`DATA_DIR` contains `dvc-services.sqlite`. It holds panel upgrade markers and Cherry Creek approval metadata: Discord request, member, reviewer, role, timestamp, and announcement references. It does not contain Java usernames, Hall conversations, or credentials.

- **Docker Compose:** `bot_data` mounts at `/data` automatically. Keep the named volume when recreating the container; `docker compose down -v` removes it.
- **loon.host:** Set `DATA_DIR=/home/container/data` if that directory is on your server's retained disk. Use a writable directory outside the deployment checkout and confirm it survives a redeploy. Use the existing Node 24 build and start settings.

Keep the state directory private, back up the whole directory with the bot stopped, and run only one instance against it. Include both database records and moderation cards in the server's retention policy.

## Hall setup and privacy

Set `WORKER_URL` and `HALLAI_API_KEY` for the Hall Worker in the bot's **runtime** environment. The Worker keeps its `OPENAI_API_KEY`; dvc.services only needs the matching Discord integration secret. Both settings are needed for `/ask`. Leave both empty to disable Hall while keeping the rest of the bot available. A missing half of the configuration produces an operator warning without revealing credentials.

If you no longer have the card, use `/ask reset:true private:true` to clear private context or `/ask reset:true` to clear public context. Omit the prompt. The bot confirms privately and sends no new question. Include a prompt alongside `reset:true` to start a new conversation. Existing Discord messages remain visible to their original audience.

## Logs and data

Message edit cards show the author when known, the source channel, a link, and **Before** and **After** text when available. A delete card includes the message ID and the last observed text. A deletion event doesn't tell the bot who removed the message; Discord's separate native audit entry can identify a moderator when present. Bulk deletions post one summary with up to two cached copies.

Verification state is the member's Discord role, and the panel lives in Discord message history. Welcome delivery uses a queue of 50 pending DMs, 1.5-second pacing, shutdown cancellation, and per-process join deduplication. A first member update without a cached prior state records current values explicitly as a snapshot. Native audit entries record actual administrative actions without guessing an actor for unrelated join/leave events. The bot's own verification, Bulletin, and Minecrafter role-change audit copies stay in the console to avoid duplicate Discord posts. Logs include identifiers, membership changes, and native audit reasons, so restrict access and choose retention appropriately. See [SECURITY.md](SECURITY.md).

## TypeScript and JavaScript

The maintained source is TypeScript in `src/`. `npm run build` checks the code and emits JavaScript into `dist/`; `npm start` runs `dist/index.js`. The `.js` import specifiers in TypeScript match the filenames that Node loads after compilation. Generated JavaScript is not maintained or committed separately.

TypeScript catches mismatched Discord API types and data handling mistakes during development. The Dockerfile performs compilation automatically, so the production process runs ordinary JavaScript without a TypeScript loader.
