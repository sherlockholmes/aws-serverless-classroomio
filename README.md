# ClassroomIO — AWS Serverless Variant (unofficial)

> An **unofficial** adaptation of [ClassroomIO](https://github.com/classroomio/classroomio)
> that runs the platform on an **AWS serverless** architecture
> (Amazon API Gateway + AWS Lambda, provisioned with the AWS CDK).
>
> This project is **not affiliated with, endorsed by, or supported by** the
> ClassroomIO project or its maintainers. ClassroomIO® and its branding belong
> to their respective owners. See [`NOTICE`](NOTICE) for attribution and the
> list of modifications.

## What this is

ClassroomIO is an open source LMS for companies (compliance training, customer
education, partner certification). The upstream project ships a monolithic
[Hono](https://hono.dev/) API designed to run as a long-lived server
(Docker / self-host / their cloud).

**This variant re-targets that same application to AWS serverless**: each API
route group is deployed as an individual AWS Lambda behind an Amazon API Gateway
HTTP API, with all infrastructure described as code using the AWS CDK. The goal
is a deployment that any team can stand up in **their own AWS account** with
minimal configuration — no account-specific values are committed to this
repository.

## What problem it solves

- **No server to operate** — pay-per-request Lambda instead of an always-on host.
- **Infrastructure as code** — the entire stack (`infrastructure/`) is reproducible
  via `cdk deploy`; nothing is clicked together by hand.
- **Account-portable** — region, domain, account ID, and database connection are
  all driven by environment variables, so the same code deploys to any AWS account.

## Relationship to ClassroomIO & key differences

This variant keeps the ClassroomIO application code (SvelteKit dashboard, domain
logic, database schema) and changes **how and where the backend runs**.

| Aspect | ClassroomIO (upstream) | This variant |
|---|---|---|
| Backend runtime | Hono monolith, long-lived server | One AWS Lambda per route group behind API Gateway |
| Infrastructure | Docker Compose / self-host | AWS CDK (TypeScript) |
| Scaling | Vertical / always-on | Serverless, on-demand |
| Transactional email | Provider-dependent | Amazon SQS → worker Lambda → Amazon SES |
| Background jobs | Redis/BullMQ worker | SQS-backed Lambda workers |
| Database | PostgreSQL | PostgreSQL (Neon or any managed Postgres) |
| Config | `.env` files | `.env` + CDK context / environment variables |

### Trade-offs introduced

- **Cold starts.** Lambda cold starts add latency that an always-warm server does not have.
- **Streaming routes.** Streaming endpoints (e.g. AI chat) need AWS Lambda response
  streaming via a Function URL; those are a documented follow-up and may fall back
  to the upstream behavior. See [Known limitations](#known-limitations).
- **Managed-service coupling.** The deployment depends on AWS managed services
  (API Gateway, Lambda, SQS, SES, CloudFront). Portability off AWS is reduced
  relative to the Docker-based upstream.

> This is an architectural adaptation, not a feature fork. Application features
> track upstream ClassroomIO; consult the upstream project for product roadmap.

## High-level AWS architecture

```
                   ┌──────────────────────────────┐
   Browser ──────► │ CloudFront (dashboard + CDN)  │
                   └──────────────┬───────────────┘
                                  │
                   ┌──────────────▼───────────────┐
                   │ API Gateway (HTTP API)        │
                   └──────────────┬───────────────┘
                                  │  route → integration
             ┌────────────────────┼────────────────────┐
             ▼                    ▼                     ▼
      ┌────────────┐      ┌──────────────┐      ┌──────────────┐
      │  Lambda(s)  │      │   Lambda(s)  │ ...  │   Lambda(s)  │
      │ (per group) │      │ (per group)  │      │ (per group)  │
      └──────┬──────┘      └──────┬───────┘      └──────┬───────┘
             │                    │                     │
             └──────────┬─────────┴─────────┬───────────┘
                        ▼                   ▼
                ┌───────────────┐   ┌───────────────┐
                │ PostgreSQL    │   │  SQS → SES     │
                │ (Neon / RDS)  │   │  (email)       │
                └───────────────┘   └───────────────┘
```

Infrastructure is defined in [`infrastructure/`](infrastructure/) (AWS CDK).
Lambda handlers live under [`infrastructure/src/lambda/`](infrastructure/src/lambda/).

## Prerequisites

| Requirement | Notes |
|---|---|
| AWS account | You deploy into your own account; no shared account is assumed |
| AWS CLI configured | Credentials with permission to deploy the stack (see [`docs/iam-permissions.md`](docs/iam-permissions.md) once added) |
| AWS CDK v2 | `npm i -g aws-cdk`; the account/region must be **bootstrapped** (`cdk bootstrap`) |
| Node.js >= 20.19.3 | See `.nvmrc` |
| pnpm v10 | Package scripts call `pnpm` directly |
| PostgreSQL database | [Neon](https://neon.tech) or any managed Postgres reachable from Lambda |
| (Local dev only) Docker | Runs Postgres + Redis locally |

## Environment variables

No real values are committed. Copy the example files and fill in **your own**
account, region, domain, and database connection. See [`.env.example`](.env.example)
for the full annotated list. The infrastructure stack reads these (all optional
except `DATABASE_URL`; omit domain vars to use the default API Gateway/CloudFront URLs):

| Variable | Purpose | Example (placeholder) |
|---|---|---|
| `CDK_DEFAULT_ACCOUNT` | Target AWS account ID | `123456789012` |
| `CDK_DEFAULT_REGION` | Target AWS region | `us-east-1` |
| `DATABASE_URL` | Postgres connection string | `postgresql://user:pass@host:5432/db?sslmode=require` |
| `ALLOWED_ORIGINS` | Comma-separated CORS origins | `https://app.example.com,http://localhost:5173` |
| `API_DOMAIN` | Custom API domain (optional) | `api.example.com` |
| `CDN_DOMAIN` | Custom CDN domain (optional) | `cdn.example.com` |
| `HOSTED_ZONE_ID` | Route53 hosted zone (optional) | `ZXXXXXXXXXXXXX` |
| `CERTIFICATE_ARN` | ACM certificate ARN (optional) | `arn:aws:acm:us-east-1:123456789012:certificate/…` |
| `BUCKET_PREFIX` | Prefix for S3 bucket names | `classroomio` |
| `PRIVATE_SERVER_KEY` | Dashboard↔API shared secret | generate: `openssl rand -hex 32` |
| `BETTER_AUTH_SECRET` | Auth signing secret | generate: `openssl rand -hex 32` |
| `EMAIL_FROM` / `SMTP_SENDER` | Default sender (verified in SES) | `"Your Org" <notify@example.com>` |

## Deploy to AWS

> You deploy into **your own** AWS account. Replace every placeholder with your
> own values; never commit real secrets.

```bash
# 1. Install dependencies
pnpm install

# 2. Configure your environment
cp .env.example .env            # fill in account, region, DATABASE_URL, secrets

# 3. Bootstrap CDK in your account/region (one-time per account+region)
cd infrastructure
npx cdk bootstrap aws://<YOUR_ACCOUNT_ID>/<YOUR_REGION>

# 4. Review what will be created
npx cdk synth
npx cdk diff

# 5. Deploy
npx cdk deploy --all
```

Custom domains (`API_DOMAIN`, `CDN_DOMAIN`) require a Route53 hosted zone
(`HOSTED_ZONE_ID`) and an ACM certificate (`CERTIFICATE_ARN`) in your account.
Leave those unset to use the default API Gateway and CloudFront URLs.

## Local development

The application also runs locally without AWS (Postgres + Redis via Docker),
which is the fastest way to work on application code.

```bash
nvm install && nvm use          # Node 20.19.3
pnpm install

# Per-app .env files — copy the examples and generate secrets
cp apps/api/.env.example apps/api/.env
cp apps/dashboard/.env.example apps/dashboard/.env
cp packages/db/.env.example packages/db/.env
# Generate each secret with: openssl rand -hex 32
# PRIVATE_SERVER_KEY must be identical in apps/api/.env and apps/dashboard/.env

# Start Postgres + Redis and seed the database
docker compose -f docker-compose.yaml up -d postgres redis
pnpm --filter @cio/db db:setup:seed

# Run the services (separate terminals)
pnpm api:dev          # http://localhost:3002
pnpm dashboard:dev    # http://localhost:5173
```

Monorepo layout:

- `apps/dashboard` — SvelteKit LMS web app
- `apps/api` — Hono API (source of the serverless handlers' logic)
- `apps/jobs` — background workers
- `apps/website`, `apps/docs` — marketing site and documentation
- `packages/*` — shared code (`db`, `utils`, `ui`, `email`, …)
- `infrastructure/` — AWS CDK stacks + Lambda handlers for the serverless deployment

## Known limitations

- **Streaming endpoints** (e.g. AI chat) are not yet served over Lambda response
  streaming in this variant; they require a Function URL and are tracked as
  follow-up work.
- **Not every upstream route** is deployed as a native Lambda yet. The serverless
  surface covers the core LMS flows; some advanced/low-traffic route groups remain
  to be ported. The deployment returns a clean 404 for unported routes rather than
  misbehaving.
- **AI features are opt-in** and require provider API keys (OpenAI / Google / Anthropic).

## Cost considerations

Costs depend entirely on **your** usage and AWS pricing in your region. The
serverless model is pay-per-request:

- **API Gateway + Lambda** — charged per request and per GB-second; low idle cost.
- **SQS + SES** — per message / per email.
- **CloudFront + S3** — per GB transferred / stored.
- **PostgreSQL (Neon or RDS)** — billed by your database provider, separately from AWS compute.

Estimate against the [AWS Pricing Calculator](https://calculator.aws/) for your
expected traffic. No cost figures from any specific deployment are included here.

## Security

- **No secrets in git.** All credentials, account IDs, and domains are provided at
  deploy time via environment variables. Never commit a real `.env`.
- **Rotate on exposure.** If a credential is ever committed, rotate it at the
  provider immediately — removing it from a later commit is not sufficient.
- See [`SECURITY.md`](SECURITY.md) for how to report a vulnerability.

## License & attribution

This project is licensed under the **GNU Affero General Public License v3.0
(AGPL-3.0)** — the same license as upstream ClassroomIO. See [`LICENSE`](LICENSE).

Because AGPL-3.0 is a network copyleft license, if you run a modified version of
this software to provide a service over a network, you must make the
corresponding source available to that service's users.

This is a derivative work. Attribution to the original project and a summary of
modifications are in [`NOTICE`](NOTICE). Original project:
[ClassroomIO](https://github.com/classroomio/classroomio).
