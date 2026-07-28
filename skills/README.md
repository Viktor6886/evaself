# skills

Agent skills for Letta, in the layout Letta expects: one directory per
skill containing a `SKILL.md`.

```
skills/
├── memory-hygiene/SKILL.md
└── reflection-session/SKILL.md
```

The directory is mounted read-only into the Letta container at `/skills`,
and into Eva Core at `/app/skills`.

Letta 0.16 exposes skills two ways:

* attached to an agent and exported with it —
  `POST /v1/agents/{id}/export` (the "export with skills" variant);
* passed per request as client-side skills, which is how Eva Core
  advertises repository skills without copying them into every agent.

Because they live in this repository, skills are versioned in git, shipped
by `make update`, and captured by `make backup`.

## Writing one

`SKILL.md` starts with front matter and then plain instructions:

```markdown
---
name: my-skill
description: One line the model uses to decide whether to open this.
---

Concrete instructions. Short. Imperative.
```

Keep the description sharp: it is the only thing the model sees before
deciding to read the body.
