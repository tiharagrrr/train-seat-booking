import {
  OrganizationSwitcher,
  Show,
  SignInButton,
  UserButton,
  useAuth,
} from '@clerk/react';
import {
  AlertCircle,
  Armchair,
  ArrowRight,
  CheckCircle2,
  Clock,
  ShieldCheck,
  TrainFront,
} from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import { ApiError, request } from './api';
import { AdminPanel } from './Admin';

type Run = {
  id: number;
  serviceCode: string;
  departureAt: string;
  routeName: string;
};

type Station = {
  id: number;
  code: string;
  name: string;
  position: number;
};

type Seat = {
  id: number;
  seatNumber: string;
  rowNumber: number;
  columnNumber: number;
  coachCode: string;
  className: string;
  fareLkr: number;
  available: boolean;
};

const msg = (e: unknown) =>
  e instanceof ApiError ? e.message : 'Something went wrong. Please try again.';

function Header() {
  const { has } = useAuth();
  const staff =
    has?.({ permission: 'org:rail:view' }) ||
    has?.({ permission: 'org:rail:admin' });

  return (
    <header>
      <a className="brand" href="/">
        <TrainFront />
        <span>Udarata Rail</span>
      </a>
      <nav>
        <a href="/">Book</a>
        <Show when="signed-in">
          <a href="/account">My journeys</a>
          <OrganizationSwitcher hidePersonal={false} />
          {staff && <a href="/admin">Admin</a>}
          <UserButton />
        </Show>
        <Show when="signed-out">
          <SignInButton mode="modal">
            <button className="quiet">Sign in</button>
          </SignInButton>
        </Show>
      </nav>
    </header>
  );
}

function Notice({
  kind = 'error',
  children,
}: {
  kind?: 'error' | 'success' | 'info';
  children: React.ReactNode;
}) {
  return (
    <div role={kind === 'error' ? 'alert' : 'status'} className={`notice ${kind}`}>
      {kind === 'error' ? (
        <AlertCircle />
      ) : kind === 'success' ? (
        <CheckCircle2 />
      ) : (
        <Clock />
      )}
      <span>{children}</span>
    </div>
  );
}

