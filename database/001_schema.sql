CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE routes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL UNIQUE,
  currency char(3) NOT NULL DEFAULT 'LKR'
);
CREATE TABLE stations (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, code text NOT NULL UNIQUE, name text NOT NULL);
CREATE TABLE route_stations (
  route_id bigint NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  station_id bigint NOT NULL REFERENCES stations(id),
  position integer NOT NULL CHECK(position>=0),
  distance_to_next_km numeric(8,2) NOT NULL CHECK(distance_to_next_km>=0),
  PRIMARY KEY(route_id,station_id), UNIQUE(route_id,position)
);

CREATE TABLE train_templates (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL UNIQUE, active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE coach_templates (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  train_template_id bigint NOT NULL REFERENCES train_templates(id) ON DELETE CASCADE,
  coach_code text NOT NULL, class_name text NOT NULL, reserved boolean NOT NULL DEFAULT true,
  rate_per_km_lkr numeric(8,2) NOT NULL CHECK(rate_per_km_lkr>=0), display_order integer NOT NULL,
  UNIQUE(train_template_id,coach_code), UNIQUE(train_template_id,display_order)
);
CREATE TABLE seat_templates (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  coach_template_id bigint NOT NULL REFERENCES coach_templates(id) ON DELETE CASCADE,
  seat_number text NOT NULL, row_number integer NOT NULL CHECK(row_number>0),
  column_number integer NOT NULL CHECK(column_number>0), accessible boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true, UNIQUE(coach_template_id,seat_number), UNIQUE(coach_template_id,row_number,column_number)
);

CREATE TABLE service_schedules (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  route_id bigint NOT NULL REFERENCES routes(id), train_template_id bigint NOT NULL REFERENCES train_templates(id),
  service_code text NOT NULL, departure_time time NOT NULL, operating_days smallint[] NOT NULL DEFAULT ARRAY[1,2,3,4,5,6,7],
  active_from date NOT NULL, active_until date, active boolean NOT NULL DEFAULT true,
  UNIQUE(service_code,active_from)
);
CREATE TYPE run_status AS ENUM('draft','open','closed','departed','cancelled');
CREATE TABLE service_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  schedule_id bigint REFERENCES service_schedules(id), route_id bigint NOT NULL REFERENCES routes(id),
  service_code text NOT NULL, departure_at timestamptz NOT NULL, status run_status NOT NULL DEFAULT 'open',
  UNIQUE(service_code,departure_at)
);
CREATE TABLE coaches (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id bigint NOT NULL REFERENCES service_runs(id) ON DELETE CASCADE,
  source_template_id bigint REFERENCES coach_templates(id), coach_code text NOT NULL, class_name text NOT NULL,
  reserved boolean NOT NULL DEFAULT true, rate_per_km_lkr numeric(8,2) NOT NULL CHECK(rate_per_km_lkr>=0), display_order integer NOT NULL,
  UNIQUE(run_id,coach_code), UNIQUE(run_id,display_order)
);
CREATE TABLE seats (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  coach_id bigint NOT NULL REFERENCES coaches(id) ON DELETE CASCADE,
  source_template_id bigint REFERENCES seat_templates(id), seat_number text NOT NULL,
  row_number integer NOT NULL, column_number integer NOT NULL, accessible boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true, UNIQUE(coach_id,seat_number), UNIQUE(coach_id,row_number,column_number)
);

CREATE TYPE booking_status AS ENUM('held','confirmed','cancelled','expired');
CREATE TABLE bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), reference text NOT NULL UNIQUE,
  run_id bigint NOT NULL REFERENCES service_runs(id), seat_id bigint NOT NULL REFERENCES seats(id),
  origin_station_id bigint NOT NULL REFERENCES stations(id), destination_station_id bigint NOT NULL REFERENCES stations(id),
  segment int4range NOT NULL, clerk_user_id text NOT NULL, passenger_name text NOT NULL,
  passenger_email text NOT NULL, fare_lkr integer NOT NULL CHECK(fare_lkr>=0), currency char(3) NOT NULL DEFAULT 'LKR',
  qr_token uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE, status booking_status NOT NULL DEFAULT 'confirmed',
  waitlist_entry_id uuid, offer_expires_at timestamptz, cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), CHECK(NOT isempty(segment))
);
ALTER TABLE bookings ADD CONSTRAINT no_overlapping_active_allocations
  EXCLUDE USING gist(run_id WITH =,seat_id WITH =,segment WITH &&)
  WHERE(status IN('held','confirmed'));
CREATE INDEX booking_owner_idx ON bookings(clerk_user_id,created_at DESC);
CREATE INDEX booking_run_idx ON bookings(run_id);

CREATE TYPE waitlist_status AS ENUM('waiting','offered','converted','cancelled','expired');
CREATE TABLE waitlist_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id bigint NOT NULL REFERENCES service_runs(id),
  clerk_user_id text NOT NULL, passenger_name text NOT NULL, passenger_email text NOT NULL,
  origin_station_id bigint NOT NULL REFERENCES stations(id), destination_station_id bigint NOT NULL REFERENCES stations(id),
  segment int4range NOT NULL, class_name text NOT NULL, quoted_fare_lkr integer NOT NULL,
  status waitlist_status NOT NULL DEFAULT 'waiting', joined_at timestamptz NOT NULL DEFAULT now(),
  offered_at timestamptz, offer_expires_at timestamptz, converted_booking_id uuid REFERENCES bookings(id),
  UNIQUE(run_id,clerk_user_id,origin_station_id,destination_station_id,class_name)
);
ALTER TABLE bookings ADD CONSTRAINT booking_waitlist_fk FOREIGN KEY(waitlist_entry_id) REFERENCES waitlist_entries(id);
CREATE INDEX waitlist_queue_idx ON waitlist_entries(run_id,status,joined_at);

CREATE TABLE system_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  waitlist_offer_minutes integer NOT NULL DEFAULT 60 CHECK(waitlist_offer_minutes BETWEEN 5 AND 1440),
  waitlist_retention_days integer NOT NULL DEFAULT 90 CHECK(waitlist_retention_days BETWEEN 1 AND 3650),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by text
);
INSERT INTO system_settings(singleton) VALUES(true);

CREATE TYPE email_status AS ENUM('pending','sending','sent','failed');
CREATE TABLE email_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_type text NOT NULL, recipient text NOT NULL,
  payload jsonb NOT NULL, status email_status NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(), provider_message_id text, last_error text,
  created_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz
);
CREATE INDEX email_due_idx ON email_outbox(status,next_attempt_at);
CREATE TABLE audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, actor_clerk_user_id text NOT NULL,
  action text NOT NULL, entity_type text NOT NULL, entity_id text NOT NULL,
  before_data jsonb, after_data jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
