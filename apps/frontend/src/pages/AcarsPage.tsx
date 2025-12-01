import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

import { getAcarsMessages, getAcarsStatus, updateAcarsConfig } from '../api/acars';
import type { AcarsStatus } from '../api/types';
import { useAuthStore } from '../stores/auth-store';
import { useMapPreferences } from '../stores/map-store';

type LogEntry = {
  id: string;
  tail: string;
  flight?: string | null;
  label?: string | null;
  text?: string | null;
  timestamp: string;
  frequency?: number | null;
  signalLevel?: number | null;
  messageNumber?: string | null;
  stationId?: string | null;
  firstSeen: string;
  lastSeen: string;
  hits: number;
};

export function AcarsPage() {
  const [activeSection, setActiveSection] = useState<'settings' | 'help' | 'log'>('settings');
  const [acarsStatus, setAcarsStatus] = useState<AcarsStatus | null>(null);
  const [acarsEnabled, setAcarsEnabled] = useState<boolean>(false);
  const [acarsUdpHost, setAcarsUdpHost] = useState<string>('127.0.0.1');
  const [acarsUdpPort, setAcarsUdpPort] = useState<number>(15550);
  const [acarsIntervalMs, setAcarsIntervalMs] = useState<number>(5000);
  const [acarsTestMessage, setAcarsTestMessage] = useState<string | null>(null);
  const [acarsTestError, setAcarsTestError] = useState<string | null>(null);
  const [acarsTesting, setAcarsTesting] = useState<boolean>(false);
  const acarsMuted = useMapPreferences((state) => state.acarsMuted);
  const toggleAcarsMuted = useMapPreferences((state) => state.toggleAcarsMuted);
  const [log, setLog] = useState<Map<string, LogEntry>>(new Map());

  const acarsStatusQuery = useQuery({
    queryKey: ['acars', 'status'],
    queryFn: () => getAcarsStatus(),
    staleTime: 5_000,
    refetchInterval: () => Math.max(2_000, acarsIntervalMs),
  });

  useEffect(() => {
    if (acarsStatusQuery.data) {
      const addons = useAuthStore.getState().user?.preferences?.notifications?.addons ?? {};
      if (addons.acars === false) {
        setAcarsEnabled(false);
      } else {
        setAcarsEnabled(acarsStatusQuery.data.enabled);
      }
      setAcarsStatus(acarsStatusQuery.data);
      setAcarsUdpHost(acarsStatusQuery.data.udpHost);
      setAcarsUdpPort(acarsStatusQuery.data.udpPort);
      setAcarsIntervalMs(acarsStatusQuery.data.intervalMs ?? 5000);
    }
  }, [acarsStatusQuery.data]);

  const acarsConfigMutation = useMutation({
    mutationFn: (body: {
      enabled?: boolean;
      udpHost?: string;
      udpPort?: number;
      intervalMs?: number;
    }) => updateAcarsConfig(body),
    onSuccess: (data) => {
      setAcarsStatus(data);
      void acarsStatusQuery.refetch();
    },
  });

  const messagesQuery = useQuery({
    queryKey: ['acars', 'messages', 'log'],
    queryFn: getAcarsMessages,
    refetchInterval: () => Math.max(2_000, acarsIntervalMs),
  });

  useEffect(() => {
    if (!messagesQuery.data) return;
    const filtered = messagesQuery.data.filter((msg) => {
      return Boolean(msg.tail && msg.tail.trim());
    });
    setLog((prev) => {
      const next = new Map(prev);
      filtered.forEach((msg) => {
        const existing = next.get(msg.id);
        const now = new Date().toISOString();
        if (existing) {
          next.set(msg.id, {
            ...existing,
            flight: msg.flight ?? existing.flight,
            label: msg.label ?? existing.label,
            text: msg.text ?? existing.text,
            frequency: msg.frequency ?? existing.frequency,
            signalLevel: msg.signalLevel ?? existing.signalLevel,
            messageNumber: msg.messageNumber ?? existing.messageNumber,
            stationId: msg.stationId ?? existing.stationId,
            lastSeen: msg.lastSeen ?? now,
            hits: existing.hits + 1,
          });
        } else {
          next.set(msg.id, {
            id: msg.id,
            tail: msg.tail,
            flight: msg.flight ?? null,
            label: msg.label ?? null,
            text: msg.text ?? null,
            timestamp: msg.timestamp,
            frequency: msg.frequency ?? null,
            signalLevel: msg.signalLevel ?? null,
            messageNumber: msg.messageNumber ?? null,
            stationId: msg.stationId ?? null,
            firstSeen: msg.lastSeen ?? now,
            lastSeen: msg.lastSeen ?? now,
            hits: 1,
          });
        }
      });
      return next;
    });
  }, [messagesQuery.data]);

  const logEntries = useMemo(() => {
    return Array.from(log.values()).sort((a, b) => (a.lastSeen > b.lastSeen ? -1 : 1));
  }, [log]);

  const handleClearLog = () => setLog(new Map());

  const handleExportLog = () => {
    const header = [
      'Tail',
      'Flight',
      'Label',
      'Message Number',
      'Frequency',
      'Signal Level',
      'Station ID',
      'Text',
      'First Seen',
      'Last Seen',
      'Hits',
    ];
    const rows = logEntries.map((entry) => [
      entry.tail,
      entry.flight ?? '',
      entry.label ?? '',
      entry.messageNumber ?? '',
      entry.frequency?.toFixed(3) ?? '',
      entry.signalLevel?.toFixed(1) ?? '',
      entry.stationId ?? '',
      (entry.text ?? '').replace(/"/g, '""'),
      entry.firstSeen,
      entry.lastSeen,
      entry.hits.toString(),
    ]);
    const csv = [header, ...rows]
      .map((cols) =>
        cols
          .map((col) =>
            typeof col === 'string' && col.includes(',')
              ? `"${col.replace(/"/g, '""')}"`
              : String(col),
          )
          .join(','),
      )
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `acars-log-${new Date().toISOString()}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="config-shell">
      <aside className="config-rail">
        <div className="config-rail__title">
          <h1 className="config-rail__heading">ACARS</h1>
          <p className="config-rail__copy">
            Configure ACARS ingest, feed settings, and message logging.
          </p>
        </div>
        <nav className="config-menu" aria-label="ACARS sections">
          <button
            type="button"
            className={`config-menu__item${activeSection === 'settings' ? ' config-menu__item--active' : ''}`}
            onClick={() => setActiveSection('settings')}
            aria-pressed={activeSection === 'settings'}
          >
            <span className="config-menu__label">ACARS Settings</span>
            <span className="config-menu__description">Feed URL and polling</span>
          </button>
          <button
            type="button"
            className={`config-menu__item${activeSection === 'help' ? ' config-menu__item--active' : ''}`}
            onClick={() => setActiveSection('help')}
            aria-pressed={activeSection === 'help'}
          >
            <span className="config-menu__label">Help</span>
            <span className="config-menu__description">Setup steps and links</span>
          </button>
          <button
            type="button"
            className={`config-menu__item${activeSection === 'log' ? ' config-menu__item--active' : ''}`}
            onClick={() => setActiveSection('log')}
            aria-pressed={activeSection === 'log'}
          >
            <span className="config-menu__label">ACARS Log</span>
            <span className="config-menu__description">Messages seen this session</span>
          </button>
        </nav>
      </aside>

      <section className="panel config-page">
        <header className="panel__header">
          <div>
            <h1 className="panel__title">ACARS Ingest (RTL-SDR + acarsdec)</h1>
            <p className="panel__subtitle">
              Decode aircraft ACARS messages via UDP from acarsdec. Real-time UDP listener with
              cross-platform support for macOS, Windows, and Linux.
            </p>
          </div>
        </header>

        <div className="config-content">
          <div className="config-grid config-grid--single">
            {activeSection === 'settings' ? (
              <section className="config-card">
                <header>
                  <h2>ACARS settings</h2>
                  <p>Control ingest and UDP listener settings.</p>
                </header>
                <div className="config-card__body">
                  <div className="config-row">
                    <span className="config-label">Enabled</span>
                    <label className="switch" aria-label="Toggle ACARS ingest">
                      <input
                        type="checkbox"
                        checked={acarsEnabled}
                        onChange={(event) => {
                          const newValue = event.target.checked;
                          setAcarsEnabled(newValue);
                          acarsConfigMutation.mutate({
                            enabled: newValue,
                            udpHost: acarsUdpHost,
                            udpPort: acarsUdpPort,
                            intervalMs: acarsIntervalMs,
                          });
                        }}
                      />
                      <span />
                    </label>
                  </div>
                  <div className="config-row">
                    <span className="config-label">UDP Host</span>
                    <input
                      value={acarsUdpHost}
                      onChange={(event) => setAcarsUdpHost(event.target.value)}
                      placeholder="127.0.0.1"
                    />
                  </div>
                  <div className="config-row">
                    <span className="config-label">UDP Port</span>
                    <input
                      type="number"
                      min={1024}
                      max={65535}
                      value={acarsUdpPort}
                      onChange={(event) => setAcarsUdpPort(Number(event.target.value))}
                    />
                  </div>
                  <div className="config-row">
                    <span className="config-label">Poll interval (ms)</span>
                    <input
                      type="number"
                      min={1000}
                      max={60000}
                      step={500}
                      value={acarsIntervalMs}
                      onChange={(event) => setAcarsIntervalMs(Number(event.target.value))}
                    />
                  </div>
                  <div className="config-row">
                    <span className="config-label">Mute ACARS log updates</span>
                    <label className="switch" aria-label="Mute ACARS updates in Terminal & Events">
                      <input type="checkbox" checked={acarsMuted} onChange={toggleAcarsMuted} />
                      <span />
                    </label>
                    <p className="form-hint">Suppress ACARS info messages in the event feed.</p>
                  </div>
                  <div className="config-row">
                    <span className="config-label">Last message</span>
                    <span>
                      {acarsStatus?.lastMessageAt
                        ? new Date(acarsStatus.lastMessageAt).toLocaleString()
                        : 'N/A'}
                    </span>
                  </div>
                  <div className="config-row">
                    <span className="config-label">Messages</span>
                    <span>{acarsStatus?.messageCount ?? 0}</span>
                  </div>
                  {acarsStatus?.lastError ? (
                    <div className="form-error">Last error: {acarsStatus.lastError}</div>
                  ) : null}
                  {acarsTestError ? <div className="form-error">{acarsTestError}</div> : null}
                  {acarsTestMessage ? <div className="form-hint">{acarsTestMessage}</div> : null}
                  <div className="controls-row">
                    <button
                      type="button"
                      className="submit-button"
                      onClick={() =>
                        acarsConfigMutation.mutate({
                          enabled: acarsEnabled,
                          udpHost: acarsUdpHost,
                          udpPort: acarsUdpPort,
                          intervalMs: acarsIntervalMs,
                        })
                      }
                      disabled={acarsConfigMutation.isPending}
                    >
                      {acarsConfigMutation.isPending ? 'Saving...' : 'Save ACARS settings'}
                    </button>
                    <button
                      type="button"
                      className="control-chip"
                      onClick={() => acarsStatusQuery.refetch()}
                      disabled={acarsStatusQuery.isFetching}
                    >
                      Refresh status
                    </button>
                    <button
                      type="button"
                      className="control-chip"
                      onClick={async () => {
                        setAcarsTestError(null);
                        setAcarsTestMessage(null);
                        setAcarsTesting(true);
                        const start = performance.now();
                        try {
                          const messages = await getAcarsMessages();
                          const duration = performance.now() - start;
                          setAcarsTestMessage(
                            `UDP listener active (${messages.length} messages in buffer) in ${duration.toFixed(0)}ms.`,
                          );
                        } catch (error) {
                          const message =
                            error instanceof Error
                              ? error.message
                              : 'Unable to reach ACARS endpoint.';
                          setAcarsTestError(message);
                        } finally {
                          setAcarsTesting(false);
                        }
                      }}
                      disabled={acarsTesting}
                    >
                      {acarsTesting ? 'Testing...' : 'Test listener'}
                    </button>
                  </div>
                </div>
              </section>
            ) : null}

            {activeSection === 'help' ? (
              <section className="config-card">
                <header>
                  <h2>Setup steps</h2>
                  <p>Minimal steps to get acarsdec/dumpvdl2 running on common platforms.</p>
                </header>
                <div className="config-card__body">
                  <ul className="config-list">
                    <li>
                      <strong>Linux (acarsdec - Legacy ACARS)</strong>
                      <div className="config-hint">
                        Repo:{' '}
                        <a
                          href="https://github.com/f00b4r0/acarsdec"
                          target="_blank"
                          rel="noreferrer"
                        >
                          github.com/f00b4r0/acarsdec
                        </a>
                        <br />
                        Install:{' '}
                        <code>
                          sudo apt-get install rtl-sdr librtlsdr-dev build-essential cmake
                          libacars-dev
                        </code>
                        <br />
                        Build:{' '}
                        <code>
                          git clone https://github.com/f00b4r0/acarsdec && cd acarsdec && mkdir
                          build && cd build && cmake .. && make && sudo make install
                        </code>
                        <br />
                        Run:{' '}
                        <code>
                          acarsdec -A -e -g 49.6 --output json:udp:host=127.0.0.1,port=15550
                          --rtlsdr 0 131.550 131.725 131.825 130.450 130.825
                        </code>
                      </div>
                    </li>
                    <li>
                      <strong>Linux (dumpvdl2 - VDL2 Mode 2)</strong>
                      <div className="config-hint">
                        Repo:{' '}
                        <a
                          href="https://github.com/szpajder/dumpvdl2"
                          target="_blank"
                          rel="noreferrer"
                        >
                          github.com/szpajder/dumpvdl2
                        </a>
                        <br />
                        Install:{' '}
                        <code>
                          sudo apt-get install rtl-sdr librtlsdr-dev build-essential cmake
                          libglib2.0-dev libacars-dev libzmq3-dev
                        </code>
                        <br />
                        Build:{' '}
                        <code>
                          git clone https://github.com/szpajder/dumpvdl2 && cd dumpvdl2 && mkdir
                          build && cd build && cmake .. && make && sudo make install
                        </code>
                        <br />
                        Run (Delta/Southwest hubs - 136 MHz):{' '}
                        <code>
                          dumpvdl2 --rtlsdr 0 --gain 49.6 136650000 136725000 136775000 136800000
                          136825000 136875000 136900000 136975000 --output
                          decoded:json:udp:address=127.0.0.1,port=15550
                        </code>
                        <br />
                        Run (Most airports - 131 MHz):{' '}
                        <code>
                          dumpvdl2 --rtlsdr 0 --gain 49.6 131525000 131550000 131725000 131825000
                          --output decoded:json:udp:address=127.0.0.1,port=15550
                        </code>
                      </div>
                    </li>
                    <li>
                      <strong>macOS</strong>
                      <div className="config-hint">
                        Install: <code>brew install rtl-sdr cmake libacars</code>
                        <br />
                        Build acarsdec or dumpvdl2 from source (same as Linux)
                        <br />
                        Run acarsdec:{' '}
                        <code>
                          acarsdec -A -e -g 49.6 --output json:udp:host=127.0.0.1,port=15550
                          --rtlsdr 0 131.550 131.725 131.825
                        </code>
                      </div>
                    </li>
                    <li>
                      <strong>Windows</strong>
                      <div className="config-hint">
                        Download prebuilt binaries from{' '}
                        <a
                          href="https://github.com/f00b4r0/acarsdec/releases"
                          target="_blank"
                          rel="noreferrer"
                        >
                          acarsdec releases
                        </a>{' '}
                        or{' '}
                        <a
                          href="https://github.com/szpajder/dumpvdl2/releases"
                          target="_blank"
                          rel="noreferrer"
                        >
                          dumpvdl2 releases
                        </a>
                        <br />
                        Install RTL-SDR drivers via Zadig
                        <br />
                        Run:{' '}
                        <code>
                          acarsdec.exe -A -e -g 49.6 --output json:udp:host=127.0.0.1,port=15550
                          --rtlsdr 0 131.550 131.725
                        </code>
                      </div>
                    </li>
                    <li>
                      <strong>Common Options</strong>
                      <div className="config-hint">
                        <strong>acarsdec:</strong>
                        <br />
                        <code>-A</code>: Aircraft messages only (no uplink)
                        <br />
                        <code>-e</code>: Skip empty messages
                        <br />
                        <code>-g</code>: RTL-SDR gain in dB (0-49.6, &gt;52 for AGC)
                        <br />
                        <code>-p</code>: PPM frequency correction
                        <br />
                        <br />
                        <strong>dumpvdl2:</strong>
                        <br />
                        <code>--gain</code>: RTL-SDR gain (0-49.6)
                        <br />
                        <code>--correction</code>: PPM frequency correction
                        <br />
                        <code>--rtlsdr N</code>: Device index
                        <br />
                        <code>--output decoded:json:udp:address=IP,port=PORT</code>: UDP JSON output
                      </div>
                    </li>
                    <li>
                      <strong>VDL2 vs Legacy ACARS Frequencies</strong>
                      <div className="config-hint">
                        <strong>VDL2 (136 MHz band)</strong> - Used by Delta, Southwest, United at
                        major hubs:
                        <br />
                        136.650, 136.725, 136.775, 136.800, 136.825, 136.875, 136.900, 136.975 MHz
                        <br />
                        <br />
                        <strong>Legacy ACARS (130-131 MHz)</strong> - Most airports worldwide:
                        <br />
                        131.550 (Primary), 131.725, 131.825, 130.450, 130.825, 130.025 (Japan),
                        129.125 (USA)
                      </div>
                    </li>
                    <li>
                      <strong>Verify</strong>
                      <div className="config-hint">
                        Check the &ldquo;Last message&rdquo; timestamp in settings to confirm UDP
                        messages are being received. The backend listens on{' '}
                        <code>
                          {acarsUdpHost}:{acarsUdpPort}
                        </code>
                        .
                      </div>
                    </li>
                  </ul>
                  <p className="config-hint">
                    For production, run acarsdec/dumpvdl2 as a service. Use dumpvdl2 for VDL2 (newer
                    aircraft) and acarsdec for legacy ACARS (older aircraft).
                  </p>
                </div>
              </section>
            ) : null}

            {activeSection === 'log' ? (
              <section className="config-card">
                <header className="config-card__header">
                  <div>
                    <h2>ACARS Log</h2>
                    <p>Session log of all ACARS messages seen.</p>
                  </div>
                  <div className="controls-row">
                    <button
                      type="button"
                      className="control-chip"
                      onClick={handleExportLog}
                      disabled={logEntries.length === 0}
                    >
                      Export CSV
                    </button>
                    <button
                      type="button"
                      className="control-chip control-chip--danger"
                      onClick={handleClearLog}
                    >
                      Clear log
                    </button>
                  </div>
                </header>
                <div className="config-card__body adsb-log-table-wrapper">
                  <table className="table adsb-log-table">
                    <thead>
                      <tr>
                        <th>Tail</th>
                        <th>Flight</th>
                        <th>Label</th>
                        <th>Message #</th>
                        <th>Frequency</th>
                        <th>Signal</th>
                        <th>Station</th>
                        <th>Text</th>
                        <th>First Seen</th>
                        <th>Last Seen</th>
                        <th>Hits</th>
                      </tr>
                    </thead>
                    <tbody>
                      {logEntries.map((entry) => (
                        <tr key={entry.id}>
                          <td data-label="Tail">{entry.tail}</td>
                          <td data-label="Flight">{entry.flight ?? '—'}</td>
                          <td data-label="Label">{entry.label ?? '—'}</td>
                          <td data-label="Message #">{entry.messageNumber ?? '—'}</td>
                          <td data-label="Frequency">
                            {entry.frequency ? `${entry.frequency.toFixed(3)} MHz` : '—'}
                          </td>
                          <td data-label="Signal">
                            {entry.signalLevel ? `${entry.signalLevel.toFixed(1)} dB` : '—'}
                          </td>
                          <td data-label="Station">{entry.stationId ?? '—'}</td>
                          <td data-label="Text" className="text-truncate" title={entry.text ?? ''}>
                            {entry.text ?? '—'}
                          </td>
                          <td data-label="First Seen">
                            {new Date(entry.firstSeen).toLocaleString()}
                          </td>
                          <td data-label="Last Seen">
                            {new Date(entry.lastSeen).toLocaleString()}
                          </td>
                          <td data-label="Hits">{entry.hits}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {logEntries.length === 0 ? (
                    <div className="empty-state">No ACARS messages received yet</div>
                  ) : null}
                </div>
              </section>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}
