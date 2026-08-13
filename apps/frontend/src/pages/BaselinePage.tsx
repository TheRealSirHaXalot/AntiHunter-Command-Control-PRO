import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { MdFingerprint } from 'react-icons/md';

import { apiClient } from '../api/client';
import {
  BaselineConfig,
  BaselineConfigInput,
  ClassificationSummary,
  DeviceCategory,
  PresenceDevice,
} from '../api/device-classification';
import type { CommandRequest, CommandResponse, SiteSummary } from '../api/types';
import { useAuthStore } from '../stores/auth-store';
import { useBaselineStore } from '../stores/baseline-store';
import { useNodeStore } from '../stores/node-store';

const CATEGORY_META: Record<DeviceCategory, { label: string; color: string; blurb: string }> = {
  stationary: { label: 'Stationary', color: '#22c55e', blurb: 'here almost all the time' },
  'frequent-flier': { label: 'Frequent Flier', color: '#a855f7', blurb: 'comes and goes often' },
  visitor: { label: 'Visitor', color: '#f97316', blurb: 'showed up after baseline, then left' },
  new: { label: 'New', color: '#38bdf8', blurb: 'showed up after baseline, still here' },
  transient: { label: 'Transient', color: '#94a3b8', blurb: 'seen briefly, no clear pattern' },
};

const CONFIG_FIELDS: Array<{ key: keyof BaselineConfigInput; label: string; hint: string }> = [
  {
    key: 'rollingWindowMinutes',
    label: 'Scoring window (minutes)',
    hint: 'How far back to look when labeling a device. 1440 = the last 24 hours.',
  },
  {
    key: 'gapThresholdMinutes',
    label: 'New-visit gap (minutes)',
    hint: 'If a device disappears for longer than this and returns, it counts as a new visit.',
  },
  {
    key: 'frequentFlierVisits',
    label: 'Frequent-flier visits',
    hint: 'This many separate visits inside the window labels a device a Frequent Flier.',
  },
  {
    key: 'visitorAbsenceMinutes',
    label: 'Departed after (minutes)',
    hint: 'A device gone at least this long (that first appeared after baseline) is a Visitor.',
  },
  {
    key: 'stationaryPresencePct',
    label: 'Stationary presence (%)',
    hint: 'Present for at least this share of the window labels a device Stationary.',
  },
  {
    key: 'autoClassifyMinutes',
    label: 'Auto-classify every (minutes)',
    hint: 'How often the labels recompute on their own, in addition to Classify now.',
  },
];

function rssiColor(rssi: number): string {
  if (rssi >= -60) return '#22c55e';
  if (rssi >= -75) return '#f97316';
  return '#ef4444';
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

function formatClock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString();
}

function categoryBadge(category: DeviceCategory | null) {
  if (!category) {
    return <span style={{ color: 'var(--color-text-muted)' }}>—</span>;
  }
  const meta = CATEGORY_META[category];
  return (
    <span className="status-pill" style={{ borderColor: meta.color, color: meta.color }}>
      {meta.label}
    </span>
  );
}

