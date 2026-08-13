import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

import { apiClient } from '../api/client';
import {
  BaselineConfig,
  BaselineConfigInput,
  ClassificationSummary,
  DeviceCategory,
  PresenceDevice,
} from '../api/device-classification';
import { useAuthStore } from '../stores/auth-store';

const CATEGORY_META: Record<DeviceCategory, { label: string; color: string }> = {
  stationary: { label: 'Stationary', color: '#22c55e' },
  'frequent-flier': { label: 'Frequent Flier', color: '#a855f7' },
  visitor: { label: 'Visitor', color: '#f97316' },
  new: { label: 'New', color: '#38bdf8' },
  transient: { label: 'Transient', color: '#94a3b8' },
};

const CONFIG_FIELDS: Array<{ key: keyof BaselineConfigInput; label: string; hint: string }> = [
  { key: 'rollingWindowMinutes', label: 'Window (min)', hint: 'Interval classified over' },
  { key: 'gapThresholdMinutes', label: 'Visit gap (min)', hint: 'Absence that ends a visit' },
  {
    key: 'frequentFlierVisits',
    label: 'Frequent ≥ visits',
    hint: 'Visits in window ⇒ frequent flier',
  },
  {
    key: 'visitorAbsenceMinutes',
    label: 'Visitor absence (min)',
    hint: 'Gone this long ⇒ departed',
  },
  { key: 'stationaryPresencePct', label: 'Stationary ≥ %', hint: 'Present this % of window' },
  { key: 'autoClassifyMinutes', label: 'Auto-run (min)', hint: 'Re-classify interval' },
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
    <span
      className="badge"
      style={{ borderColor: meta.color, color: meta.color, fontSize: '0.75em' }}
    >
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

  return (
    <section className="panel">
      <header className="panel__header">
        <div>
          <h1 className="panel__title">Baseline</h1>
          <p className="panel__subtitle">
            {(devices ?? []).length} device{(devices ?? []).length !== 1 ? 's' : ''} indexed ·
            baseline{' '}
            {config?.baselineStart
              ? `established ${formatTime(config.baselineStart)}`
              : 'not established'}
          </p>
        </div>
        <div className="controls-row">
          <button
            type="button"
            className="control-chip"
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
                className="control-chip"
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
                Clear
              </button>
            </>
          )}
        </div>
      </header>

      <div
        className="controls-row"
        style={{ flexWrap: 'wrap', gap: '0.75rem', marginBottom: '1rem' }}
      >
        {CONFIG_FIELDS.map((field) => (
          <label
            key={field.key}
            style={{ display: 'flex', flexDirection: 'column', fontSize: '0.75em' }}
            title={field.hint}
          >
            <span style={{ color: 'var(--color-text-muted)' }}>{field.label}</span>
            <input
              className="control-input"
              type="number"
              style={{ width: '7rem' }}
              value={draft[field.key] ?? ''}
              disabled={!isAdmin}
              onChange={(e) =>
                setDraft((prev) => ({
                  ...prev,
                  [field.key]: e.target.value === '' ? undefined : Number(e.target.value),
                }))
              }
            />
          </label>
        ))}
        {isAdmin && (
          <button
            type="button"
            className="control-chip"
            style={{ alignSelf: 'flex-end' }}
            onClick={() => saveConfig.mutate(draft)}
            disabled={saveConfig.isPending}
          >
            Save settings
          </button>
        )}
      </div>

      <div
        className="controls-row"
        style={{ flexWrap: 'wrap', gap: '0.5rem', marginBottom: '1rem' }}
      >
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
          All
        </button>
        {(Object.keys(CATEGORY_META) as DeviceCategory[]).map((cat) => (
          <button
            key={cat}
            type="button"
            className="control-chip"
            onClick={() => setFilter(cat)}
            style={
              filter === cat
                ? { borderColor: CATEGORY_META[cat].color, color: CATEGORY_META[cat].color }
                : undefined
            }
          >
            {CATEGORY_META[cat].label} ({counts[cat] ?? 0})
          </button>
        ))}
        <input
          className="control-input"
          placeholder="Search MAC, vendor, name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ marginLeft: 'auto' }}
        />
      </div>

      {isLoading && (devices ?? []).length === 0 && (
        <div className="empty-state">Loading device index…</div>
      )}
      {isError && (devices ?? []).length === 0 && (
        <div className="empty-state">Failed to load device index.</div>
      )}
      {!isLoading && !isError && visible.length === 0 && (
        <div className="empty-state">No devices in this category yet.</div>
      )}

      {visible.length > 0 && (
        <div className="inventory-table">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Category</th>
                <th>MAC</th>
                <th>Vendor</th>
                <th>Hits</th>
                <th>RSSI</th>
                <th>Nodes</th>
                <th>First Seen</th>
                <th>Last Seen</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((d) => (
                <tr key={d.mac}>
                  <td style={{ fontWeight: 600 }}>{d.smartName ?? '—'}</td>
                  <td>{categoryBadge(d.category)}</td>
                  <td style={{ fontFamily: 'monospace', fontSize: '0.85em' }}>{d.mac}</td>
                  <td>{d.vendor ?? <span style={{ color: 'var(--color-text-muted)' }}>—</span>}</td>
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
    </section>
  );
}
