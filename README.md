# Segment-based train seat booking

A React, Node.js, and PostgreSQL reference implementation for reselling the same physical reserved seat across non-overlapping legs of one train run.

## Run with one command

Prerequisite: Docker Desktop or Docker Engine with Compose.

```bash
cp .env.example .env
# Change POSTGRES_PASSWORD in .env for any non-local environment.
docker compose up --build
```

Open `http://localhost:5173`. The API is at `http://localhost:4000`; `GET /health` reports readiness. PostgreSQL creates the schema and demonstration route only on the first start. To deliberately reset local demo data:

```bash
docker compose down -v
docker compose up --build
```

## Local development without containerized app services

Start PostgreSQL with `docker compose up db`, copy `.env.example` to `.env`, then:

```bash
npm install
npm run dev
```

With the database running, execute the real PostgreSQL concurrency tests:

```bash
DATABASE_URL=postgresql://railway:change-me@localhost:5432/railway npm test
```

## Correctness model

Stations have a zero-based position on an ordered route. A booking occupies a half-open PostgreSQL range `[origin_position, destination_position)`. Thus Colombo–Kandy `[0,4)` and Kandy–Badulla `[4,8)` are adjacent and may use the same seat.

PostgreSQL's GiST exclusion constraint is the final concurrency authority:

```sql
EXCLUDE USING gist (run_id WITH =, seat_id WITH =, segment WITH &&)
WHERE (status = 'confirmed')
```

Even if simultaneous clients both observe a seat as available, the database allows only one overlapping booking to commit. The API converts the losing constraint violation into `409 SEAT_CONFLICT`. Availability is advisory; booking insertion is authoritative.

## Fare design

Each coach has a configurable rate per kilometre in integer cents. Route-station rows contain the distance to the next station. The API recalculates and snapshots the fare inside the booking transaction, so a client cannot submit its own price and later price changes do not alter historical bookings.

For clarity, the seed rates are illustrative rather than official Sri Lanka Railways fares.

## API

- `GET /api/runs`
- `GET /api/runs/:runId/stations`
- `GET /api/availability?runId=&originId=&destinationId=`
- `POST /api/bookings`
- `GET /api/bookings/:reference`

Example booking body:

```json
{
  "runId": 1,
  "seatId": 1,
  "originId": 1,
  "destinationId": 5,
  "passengerName": "Nimali Perera",
  "passengerEmail": "nimali@example.com"
}
```

## Decisions and alternatives

- **PostgreSQL exclusion constraint:** directly encodes the invariant. A seat-row `SELECT FOR UPDATE` was considered, but it unnecessarily serializes non-overlapping bookings. An application-only availability check is unsafe.
- **Half-open ranges:** make adjacent journeys naturally non-overlapping and avoid station-boundary special cases.
- **Service runs:** bookings belong to a dated departure, not just a route, so the same seat identity can be reused on future runs.
- **Raw parameterized SQL:** keeps the core range and transactional behavior visible for this exercise. A larger system could wrap it with Drizzle while retaining the database constraint in a migration.
- **Separate React and API services:** enables independent scaling and keeps PostgreSQL credentials out of the browser.
- **Integer currency storage:** avoids floating-point rounding errors.

## Production extensions

Before launch, add authenticated administration, payment authorization/idempotency keys, PII encryption and retention rules, cancellation/refund policy, audit logs, rate limiting, observability, scheduled service creation, accessibility testing, and backups. A temporary inventory hold would be introduced during payment; expired holds should not block inventory.

