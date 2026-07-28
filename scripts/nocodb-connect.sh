#!/usr/bin/env bash
# =====================================================================
# Print the exact values needed to connect NocoDB to the `eva` database.
#
# NocoDB stores external data sources in its own metadata database, which
# means adding one through its API requires an authenticated session and
# a base that only exists after the first login. Rather than fake that
# with a brittle scripted login, this prints the four fields the operator
# pastes once, in the UI, in under a minute.
#
# NocoDB is only a GUI: PostgreSQL remains the source of truth.
# =====================================================================
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

load_env

step "Connect NocoDB to the Eva database"

cat <<INSTRUCTIONS

  1. Open  https://${DOMAIN_NOCODB}
     Sign in as  ${NC_ADMIN_EMAIL}
     (the password is NC_ADMIN_PASSWORD in .env)

  2. Create a base, then:  Data Sources -> New Data Source -> PostgreSQL

  3. Paste these values — the host is the container name, because NocoDB
     reaches PostgreSQL over evaself-network, not over the internet:

        Host        ${POSTGRES_HOST}
        Port        ${POSTGRES_PORT}
        Database    ${EVA_DB_NAME}
        Username    ${EVA_DB_USER}
        Password    ${EVA_DB_PASSWORD}
        SSL         disabled (internal network)

  4. Import the schema. You will get the 13 Eva tables plus the reporting
     views:

        users                   agent_links             subscriptions
        payments                quotas                  usage_counters
        onboarding_fields       test_results            tasks
        referrals               partner_analysis_links  notifications
        crisis_events

        v_user_overview     users with plan, agent and last activity
        v_quota_status      today's consumption against each limit
        v_revenue_monthly   succeeded payments by month
        v_crisis_open       unhandled safety events, worst first

  Read-only alternative
  ---------------------
  For dashboards that must never write, use the reporting role instead:

        Username    ${EVA_DB_READONLY_USER}
        Password    ${EVA_DB_READONLY_PASSWORD}

  Notes
  -----
  * Open sign-up is disabled (NC_INVITE_ONLY_SIGNUP=true). Add colleagues
    by invitation from inside NocoDB.
  * Editing a row in NocoDB writes straight to PostgreSQL. Eva sees the
    change on the user's next message.
  * NocoDB's own metadata lives in a separate database (${NOCODB_DB_NAME}),
    so a broken NocoDB can never damage Eva's data.

INSTRUCTIONS

if service_running nocodb; then
	ok "NocoDB is running"
else
	warn "NocoDB is not running — start it with 'make start'"
fi
