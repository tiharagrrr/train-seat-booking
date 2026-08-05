import { useAuth } from '@clerk/react';
import { AlertCircle, CheckCircle2, ShieldCheck } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { ApiError, request } from './api';

type Coach = {
  id: number;
  coachCode: string;
  className: string;
  reserved: boolean;
  ratePerKmLkr: string;
};

type Template = {
  id: number;
  name: string;
  coaches: Coach[];
};

type Route = {
  id: number;
  name: string;
};

type Schedule = {
  id: number;
  serviceCode: string;
  departureTime: string;
  operatingDays: number[];
  activeFrom: string;
  routeName: string;
  templateName: string;
};

const message = (e: unknown) =>
  e instanceof ApiError ? e.message : 'Something went wrong. Please try again.';

export function AdminPanel() {
  const { getToken, has } = useAuth();
  const canEdit = !!has?.({ permission: 'org:rail:admin' });
  
  const [summary, setSummary] = useState<any>();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
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
      const [s, t, r, sc, set] = await Promise.all([
        call('/api/admin/summary'),
        call<Template[]>('/api/admin/templates'),
        call<Route[]>('/api/admin/routes'),
        call<Schedule[]>('/api/admin/schedules'),
        call('/api/admin/settings'),
      ]);
      setSummary(s);
      setTemplates(t);
      setRoutes(r);
      setSchedules(sc);
      setSettings(set);
      setError('');
    } catch (e) {
      setError(message(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function perform(
    work: () => Promise<unknown>,
    ok: string,
    form?: HTMLFormElement
  ) {
    setError('');
    setSuccess('');
    try {
      await work();
      setSuccess(ok);
      form?.reset();
      await refresh();
    } catch (e) {
      setError(message(e));
    }
  }

  async function createTemplate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = e.currentTarget;
    const d = new FormData(f);
    
    await perform(
      () =>
        call('/api/admin/templates', {
          method: 'POST',
          body: JSON.stringify({ name: d.get('name') }),
        }),
      'Train template created.',
      f
    );
  }

  async function createCoach(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = e.currentTarget;
    const d = new FormData(f);
    const reserved = d.get('reserved') === 'on';
    
    await perform(async () => {
      const c = await call<{ id: number }>(
        `/api/admin/templates/${d.get('templateId')}/coaches`,
        {
          method: 'POST',
          body: JSON.stringify({
            coachCode: d.get('coachCode'),
            className: d.get('className'),
            reserved,
            ratePerKmLkr: Number(d.get('rate')),
            displayOrder: Number(d.get('order')),
          }),
        }
      );
      
      if (reserved) {
        await call(`/api/admin/coaches/${c.id}/seats/generate`, {
          method: 'POST',
          body: JSON.stringify({
            rows: Number(d.get('rows')),
            columns: Number(d.get('columns')),
            startAt: 1,
          }),
        });
      }
    }, 'Coach and seat layout created.', f);
  }

  async function createSchedule(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = e.currentTarget;
    const d = new FormData(f);
    
    await perform(
      () =>
        call('/api/admin/schedules', {
          method: 'POST',
          body: JSON.stringify({
            routeId: Number(d.get('routeId')),
            trainTemplateId: Number(d.get('templateId')),
            serviceCode: d.get('serviceCode'),
            departureTime: d.get('departureTime'),
            operatingDays: String(d.get('days')).split(',').map(Number),
            activeFrom: d.get('activeFrom'),
            activeUntil: d.get('activeUntil') || null,
          }),
        }),
      'Schedule created.',
      f
    );
  }

  async function generateRuns(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    
    await perform(
      () =>
        call(`/api/admin/schedules/${d.get('scheduleId')}/generate-runs`, {
          method: 'POST',
          body: JSON.stringify({ from: d.get('from'), to: d.get('to') }),
        }),
      'Dated service runs generated.'
    );
  }

  async function savePolicy(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    
    await perform(
      () =>
        call('/api/admin/settings', {
          method: 'PATCH',
          body: JSON.stringify({
            waitlistOfferMinutes: Number(d.get('minutes')),
          }),
        }),
      'Waitlist policy updated.'
    );
  }

  if (loading) {
    return (
      <section className="page">
        <div className="loading card">Loading administration…</div>
      </section>
    );
  }

  return (
    <section className="page admin">
      <p className="eyebrow">RAILWAY OPERATIONS</p>
      <h1>Administration</h1>
      
      <p className="role-note">
        <ShieldCheck />
        Your role is <b>{canEdit ? 'Admin' : 'Viewer'}</b>.{' '}
        {canEdit
          ? 'You can view and change configuration.'
          : 'You have read-only access.'}
      </p>

      {error && (
        <div className="notice error">
          <AlertCircle />
          {error}
        </div>
      )}
      
      {success && (
        <div className="notice success">
          <CheckCircle2 />
          {success}
        </div>
      )}

      <div className="metrics">
        <div className="card">
          <b>{summary?.runsToday}</b>
          <span>Runs today</span>
        </div>
        <div className="card">
          <b>{summary?.bookings}</b>
          <span>Bookings</span>
        </div>
        <div className="card">
          <b>LKR {summary?.revenueLkr?.toLocaleString()}</b>
          <span>Revenue</span>
        </div>
        <div className="card">
          <b>{summary?.waitlisted}</b>
          <span>Waitlisted</span>
        </div>
      </div>

      <div className="admin-grid">
        <div className="card admin-panel">
          <h2>Train formations</h2>
          {templates.map((t) => (
            <div className="template" key={t.id}>
              <b>{t.name}</b>
              <small>{t.coaches.length} coaches</small>
              {t.coaches.map((c) => (
                <span key={c.id}>
                  {c.coachCode} · {c.className} · {c.reserved ? 'reserved' : 'unreserved'} · LKR {c.ratePerKmLkr}/km
                </span>
              ))}
            </div>
          ))}
          {canEdit && (
            <form onSubmit={createTemplate}>
              <label>
                New template name
                <input name="name" required />
              </label>
              <button>Create train template</button>
            </form>
          )}
        </div>
        
        <div className="card admin-panel">
          <h2>Waitlist policy</h2>
          <p>
            Passengers have <b>{settings?.waitlistOfferMinutes} minutes</b> to accept.
          </p>
          {canEdit && (
            <form onSubmit={savePolicy}>
              <label>
                Offer expiry (minutes)
                <input
                  name="minutes"
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

      {canEdit && (
        <div className="admin-grid">
          <div className="card admin-panel">
            <h2>Add coach and seats</h2>
            <form onSubmit={createCoach}>
              <label>
                Train template
                <select name="templateId">
                  {templates.map((t) => (
                    <option value={t.id} key={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Coach code
                <input name="coachCode" placeholder="R4" required />
              </label>
              <label>
                Class
                <input name="className" placeholder="Second Class" required />
              </label>
              <label>
                <input name="reserved" type="checkbox" defaultChecked /> Reserved
                with assigned seats
              </label>
              <label>
                Rate/km (LKR)
                <input name="rate" type="number" step="0.01" min="0" required />
              </label>
              <label>
                Train position
                <input name="order" type="number" min="1" required />
              </label>
              <div className="form-pair">
                <label>
                  Rows
                  <input name="rows" type="number" min="1" max="50" defaultValue="6" />
                </label>
                <label>
                  Columns
                  <input name="columns" type="number" min="1" max="8" defaultValue="4" />
                </label>
              </div>
              <button>Create coach</button>
            </form>
          </div>
          
          <div className="card admin-panel">
            <h2>Create timetable</h2>
            <form onSubmit={createSchedule}>
              <label>
                Route
                <select name="routeId">
                  {routes.map((r) => (
                    <option value={r.id} key={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Train template
                <select name="templateId">
                  {templates.map((t) => (
                    <option value={t.id} key={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Service code
                <input name="serviceCode" required />
              </label>
              <label>
                Departure time
                <input name="departureTime" type="time" required />
              </label>
              <label>
                Days (1=Mon … 7=Sun)
                <input name="days" defaultValue="1,2,3,4,5,6,7" required />
              </label>
              <div className="form-pair">
                <label>
                  Active from
                  <input name="activeFrom" type="date" required />
                </label>
                <label>
                  Active until
                  <input name="activeUntil" type="date" />
                </label>
              </div>
              <button>Create schedule</button>
            </form>
          </div>
        </div>
      )}

      <div className="card admin-panel">
        <h2>Schedules and dated runs</h2>
        {schedules.map((s) => (
          <div className="template" key={s.id}>
            <b>
              {s.serviceCode} · {s.departureTime}
            </b>
            <span>
              {s.routeName} · {s.templateName}
            </span>
            <small>
              Days {s.operatingDays.join(', ')} · from{' '}
              {new Date(s.activeFrom).toLocaleDateString()}
            </small>
          </div>
        ))}
        
        {canEdit && (
          <form onSubmit={generateRuns}>
            <label>
              Schedule
              <select name="scheduleId">
                {schedules.map((s) => (
                  <option value={s.id} key={s.id}>
                    {s.serviceCode} · {s.departureTime}
                  </option>
                ))}
              </select>
            </label>
            <div className="form-pair">
              <label>
                From
                <input name="from" type="date" required />
              </label>
              <label>
                Through
                <input name="to" type="date" required />
              </label>
            </div>
            <button>Generate service runs</button>
          </form>
        )}
      </div>
    </section>
  );
}