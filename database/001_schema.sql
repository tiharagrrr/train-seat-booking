CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE routes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL UNIQUE,
  currency char(3) NOT NULL DEFAULT 'LKR'
);

CREATE TABLE stations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL
);

CREATE TABLE route_stations (
  route_id bigint NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  station_id bigint NOT NULL REFERENCES stations(id),
  position integer NOT NULL CHECK (position >= 0),
  distance_km numeric(8,2) NOT NULL CHECK (distance_km >= 0),
  PRIMARY KEY (route_id, station_id),
  UNIQUE (route_id, position)
);

CREATE TABLE service_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  route_id bigint NOT NULL REFERENCES routes(id),
  service_code text NOT NULL,
  departure_at timestamptz NOT NULL,
  UNIQUE (service_code, departure_at)
);

CREATE TABLE coaches (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id bigint NOT NULL REFERENCES service_runs(id) ON DELETE CASCADE,
  coach_code text NOT NULL,
  class_name text NOT NULL,
  reserved boolean NOT NULL DEFAULT true,
  rate_per_km_cents integer NOT NULL CHECK (rate_per_km_cents >= 0),
  UNIQUE (run_id, coach_code)
);

CREATE TABLE seats (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  coach_id bigint NOT NULL REFERENCES coaches(id) ON DELETE CASCADE,
  seat_number text NOT NULL,
  row_number integer NOT NULL,
  column_number integer NOT NULL,
  UNIQUE (coach_id, seat_number)
);

CREATE TYPE booking_status AS ENUM ('confirmed', 'cancelled');

CREATE TABLE bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference text NOT NULL UNIQUE,
  run_id bigint NOT NULL REFERENCES service_runs(id),
  seat_id bigint NOT NULL REFERENCES seats(id),
  origin_station_id bigint NOT NULL REFERENCES stations(id),
  destination_station_id bigint NOT NULL REFERENCES stations(id),
  segment int4range NOT NULL,
  passenger_name text NOT NULL,
  passenger_email text NOT NULL,
  fare_cents integer NOT NULL CHECK (fare_cents >= 0),
  currency char(3) NOT NULL,
  status booking_status NOT NULL DEFAULT 'confirmed',
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT isempty(segment))
);

ALTER TABLE bookings ADD CONSTRAINT no_overlapping_confirmed_bookings
  EXCLUDE USING gist (run_id WITH =, seat_id WITH =, segment WITH &&)
  WHERE (status = 'confirmed');

CREATE INDEX booking_run_idx ON bookings(run_id);
CREATE INDEX booking_email_idx ON bookings(passenger_email);
