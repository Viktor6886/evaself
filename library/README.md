# library

Редактируемый контент, который не является кодом:

```text
library/
├── README.md
├── persona/
│   └── eva.md
├── prompts/
├── system/
│   └── letta_local_memfs.md
└── tests/
```

Persona копируется в память нового agent при создании. Изменение файла не
перезаписывает память существующих agents: такую миграцию нужно выполнять
отдельно и осознанно.

Каталог включён в backup и монтируется в `eva-agent-service` read-only.