export function BaselinePage() {
  const role = useAuthStore((state) => state.user?.role ?? null);
  const isAdmin = role === 'ADMIN';
  const canSend = role === 'ADMIN' || role === 'OPERATOR';
  const queryClient = useQueryClient();

  const nodes = useNodeStore((state) => state.nodes);
  const bStatus = useBaselineStore((state) => state.status);
  const bAnomalies = useBaselineStore((state) => state.anomalies);
  const bDone = useBaselineStore((state) => state.done);
  const clearBaselineFeed = useBaselineStore((state) => state.clear);
  const [target, setTarget] = useState('@ALL');
  const [fwSiteId, setFwSiteId] = useState<string | undefined>(undefined);
  const [duration, setDuration] = useState(300);
  const [forever, setForever] = useState(false);
  const [fwFeedback, setFwFeedback] = useState<{ level: 'ok' | 'error'; message: string } | null>(
    null,
  );

  const { data: sites } = useQuery({
    queryKey: ['sites'],
    queryFn: () => apiClient.get<SiteSummary[]>('/sites'),
  });

  const targetOptions = useMemo(() => {
    const options = [{ value: '@ALL', label: 'All nodes (@ALL)' }];
    Object.values(nodes).forEach((node) => {
      const value = `@${node.id.toUpperCase()}`;
      options.push({ value, label: node.name ? `${node.name} (${value})` : value });
    });
    return options;
  }, [nodes]);

  const command = useMutation<CommandResponse, Error, CommandRequest>({
    mutationFn: (body) => apiClient.post<CommandResponse>('/commands/send', body),
    onSuccess: (data, variables) =>
      setFwFeedback({ level: 'ok', message: `${variables.name} queued (${data.id.slice(0, 8)})` }),
    onError: (error, variables) =>
      setFwFeedback({
        level: 'error',
        message: `${variables.name} failed: ${error instanceof Error ? error.message : 'error'}`,
      }),
  });

  const send = (name: string, params: string[] = []) => {
    if (!canSend) return;
    command.mutate({ target, name, params, siteId: fwSiteId });
  };

  const startBaseline = () =>
    send('BASELINE_START', forever ? [String(duration), 'FOREVER'] : [String(duration)]);

  const statusRows = useMemo(() => Object.values(bStatus), [bStatus]);

  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<DeviceCategory | 'all'>('all');
  const [draft, setDraft] = useState<BaselineConfigInput>({});

  const { data: config } = useQuery<BaselineConfig>({
    queryKey: ['device-classification', 'config'],
    queryFn: () => apiClient.get<BaselineConfig>('/device-classification/config'),
    refetchInterval: 30_000,
    retry: false,
  });

  const {
    data: devices,
    isLoading,
    isError,
  } = useQuery<PresenceDevice[]>({
    queryKey: ['device-classification'],
    queryFn: () => apiClient.get<PresenceDevice[]>('/device-classification'),
    refetchInterval: 10_000,
  });

  useEffect(() => {
    if (config) {
      setDraft({
        rollingWindowMinutes: config.rollingWindowMinutes,
        gapThresholdMinutes: config.gapThresholdMinutes,
        frequentFlierVisits: config.frequentFlierVisits,
        visitorAbsenceMinutes: config.visitorAbsenceMinutes,
        stationaryPresencePct: config.stationaryPresencePct,
        autoClassifyMinutes: config.autoClassifyMinutes,
      });
    }
  }, [config]);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['device-classification'] });
    void queryClient.invalidateQueries({ queryKey: ['device-classification', 'config'] });
  };

  const saveConfig = useMutation({
    mutationFn: (body: BaselineConfigInput) =>
      apiClient.put<BaselineConfig>('/device-classification/config', body),
    onSuccess: invalidate,
  });
  const classifyNow = useMutation({
    mutationFn: () => apiClient.post<ClassificationSummary>('/device-classification/classify'),
    onSuccess: invalidate,
  });
  const establishClassifierBaseline = useMutation({
    mutationFn: () => apiClient.post<ClassificationSummary>('/device-classification/baseline'),
    onSuccess: invalidate,
  });
  const resetClassifierBaseline = useMutation({
    mutationFn: () => apiClient.delete('/device-classification/baseline'),
    onSuccess: invalidate,
  });
  const clearClassifier = useMutation({
    mutationFn: () => apiClient.delete('/device-classification'),
    onSuccess: invalidate,
  });

  const counts = useMemo(() => {
    const tally: Record<string, number> = {};
    (devices ?? []).forEach((d) => {
      const key = d.category ?? 'unclassified';
      tally[key] = (tally[key] ?? 0) + 1;
    });
    return tally;
  }, [devices]);

  const visible = useMemo(() => {
    const term = search.toLowerCase();
    return (devices ?? [])
      .filter((d) => (filter === 'all' ? true : d.category === filter))
      .filter(
        (d) =>
          !term ||
          d.mac.toLowerCase().includes(term) ||
          (d.vendor ?? '').toLowerCase().includes(term) ||
          (d.smartName ?? '').toLowerCase().includes(term),
      );
  }, [devices, filter, search]);

  const total = (devices ?? []).length;

  return (
    <div className="page-stack">
      <header className="page-header">
        <h1 style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
          <MdFingerprint /> Baseline
        </h1>
        <p className="form-hint">
          Run the on-node baseline anomaly detector and watch its results, then let the command
          center profile how each device comes and goes over time.
        </p>
      </header>

      <article className="config-card">
        <div className="panel__header">
          <h2 className="panel__title">Firmware baseline detector</h2>
          {statusRows.length > 0 && (
            <span className="status-pill">
              {statusRows.filter((s) => s.scanning).length} scanning /{' '}
              {statusRows.filter((s) => s.established).length} established
            </span>
          )}
        </div>
        <p className="form-hint">
          Each node learns the RF devices normally present, then reports new / returning / RSSI
          anomalies and devices that disappear. Start it on one node, a whole site, or all nodes.
        </p>

        <div className="baseline-grid">
          <div className="baseline-field">
            <label className="form-label" htmlFor="fw-target">
              Target
            </label>
            <select
              id="fw-target"
              className="control-input"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            >
              {targetOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <span className="form-hint">Single node, or @ALL for every node.</span>
          </div>

          {sites && sites.length > 1 && (
            <div className="baseline-field">
              <label className="form-label" htmlFor="fw-site">
                Site
              </label>
              <select
                id="fw-site"
                className="control-input"
                value={fwSiteId ?? ''}
                onChange={(e) => setFwSiteId(e.target.value || undefined)}
              >
                <option value="">All sites</option>
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name ?? s.id}
                  </option>
                ))}
              </select>
              <span className="form-hint">Scope the command to one site.</span>
            </div>
          )}

          <div className="baseline-field">
            <label className="form-label" htmlFor="fw-duration">
              Duration (seconds)
            </label>
            <input
              id="fw-duration"
              className="control-input"
              type="number"
              min={60}
              value={duration}
              disabled={forever}
              onChange={(e) => setDuration(Number(e.target.value))}
            />
            <span className="form-hint">
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
                <input
                  type="checkbox"
                  checked={forever}
                  onChange={(e) => setForever(e.target.checked)}
                />
                Run until stopped (FOREVER)
              </label>
            </span>
          </div>
        </div>

        <div className="sentinel-controls">
          <button
            type="button"
            className="control-chip control-chip--primary"
            disabled={!canSend || command.isPending}
            onClick={startBaseline}
          >
            Establish baseline
          </button>
          <button
            type="button"
            className="control-chip"
            disabled={!canSend || command.isPending}
            onClick={() => send('BASELINE_STATUS')}
          >
            Query status
          </button>
          <button
            type="button"
            className="control-chip control-chip--danger"
            disabled={!canSend || command.isPending}
            onClick={() => send('STOP')}
          >
            Stop
          </button>
          {(statusRows.length > 0 || bAnomalies.length > 0) && (
            <button
              type="button"
              className="control-chip control-chip--ghost"
              onClick={clearBaselineFeed}
            >
              Clear feed
            </button>
          )}
        </div>
        {fwFeedback && (
          <p
            className="form-hint"
            style={{
              color:
                fwFeedback.level === 'error' ? 'var(--alert-color-alert)' : 'var(--color-accent)',
            }}
          >
            {fwFeedback.message}
          </p>
        )}
        {!canSend && <p className="form-hint">Viewer role — controls are read-only.</p>}

        {statusRows.length > 0 && (
          <div className="table-wrap" style={{ marginTop: '0.75rem' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Node</th>
                  <th>Scanning</th>
                  <th>Established</th>
                  <th>Devices</th>
                  <th>Anomalies</th>
                  <th>Phase</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {statusRows.map((s) => {
                  const done = bDone[s.nodeId];
                  return (
                    <tr key={s.nodeId}>
                      <td>{s.nodeId}</td>
                      <td>{s.scanning ? 'Yes' : 'No'}</td>
                      <td>{s.established ? 'Yes' : 'No'}</td>
                      <td>{s.devices}</td>
                      <td>{s.anomalies}</td>
                      <td style={{ fontSize: '0.85em', color: 'var(--color-text-muted)' }}>
                        {s.phase ?? '—'}
                        {done ? ` · done: ${done.tx ?? 0} tx / ${done.pend ?? 0} pend` : ''}
                      </td>
                      <td style={{ fontSize: '0.85em' }}>{formatClock(s.updatedAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </article>

      <article className="config-card">
        <div className="panel__header">
          <h2 className="panel__title">Baseline results ({bAnomalies.length})</h2>
        </div>
        {bAnomalies.length === 0 ? (
          <div className="empty-state">
            No baseline anomalies yet — they stream in here as nodes report NEW / RETURN / RSSI
            anomalies and disappeared devices.
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Node</th>
                  <th>Event</th>
                  <th>MAC</th>
                  <th>Type</th>
                  <th>RSSI</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {bAnomalies.map((a) => (
                  <tr key={a.id}>
                    <td style={{ fontSize: '0.85em' }}>{formatClock(a.timestamp)}</td>
                    <td style={{ fontSize: '0.85em' }}>{a.nodeId}</td>
                    <td>
                      <span
                        className="status-pill"
                        style={
                          a.event === 'disappeared'
                            ? { borderColor: '#94a3b8', color: '#94a3b8' }
                            : { borderColor: '#f97316', color: '#f97316' }
                        }
                      >
                        {a.event === 'disappeared' ? 'GONE' : (a.kind ?? 'ANOMALY')}
                      </span>
                    </td>
                    <td style={{ fontFamily: 'monospace', fontSize: '0.85em' }}>{a.mac ?? '—'}</td>
                    <td>{a.type ?? '—'}</td>
                    <td>
                      {a.rssi != null ? (
                        <span style={{ color: rssiColor(a.rssi) }}>{a.rssi}</span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td style={{ fontSize: '0.85em', color: 'var(--color-text-muted)' }}>
                      {a.event === 'disappeared'
                        ? `absent ${a.absentSeconds ?? '?'}s`
                        : [a.reason, a.name ? `(${a.name})` : null].filter(Boolean).join(' ') ||
                          '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </article>

      <article className="config-card">
        <div className="panel__header">
          <h2 className="panel__title">Device classification</h2>
          <span className="status-pill">
            {total} indexed ·{' '}
            {config?.baselineStart ? `baseline ${formatTime(config.baselineStart)}` : 'no baseline'}
          </span>
        </div>
        <p className="form-hint">
          Command-center analytics over every sighting: labels each device Stationary / Frequent
          Flier / Visitor / New from how often and how long it is seen. Independent of the on-node
          detector above.
        </p>
        <div className="sentinel-controls">
          <button
            type="button"
            className="control-chip control-chip--primary"
            onClick={() => classifyNow.mutate()}
            disabled={classifyNow.isPending}
          >
            Classify now
          </button>
          {isAdmin && (
            <>
              <button
                type="button"
                className="control-chip"
                onClick={() => establishClassifierBaseline.mutate()}
                disabled={establishClassifierBaseline.isPending}
              >
                Set baseline point
              </button>
              <button
                type="button"
                className="control-chip control-chip--ghost"
                onClick={() => resetClassifierBaseline.mutate()}
                disabled={resetClassifierBaseline.isPending || !config?.baselineStart}
              >
                Reset baseline point
              </button>
              <button
                type="button"
                className="control-chip control-chip--danger"
                onClick={() => clearClassifier.mutate()}
                disabled={clearClassifier.isPending}
              >
                Clear index
              </button>
            </>
          )}
        </div>

        <div className="baseline-grid">
          {CONFIG_FIELDS.map((field) => (
            <div key={field.key} className="baseline-field">
              <label className="form-label" htmlFor={`baseline-${field.key}`}>
                {field.label}
              </label>
              <input
                id={`baseline-${field.key}`}
                className="control-input"
                type="number"
                min={1}
                value={draft[field.key] ?? ''}
                disabled={!isAdmin}
                onChange={(e) =>
                  setDraft((prev) => ({
                    ...prev,
                    [field.key]: e.target.value === '' ? undefined : Number(e.target.value),
                  }))
                }
              />
              <span className="form-hint">{field.hint}</span>
            </div>
          ))}
        </div>
        {isAdmin && (
          <div className="sentinel-controls">
            <button
              type="button"
              className="control-chip control-chip--primary"
              onClick={() => saveConfig.mutate(draft)}
              disabled={saveConfig.isPending}
            >
              Save settings
            </button>
          </div>
        )}

        <div className="baseline-filter">
          <button
            type="button"
            className="control-chip"
            onClick={() => setFilter('all')}
            style={
              filter === 'all'
                ? { borderColor: 'var(--color-accent)', color: 'var(--color-accent)' }
                : undefined
            }
          >
            All ({total})
          </button>
          {(Object.keys(CATEGORY_META) as DeviceCategory[]).map((cat) => (
            <button
              key={cat}
              type="button"
              className="control-chip"
              title={CATEGORY_META[cat].blurb}
              onClick={() => setFilter(cat)}
              style={
                filter === cat
                  ? { borderColor: CATEGORY_META[cat].color, color: CATEGORY_META[cat].color }
                  : undefined
              }
            >
              <span className="baseline-cat-dot" style={{ background: CATEGORY_META[cat].color }} />
              {CATEGORY_META[cat].label} ({counts[cat] ?? 0})
            </button>
          ))}
          <input
            className="control-input baseline-search"
            placeholder="Search MAC, vendor, name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <p className="form-hint baseline-legend">
          {(Object.keys(CATEGORY_META) as DeviceCategory[])
            .map((cat) => `${CATEGORY_META[cat].label} — ${CATEGORY_META[cat].blurb}`)
            .join(' · ')}
        </p>

        {isLoading && total === 0 && <div className="empty-state">Loading device index…</div>}
        {isError && total === 0 && (
          <div className="empty-state">Failed to load the device index.</div>
        )}
        {!isLoading && !isError && visible.length === 0 && (
          <div className="empty-state">
            {total === 0
              ? 'No devices yet — they appear here as your nodes report probe hits and detections.'
              : 'No devices in this category.'}
          </div>
        )}

        {visible.length > 0 && (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Category</th>
                  <th>MAC</th>
                  <th>Vendor</th>
                  <th>Hits</th>
                  <th>RSSI</th>
                  <th>Nodes</th>
                  <th>First seen</th>
                  <th>Last seen</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((d) => (
                  <tr key={d.mac}>
                    <td style={{ fontWeight: 600 }}>{d.smartName ?? '—'}</td>
                    <td>{categoryBadge(d.category)}</td>
                    <td style={{ fontFamily: 'monospace', fontSize: '0.85em' }}>{d.mac}</td>
                    <td>
                      {d.vendor ?? <span style={{ color: 'var(--color-text-muted)' }}>—</span>}
                    </td>
                    <td>{d.hits}</td>
                    <td>
                      {d.maxRssi != null ? (
                        <span style={{ color: rssiColor(d.maxRssi) }}>{d.maxRssi}</span>
                      ) : (
                        '—'
                      )}
                      {d.minRssi != null && d.maxRssi != null && (
                        <span style={{ color: 'var(--color-text-muted)', fontSize: '0.8em' }}>
                          {' '}
                          ({d.minRssi}/{d.maxRssi})
                        </span>
                      )}
                    </td>
                    <td style={{ fontSize: '0.8em', color: 'var(--color-text-muted)' }}>
                      {d.nodeIds.length > 0 ? d.nodeIds.join(', ') : '—'}
                    </td>
                    <td style={{ fontSize: '0.85em' }}>{formatTime(d.firstSeen)}</td>
                    <td style={{ fontSize: '0.85em' }}>{formatTime(d.lastSeen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </article>
    </div>
  );
}
