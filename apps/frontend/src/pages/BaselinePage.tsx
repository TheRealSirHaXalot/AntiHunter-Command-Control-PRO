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
import { useAuthStore } from '../stores/auth-store';

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
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<DeviceCategory | 'all'>('all');
  const [draft, setDraft] = useState<BaselineConfigInput>({});
  const role = useAuthStore((state) => state.user?.role ?? null);
  const isAdmin = role === 'ADMIN';
  const queryClient = useQueryClient();

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

  const establishBaseline = useMutation({
    mutationFn: () => apiClient.post<ClassificationSummary>('/device-classification/baseline'),
    onSuccess: invalidate,
  });

  const resetBaseline = useMutation({
    mutationFn: () => apiClient.delete('/device-classification/baseline'),
    onSuccess: invalidate,
  });

  const clearAll = useMutation({
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
          Learns what devices are normal at your site, then labels each one by how it comes and
          goes. Establish a baseline snapshot, and anything new or unusual stands out.
        </p>
      </header>

      <article className="config-card">
        <div className="panel__header">
          <h2 className="panel__title">Baseline snapshot</h2>
          <span className="status-pill">
            {total} indexed ·{' '}
            {config?.baselineStart
              ? `baseline ${formatTime(config.baselineStart)}`
              : 'no baseline yet'}
          </span>
        </div>
        <p className="form-hint">
          &ldquo;Establish baseline&rdquo; marks the current moment as normal. Devices seen before
          it are residents; anything appearing after is a candidate Visitor or New device.
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
                onClick={() => establishBaseline.mutate()}
                disabled={establishBaseline.isPending}
              >
                Establish baseline
              </button>
              <button
                type="button"
                className="control-chip control-chip--ghost"
                onClick={() => resetBaseline.mutate()}
                disabled={resetBaseline.isPending || !config?.baselineStart}
              >
                Reset baseline
              </button>
              <button
                type="button"
                className="control-chip control-chip--danger"
                onClick={() => clearAll.mutate()}
                disabled={clearAll.isPending}
              >
                Clear index
              </button>
            </>
          )}
        </div>
      </article>

      <article className="config-card">
        <div className="panel__header">
          <h2 className="panel__title">Classification settings</h2>
        </div>
        <p className="form-hint">
          Tune how devices are scored. The defaults suit most sites — change these only if labels
          don&rsquo;t match what you see.
        </p>
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
      </article>

      <article className="config-card">
        <div className="panel__header">
          <h2 className="panel__title">Classified devices</h2>
          <input
            className="control-input baseline-search"
            placeholder="Search MAC, vendor, name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
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
