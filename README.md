# Discord Ticket System

A self-hosted support portal with local accounts, category-based tickets, staff roles, audit log, transcript export, and a Discord bot bridge. This is a real application, not a mockup. Discord synchronization requires a configured bot and a Discord server.

## Requirements
- Node.js 20 or newer
- A Discord application/bot created in https://discord.com/developers/applications
- A Discord server where you can invite the bot

## Start
1. Extract the ZIP into a folder outside OneDrive if possible.
2. Run `start.cmd` once. It creates `.env` and opens it in Notepad.
3. In `.env`, set `SESSION_SECRET` to a long random value, `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, and optionally `DISCORD_TICKET_CATEGORY_ID` and `DISCORD_STAFF_ROLE_ID`.
4. Invite the bot with `bot` and `applications.commands` scopes and permissions: Manage Channels, View Channels, Send Messages, Read Message History, Embed Links, Attach Files, and Manage Messages only if needed. Do not grant Administrator.
5. Enable the **Message Content Intent** in the Developer Portal if you want staff messages in ticket channels to sync into the website. The bot uses guild and message events.
6. Run `start.cmd` again and open `http://127.0.0.1:3000`.
7. Register an account. The first account is not automatically staff: assign staff status manually in `data/store.json` only after registering, or set `"role":"admin"` for your account's user object. Restart the app after editing. Never expose the site publicly before configuring HTTPS and strong secrets.

## How Discord sync works
- Creating a ticket in the website creates a private Discord text channel when bot configuration is valid.
- Website replies are posted in that Discord channel.
- Staff messages sent in the ticket channel sync to the website.
- Closing a ticket updates its status and locks the Discord channel from the ticket owner (the channel is retained for records).
- Transcript downloads are generated from the application's stored ticket messages.

## Security notes
- Accounts use bcrypt password hashes; session cookies are HTTP-only and SameSite=Lax.
- Bind to `127.0.0.1` by default. For internet access, use a properly configured HTTPS reverse proxy, set `COOKIE_SECURE=true`, use a long unique session secret, and add rate limiting/monitoring appropriate to your deployment.
- The app stores data in `data/store.json`. Back it up while the server is stopped. Do not edit it while the server is running.
- Discord bot permissions and role hierarchy can prevent actions even if the web UI is available.
- This package has not been tested against your live Discord server; validate with a private test server first.
