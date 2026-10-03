# Contributing

Thanks for your interest in contributing to this AWS serverless variant of
ClassroomIO.

## Before you start

- This is an **unofficial derivative** of
  [ClassroomIO](https://github.com/classroomio/classroomio). Application-level
  feature work is often better directed upstream; this repository focuses on the
  **AWS serverless deployment** (CDK infrastructure and Lambda handlers under
  `infrastructure/`).
- By contributing, you agree your contributions are licensed under
  **AGPL-3.0**, the project license.

## Ground rules

- **Never commit secrets.** No real AWS account IDs, domains, database
  connection strings, or `.env` files. Use the generic placeholders already in
  the repo (`123456789012`, `example.com`, etc.).
- Keep changes scoped and described clearly in the PR.
- Match the existing code style; run the repo's formatter before committing.

## Development setup

See the [README](README.md#local-development) for local setup, and
[README → Deploy to AWS](README.md#deploy-to-aws) for the serverless path.

```bash
nvm install && nvm use   # Node 20.19.3
pnpm install
```

## Pull requests

1. Fork and create a feature branch.
2. Make your change; add/adjust tests where it makes sense.
3. Ensure the project builds and the formatter passes.
4. For infrastructure changes, confirm `cdk synth` succeeds.
5. Open a PR with a clear description of **what** changed and **why**.

## Commit messages

Use clear, conventional commit messages (e.g. `feat:`, `fix:`, `chore:`,
`docs:`). Do not include tool/vendor attribution in commits.

## Reporting issues

- **Bugs / features:** open a GitHub issue.
- **Security:** follow [`SECURITY.md`](SECURITY.md) — do not open a public issue.
