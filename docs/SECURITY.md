# Security

Agent Router modifies Codex home configuration and external workflow state, so it applies these controls:

- no shell interpolation for user-controlled values;
- path normalization and traversal rejection;
- symlink-escape checks;
- atomic writes;
- backups before managed mutation;
- dry-run and rollback;
- schema/record validation;
- secret scanning before review-pack creation;
- explicit cleanup-plan confirmation;
- no automatic deletion of ambiguous data;
- zero writes to work repositories during setup, registration, bootstrap, sync, doctor, or review packaging.

The `security-research` profile is for explicitly authorized scope only. The secure-development profiles review software changes and are not pentest profiles.
