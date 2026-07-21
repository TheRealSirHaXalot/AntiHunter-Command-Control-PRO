import { useMutation, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { MdDeleteSweep, MdRefresh, MdShield } from 'react-icons/md';

import { apiClient } from '../api/client';
import type { CommandRequest, CommandResponse, SiteSummary } from '../api/types';
import {
  SENTINEL_DEFAULT_MODE,
  SENTINEL_DETECTORS,
  SENTINEL_GROUPS,
  SENTINEL_MODES,
} from '../data/sentinel';
import { useAuthStore } from '../stores/auth-store';
import { useNodeStore } from '../stores/node-store';
import { useSentinelStore } from '../stores/sentinel-store';

const NODE_TARGET_PATTERN = /^[A-Z0-9]{2,}$/;

function toTargetValue(nodeId: string): string {
  const upper = nodeId.trim().toUpperCase();
  if (upper.startsWith('NODE_') || NODE_TARGET_PATTERN.test(upper)) {
    return `@${upper}`;
  }
  return `@${upper}`;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString();
}

export function SentinelPage() {
  const role = useAuthStore((state) => state.user?.role ?? null);
  const canSend = role === 'ADMIN' || role === 'OPERATOR';

  const nodes = useNodeStore((state) => state.nodes);
  const detections = useSentinelStore((state) => state.detections);
  const statusMap = useSentinelStore((state) => state.status);
  const clearDetections = useSentinelStore((state) => state.clearDetections);

  const { data: sites } = useQuery({
    queryKey: ['sites'],
    queryFn: () => apiClient.get<SiteSummary[]>('/sites'),
  });

  const [target, setTarget] = useState('@ALL');
  const [siteId, setSiteId] = useState<string | undefined>(undefined);
  const [typeFilter, setTypeFilter] = useState<string>('ALL');
  const [selectedMode, setSelectedMode] = useState<string>(SENTINEL_DEFAULT_MODE);
  const [selectedBoot, setSelectedBoot] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ level: 'ok' | 'error'; message: string } | null>(null);

  const targetOptions = useMemo(() => {
    const options = [{ value: '@ALL', label: 'All nodes (@ALL)' }];
    Object.values(nodes).forEach((node) => {
      const value = toTargetValue(node.id);
      const label = node.name ? `${node.name} (${value})` : value;
      options.push({ value, label });
    });
    return options;
  }, [nodes]);

  const mutation = useMutation<CommandResponse, Error, CommandRequest>({
    mutationFn: (body) => apiClient.post<CommandResponse>('/commands/send', body),
    onSuccess: (data, variables) => {
      setFeedback({ level: 'ok', message: `${variables.name} queued (${data.id.slice(0, 8)})` });
    },
    onError: (error, variables) => {
      setFeedback({
        level: 'error',
        message: `${variables.name} failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      });
    },
  });

  const send = (name: string, params: string[] = []) => {
    if (!canSend) return;
    mutation.mutate({ target, name, params, siteId });
  };

  const statuses = useMemo(() => Object.values(statusMap), [statusMap]);
  const runningCount = useMemo(
    () => statuses.filter((status) => status.running).length,
    [statuses],
  );

  const typeCounts = useMemo(() => {
    const counts = new Map<string, { label: string; count: number }>();
    detections.forEach((detection) => {
      const existing = counts.get(detection.detectionType);
      if (existing) {
        existing.count += 1;
      } else {
        counts.set(detection.detectionType, { label: detection.label, count: 1 });
      }
    });
    return Array.from(counts.entries())
      .map(([type, value]) => ({ type, ...value }))
      .sort((a, b) => b.count - a.count);
  }, [detections]);

  const visibleDetections = useMemo(() => {
    if (typeFilter === 'ALL') return detections;
    return detections.filter((detection) => detection.detectionType === typeFilter);
  }, [detections, typeFilter]);

  const busy = mutation.isPending;

  return (
    <div className="page sentinel-page">
      <header className="page-header">
        <h1>
          <MdShield /> Sentinel
        </h1>
        <p className="form-hint">
          Counterintel engine — control the WiFi attacker-tool detectors on your nodes and watch
          live detections stream in over mesh.
        </p>
      </header>

      {!canSend ? (
        <div className="config-card">
          <p className="form-hint">
            You are signed in as a viewer. Controls are read-only; the live detection feed below is
            still active.
          </p>
        </div>
      ) : null}

      {feedback ? (
        <div className={`config-card sentinel-feedback sentinel-feedback--${feedback.level}`}>
          <span>{feedback.message}</span>
        </div>
      ) : null}

      <article className="config-card">
        <div className="panel__header">
          <h2 className="panel__title">Sentinel Control</h2>
          {statuses.length > 0 ? (
            <span className="status-pill">
              {runningCount} running / {statuses.length} reporting
            </span>
          ) : null}
        </div>
        <div className="sentinel-control-grid">
          <div className="sentinel-control-col">
            <div className="sentinel-field">
              <label htmlFor="sentinel-target">Target</label>
              <select
                id="sentinel-target"
                value={target}
                onChange={(event) => setTarget(event.target.value)}
              >
                {targetOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            {sites && sites.length > 1 ? (
              <div className="sentinel-field">
                <label htmlFor="sentinel-site">Site</label>
                <select
                  id="sentinel-site"
                  value={siteId ?? ''}
                  onChange={(event) => setSiteId(event.target.value || undefined)}
                >
                  <option value="">All sites</option>
                  {sites.map((site) => (
                    <option key={site.id} value={site.id}>
                      {site.name ?? site.id}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            <div className="sentinel-block">
              <span className="form-label">Power</span>
              <div className="sentinel-controls">
                <button
                  type="button"
                  className="control-chip control-chip--primary"
                  disabled={!canSend || busy}
                  onClick={() => send('SENTINEL_ON')}
                >
                  Start
                </button>
                <button
                  type="button"
                  className="control-chip control-chip--danger"
                  disabled={!canSend || busy}
                  onClick={() => send('SENTINEL_OFF')}
                >
                  Stop
                </button>
                <button
                  type="button"
                  className="control-chip control-chip--ghost"
                  disabled={!canSend || busy}
                  onClick={() => send('SENTINEL_STATUS')}
                >
                  <MdRefresh /> Query Status
                </button>
              </div>
            </div>

            <div className="sentinel-block">
              <span className="form-label">Radio mode</span>
              <div className="sentinel-controls">
                {SENTINEL_MODES.map((mode) => (
                  <button
                    key={mode.value}
                    type="button"
                    className={`control-chip${selectedMode === mode.value ? ' is-active' : ''}`}
                    disabled={!canSend || busy}
                    onClick={() => {
                      setSelectedMode(mode.value);
                      send('SENTINEL_MODE', [mode.value]);
                    }}
                  >
                    {mode.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="sentinel-block">
              <span className="form-label">Start on boot</span>
              <div className="sentinel-controls">
                <button
                  type="button"
                  className={`control-chip${selectedBoot === 'on' ? ' is-active' : ''}`}
                  disabled={!canSend || busy}
                  onClick={() => {
                    setSelectedBoot('on');
                    send('SENTINEL_BOOT', ['on']);
                  }}
                >
                  On
                </button>
                <button
                  type="button"
                  className={`control-chip${selectedBoot === 'off' ? ' is-active' : ''}`}
                  disabled={!canSend || busy}
                  onClick={() => {
                    setSelectedBoot('off');
                    send('SENTINEL_BOOT', ['off']);
                  }}
                >
                  Off
                </button>
              </div>
            </div>
          </div>

          <div className="sentinel-node-panel">
            <h3>Node Status</h3>
            {statuses.length === 0 ? (
              <p className="form-hint">
                No status reported yet. Press “Query Status” to request it from the node(s).
              </p>
            ) : (
              statuses.map((status) => {
                const state = status.running ? 'run' : status.enabled ? 'idle' : 'off';
                const meta = status.running ? 'running' : status.enabled ? 'idle' : 'disabled';
                return (
                  <div
                    key={`${status.siteId ?? 'default'}-${status.nodeId}`}
                    className="sentinel-node"
                  >
                    <span
                      className={`sentinel-node__dot${
                        state === 'run'
                          ? ' sentinel-node__dot--run'
                          : state === 'idle'
                            ? ' sentinel-node__dot--idle'
                            : ''
                      }`}
                    />
                    <span className="sentinel-node__id">{status.nodeId}</span>
                    <span className="sentinel-node__meta">{meta}</span>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </article>

      <article className="config-card">
        <div className="panel__header">
          <h2 className="panel__title">Detector Groups</h2>
        </div>
        <p className="form-hint">
          Toggle whole attack-class groups. State is not read back over mesh — these are
          fire-and-forget commands.
        </p>
        <div className="sentinel-groups">
          {SENTINEL_GROUPS.map((group) => (
            <div key={group.key} className="sentinel-group">
              <div className="sentinel-group__meta">
                <strong>{group.label}</strong>
                <span className="form-hint">{group.description}</span>
              </div>
              <div className="sentinel-controls">
                <button
                  type="button"
                  className="control-chip control-chip--primary"
                  disabled={!canSend || busy}
                  onClick={() => send('GROUP', [group.key, 'on'])}
                >
                  On
                </button>
                <button
                  type="button"
                  className="control-chip control-chip--ghost"
                  disabled={!canSend || busy}
                  onClick={() => send('GROUP', [group.key, 'off'])}
                >
                  Off
                </button>
              </div>
            </div>
          ))}
        </div>
        <div className="sentinel-controls">
          <button
            type="button"
            className="control-chip"
            disabled={!canSend || busy}
            onClick={() => send('GROUP', ['all', 'on'])}
          >
            All On
          </button>
          <button
            type="button"
            className="control-chip"
            disabled={!canSend || busy}
            onClick={() => send('GROUP', ['all', 'off'])}
          >
            All Off
          </button>
        </div>
      </article>

      <article className="config-card">
        <div className="panel__header">
          <h2 className="panel__title">Individual Detectors</h2>
        </div>
        <p className="form-hint">
          Enable or disable a single detector via DETECT_CFG. Deauth-family detectors are always on
          and have no toggle.
        </p>
        <div className="sentinel-detectors">
          {SENTINEL_DETECTORS.map((detector) => (
            <div key={detector.key} className="sentinel-detector">
              <span>{detector.label}</span>
              <div className="sentinel-controls">
                <button
                  type="button"
                  className="control-chip control-chip--primary"
                  disabled={!canSend || busy}
                  onClick={() => send('DETECT_CFG', [JSON.stringify({ [detector.key]: true })])}
                >
                  On
                </button>
                <button
                  type="button"
                  className="control-chip control-chip--ghost"
                  disabled={!canSend || busy}
                  onClick={() => send('DETECT_CFG', [JSON.stringify({ [detector.key]: false })])}
                >
                  Off
                </button>
              </div>
            </div>
          ))}
        </div>
      </article>

      <article className="config-card">
        <div className="panel__header">
          <h2 className="panel__title">Live Detections ({detections.length})</h2>
          <div className="sentinel-controls">
            <button
              type="button"
              className="control-chip control-chip--ghost"
              onClick={() => clearDetections()}
            >
              Clear View
            </button>
            <button
              type="button"
              className="control-chip control-chip--danger"
              disabled={!canSend || busy}
              onClick={() => send('INCIDENTS_CLEAR')}
            >
              <MdDeleteSweep /> Clear Node Log
            </button>
          </div>
        </div>

        <div className="sentinel-chips">
          <button
            type="button"
            className={`control-chip${typeFilter === 'ALL' ? ' is-active' : ''}`}
            onClick={() => setTypeFilter('ALL')}
          >
            All ({detections.length})
          </button>
          {typeCounts.map((entry) => (
            <button
              key={entry.type}
              type="button"
              className={`control-chip${typeFilter === entry.type ? ' is-active' : ''}`}
              onClick={() => setTypeFilter(entry.type)}
            >
              {entry.label} ({entry.count})
            </button>
          ))}
        </div>

        {visibleDetections.length === 0 ? (
          <p className="form-hint">
            No detections received. Detections stream in live once a node’s sentinel is running and
            broadcasting.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="data-table sentinel-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Node</th>
                  <th>Detection</th>
                  <th>MAC</th>
                  <th>RSSI</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {visibleDetections.slice(0, 200).map((detection) => (
                  <tr key={detection.id}>
                    <td>{formatTime(detection.timestamp)}</td>
                    <td>{detection.nodeId}</td>
                    <td>
                      <span
                        className={`status-pill${detection.category === 'mesh-guard' ? ' status-pill--danger' : ''}`}
                      >
                        {detection.label}
                      </span>
                    </td>
                    <td>{detection.mac ?? '—'}</td>
                    <td>{typeof detection.rssi === 'number' ? `${detection.rssi} dBm` : '—'}</td>
                    <td className="sentinel-detail">{detection.message}</td>
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
