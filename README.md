# Udarata Rail — segment-based seat booking

Production-minded React, Express, and PostgreSQL implementation for independently selling non-overlapping legs of one physical train seat. It includes Clerk authentication, admin train/timetable configuration, cancellations, a fair waitlist with expiring offers, ticket email/QR delivery, whole-rupee LKR fares, and database-enforced concurrency safety.

## What you must configure

### 1. Clerk

1. Create an application at https://dashboard.clerk.com.
2. Enable email sign-in. Passengers use personal accounts.
3. Enable Organizations and disable public organization creation.
4. Create an organization named `Sri Lanka Railways`.
5. Create feature `rail` and two custom permissions:
   - `org:rail:admin`
   - `org:rail:view`
6. Keep two organization roles:
   - **Admin:** assign both permissions. Admins can view data and change templates, coaches, seats, timetables, dates, fares, waitlist policy, and bookings.
   - **Viewer:** assign only `org:rail:view`. Viewers can inspect dashboards, configuration, and verify QR tickets, but cannot change data.
7. Invite staff into the organization and assign one of those roles. Passengers must not be organization members.
8. Copy the React publishable key and backend secret key into `.env`.

The API checks permissions server-side. Hiding an admin button in React is not treated as security.

### 2. Resend

1. Create an account at https://resend.com.
2. Verify a sending domain.
3. Create an API key.
4. Set `RESEND_API_KEY` and an `EMAIL_FROM` address on the verified domain.

Without a Resend key, local development still works: the worker logs email events and marks them delivered through the development console transport.

### 3. Environment

```bash
cp .env.example .env
```

Replace at minimum:

```env
POSTGRES_PASSWORD=a-long-local-password
VITE_CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...
CLERK_AUTHORIZED_PARTIES=http://localhost:5173
RESEND_API_KEY=re_...
EMAIL_FROM=Udarata Rail <tickets@your-domain.lk>
PUBLIC_APP_URL=http://localhost:5173
```

Never commit `.env`. The Vite publishable key is intentionally public; the Clerk secret and Resend key must only be supplied to the API/worker.

## One-command startup

Prerequisite: Docker Desktop or Docker Engine with Compose.

This release replaces the original schema. If you ran an earlier version, recreate the local database once:

```bash
docker compose down -v
docker compose up --build
```

Open http://localhost:5173. The API health endpoint is http://localhost:4000/health.

Future code-only updates normally need:

```bash
docker compose up --build
```

Do not use `-v` again unless you deliberately want to erase all local bookings and configuration.

## Faster development

```bash
docker compose up db
npm install
npm run dev
```

This runs PostgreSQL in Docker and starts the API, worker, and Vite hot reload locally. The root `.env` is used by both workspaces.

## Passenger behavior

- Availability is public.
- Clerk sign-in is required to book, waitlist, view, cancel, or accept an offer.
- Bookings belong to the verified Clerk user ID; the frontend cannot choose the owner ID.
- Cancellation requires account ownership or an authorized future admin-management endpoint.
- NIC is not collected.
- The QR contains only a random verification token. Viewing it does not authorize cancellation.
- Staff with Viewer or Admin permission can scan and verify ticket status.

## Segment concurrency model

Stations have ordered positions. A booking occupies a half-open PostgreSQL range, such as Colombo–Kandy `[0,4)`. Kandy–Badulla `[4,8)` is adjacent and may use the same seat.

Confirmed bookings and active waitlist holds share the same table and exclusion constraint:

```sql
EXCLUDE USING gist (
  run_id WITH =,
  seat_id WITH =,
  segment WITH &&
)
WHERE (status IN ('held', 'confirmed'))
```

The availability response is advisory. The database is the final authority when simultaneous clients attempt to allocate overlapping legs.

## Whole-rupee fares

Coach templates store a potentially decimal LKR rate per kilometre. The API totals the selected route distances, multiplies by that rate, rounds once, and stores `fare_lkr` as an integer snapshot. The browser cannot submit its own fare.

## Train configuration

- Train templates describe reusable formations.
- Coach templates belong to a train template and define code, class, reservation type, position, and rate.
- Seat templates define seat number and map position.
- Schedules combine route, train template, service code, time, weekdays, and effective dates.
- Generating dated runs copies coach/seat snapshots into each departure so later template changes cannot damage existing bookings.

## Waitlist

Waitlists are ordered by join time and ID. They target a run, segment, and class rather than one seat. When inventory is released, the worker offers the earliest compatible passenger an actual seat hold. Holds participate in the same exclusion constraint as bookings.

The default offer window is 60 minutes. An Admin can change it from 5 minutes through 24 hours; new offers read the current database setting. Expired offers release inventory and allow the worker to promote the next person. Entries are marked expired after departure rather than immediately deleted, preserving an audit trail.

## Reliable email delivery

Booking, cancellation, waitlist, and offer events are inserted into `email_outbox` in the same transaction as the business event. The worker sends them afterward and retries failures. Therefore, an email outage cannot roll back a valid booking. Resend idempotency keys reduce duplicate delivery during retries.

## Useful routes

- `/` — public availability and authenticated booking
- `/account` — owned bookings, cancellation, waitlist, offers
- `/admin` — role-protected operations
- `/verify/:opaque-token` — staff ticket verification

## Tests

With PostgreSQL initialized:

```bash
DATABASE_URL=postgresql://railway:your-password@localhost:5432/railway npm test
```

The integration test proves that only one simultaneous overlapping allocation commits and that adjacent legs can share the same seat.

## Production follow-ups

Add payment authorization and refunds, request idempotency keys for booking submission, Clerk webhook synchronization, PII retention policy, operational alerts, database backups, formal accessibility testing, official fare tables, and deployment-specific scheduled worker supervision before a real launch.
