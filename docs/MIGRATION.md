# Moving to another server

Everything that matters is in one backup archive, so a migration is a
restore plus a DNS change. Budget 30–45 minutes, most of it waiting.

## Plan

```
old server                          new server
──────────                          ──────────
1. make backup
2. scp the archive  ───────────────► 3. git clone + sudo make install
                                     4. make restore BACKUP=…
                                     5. verify with the hosts file
6. lower DNS TTL
7. stop Eva's webhook
                                     8. switch DNS
                                     9. re-register the webhook
10. keep as a cold spare for a week
```

## 1. Lower the TTL first (a day ahead)

Set the TTL on all seven records to 300 seconds. Do this the day before —
a TTL change is only honoured after the old TTL expires.

## 2. Back up on the old server

```bash
make backup
ls -lh /var/backups/evaself/
```

## 3. Copy the archive

The archive contains every secret, so encrypt it in transit:

```bash
scp /var/backups/evaself/evaself-backup-….tar.gz root@NEW_IP:/root/
```

## 4. Install on the new server

```bash
git clone https://github.com/viktor6886/evaself.git
cd evaself
sudo make install
```

Answer the prompts with anything valid — the restore overwrites all of it.
Certificate issuance will fail at this point because DNS still points at
the old server. That is expected and harmless.

## 5. Restore

```bash
make restore BACKUP=/root/evaself-backup-….tar.gz
```

## 6. Verify before touching DNS

Point your own machine at the new server with a hosts entry, so you can
test without affecting users:

```
# /etc/hosts on your laptop
203.0.113.99  evaself.online app.evaself.online api.evaself.online
203.0.113.99  n8n.evaself.online admin.evaself.online letta.evaself.online
```

Then check:

* `https://n8n.<domain>` — the editor loads, workflows are there,
  credentials open without an "unable to decrypt" error;
* `https://admin.<domain>` — NocoDB shows the users table with the
  expected row count;
* `https://letta.<domain>` — the console lists the same agents, each with
  its conversation id;
* on the server: `make doctor`, then

  ```bash
  make shell-db
  select count(*) from users;
  select count(*) from agent_links where status='active';
  ```

  Both must match the old server.

Certificates: the archive includes `caddy_data`, so the existing
certificates come along and Caddy does not need to re-issue immediately.
Remove the hosts entries when you are done.

## 7. Freeze writes on the old server

To guarantee no message is processed twice, stop Eva's webhook on the old
server just before the switch:

```bash
# on the OLD server
scripts/telegram-webhook.sh delete
```

Telegram queues updates while no webhook is registered, so nothing is lost.
Then take a final incremental backup and restore it on the new server the
same way — it is quick, since only the databases changed.

## 8. Switch DNS

Point all seven records at the new IP. With a 300-second TTL, propagation
is minutes.

```bash
watch -n5 'getent ahostsv4 n8n.evaself.online'
```

## 9. Re-register the webhook

```bash
# on the NEW server
scripts/telegram-webhook.sh set
scripts/telegram-webhook.sh status
```

Check `"url"` in the output and that `pending_update_count` drains to 0.
Then activate the two Telegram workflows in the n8n editor if they are not
already active.

## 10. Final checks

```bash
make doctor
make logs s=n8n     # watch a real message flow through
```

Send yourself a message as a normal user. Eva should answer *with
context* — if she greets you as a stranger, her memory did not come
across; stop and check `agent_links` and the Letta console before letting
users back in.

## 11. Keep the old server for a week

Do not destroy it. Stop the stack (`make stop`) so it cannot process
anything, but keep the disk. If something surfaces a few days later, the
old server is the fastest possible rollback.

## Changing domain at the same time

Restore first, then:

```bash
make configure       # enter the new domain; existing secrets are preserved
make restart
scripts/telegram-webhook.sh set
```

Also update the Mini App URL in @BotFather, and the OAuth/webhook URLs of
any payment provider you have configured.

## Troubleshooting

**"unable to decrypt credentials" in n8n** — `N8N_ENCRYPTION_KEY` in
`.env` does not match the backup. Take it from the archive:

```bash
tar xzf backup.tar.gz -O '*/n8n/encryption-key.env'
```

Put that value in `.env` and `make restart`.

**Eva does not remember anyone** — the App Server state volume restored
but `agent_links` did not, or vice versa. Check both ends:

```bash
make shell-db
SELECT telegram_id, agent_id, conversation_id FROM v_agent_runtime;
```

```bash
docker compose --env-file versions.env --env-file .env \
  exec letta-app-server letta agents list
```

The agent ids must match. A row whose `conversation_id` is NULL keeps the
agent and its memory but starts a new thread on the next message. The
archive's `letta/inventory.json` records what both sides looked like when
the backup was taken.

**Certificates not issuing after the switch** — port 80 must be reachable
on the new server. Check the cloud provider's firewall, not just UFW.
