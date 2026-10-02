# Repository Guidelines

## Project Structure & Module Organization

MasterDNS is a pnpm monorepo for DNS management, health checks, DDNS, and failover.

- `apps/web/src/`: Next.js console, React components, and UI styles.
- `apps/api/src/`: NestJS/Fastify API; feature modules live under `modules/`.
- `apps/worker/src/`: BullMQ workers for synchronization, health checks, rotation, and notifications.
- `packages/`: shared contracts, automation logic, DNS/cloud providers, checkers, crypto, and database code. Drizzle migrations live in `packages/db/drizzle/`.
- `agent/`: Linux DDNS client; the external Probe Agent is maintained separately.
- `tests/`, `scripts/`, and `apps/api/test/`: integration and operational checks. Start with `docs/README.md` for architecture and deployment documentation.

## Build, Test, and Development Commands

Use Node.js 22+ and pnpm 11.9.0. Run commands from the repository root.

- `pnpm install`: install workspace dependencies.
- `pnpm dev`: build shared packages and start all development watchers. Use `pnpm dev:web`, `pnpm dev:api`, or `pnpm dev:worker` for individual applications.
- `pnpm build`: build shared packages, API, worker, and web console.
- `pnpm typecheck` / `pnpm lint`: check TypeScript and configured ESLint rules.
- `pnpm test`: run workspace test scripts.
- `pnpm db:generate` / `pnpm db:migrate`: generate and apply database migrations.
- `docker compose up --build`: start the full stack with PostgreSQL and Redis after configuring `.env` from `.env.example`.

## Coding Style & Naming Conventions

Follow existing TypeScript conventions: two-space indentation, double quotes, semicolons, and strict typing. Use PascalCase for classes/components, camelCase for functions/variables, and kebab-case filenames. Preserve NestJS suffixes such as `.service.ts`, `.controller.ts`, and `.module.ts`. Backend ESM relative imports use `.js` extensions. Share schemas through `@masterdns/contracts`. Web linting uses Next.js ESLint rules; no repository-wide formatter is configured.

## Testing Guidelines

Use Vitest with colocated `*.test.ts` or `*.test.tsx` files. Target one workspace with `pnpm --filter @masterdns/api test`. `pnpm test:coverage` enforces 90% branches, functions, lines, and statements for selected automation modules. Run `pnpm test:update` for updater changes and `pnpm test:probe-integration` for probe integration checks. Consult `docs/TEST_PLAN.md` before credential-dependent tests.

## Commit & Pull Request Guidelines

Follow history’s Conventional Commit style: `feat(web): …`, `fix(cloud): …`, or `docs: …`. Keep commits focused. PRs should explain behavior changes, link related issues, report validation commands/results, and include screenshots for UI changes. Describe migration or configuration impacts.

## Security & Configuration

Never commit credentials, `.env`, or secrets in snapshots. Supply cloud credentials through environment variables or the console. Back up `MASTER_ENCRYPTION_KEY` independently of the database. Preserve explicit authorization checks for cloud rotation and destructive lifecycle actions.
