#!/bin/sh
set -eu

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
