# NocoDB

The graphical interface over Eva's data. **PostgreSQL is the source of
truth**; NocoDB is a window onto it.

## Two databases, on purpose

| | |
|---|---|
| `nocodb` | NocoDB's own metadata: bases, views, users, sharing |
| `eva` | Eva's data, connected as an **external data source** |

A broken or compromised NocoDB therefore cannot damage Eva's schema, and
Eva's dumps stay free of GUI metadata.

## Connecting it

```bash
scripts/nocodb-connect.sh
```

prints the four fields to paste into
*Data Sources → New Data Source → PostgreSQL*. The host is `postgres` —
the container name — because NocoDB reaches the database over
`evaself-network`, not the internet.

This step is manual on purpose: adding a data source through NocoDB's API
needs an authenticated session and a base that only exists after the first
login, and a scripted browser login is a worse thing to maintain than a
one-minute paste.

## What you get

Thirteen tables:

```
users              agent_links       subscriptions
payments           quotas            usage_counters
onboarding_fields  test_results      tasks
referrals          partner_analysis_links
notifications      crisis_events
```

and four views that are what you will actually look at:

| view | shows |
|---|---|
| `v_user_overview` | every user with plan, agent, message count, last seen |
| `v_quota_status` | today's consumption against each limit |
| `v_revenue_monthly` | succeeded payments by month and currency |
| `v_crisis_open` | unhandled safety events, worst first |

## Editing

Editing a row writes straight to PostgreSQL. Eva sees it on the user's
next message. Useful in practice:

* `users.is_blocked` — stop someone immediately;
* `quotas.limit_value` — raise a plan's limit for everyone (`-1` =
  unlimited);
* `subscriptions.plan` / `current_period_end` — grant access manually;
* `crisis_events.handled` / `handled_by` / `notes` — work the queue.

Be careful with `agent_links.agent_id`: it points at a real Letta agent.
Changing it hands one person's memory to another.

## Access

* Admin account: `NC_ADMIN_EMAIL` / `NC_ADMIN_PASSWORD` from `.env`.
* Open sign-up is disabled (`NC_INVITE_ONLY_SIGNUP=true`) — add people by
  invitation from inside NocoDB.
* Reachable only over HTTPS on `admin.<domain>`.

For dashboards that must never write, connect a second data source with
`EVA_DB_READONLY_USER`, which has `SELECT` and nothing else.

## Backups

`nocodb.dump` and the `nocodb_data` volume are both in every archive, so
bases, views and sharing links survive a migration.
