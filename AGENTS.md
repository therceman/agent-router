# Agent Router Repository Instructions

This repository implements the Agent Router CLI.

- Use strict TypeScript and Node.js built-ins.
- The published runtime must remain dependency-free.
- Never pass user-controlled values through a shell.
- Use atomic writes for managed files.
- Preserve user-owned content outside managed blocks.
- Repository cleanup is plan-first and must preserve ambiguous evidence.
- Add regression tests before fixing discovered defects.
- Run `npm run quality-gates` before packaging.
- Do not publish the npm package automatically.
