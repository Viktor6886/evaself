# Installation

## Before you start

1. A clean Ubuntu 24.04 server, root or sudo access.
2. DNS records for **all seven** names pointing at the server's IP —
   Caddy validates over HTTP-01/TLS-ALPN-01 and cannot issue a
   certificate for a name that does not resolve to you.

   ```
   evaself.online          A    203.0.113.10
   app.evaself.online      A    203.0.113.10
   api.evaself.online      A    203.0.113.10
   n8n.evaself.online      A    203.0.113.10
   admin.evaself.online    A    203.0.113.10
   letta.evaself.online    A    203.0.113.10
   status.evaself.online   A    203.0.113.10
   ```

3. Two Telegram bots from [@BotFather](https://t.me/BotFather): one for
   Eva, one for Hermes. Keep both tokens at hand.
4. Your numeric Telegram ID — [@userinfobot](https://t.me/userinfobot)
   will tell you.
5. An OpenAI-compatible LLM endpoint (base URL, API key, model name).

## Install

```bash
git clone https://github.com/viktor6886/evaself.git
cd evaself
sudo make install
```

## What the installer does

| Step | What happens | Safe to re-run? |
|---|---|---|
| 1 | Checks OS, CPU, RAM, disk; warns rather than refuses | yes |
| 2 | Installs curl, git, jq, openssl, ufw, fail2ban, tar, cron, python3 | yes |
| 3 | Installs Docker CE + compose plugin from Docker's own repo | yes |
| 4 | Configures UFW: your **existing** SSH port, 80, 443 tcp+udp | yes |
| 5 | Configures Fail2Ban for SSH | yes |
| 6 | Runs the configuration wizard if `.env` has no domain yet | yes |
| 7 | Checks that every host name resolves to this server (warns only) | yes |
| 8 | Pulls pinned images, hashes the Letta console password | yes |
| 9 | Builds eva-core, media-service, webapp, letta-ui, n8n, backup | yes |
| 10 | `docker compose up -d` and waits for health | yes |
| 11 | Applies SQL migrations (idempotent) | yes |
| 12 | Imports the n8n workflows and generates the DB credential | yes |
| 13 | Installs Hermes into Ubuntu, writes token + allowlist, **does not start it** | yes |
| 14 | Installs systemd units, enables the daily backup timer | yes |
| 15 | Runs `make doctor` | yes |
| 16 | Prints URLs and administrative passwords | — |

Re-running `sudo make install` on an existing installation preserves every
secret in `.env`, never removes a volume, and simply reconciles the state.

**Your SSH access is never modified.** The installer reads the port out of
`sshd_config` and allows it; it does not touch keys, passwords or the
daemon's configuration.

## The wizard

```
==> Domains
  Main domain (e.g. evaself.online): evaself.online
  WebApp domain [app.evaself.online]:        ← press Enter, or type your own
  API domain [api.evaself.online]:
  n8n domain [n8n.evaself.online]:
  NocoDB domain [admin.evaself.online]:
  Letta UI domain [letta.evaself.online]:
  Status domain [status.evaself.online]:
  E-mail for Let's Encrypt: ops@evaself.online

==> Telegram
  Eva bot token: 123456789:AAE…
  Hermes bot token (server agent): 987654321:AAE…
  Owner Telegram ID: 555000111

==> LLM for Eva
  LLM base URL (…/v1): https://api.example.com/v1
  LLM API key: ••••••
  Model [mimo-v2.5-pro]:
  Context window [131072]:
  Embedding base URL (empty = same as LLM):
  Embedding model [text-embedding-3-small]:
  Embedding dimensions [1536]:

==> Optional services
  Install Crawl4AI for reading and cleaning web pages? [y/N]
  Install Uptime Kuma for the status page? [y/N]
  Server timezone [Europe/Amsterdam]:
```

Everything else — 14 passwords, keys and tokens — is generated. `.env`
ends up mode 600 and is in `.gitignore`.

`N8N_ENCRYPTION_KEY` is generated exactly once and never regenerated:
without it, stored n8n credentials cannot be decrypted, on this server or
any other.

## After the install

The installer prints these, and they are also in `.env`:

```
1. Open https://n8n.<domain> and create the n8n owner account.
2. scripts/telegram-webhook.sh set     register Eva's webhook
3. Activate the two Telegram workflows in the n8n editor.
4. scripts/nocodb-connect.sh           connect NocoDB to the eva database
5. make configure-hermes               give Hermes an LLM when ready
6. Fill in MEDIA_ASR_* / MEDIA_TTS_* in .env, then: make restart
```

Workflows are imported **inactive**. Activating a Telegram webhook is a
decision, not an installation side effect.

## Verifying

```bash
make doctor
```

checks containers, health probes, the four databases, the Eva schema,
every internal endpoint, public HTTPS on all six routed hosts, UFW,
Fail2Ban, that PostgreSQL and Valkey are unpublished, Hermes's state, and
the age of the last backup.

## If certificates do not arrive

```bash
make logs s=caddy
```

Almost always one of:

* DNS not propagated yet — `getent ahostsv4 n8n.<domain>`;
* port 80 blocked upstream (cloud firewall, not UFW);
* an A record pointing somewhere else;
* Let's Encrypt rate limits after repeated failures — set
  `ACME_STAGING=1` in `.env`, `make restart`, fix the cause, then set it
  back to `0` and `make restart` again.

## Uninstalling

```bash
make stop
docker compose --env-file versions.env --env-file .env down
```

Volumes survive that. Removing them is intentionally manual:

```bash
docker volume rm evaself_postgres_data evaself_letta_data evaself_n8n_data …
```

Take a backup first; there is no undo.
