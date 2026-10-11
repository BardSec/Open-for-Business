# Open for Business

A simple open/closed status board for a school help desk. Staff toggle each help desk location open or closed from an admin page, and anyone can view the live status on a public page. Built for K12 technology departments that run one or more walk-up help desks.

## Features

- **Public status pages**: an overview page (`/`) showing every site at a glance, plus a per-site page (`/site/:id`). Both refresh automatically every few seconds.
- **Admin dashboard** (`/admin`): add and remove sites (up to 50), toggle open/closed, and set business hours per site.
- **Business-hours auto-close**: a scheduler runs every minute and closes any site that is open outside its configured hours. Opening is always manual.
- **Uptime report** (`/admin/report`): for a chosen date range (up to 2 years), shows minutes open vs. closed during business hours and an open percentage for each site.
- **Authentication**:
  - OpenID Connect SSO (Microsoft Entra ID, Google, or any OIDC provider), with an optional allowlist by email or domain.
  - HTTP Basic Auth fallback when OIDC isn't configured.
- **Simple persistence**: state and the open/close event log live in a single JSON file, written atomically. Events older than the 2-year retention window are pruned daily.
- **Basic hardening**: per-IP rate limiting on admin API calls, XHR-only mutation endpoints, secure session cookies in production, and a non-root container user.

## Tech Stack

- Node.js 20, Express 4
- express-session, openid-client, dotenv
- Server-rendered HTML (no frontend framework), all in `server.js`
- Docker / Docker Compose

## Setup

### Docker Compose (recommended)

```bash
cp .env.example .env    # then fill in the values
docker compose up -d --build
```

The app listens on port 3000. State is stored in the `helpdesk-state` volume.

Set `TZ` in `compose.yaml` to your school's IANA timezone (for example `America/Chicago`). The auto-close scheduler compares against server-local time, so a wrong timezone will close sites during open hours.

### Local

```bash
npm install
cp .env.example .env
npm start
```

### Configuring SSO (Microsoft Entra ID)

1. In the Azure portal, create an App registration.
2. Add a redirect URI of `https://<your-host>/auth/callback` (or `http://localhost:3000/auth/callback` for local use).
3. Copy the client ID, tenant ID, and a new client secret into `.env` (see below).
4. Set `OIDC_ALLOWED_EMAILS` and/or `OIDC_ALLOWED_DOMAIN`. Without them, **any** user your identity provider authenticates gets admin access.

Run behind a reverse proxy that terminates TLS. The app trusts one proxy hop.

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `OIDC_ISSUER` | OIDC discovery URL (e.g. Entra `https://login.microsoftonline.com/{tenant}/v2.0` or `https://accounts.google.com`). Set the issuer, client ID, and secret together to enable SSO. |
| `OIDC_CLIENT_ID` | OAuth2 application (client) ID |
| `OIDC_CLIENT_SECRET` | OAuth2 client secret |
| `OIDC_REDIRECT_URI` | Callback URL registered with the provider. Defaults to `http://localhost:{PORT}/auth/callback` |
| `OIDC_ALLOWED_EMAILS` | Comma-separated list of emails allowed to sign in |
| `OIDC_ALLOWED_DOMAIN` | Email domain allowed to sign in |
| `SESSION_SECRET` | Secret for signing session cookies. If unset, a random one is generated and sessions don't survive restarts |
| `ADMIN_PASSWORD` | Basic Auth password, used only when OIDC is not configured. If unset, a random one is printed to the console at startup |
| `PORT` | Listen port (default `3000`) |
| `STATE_FILE` | Path to the JSON state file (default `./state.json`; Compose sets `/app/state/state.json`) |
| `NODE_ENV` | Set to `production` to enable secure cookies |
| `TZ` | Server timezone, used by the business-hours scheduler |

## Project Structure

```
server.js       # Entire app: auth, API, scheduler, reports, HTML pages
compose.yaml    # Docker Compose service + state volume
Dockerfile      # node:20-alpine, runs as non-root user
.env.example    # Documented configuration template
```
