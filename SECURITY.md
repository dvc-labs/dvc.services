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
- Put the bot above the ordinary member verification and optional Bulletin roles and below privileged team roles. Do not configure a staff role as the verification or Bulletin role; the bot rejects View Server Insights and the administrative/moderation permissions it recognises.
- Keep the logs channel private and choose an appropriate retention period for provider console logs and Discord messages. IDs identify people even when usernames and message content are absent.
- Restrict access to host configuration and deployment controls. Only trusted changes should reach production; reviews and branch protection are recommended.
- v0.2.0 requests an explicit list of five used Gateway intents (bitfield 391). Enable Presence and Server Members in the Portal. Message Content and incoming DM intents are not requested. Dependency upgrades do not automatically broaden subscriptions. Missing authorisation for a required privileged intent can prevent login; the corrective hint is restricted to DisallowedIntents/4014.
- Run a single bot process. Keep the health listener internal unless the host requires a public probe; it exposes fixed status objects only.

## Verification scope and data

The Verify button grants the configured access role with one click. This is a lightweight server access acknowledgement, not a CAPTCHA, proof of identity, age, account ownership beyond the current Discord interaction, or resistance to automated raids. A single button press does not reliably prevent automation. Configure Discord's own moderation, rules screening, and raid protections as appropriate.

The bot only adds the configured access role to the member who clicks Verify. The button checks the active panel's guild, channel, author, message ID, and component ID. It validates role safety, Manage Roles permission, and hierarchy, preserves other roles, refuses new awards during pending screening, and limits repeated role-award requests. Existing verification and optional `ADMIN_ROLE_ID` membership count as access and stop before any role write. The admin role is checked for membership only; it does not grant additional bot command permissions. Submissions from old forms are ignored.

The verification and Bulletin panels open private preference cards in the verification channel. Only the bot's active panel messages can open them. Private action buttons are bound to the caller and currently configured role, and each press checks current membership before changing only `BULLETIN_ROLE_ID`. Opting in requires the verification role or `ADMIN_ROLE_ID`; existing subscribers can opt out after losing access. Bulletin gets the same self-assignment and hierarchy checks as verification, with one change per member every three seconds. Old verification receipts cannot change roles.

Roles and the verification message are stored by Discord. The bot maintains no local member database and does not request, handle, or archive ordinary chat messages or incoming DMs. Message caching is disabled; member/user and presence caches are bounded. Activity logs contain timestamps, member/channel/role references, command names, outcomes, membership changes, Discord audit reasons, safe error codes, and locally authored setup-error messages. Setup details stay in operator logs; failures show generic guidance. Known non-members are rejected ephemerally before any public defer. Rare API failures use a non-empty acknowledgement, private follow-up, and placeholder cleanup. Components V2 cards use native references with notifications disabled; console logs retain exact IDs. User-controlled Markdown/subtext, quotes, mentions, bidi controls, and URL schemes are neutralised. Truncation occurs by source code point before escaping; authored links remain usable. Raw errors, request bodies/headers, interaction tokens, and chat content are deliberately not logged. The configured bot token is redacted from console output.

`/member` is public and available to every server member in the commands channel. Public cards expose profile/identity fields, joined/boost dates, verification, badges, and roles, and remain in the channel. Permissions, hierarchy capabilities, screening/timeouts, devices, activities, and voice state are restricted to ephemeral **Staff details** views requiring Manage Server or Moderate Members. Private-page access rechecks staff permission on every click. Restricted voice-channel names and IDs remain omitted. The lookup cannot expose emails, IPs, private messages, or distinguish invisible users from offline users.

Snapshots are held only in memory for two minutes, with at most 100 messages cached. Public snapshots exclude staff-only fields. Navigation does not refetch member/profile data and is bound to the original requester, guild, channel, message, and target. Expired snapshots require a new lookup. Queries, page edits, and private detail requests share a token budget and two-operation concurrency cap, in addition to per-user intervals. `/verification` still requires Manage Server; member lookups never change a member or role.

New human joins receive a fixed welcome template with verification/GitHub links and a short explanation of logging and public/private member views. There is no startup/backfill campaign or user-supplied DM command. The queue is limited to 50, attempts start at least 1.5 seconds apart, duplicate join deliveries are suppressed within the process, and bot accounts are skipped. Shutdown aborts pacing waits. Closed/blocked DMs are logged in the console and do not affect verification. The queue/deduplication state is in memory; delivery is best effort, not a durable exactly-once guarantee.

Discord delivery is best effort with explicit routine, important-success, and critical-error/lifecycle tiers. At most 100 records wait: routine records are capped at 60 and non-critical records at 80, protecting failures from a burst of verification successes. Higher tiers can evict lower tiers and are sent first, with FIFO order within each tier. Denied card clicks, DM results, cooldowns, and connection resumes remain console-only. Saturation by critical events can still drop records; console copies remain. An uncached member update records a labelled current snapshot rather than fabricating previous values. This is operational logging, not a durable or tamper-proof ledger. Host/provider and Discord access policies govern retention and availability.

## Cherry Creek whitelist requests

Only members with the verification or configured admin role can submit their Java username. The username, Discord account reference, and review result are stored on the private moderation message until removed under server retention policy. Staff should keep the moderation channel and its permissions private. The bot rejects public access for the default and self-assignable roles at startup. Console and audit entries include identifiers, result and links to the staff card or notice; they omit the submitted username.

One pending card is allowed per Discord account. Submissions check only the bot's own enabled review buttons in uncached moderation history. Missing history permissions or an incomplete scan block new requests; duplicate attempts and history check errors stay in the operator console.

Review actions require Manage Server or Moderate Members and an active button on a freshly fetched, bot-authored moderation card. The final decision is saved before notifying the applicant. A positive notice mentions only the applicant and contains the fixed server address and website. Declines are staff-only. Paper whitelisting is done manually before Accept; the bot does not store Minecraft credentials or connect to the server console. Run a single bot instance.

## Optional Hall integration

`/ask question` sends the submitted prompt and Discord conversation identifiers to the configured Hall Worker. It may process the question with OpenAI and web search, and manages expiring conversation context. `/ask forget` and `/ask question reset:true` delete the selected Worker context, while Discord messages remain subject to Discord and server retention. Private replies restrict the Discord audience, including continuation cards; they still use the same external providers. Publish an accurate notice covering these recipients and the actual Worker's retention before enabling the integration.

Store `HALLAI_API_KEY` as a runtime secret. It matches the Worker's `DISCORD_API_KEY`, distinct from both `DISCORD_TOKEN` and the Worker's `OPENAI_API_KEY`. The bot uses the configured HTTPS origin and rejects redirects. It bounds response size, concurrent requests, and request duration, aborts on shutdown, and does not retry generation. Command diagnostics stay in the console without prompts, answers, raw upstream error bodies, or credentials. Displayed questions escape member-controlled formatting; answer cards preserve Hall's Markdown and disable mention notifications.
