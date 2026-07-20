# Repository Hygiene

```bash
agent-router repo inspect
agent-router repo diet plan
agent-router repo diet apply --plan FILE --destination DIR --confirm PLAN-ID
```

Inspection recognizes generated output, caches, Docker/runtime state, Ghidra/analysis artifacts, scanner output, archives, canonical sources, and ambiguous data.

Planning is read-only. Apply requires exact plan confirmation. Ambiguous evidence is never moved automatically.

Unexpected repository-local `.agent-router/` or `.codex/` state is classified as ambiguous because Agent Router always keeps framework state in the user home directory.
