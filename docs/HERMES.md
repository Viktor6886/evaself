# Hermes Agent

Hermes is [Nous Research's self-improving agent](https://github.com/NousResearch/hermes-agent).
In Evaself it is the **operator** agent: you talk to it in Telegram and it
runs the server.

It is installed **directly into Ubuntu**, not into Docker — an agent whose
job is to manage Docker cannot live inside it.

## What it can do

Shell commands · Docker · systemd · read and edit the project files ·
read logs · install packages · `make backup` · `make restore` ·
`make update` · `make rollback` · inspect CPU, memory and disk.

That is the full list, and it is deliberate. Hermes runs as root with
`HERMES_YOLO_MODE=1`, i.e. no approval prompts and no sandbox, because a
service with no TTY cannot answer a prompt and a sandboxed agent cannot
restart Docker.

## Therefore: the allowlist is the security boundary

There is no second line of defence. Access is a single Telegram ID:

```
# /root/.hermes/.env   (mode 600)
TELEGRAM_BOT_TOKEN=987654321:AAE…
TELEGRAM_ALLOWED_USER_IDS=555000111
```

and, declaratively:

```yaml
# /root/.hermes/config.yaml
gateway:
  telegram:
    enabled: true
    allowed_user_ids:
      - 555000111
```

Consequences to take seriously:

* Use a **separate bot** for Hermes. Never the same token as Eva.
* If that Telegram account is compromised, the server is compromised.
  Turn on 2FA in Telegram.
* Never add a second ID "temporarily".
* Verify the allowlist after any change: `make hermes-status`.

## Installation

`sudo make install` runs `scripts/install-hermes.sh`, which:

1. runs the official installer;
2. writes the bot token and your Telegram ID from `.env`;
3. installs `evaself-hermes.service` — **without enabling or starting it**.

Hermes has no model at that point, so it sits in
`awaiting-configuration`. This is intentional: nothing with root on the
server starts talking to an LLM before you have chosen which one.

## Giving it a model

```bash
make configure-hermes
```

Offers four options:

1. **Nous Portal** — `hermes setup --portal`
2. **Interactive picker** — `hermes model` (OpenRouter, OpenAI, custom)
3. **Reuse Eva's endpoint** — writes Eva's base URL and key into
   `~/.hermes/.env`. Convenient, but the two then share one API key: revoke
   it and both stop.
4. **Skip** — configure by hand later.

Then it offers to run `hermes gateway setup` and to enable autostart.

## Commands

```bash
make configure-hermes    # model + gateway + autostart
make start-hermes
make stop-hermes
make restart-hermes
make update-hermes       # snapshot config, reinstall binary, restart
make hermes-status       # state, allowlist, capabilities, recent journal
```

Underneath it is an ordinary systemd unit:

```bash
systemctl status evaself-hermes
journalctl -u evaself-hermes -f
```

## The systemd unit, and what is missing from it

`systemd/evaself-hermes.service` has no `ProtectSystem`, no `PrivateTmp`,
no `NoNewPrivileges`, no `ReadOnlyPaths`. That is not an oversight — every
one of those would break the job Hermes is installed to do. The file says
so, in the file, so nobody "hardens" it by accident and then wonders why
`make backup` fails from Telegram.

What the unit *does* set:

```
HERMES_YOLO_MODE=1          no approval prompts (there is no TTY)
HERMES_ACCEPT_HOOKS=1       same reason
HERMES_ALLOW_PRIVATE_URLS=1 so it can reach the stack on evaself-network
HERMES_REDACT_SECRETS=1     keep secrets out of the journal
Restart=on-failure          with a 5-in-300s limit, so a crash loop stops
```

## Things worth asking it

```
make doctor
покажи логи n8n за последние 10 минут
сколько места на диске
сделай backup
что съедает память
перезапусти letta
покажи последние crisis_events
```

## Auditing

Every command Hermes runs is in the journal:

```bash
journalctl -u evaself-hermes --since "1 hour ago" --no-pager
journalctl -u evaself-hermes --since today | grep -i 'docker\|rm \|systemctl'
```

If you ever see a command you did not ask for, stop it immediately —
`make stop-hermes` — and check `make hermes-status` for the allowlist.

## Turning it off

```bash
make stop-hermes
systemctl disable evaself-hermes
```

Evaself runs perfectly well without Hermes. It is a convenience for the
owner, not a dependency of the stack.

## Backups

`make backup` includes `~/.hermes` (token, allowlist, config, state) and
the systemd unit. A restore puts both back but does **not** start the
service — the same deliberate pause as a fresh install.