function CoachSeatMap({
  coachCode,
  seats,
  selected,
  confirmation,
  submitting,
  onSelect,
}: {
  coachCode: string;
  seats: Seat[];
  selected?: Seat;
  confirmation: string;
  submitting: boolean;
  onSelect: (seat: Seat) => void;
}) {
  const coachSeats = seats.filter((seat) => seat.coachCode === coachCode);
  const columnCount = Math.max(...coachSeats.map((seat) => seat.columnNumber), 1);
  const leftColumns = Math.ceil(columnCount / 2);
  const rightColumns = columnCount - leftColumns;
  const hasAisle = rightColumns > 0;
  const gridTemplateColumns = [
    `repeat(${leftColumns}, minmax(42px, 54px))`,
    hasAisle ? '25px' : '',
    rightColumns ? `repeat(${rightColumns}, minmax(42px, 54px))` : '',
  ].filter(Boolean).join(' ');

  return (
    <div className="coach">
      <h3>
        Coach {coachCode} <small>{coachSeats[0]?.className}</small>
      </h3>
      <div className="seats" style={{ gridTemplateColumns }}>
        {coachSeats.map((seat) => (
          <React.Fragment key={seat.id}>
            {hasAisle && seat.columnNumber === leftColumns + 1 && (
              <span className="aisle" aria-hidden="true" />
            )}
            <button
              className={`seat ${!seat.available ? 'unavailable' : ''} ${
                selected?.id === seat.id && !confirmation ? 'selected' : ''
              }`}
              disabled={!seat.available || submitting}
              onClick={() => onSelect(seat)}
              aria-label={`Coach ${coachCode}, seat ${seat.seatNumber}, ${
                seat.available ? 'available' : 'taken'
              }`}
            >
              <Armchair />
              <span>{seat.seatNumber}</span>
            </button>
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

function Booking() {
  const { isSignedIn, getToken } = useAuth();
  const [runs, setRuns] = useState<Run[]>([]);
  const [runId, setRunId] = useState<number>();
  const [stations, setStations] = useState<Station[]>([]);
  const [originId, setOriginId] = useState<number>();
  const [destinationId, setDestinationId] = useState<number>();
  const [seats, setSeats] = useState<Seat[]>([]);
  const [selected, setSelected] = useState<Seat>();
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [waitlisted, setWaitlisted] = useState(false);

  useEffect(() => {
    request<Run[]>('/api/runs')
      .then((x) => {
        setRuns(x);
        setRunId(x[0]?.id);
        if (!x.length) setError('There are no open services available.');
      })
      .catch((e) => setError(msg(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!runId) return;
    setLoading(true);
    request<Station[]>(`/api/runs/${runId}/stations`)
      .then((x) => {
        setStations(x);
        setOriginId(x[0]?.id);
        setDestinationId(x.at(-1)?.id);
      })
      .catch((e) => setError(msg(e)))
      .finally(() => setLoading(false));
  }, [runId]);

  async function load() {
    if (!runId || !originId || !destinationId) return;
    setLoading(true);
    setError('');
    setConfirmation('');
    setSelected(undefined);
    try {
      setSeats(
        await request(
          `/api/availability?runId=${runId}&originId=${originId}&destinationId=${destinationId}`
        )
      );
    } catch (e) {
      setSeats([]);
      setError(msg(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (destinationId) void load();
  }, [originId, destinationId]);

  const coaches = useMemo(
    () => [...new Set(seats.map((s) => s.coachCode))],
    [seats]
  );
  
  const noSeats = seats.length > 0 && !seats.some((x) => x.available);

  async function book() {
    if (!selected || !isSignedIn) return;
    setSubmitting(true);
    setError('');
    try {
      const token = await getToken();
      const x = await request<{ reference: string }>(
        '/api/bookings',
        {
          method: 'POST',
          body: JSON.stringify({ runId, seatId: selected.id, originId, destinationId }),
        },
        token
      );
      setSeats((all) =>
        all.map((s) => (s.id === selected.id ? { ...s, available: false } : s))
      );
      setConfirmation(x.reference);
    } catch (e) {
      setError(msg(e));
      if (e instanceof ApiError && e.code === 'SEAT_CONFLICT') await load();
    } finally {
      setSubmitting(false);
    }
  }

  async function joinWaitlist() {
    if (!runId || !originId || !destinationId || !isSignedIn) return;
    setSubmitting(true);
    setError('');
    try {
      const token = await getToken();
      const className = seats[0]?.className ?? 'Second Class';
      await request(
        '/api/waitlist',
        {
          method: 'POST',
          body: JSON.stringify({ runId, originId, destinationId, className }),
        },
        token
      );
      setWaitlisted(true);
    } catch (e) {
      setError(msg(e));
    } finally {
      setSubmitting(false);
    }
  }

  const origin = stations.find((x) => x.id === originId);
  const dest = stations.find((x) => x.id === destinationId);

  return (
    <>
      <section className="hero">
        <p className="eyebrow">COLOMBO FORT — BADULLA</p>
        <h1>
          Your seat. Only for the
          <br />
          distance you need.
        </h1>
        <p>
          Reserve a comfortable seat across the hill country. Fair fares, flexible segments, one unforgettable journey.
        </p>
      </section>

      <section className="search card">
        <label>
          Service
          <select
            value={runId ?? ''}
            onChange={(e) => setRunId(Number(e.target.value))}
          >
            {runs.map((r) => (
              <option key={r.id} value={r.id}>
                {r.serviceCode} · {new Date(r.departureAt).toLocaleString()}
              </option>
            ))}
          </select>
        </label>
        <label>
          From
          <select
            value={originId ?? ''}
            onChange={(e) => setOriginId(Number(e.target.value))}
          >
            {stations.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <ArrowRight className="arrow" />
        <label>
          To
          <select
            value={destinationId ?? ''}
            onChange={(e) => setDestinationId(Number(e.target.value))}
          >
            {stations.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <button onClick={load} disabled={loading}>
          {loading ? 'Checking…' : 'Find seats'}
        </button>
      </section>

      {error && <Notice>{error}</Notice>}
      
      {loading && !seats.length && (
        <div className="loading card" aria-live="polite">
          Loading journey availability…
        </div>
      )}

      {seats.length > 0 && (
        <section className="booking">
          <div className="map card">
            <div className="section-title">
              <div>
                <p className="eyebrow">SELECT A SEAT</p>
                <h2>
                  {origin?.name} <span>to</span> {dest?.name}
                </h2>
              </div>
              <div className="legend">
                <i /> Available <i className="taken" /> Taken
              </div>
            </div>
            {coaches.map((coach) => (
              <CoachSeatMap
                key={coach}
                coachCode={coach}
                seats={seats}
                selected={selected}
                confirmation={confirmation}
                submitting={submitting}
                onSelect={setSelected}
              />
            ))}
          </div>

          <aside className="summary card">
            <p className="eyebrow">YOUR JOURNEY</p>
            <h2>
              {origin?.code} <ArrowRight /> {dest?.code}
            </h2>

            {selected && (
              <>
                <div className="choice">
                  <span>
                    Coach <b>{selected.coachCode}</b>
                  </span>
                  <span>
                    Seat <b>{selected.seatNumber}</b>
                  </span>
                </div>
                <div className="fare">
                  <span>Total fare</span>
                  <strong>LKR {selected.fareLkr.toLocaleString()}</strong>
                  <small>Rounded to the nearest rupee</small>
                </div>
                {!confirmation &&
                  (isSignedIn ? (
                    <button className="wide" onClick={book} disabled={submitting}>
                      {submitting ? 'Securing seat…' : 'Confirm booking'}
                    </button>
                  ) : (
                    <SignInButton mode="modal">
                      <button className="wide">Sign in to book</button>
                    </SignInButton>
                  ))}
              </>
            )}

            {!selected && !noSeats && (
              <p className="empty">Choose an available seat to continue.</p>
            )}

            {noSeats &&
              !waitlisted &&
              (isSignedIn ? (
                <button
                  className="wide"
                  onClick={joinWaitlist}
                  disabled={submitting}
                >
                  {submitting ? 'Joining…' : 'Join the waitlist'}
                </button>
              ) : (
                <SignInButton mode="modal">
                  <button className="wide">Sign in to join waitlist</button>
                </SignInButton>
              ))}

            {confirmation && (
              <Notice kind="success">
                Booking confirmed. Your reference is <b>{confirmation}</b>. Your
                ticket email is queued.
              </Notice>
            )}

            {waitlisted && (
              <Notice kind="success">
                You joined the waitlist. We will email you if a seat becomes
                available.
              </Notice>
            )}
          </aside>
        </section>
      )}
    </>
  );
}

type MyBooking = {
  reference: string;
  status: string;
  fareLkr: number;
  origin: string;
  destination: string;
  coachCode: string;
  seatNumber: string;
  departureAt: string;
};

type Wait = {
  id: string;
  status: string;
  className: string;
  origin: string;
  destination: string;
  offerExpiresAt?: string;
  reference?: string;
};

function Account() {
  const { getToken } = useAuth();
  const [bookings, setBookings] = useState<MyBooking[]>([]);
  const [waitlist, setWaitlist] = useState<Wait[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  async function refresh() {
    setLoading(true);
    try {
      const t = await getToken();
      const [b, w] = await Promise.all([
        request<MyBooking[]>('/api/me/bookings', {}, t),
        request<Wait[]>('/api/me/waitlist', {}, t),
      ]);
      setBookings(b);
      setWaitlist(w);
    } catch (e) {
      setError(msg(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function action(path: string, successMessage: string) {
    setError('');
    try {
      const t = await getToken();
      await request(path, { method: 'POST' }, t);
      setSuccess(successMessage);
      await refresh();
    } catch (e) {
      setError(msg(e));
    }
  }

  return (
    <section className="page">
      <p className="eyebrow">MY ACCOUNT</p>
      <h1>Journeys and waitlist</h1>
      {error && <Notice>{error}</Notice>}
      {success && <Notice kind="success">{success}</Notice>}
      {loading ? (
        <div className="loading card">Loading your journeys…</div>
      ) : (
        <div className="account-grid">
          <div>
            <h2>Bookings</h2>
            {!bookings.length && (
              <div className="card empty-panel">You have no bookings yet.</div>
            )}
            {bookings.map((b) => (
              <article className="card row-card" key={b.reference}>
                <div>
                  <b>
                    {b.origin} → {b.destination}
                  </b>
                  <small>
                    {new Date(b.departureAt).toLocaleString()} · Coach {b.coachCode},
                    seat {b.seatNumber}
                  </small>
                </div>
                <div>
                  <strong>LKR {b.fareLkr}</strong>
                  <span className={`pill ${b.status}`}>{b.status}</span>
                  {b.status === 'confirmed' &&
                    new Date(b.departureAt) > new Date() && (
                      <button
                        className="danger"
                        onClick={() =>
                          action(
                            `/api/me/bookings/${b.reference}/cancel`,
                            'Booking cancelled successfully.'
                          )
                        }
                      >
                        Cancel
                      </button>
                    )}
                </div>
              </article>
            ))}
          </div>
          <div>
            <h2>Waitlist</h2>
            {!waitlist.length && (
              <div className="card empty-panel">You are not on a waitlist.</div>
            )}
            {waitlist.map((w) => (
              <article className="card row-card" key={w.id}>
                <div>
                  <b>
                    {w.origin} → {w.destination}
                  </b>
                  <small>
                    {w.className}
                    {w.offerExpiresAt &&
                      ` · Offer expires ${new Date(w.offerExpiresAt).toLocaleString()}`}
                  </small>
                </div>
                <span className={`pill ${w.status}`}>{w.status}</span>
                {w.status === 'offered' && (
                  <button
                    onClick={() =>
                      action(
                        `/api/me/waitlist/${w.id}/accept`,
                        'Your seat is confirmed.'
                      )
                    }
                  >
                    Accept offer
                  </button>
                )}
              </article>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

type Template = { id: number; name: string; active: boolean; coaches: any[] };

function VerifyTicket({ token }: { token: string }) {
  const { getToken } = useAuth();
  const [data, setData] = useState<any>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getToken()
      .then((t: string | null) => request(`/api/tickets/verify/${token}`, {}, t))
      .then(setData)
      .catch((e: unknown) => setError(msg(e)))
      .finally(() => setLoading(false));
  }, [token]);

  if (loading)
    return (
      <section className="page">
        <div className="loading card">Verifying ticket…</div>
      </section>
    );

  return (
    <section className="page">
      <p className="eyebrow">STAFF TICKET CHECK</p>
      <h1>Ticket verification</h1>
      {error ? (
        <Notice>{error}</Notice>
      ) : (
        <div className="card admin-panel">
          <Notice kind={data.status === 'confirmed' ? 'success' : 'error'}>
            {data.status === 'confirmed'
              ? 'Valid confirmed ticket'
              : `Ticket status: ${data.status}`}
          </Notice>
          <h2>
            {data.origin} → {data.destination}
          </h2>
          <p>
            <b>{data.passengerName}</b>
          </p>
          <p>
            Service {data.serviceCode} · Coach {data.coachCode} · Seat{' '}
            {data.seatNumber}
          </p>
          <p>{new Date(data.departureAt).toLocaleString()}</p>
          <p>Reference {data.reference}</p>
        </div>
      )}
    </section>
  );
}

function Admin() {
  const { getToken, has } = useAuth();
  const canEdit = !!has?.({ permission: 'org:rail:admin' });
  const [summary, setSummary] = useState<any>();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [settings, setSettings] = useState<any>();
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(true);

  async function call<T>(path: string, options: RequestInit = {}) {
    return request<T>(path, options, await getToken());
  }

  async function refresh() {
    setLoading(true);
    try {
      const [s, t, set] = await Promise.all([
        call('/api/admin/summary'),
        call<Template[]>('/api/admin/templates'),
        call('/api/admin/settings'),
      ]);
      setSummary(s);
      setTemplates(t);
      setSettings(set);
    } catch (e) {
      setError(msg(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function submit(
    e: React.FormEvent<HTMLFormElement>,
    path: string,
    message: string
  ) {
    e.preventDefault();
    setError('');
    const data = Object.fromEntries(new FormData(e.currentTarget));
    try {
      await call(path, {
        method: path === '/api/admin/settings' ? 'PATCH' : 'POST',
        body: JSON.stringify(
          path === '/api/admin/settings'
            ? { waitlistOfferMinutes: Number(data.waitlistOfferMinutes) }
            : { name: data.name }
        ),
      });
      setSuccess(message);
      await refresh();
      e.currentTarget.reset();
    } catch (e) {
      setError(msg(e));
    }
  }

  if (loading)
    return (
      <section className="page">
        <div className="loading card">Loading administration…</div>
      </section>
    );

  return (
    <section className="page admin">
      <p className="eyebrow">RAILWAY OPERATIONS</p>
      <h1>Administration</h1>
      <p className="role-note">
        <ShieldCheck />
        Your role is <b>{canEdit ? 'Admin' : 'Viewer'}</b>.{' '}
        {canEdit
          ? 'You can view and change operational configuration.'
          : 'You have read-only access.'}
      </p>

      {error && <Notice>{error}</Notice>}
      {success && <Notice kind="success">{success}</Notice>}

      <div className="metrics">
        <div className="card">
          <b>{summary?.runsToday}</b>
          <span>Runs today</span>
        </div>
        <div className="card">
          <b>{summary?.bookings}</b>
          <span>Confirmed bookings</span>
        </div>
        <div className="card">
          <b>LKR {summary?.revenueLkr?.toLocaleString()}</b>
          <span>Revenue</span>
        </div>
        <div className="card">
          <b>{summary?.waitlisted}</b>
          <span>Waiting/offered</span>
        </div>
      </div>

      <div className="admin-grid">
        <div className="card admin-panel">
          <h2>Train templates</h2>
          {templates.map((t) => (
            <div className="template" key={t.id}>
              <b>{t.name}</b>
              <small>{t.coaches.length} coaches</small>
              {t.coaches.map((c) => (
                <span key={c.id}>
                  {c.coachCode} · {c.className} · LKR {c.ratePerKmLkr}/km
                </span>
              ))}
            </div>
          ))}
          {canEdit && (
            <form
              onSubmit={(e) =>
                submit(e, '/api/admin/templates', 'Train template created.')
              }
            >
              <label>
                New template name
                <input name="name" required minLength={2} />
              </label>
              <button>Create template</button>
            </form>
          )}
        </div>
        <div className="card admin-panel">
          <h2>Waitlist policy</h2>
          <p>
            Passengers currently have <b>{settings?.waitlistOfferMinutes} minutes</b>{' '}
            to accept an offered seat.
          </p>
          {canEdit && (
            <form
              onSubmit={(e) =>
                submit(e, '/api/admin/settings', 'Waitlist offer time updated.')
              }
            >
              <label>
                Offer expiry (minutes)
                <input
                  name="waitlistOfferMinutes"
                  type="number"
                  min="5"
                  max="1440"
                  defaultValue={settings?.waitlistOfferMinutes}
                />
              </label>
              <button>Save policy</button>
            </form>
          )}
        </div>
      </div>

      <div className="card admin-panel">
        <h2>Coach, seat, and timetable configuration</h2>
        <p>
          The API supports coach creation, generated seat layouts, schedules, and
          dated run generation. The next UI expansion can expose these advanced
          editors; current templates and policy are fully visible here.
        </p>
      </div>
    </section>
  );
}

export function App() {
  const path = location.pathname;
  const verifyToken = path.startsWith('/verify/') ? path.split('/').pop() : undefined;

  return (
    <main>
      <Header />
      <Show when="signed-in">
        {verifyToken ? (
          <VerifyTicket token={verifyToken!} />
        ) : path === '/account' ? (
          <Account />
        ) : path === '/admin' ? (
          <AdminPanel />
        ) : (
          <Booking />
        )}
      </Show>
      <Show when="signed-out">
        {path === '/' ? (
          <Booking />
        ) : (
          <section className="page auth-card card">
            <h1>Sign in required</h1>
            <p>
              Sign in to view bookings, manage waitlists, or access administration.
            </p>
            <SignInButton mode="modal">
              <button>Sign in</button>
            </SignInButton>
          </section>
        )}
      </Show>
    </main>
  );
}
