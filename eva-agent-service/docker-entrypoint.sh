#!/bin/sh
set -eu

# The image includes signatures; refreshing them never blocks service boot.
# Only the agent worker maintains the shared cache, not every process using
# this image. Foreground mode keeps freshclam in tini's signal process group.
if [ "${1:-}" = "node" ] && [ "${2:-}" = "dist/index.js" ] &&
	[ "${EVA_BULLMQ_JOBS:-true}" = "true" ]; then
	if [ "$(id -u)" -eq 0 ]; then
		chown node:node /var/lib/clamav
		gosu node freshclam --daemon --foreground --checks=4 --quiet \
			--config-file=/app/assets/freshclam.conf &
	else
		freshclam --daemon --foreground --checks=4 --quiet \
			--config-file=/app/assets/freshclam.conf &
	fi
fi

# Host key stays root-only. When an admin process needs it, copy it into the
# container runtime directory, make it read-only for the node group, then
# permanently drop privileges before starting Node.js.
if [ "$(id -u)" -eq 0 ]; then
	# Named volumes are initially root-owned. Both the one-shot initializer and
	# long-running writer drop to node only after making the mounted filesystem writable.
	if [ -d /data/letta/.skills ]; then
		chown node:node /data/letta/.skills
		chmod 0750 /data/letta/.skills
	fi
	if [ -n "${EVA_SECRETS_MASTER_KEY_FILE:-}" ] &&
		[ -f "$EVA_SECRETS_MASTER_KEY_FILE" ]; then
		runtime_dir="/run/evaself"
		runtime_key="$runtime_dir/secrets-master-key"
		install -d -o root -g node -m 0750 "$runtime_dir"
		cp -- "$EVA_SECRETS_MASTER_KEY_FILE" "$runtime_key"
		chown root:node "$runtime_key"
		chmod 0440 "$runtime_key"
		export EVA_SECRETS_MASTER_KEY_FILE="$runtime_key"
	fi
	exec gosu node "$@"
fi

exec "$@"
