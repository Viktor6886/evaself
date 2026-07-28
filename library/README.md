# library

Shared, editable content that is **not** code and must survive updates,
backups and server migrations.

```
library/
├── persona/eva.md      Eva's persona, seeded into every new agent's
│                       `persona` memory block
├── prompts/            reusable prompt fragments for n8n workflows
└── tests/              definitions of the self-discovery questionnaires
```

Mounted read-only into `letta` (`/library`) and `eva-core`
(`/app/library`). `EVA_AGENT_PERSONA_FILE` in `.env` points at the persona
file, so it can be swapped without touching an image.

## Editing the persona

`persona/eva.md` is copied into an agent's memory **when that agent is
created**. Changing the file does not rewrite existing agents — their
memory is theirs, and silently overwriting it would destroy state users
rely on.

To roll a new persona out to existing agents deliberately:

```bash
# one user
curl -sX PATCH "$EVA_CORE_URL/v1/agents/<telegram_id>/memory" \
  -H "X-API-Key: $EVA_CORE_API_KEY" \
  -H 'Content-Type: application/json' \
  -d "{\"label\":\"persona\",\"value\":$(jq -Rs . < library/persona/eva.md)}"
```

`make backup` includes the whole directory.
