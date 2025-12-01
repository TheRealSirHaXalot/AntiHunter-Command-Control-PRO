import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

import {
  fetchAdsbProxy,
  getAdsbStatus,
  getAdsbTracksViaProxy,
  updateAdsbConfig,
  uploadAircraftDatabase,
} from '../api/adsb';
import type { AdsbStatus } from '../api/types';
import { useAuthStore } from '../stores/auth-store';
import { useMapPreferences } from '../stores/map-store';

type LogEntry = {
  id: string;
  icao: string;
  callsign?: string | null;
  reg?: string | null;
  country?: string | null;
  category?: string | null;
  dep?: string | null;
  dest?: string | null;
  lat: number;
  lon: number;
  alt?: number | null;
  speed?: number | null;
  heading?: number | null;
  messages?: number | null;
  firstSeen: string;
  lastSeen: string;
  hits: number;
};

export function AdsbPage() {
  const [activeSection, setActiveSection] = useState<'settings' | 'help' | 'log'>('settings');
  const [adsbStatus, setAdsbStatus] = useState<AdsbStatus | null>(null);
  const [adsbEnabled, setAdsbEnabled] = useState<boolean>(false);
  const [adsbFeedUrl, setAdsbFeedUrl] = useState<string>(
    'http://127.0.0.1:8080/data/aircraft.json',
  );
  const [adsbIntervalMs, setAdsbIntervalMs] = useState<number>(15000);
  const [adsbGeofencesEnabled, setAdsbGeofencesEnabled] = useState<boolean>(false);
  const [adsbTestMessage, setAdsbTestMessage] = useState<string | null>(null);
  const [adsbTestError, setAdsbTestError] = useState<string | null>(null);
  const [adsbTesting, setAdsbTesting] = useState<boolean>(false);
  const [uploadMessage, setUploadMessage] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [selectedFileName, setSelectedFileName] = useState<string>('No file selected');
  const [log, setLog] = useState<Map<string, LogEntry>>(new Map());
  const adsbMuted = useMapPreferences((state) => state.adsbMuted);
  const toggleAdsbMuted = useMapPreferences((state) => state.toggleAdsbMuted);

  const adsbStatusQuery = useQuery({
    queryKey: ['adsb', 'status'],
    queryFn: () => getAdsbStatus(),
    staleTime: 15_000,
    refetchInterval: () => Math.max(5_000, adsbIntervalMs),
  });

  useEffect(() => {
    if (adsbStatusQuery.data) {
      const addons = useAuthStore.getState().user?.preferences?.notifications?.addons ?? {};
      if (addons.adsb === false) {
        setAdsbEnabled(false);
      } else {
        setAdsbEnabled(adsbStatusQuery.data.enabled);
      }
      setAdsbStatus(adsbStatusQuery.data);
      setAdsbFeedUrl(adsbStatusQuery.data.feedUrl);
      setAdsbIntervalMs(adsbStatusQuery.data.intervalMs);
      setAdsbGeofencesEnabled(adsbStatusQuery.data.geofencesEnabled);
    }
  }, [adsbStatusQuery.data]);

  const adsbConfigMutation = useMutation({
    mutationFn: (body: {
      enabled?: boolean;
      feedUrl?: string;
      intervalMs?: number;
      geofencesEnabled?: boolean;
    }) => updateAdsbConfig(body),
    onSuccess: (data) => {
      setAdsbStatus(data);
      void adsbStatusQuery.refetch();
    },
  });

  const tracksQuery = useQuery({
    queryKey: ['adsb', 'tracks', 'log'],
    queryFn: getAdsbTracksViaProxy,
    refetchInterval: () => Math.max(5_000, adsbIntervalMs),
  });

  useEffect(() => {
    if (!tracksQuery.data) return;
    const filtered = tracksQuery.data.filter((track) => {
      const hasId = (track.callsign && track.callsign.trim()) || (track.reg && track.reg.trim());
      return Boolean(hasId);
    });
    setLog((prev) => {
      const next = new Map(prev);
      filtered.forEach((track) => {
        const existing = next.get(track.icao);
        const now = new Date().toISOString();
        if (existing) {
          next.set(track.icao, {
            ...existing,
            callsign: track.callsign ?? existing.callsign,
            reg: track.reg ?? existing.reg,
            country: track.country ?? existing.country,
            category: track.category ?? existing.category,
            dep: track.dep ?? existing.dep,
            dest: track.dest ?? existing.dest,
            lat: track.lat,
            lon: track.lon,
            alt: track.alt ?? existing.alt,
            speed: track.speed ?? existing.speed,
            heading: track.heading ?? existing.heading,
            messages: track.messages ?? existing.messages,
            lastSeen: track.lastSeen ?? now,
            hits: existing.hits + 1,
          });
        } else {
          next.set(track.icao, {
            id: track.id,
            icao: track.icao,
            callsign: track.callsign ?? null,
            reg: track.reg ?? null,
            country: track.country ?? null,
            category: track.category ?? null,
            dep: track.dep ?? null,
            dest: track.dest ?? null,
            lat: track.lat,
            lon: track.lon,
            alt: track.alt ?? null,
            speed: track.speed ?? null,
            heading: track.heading ?? null,
            messages: track.messages ?? null,
            firstSeen: track.lastSeen ?? now,
            lastSeen: track.lastSeen ?? now,
            hits: 1,
          });
        }
      });
      return next;
    });
  }, [tracksQuery.data]);

  const logEntries = useMemo(() => {
    return Array.from(log.values()).sort((a, b) => (a.lastSeen > b.lastSeen ? -1 : 1));
  }, [log]);

  const handleClearLog = () => setLog(new Map());

  const handleExportLog = () => {
    const header = [
      'ICAO',
      'Callsign',
      'Registration',
      'Country',
      'Category',
      'Departure',
      'Destination',
      'Lat',
      'Lon',
      'Alt',
      'Speed',
      'Heading',
      'Messages',
      'First Seen',
      'Last Seen',
      'Hits',
    ];
    const rows = logEntries.map((entry) => [
      entry.icao,
      entry.callsign ?? '',
      entry.reg ?? '',
      entry.country ?? '',
      entry.category ?? '',
      entry.dep ?? '',
      entry.dest ?? '',
      entry.lat,
      entry.lon,
      entry.alt ?? '',
      entry.speed ?? '',
      entry.heading ?? '',
      entry.messages ?? '',
      entry.firstSeen,
      entry.lastSeen,
      entry.hits,
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
    a.download = `adsb-log-${new Date().toISOString()}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="config-shell">
      <aside className="config-rail">
        <div className="config-rail__title">
          <h1 className="config-rail__heading">ADS-B</h1>
          <p className="config-rail__copy">
            Configure ADS-B ingest, feed settings, geofences, and the aircraft database.
          </p>
        </div>
        <nav className="config-menu" aria-label="ADS-B sections">
          <button
            type="button"
            className={`config-menu__item${activeSection === 'settings' ? ' config-menu__item--active' : ''}`}
            onClick={() => setActiveSection('settings')}
            aria-pressed={activeSection === 'settings'}
          >
            <span className="config-menu__label">ADS-B Settings</span>
            <span className="config-menu__description">Feed URL, polling, geofences</span>
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
            <span className="config-menu__label">ADS-B Log</span>
            <span className="config-menu__description">Aircraft seen this session</span>
          </button>
        </nav>
      </aside>

      <section className="panel config-page">
        <header className="panel__header">
          <div>
            <h1 className="panel__title">ADSB Ingest (RTL-SDR + dump1090)</h1>
            <p className="panel__subtitle">
              Prepare to ingest ADS-B traffic by pointing at a dump1090/readsb JSON feed. This is
              cross-platform: macOS, Windows, Linux. No native bindings added here—just HTTP polling
              against aircraft.json.
            </p>
          </div>
        </header>

        <div className="config-content">
          <div className="config-grid config-grid--single">
            {activeSection === 'settings' ? (
              <>
                <section className="config-card">
                  <header>
                    <h2>ADS-B settings</h2>
                    <p>Control ingest, feed URL, poll interval, and geofence triggers.</p>
                  </header>
                  <div className="config-card__body">
                    <div className="config-row">
                      <span className="config-label">Enabled</span>
                      <label className="switch" aria-label="Toggle ADS-B ingest">
                        <input
                          type="checkbox"
                          checked={adsbEnabled}
                          onChange={(event) => {
                            const newValue = event.target.checked;
                            setAdsbEnabled(newValue);
                            adsbConfigMutation.mutate({
                              enabled: newValue,
                              feedUrl: adsbFeedUrl,
                              intervalMs: adsbIntervalMs,
                              geofencesEnabled: adsbGeofencesEnabled,
                            });
                          }}
                        />
                        <span />
                      </label>
                    </div>
                    <div className="config-row">
                      <span className="config-label">Feed URL</span>
                      <input
                        value={adsbFeedUrl}
                        onChange={(event) => setAdsbFeedUrl(event.target.value)}
                      />
                    </div>
                    <div className="config-row">
                      <span className="config-label">Poll interval (ms)</span>
                      <input
                        type="number"
                        min={2000}
                        value={adsbIntervalMs}
                        onChange={(event) => setAdsbIntervalMs(Number(event.target.value))}
                      />
                    </div>
                    <div className="config-row">
                      <span className="config-label">Trigger geofences</span>
                      <label className="switch" aria-label="Toggle ADS-B geofence integration">
                        <input
                          type="checkbox"
                          checked={adsbGeofencesEnabled}
                          onChange={(event) => setAdsbGeofencesEnabled(event.target.checked)}
                        />
                        <span />
                      </label>
                    </div>
                    <div className="config-row">
                      <span className="config-label">Mute ADS-B log updates</span>
                      <label
                        className="switch"
                        aria-label="Mute ADS-B updates in Terminal & Events"
                      >
                        <input type="checkbox" checked={adsbMuted} onChange={toggleAdsbMuted} />
                        <span />
                      </label>
                      <p className="form-hint">Suppress ADS-B info messages in the event feed.</p>
                    </div>
                    <div className="config-row">
                      <span className="config-label">Last poll</span>
                      <span>
                        {adsbStatus?.lastPollAt
                          ? new Date(adsbStatus.lastPollAt).toLocaleString()
                          : 'N/A'}
                      </span>
                    </div>
                    <div className="config-row">
                      <span className="config-label">Tracks</span>
                      <span>{adsbStatus?.trackCount ?? 0}</span>
                    </div>
                    {adsbStatus?.lastError ? (
                      <div className="form-error">Last error: {adsbStatus.lastError}</div>
                    ) : null}
                    {adsbTestError ? <div className="form-error">{adsbTestError}</div> : null}
                    {adsbTestMessage ? <div className="form-hint">{adsbTestMessage}</div> : null}
                    <div className="controls-row">
                      <button
                        type="button"
                        className="submit-button"
                        onClick={() =>
                          adsbConfigMutation.mutate({
                            enabled: adsbEnabled,
                            feedUrl: adsbFeedUrl,
                            intervalMs: adsbIntervalMs,
                            geofencesEnabled: adsbGeofencesEnabled,
                          })
                        }
                        disabled={adsbConfigMutation.isPending}
                      >
                        {adsbConfigMutation.isPending ? 'Saving...' : 'Save ADS-B settings'}
                      </button>
                      <button
                        type="button"
                        className="control-chip"
                        onClick={() => adsbStatusQuery.refetch()}
                        disabled={adsbStatusQuery.isFetching}
                      >
                        Refresh status
                      </button>
                      <button
                        type="button"
                        className="control-chip"
                        onClick={async () => {
                          setAdsbTestError(null);
                          setAdsbTestMessage(null);
                          setAdsbTesting(true);
                          const start = performance.now();
                          try {
                            const result = await fetchAdsbProxy();
                            const duration = performance.now() - start;
                            const aircraft = Array.isArray(result?.aircraft) ? result.aircraft : [];
                            setAdsbTestMessage(
                              `Feed reachable (${aircraft.length} aircraft) in ${duration.toFixed(0)}ms.`,
                            );
                          } catch (error) {
                            const message =
                              error instanceof Error
                                ? error.message
                                : 'Unable to reach ADS-B feed.';
                            setAdsbTestError(message);
                          } finally {
                            setAdsbTesting(false);
                          }
                        }}
                        disabled={adsbTesting}
                      >
                        {adsbTesting ? 'Testing...' : 'Test feed'}
                      </button>
                    </div>
                  </div>
                </section>

                <section className="config-card">
                  <header>
                    <h2>Aircraft database</h2>
                    <p>Upload the dump1090 aircraft-database.csv to enrich track details.</p>
                  </header>
                  <div className="config-card__body">
                    <div className="file-upload">
                      <label className="file-upload__button control-chip">
                        Choose file
                        <input
                          type="file"
                          accept=".csv,text/csv"
                          onChange={async (event) => {
                            const file = event.target.files?.[0];
                            if (!file) {
                              setSelectedFileName('No file selected');
                              return;
                            }
                            setSelectedFileName(file.name);
                            setUploadMessage(null);
                            setUploadError(null);
                            setUploading(true);
                            try {
                              await uploadAircraftDatabase(file);
                              setUploadMessage(`Uploaded ${file.name} successfully.`);
                            } catch (error) {
                              const message =
                                error instanceof Error
                                  ? error.message
                                  : 'Upload failed. Ensure the file is reachable and under the size limit.';
                              setUploadError(message);
                            } finally {
                              setUploading(false);
                              event.target.value = '';
                            }
                          }}
                          disabled={uploading}
                        />
                      </label>
                      <span className="file-upload__name">{selectedFileName}</span>
                    </div>
                    {uploadMessage ? <div className="form-hint">{uploadMessage}</div> : null}
                    {uploadError ? <div className="form-error">{uploadError}</div> : null}
                  </div>
                </section>
              </>
            ) : null}

            {activeSection === 'help' ? (
              <section className="config-card">
                <header>
                  <h2>Setup steps</h2>
                  <p>Minimal steps to get a feed running on common platforms.</p>
                </header>
                <div className="config-card__body">
                  <ul className="config-list">
                    <li>
                      <strong>Windows</strong>
                      <div className="config-hint">
                        Repo:{' '}
                        <a
                          href="https://github.com/gvanem/Dump1090"
                          target="_blank"
                          rel="noreferrer"
                        >
                          github.com/gvanem/Dump1090
                        </a>
                        <br />
                        Install RTL-SDR drivers (Zadig). Copy <code>dump1090.cfg</code> to{' '}
                        <code>dump1090-8090.cfg</code> and set <code>net-http-port = 8090</code>.
                        <br />
                        Run:{' '}
                        <code>
                          dump1090.exe --config dump1090-8090.cfg --device 0 --net --interactive
                        </code>
                        <br />
                        Feed: <code>http://127.0.0.1:8090/data/aircraft.json</code>
                      </div>
                    </li>
                    <li>
                      <strong>Set home position</strong>
                      <div className="config-hint">
                        In <code>dump1090-8090.cfg</code>, set your <code>homepos</code> to your
                        location (e.g. Levanger: <code>homepos = 63.7500000,11.3000000</code>) to
                        avoid the global-distance check failing.
                      </div>
                    </li>
                    <li>
                      <strong>macOS</strong>
                      <div className="config-hint">
                        Repo:{' '}
                        <a
                          href="https://github.com/antirez/dump1090"
                          target="_blank"
                          rel="noreferrer"
                        >
                          github.com/antirez/dump1090
                        </a>
                        <br />
                        Install: <code>brew install rtl-sdr dump1090</code>
                        <br />
                        Run: <code>dump1090 --interactive --net --net-http-port 8080</code>
                      </div>
                    </li>
                    <li>
                      <strong>Linux</strong>
                      <div className="config-hint">
                        Repo:{' '}
                        <a
                          href="https://github.com/wiedehopf/readsb"
                          target="_blank"
                          rel="noreferrer"
                        >
                          github.com/wiedehopf/readsb
                        </a>
                        <br />
                        Install: <code>apt install rtl-sdr dump1090-mutability</code> or use{' '}
                        <code>readsb</code>
                        <br />
                        Run: <code>dump1090 --interactive --net --net-http-port 8080</code>
                      </div>
                    </li>
                    <li>
                      <strong>Verify</strong>
                      <div className="config-hint">
                        Open <code>{adsbFeedUrl}</code> in your browser to confirm JSON is
                        available.
                      </div>
                    </li>
                  </ul>
                  <p className="config-hint">
                    For production, run dump1090/readsb as a service, and proxy the HTTP feed
                    through the backend to avoid CORS issues.
                  </p>
                </div>
              </section>
            ) : null}

            {activeSection === 'log' ? (
              <section className="config-card">
                <header className="config-card__header">
                  <div>
                    <h2>ADS-B Log</h2>
                    <p>Session log of all ADS-B aircraft seen.</p>
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
                        <th>ICAO</th>
                        <th>Callsign</th>
                        <th>Registration</th>
                        <th>Country</th>
                        <th>Category</th>
                        <th>Departure</th>
                        <th>Destination</th>
                        <th>Lat</th>
                        <th>Lon</th>
                        <th>Alt</th>
                        <th>Speed</th>
                        <th>Heading</th>
                        <th>Messages</th>
                        <th>First Seen</th>
                        <th>Last Seen</th>
                        <th>Hits</th>
                      </tr>
                    </thead>
                    <tbody>
                      {logEntries.map((entry) => (
                        <tr key={entry.icao}>
                          <td data-label="ICAO">{entry.icao}</td>
                          <td data-label="Callsign">{entry.callsign ?? '—'}</td>
                          <td data-label="Registration">{entry.reg ?? '—'}</td>
                          <td data-label="Country">{entry.country ?? '—'}</td>
                          <td data-label="Category">{entry.category ?? '—'}</td>
                          <td data-label="Departure">{entry.dep ?? '—'}</td>
                          <td data-label="Destination">{entry.dest ?? '—'}</td>
                          <td data-label="Lat">{entry.lat.toFixed(5)}</td>
                          <td data-label="Lon">{entry.lon.toFixed(5)}</td>
                          <td data-label="Alt">{entry.alt != null ? entry.alt.toFixed(0) : '—'}</td>
                          <td data-label="Speed">
                            {entry.speed != null ? entry.speed.toFixed(0) : '—'}
                          </td>
                          <td data-label="Heading">
                            {entry.heading != null ? entry.heading.toFixed(0) : '—'}
                          </td>
                          <td data-label="Messages">
                            {entry.messages != null ? entry.messages.toString() : '—'}
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
                      {logEntries.length === 0 ? (
                        <tr>
                          <td colSpan={15} className="muted">
                            No aircraft seen yet. Log populates as ADS-B tracks arrive.
                          </td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>
              </section>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}
