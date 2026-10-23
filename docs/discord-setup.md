# Discord setup for dvc.services

This guide uses the existing application **`1562644412570538006`** and dvc.labs server **`1562082957022204006`**. You need permission to manage the server and its roles/channels. The bot itself needs only the permissions below.

## 1. General Information

1. Open the [Discord Developer Portal](https://discord.com/developers/applications/1562644412570538006/information).
2. Set the application name to **dvc.services** and add an icon if desired.
3. Suggested description: `The service bot for dvc.labs: member verification, activity logs, and tools for our projects and experiments.`
4. Confirm **Application ID** is `1562644412570538006`.
5. Leave **Interactions Endpoint URL** empty. The bot receives slash commands and buttons through Discord's Gateway, not HTTP webhooks.

You do not need the Client Secret or Public Key for this implementation. There is no OAuth callback URL to configure.

## 2. Bot

Open **Bot** in the application sidebar. New applications normally already have a bot user; use **Add Bot** only if your application still offers that step.

1. Set the bot name to **dvc.services** if needed.
2. Under **Token**, use **Reset Token** to generate the token. Complete Discord's authentication prompt.
3. Save the token in a password manager, then enter it only as the host's `DISCORD_TOKEN` secret or your ignored local `.env`.
4. Turn **Requires OAuth2 Code Grant** **OFF**. This bot uses the standard server-install flow. Enabling this option without implementing OAuth causes “integration requires code grant”.
5. Keep all **Privileged Gateway Intents OFF**:
   - Presence Intent: off.
   - Server Members Intent: off.
   - Message Content Intent: off.

The bot requests only the non-privileged Guilds intent and fetches an individual member through REST when necessary.

For a personal server bot, set **Public Bot OFF** where available so only the app owner can add it. Some portal configurations require **Installation → Install Link → None** before allowing a private bot; use the explicit owner invite in the next section in that case. If the application belongs to a team, follow Discord's owner/team installation rules. Regardless of portal visibility, the code accepts interactions only in `GUILD_ID`.

If the token is ever exposed, reset it immediately, replace the host secret, and redeploy. Deleting a screenshot or Git commit does not invalidate a token.

## 3. Installation and invite

On **Installation**:

1. Enable **Guild Install**. Disable **User Install**; a user-only install cannot assign server roles.
2. In **Default Install Settings → Guild Install**, select the scopes **`bot`** and **`applications.commands`**.
3. Select these bot permissions:

| Permission | Why |
| --- | --- |
| View Channels | Access the three configured channels |
| Send Messages | Post panels, replies, and logs |
| Embed Links | Display embeds |
| Read Message History | Find and reuse the verification panel |
| Manage Roles | Add the configured verification role |

The permission integer for that set is **`268520448`**. Do not grant Administrator.

While logged in as an owner allowed to install this application, use:

[Add dvc.services to dvc.labs](https://discord.com/oauth2/authorize?client_id=1562644412570538006&permissions=268520448&scope=bot%20applications.commands&guild_id=1562082957022204006&disable_guild_select=true)

Authorize it for dvc.labs. The bot will appear **offline until it is hosted and started**. The install does not require an OAuth redirect URI. If Discord says “integration requires code grant”, return to **Bot** and disable the code-grant requirement.

## 4. Role ordering

In **Server Settings → Roles**:

1. Find the role belonging to **dvc.services**.
2. Move it **above** role `1562110350734790696`.
3. Keep administrator and team roles above the bot whenever practical.
4. Make `1562110350734790696` a normal member/access role. It must not be integration-managed or grant administrator/moderation permissions.

Manage Roles alone is insufficient: Discord only lets a bot assign a role below its own highest role. The bot does not need to manage every member's highest role to add this ordinary access role.

## 5. Channel permissions: make the role actually unlock the server

The bot awards a role; **Discord channel/category permissions define what that role unlocks**. Configure these before opening invites.

| Channel/category | `@everyone` | Verification role | dvc.services bot |
| --- | --- | --- | --- |
| Rules and welcome | View allowed; sending optional/denied | View allowed | View allowed |
| Verification `1562263151960006736` | View Channel + Read Message History allowed; Send Messages denied | View allowed; Send Messages denied | View Channel, Send Messages, Embed Links, Read Message History allowed |
| Member categories | View Channel denied | View Channel allowed; normal member permissions as desired | Explicit view access where needed |
| Commands `1562240268659462185` | View Channel denied | View Channel, Read Message History, Send Messages, Use Application Commands allowed | View Channel, Send Messages, Embed Links allowed |
| Team logs `1562628586584932454` | View Channel denied | View Channel denied | View Channel, Send Messages, Embed Links allowed |

Allow the team to view the logs channel. For the verification and commands channels, normal **text channels** are required; do not use forums, threads, or voice channels for these IDs.

Members can click a verification button without permission to send ordinary messages. The bot needs its own explicit channel allow when `@everyone` is denied. Otherwise, category restrictions can hide channels from the bot too.

Check every member channel is synced to the restricted category, or has equivalent overrides. Another role or member-specific allow can expose a channel before verification; a deny for `@everyone` does not override every other allow. Administrators also bypass channel denies, so they cannot be used to test whether the server is locked.

Optionally open **Server Settings → Integrations → dvc.services** and restrict application-command use to the commands channel. The code also enforces `COMMANDS_CHANNEL_ID`; `/verification` checks Manage Server permission at runtime as well as setting Discord's default command permission.

## 6. Deploy and test

Follow [deployment.md](deployment.md). With the environment set, startup will:

1. Connect and confirm the token belongs to the expected application.
2. Validate the role, hierarchy, channel types, and bot permissions.
3. Register `/about` and `/verification` in dvc.labs.
4. Find and refresh the bot's panel, or post the first one.
5. Send the online log and mark the health endpoint ready.

Then test with a separate **normal member** account:

- Before verifying, only the welcome/rules/verification areas should be visible.
- Click **Verify**. The reply should be private, the member role should appear, and member categories should unlock.
- In the private logs channel, confirm a successful award with the correct member/role IDs.
- Run `/about` in the commands channel and confirm the command log.
- Try `/about` in another visible channel and confirm the private redirect.
- Run `/verification` as a team member with Manage Server; confirm it updates the existing panel.
- Restart the bot. There should still be one active panel, and its button should still work.

If Discord rules/membership screening is enabled, finish that first. The bot refuses to award a role while the fetched member is still pending screening.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Bot stays offline | Hosting console; token; application ID; outbound Discord HTTPS/WebSocket access |
| Startup exits | The safe setup diagnostic in the console; role hierarchy; all three channel IDs and bot permissions |
| Commands missing | Guild install with both scopes; startup `commands_synced`; correct guild/application; refresh Discord after setup |
| Command listed but cannot run | Channel **Use Application Commands** and integration overrides; use the configured commands channel |
| Button cannot assign role | Manage Roles, role ordering, non-managed normal role, and the logs' error code |
| Verify succeeds but channels remain hidden | Channel/category overrides for the verification role; bot role assignment alone cannot change those overrides |
| Explicit panel ID missing | Clear `VERIFICATION_MESSAGE_ID` and restart or replace it with the correct current panel ID |
| Panel was deleted after startup | Run `/verification` as a team member; if an explicit message ID was set, clear/fix it and restart |
| Repeated panel messages | Ensure only one bot instance is running; remove old duplicate panels manually |
| No Discord log messages | Console `discord_audit_failed`; logs channel access, Send Messages, Embed Links, and host connectivity |

## Official references

- [Discord: building your first bot](https://docs.discord.com/developers/quick-start/getting-started)
- [Discord: application installation](https://docs.discord.com/developers/resources/application)
- [Discord: OAuth2](https://docs.discord.com/developers/topics/oauth2)
- [Discord: permissions and role hierarchy](https://docs.discord.com/developers/topics/permissions)
- [Discord: receiving interactions](https://docs.discord.com/developers/interactions/receiving-and-responding)
