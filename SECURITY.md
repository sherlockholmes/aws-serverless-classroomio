# Security Policy

## Reporting a vulnerability

If you discover a security vulnerability in this project, please report it
privately. **Do not open a public issue for security problems.**

- Use GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability)
  ("Report a vulnerability" under the repository's **Security** tab), or
- Contact the maintainers through the channel listed in the repository profile.

Please include:

- A description of the issue and its impact.
- Steps to reproduce (proof of concept if possible).
- Affected version/commit.

We will acknowledge your report and work with you on a fix and coordinated
disclosure.

## Secrets and credentials

This repository is designed to contain **no real secrets**. All credentials,
AWS account identifiers, domains, and database connection strings are supplied
at deploy time through environment variables.

If you believe a secret has been committed:

1. **Rotate the credential immediately** at its provider (database, AWS, etc.).
   Removing it from a later commit does **not** neutralize the exposure — it
   remains in git history.
2. Report it privately per the process above.

## Scope

This is an unofficial AWS serverless adaptation of
[ClassroomIO](https://github.com/classroomio/classroomio). Vulnerabilities in
upstream ClassroomIO application code should also be reported to the upstream
project where appropriate.
