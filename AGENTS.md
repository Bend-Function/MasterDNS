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

## Documentation Requirements

Every subsequent change must include corresponding documentation updates in the same change set. This applies to features, bug fixes, refactors, APIs, data models, dependencies, configuration, deployment scripts, and tests. Documentation is part of the implementation; do not defer it to a later task or declare the work complete before it is synchronized.

- Update `README.md` and `docs/README.md` when capabilities, project status, navigation, or documented dates and code baselines change. Only state a baseline that was actually checked.
- Update `docs/ARCHITECTURE.md` for module boundaries, interfaces, data flows, scheduling, concurrency, and recovery changes; update `docs/DATA_MODEL.md` for schema, state, and persistence changes.
- Update `docs/DEPLOYMENT.md` for environment variables, installation, upgrades, rollback, backups, and operational procedures; update the relevant `docs/providers/` guide for provider capabilities and restrictions.
- Update `docs/TEST_PLAN.md` when validation commands or acceptance requirements change. Record meaningful implementation and validation details in `docs/validation/`, including internal refactors or test changes with no user-visible behavior change.
- A design or validation record does not replace updating the affected user or architecture documentation. Preserve historical validation scope; do not present earlier test results as checks of newer code.

Before committing, pushing, or handing off a change, check the documentation against the final implementation, remove obsolete claims, and verify changed links. Include the affected documentation and validation scope in the commit or PR description. This requirement also applies to changes made by agents and delegated contributors.

## Security & Configuration

Never commit credentials, `.env`, or secrets in snapshots. Supply cloud credentials through environment variables or the console. Back up `MASTER_ENCRYPTION_KEY` independently of the database. Preserve explicit authorization checks for cloud rotation and destructive lifecycle actions.
