ARG POSTGRES_IMAGE=pgvector/pgvector
ARG POSTGRES_VERSION=0.8.5-pg17
FROM ${POSTGRES_IMAGE}:${POSTGRES_VERSION}

# ---------------------------------------------------------------------
# Backup helper.
#
# It exists for one reason: pg_dump and pg_restore must match the server
# version. Deriving this image from the same base as the database
# guarantees that, so scripts/backup.sh and scripts/restore.sh never
# depend on whatever postgresql-client the host happens to have.
#
# The container idles; the backup scripts run commands inside it.
# ---------------------------------------------------------------------
RUN apt-get update \
 && apt-get install -y --no-install-recommends tar gzip ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

COPY backup-service /usr/local/bin/backup-service
RUN chmod +x /usr/local/bin/backup-service

WORKDIR /work

ENTRYPOINT ["/usr/local/bin/backup-service"]
CMD ["idle"]
