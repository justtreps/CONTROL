# myscore

Live quality scoring router for BulkMedya services. Decides which SMM service to use for each MyBoost order by measuring real delivery quality via RapidAPI Instagram/TikTok scrapers.

## Stack

- **Next.js 14** (App Router) — backend + dashboard
- **PostgreSQL** via Supabase + **Prisma** ORM
- **Redis** via Upstash (rate limiting + cron triggers)
- **Tailwind** for styling — [Unbounded](https://fonts.google.com/specimen/Unbounded) for brand, Inter for body
- **TypeScript strict**, deployed on **Vercel**

## Setup

1. `cp .env.example .env.local` and fill in values.
2. Create a Supabase project → copy pooled + direct connection URLs into `DATABASE_URL` / `DIRECT_URL`.
3. Create an Upstash Redis database → copy REST URL + token.
4. `npm install`
5. `npm run db:push` (applies Prisma schema to Supabase).
6. `npm run dev` → http://localhost:3000 — log in with `ADMIN_PASSWORD`.
7. Go to `/config`, paste BulkMedya + RapidAPI keys, click « Sync services ».

## Architecture

Four components (see `myscore-spec.md`):

1. **Test Bot** (Phase 2) — places small test orders on each active service daily.
2. **Quality Scraper** (Phase 2) — measures follower/view counts via RapidAPI at T+0 / 5min / 30min / 1h / 6h / 24h / 7d.
3. **Scoring Engine** (Phase 3) — computes `current_score = completion × (0.4 realism + 0.3 speed + 0.3 drop)`.
4. **Router API** (Phase 4) — `POST /api/order` picks the best service per category and places the order.

## Phase status

- [x] **Phase 1** — Next.js init, Prisma schema, BulkMedya client, auth, `/config` page.
- [ ] **Phase 2** — Ingestion pipeline (test bot + RapidAPI scrapers).
- [ ] **Phase 3** — Scoring engine + services dashboard.
- [ ] **Phase 4** — Router API with fallback logic.
- [ ] **Phase 5** — Dashboard polish (charts, alerts, logs).
