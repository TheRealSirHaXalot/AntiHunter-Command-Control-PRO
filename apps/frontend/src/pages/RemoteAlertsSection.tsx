import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toDataURL } from 'qrcode';
import { ReactNode, useEffect, useState } from 'react';
import { MdInfoOutline } from 'react-icons/md';

import { PushNotificationsCard, WebhooksSection } from './WebhooksSection';
import {
  AlertChannel,
  AlertTier,
  clearRemoteAlertSecret,
  eraseMatter,
  generateVapidKeys,
  getMatterInterfaces,
  getMatterStatus,
  fetchSignalLinkQr,
  getRemoteAlertConfig,
  getSignalSetup,
  getSignalStatus,
  getSignalUpdate,
  getTailscaleStatus,
  listAlertSources,
  listPushSubscriptions,
  RemoteAlertConfig,
  RemoteAlertConfigUpdate,
  removePushSubscription,
  restartMatter,
  testAlertChannel,
  updateRemoteAlertConfig,
} from '../api/remote-alerts';
import { useAuthStore } from '../stores/auth-store';

interface FormState {
  tailscaleEnabled: boolean;
  tsAuthKey: string;
  tsHostname: string;
  tsAllowedLogins: string;
  vapidSubject: string;
  ntfyEnabled: boolean;
  ntfyUrl: string;
  ntfyToken: string;
  signalEnabled: boolean;
  signalApiUrl: string;
  signalNumber: string;
  signalRecipients: string;
  matrixEnabled: boolean;
  matrixHomeserverUrl: string;
  matrixAccessToken: string;
  matrixRoomId: string;
  matterEnabled: boolean;
  matterLayout: 'bridge' | 'flat';
  matterInterface: string;
}

function toForm(config: RemoteAlertConfig): FormState {
  return {
    tailscaleEnabled: config.tailscaleEnabled,
    tsAuthKey: '',
    tsHostname: config.tsHostname ?? '',
    tsAllowedLogins: config.tsAllowedLogins.join('\n'),
    vapidSubject: config.vapidSubject ?? '',
    ntfyEnabled: config.ntfyEnabled,
    ntfyUrl: config.ntfyUrl ?? '',
    ntfyToken: '',
    signalEnabled: config.signalEnabled,
    signalApiUrl: config.signalApiUrl ?? '',
    signalNumber: config.signalNumber ?? '',
    signalRecipients: config.signalRecipients.join('\n'),
    matrixEnabled: config.matrixEnabled,
    matrixHomeserverUrl: config.matrixHomeserverUrl ?? '',
    matrixAccessToken: '',
    matrixRoomId: config.matrixRoomId ?? '',
    matterEnabled: config.matterEnabled,
    matterLayout: config.matterLayout,
    matterInterface: config.matterInterface ?? '',
  };
}

const lines = (value: string) =>
  value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);

const PAIRING_CODE_STYLE = {
  fontSize: '1.6rem',
  fontFamily: 'ui-monospace, monospace',
  letterSpacing: '0.08em',
  padding: '0.4rem 0.6rem',
};

function groupDigits(value: string | null | undefined, groups: number[]): string {
  const digits = (value ?? '').replace(/\D/g, '');
  const total = groups.reduce((sum, size) => sum + size, 0);
  if (digits.length !== total) {
    return value ?? '';
  }
  const parts: string[] = [];
  let index = 0;
  for (const size of groups) {
    parts.push(digits.slice(index, index + size));
    index += size;
  }
  return parts.join('-');
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function RemoteAlertsSection({ view = 'alerts' }: { view?: 'alerts' | 'access' }) {
  const isAdmin = useAuthStore((state) => state.user?.role === 'ADMIN');
  return (
    <div className="config-card__body remote-alerts">
      {view === 'alerts' ? <PushNotificationsCard /> : null}
      {isAdmin ? (
        <AdminCards view={view} />
      ) : (
        <p className="empty-state">Only administrators can change these settings.</p>
      )}
    </div>
  );
}

function AdminCards({ view }: { view: 'alerts' | 'access' }) {
  const queryClient = useQueryClient();
  const configQuery = useQuery({ queryKey: ['remote-alerts'], queryFn: getRemoteAlertConfig });
  const [form, setForm] = useState<FormState | null>(null);
  const [notice, setNotice] = useState<Record<string, string>>({});

  useEffect(() => {
    if (configQuery.data) {
      setForm((prev) => prev ?? toForm(configQuery.data));
    }
  }, [configQuery.data]);

  const saveMutation = useMutation({
    mutationFn: ({ patch }: { patch: RemoteAlertConfigUpdate; card: string }) =>
      updateRemoteAlertConfig(patch),
    onSuccess: (data, { card, patch }) => {
      queryClient.setQueryData(['remote-alerts'], data);
      const saved = toForm(data);
      setForm((prev) =>
        prev
          ? {
              ...prev,
              ...Object.fromEntries(
                Object.keys(patch)
                  .filter((key) => key in saved)
                  .map((key) => [key, saved[key as keyof FormState]]),
              ),
            }
          : saved,
      );
      queryClient.invalidateQueries({ queryKey: ['remote-alerts-matter'] });
      setNotice((prev) => ({ ...prev, [card]: 'Saved.' }));
    },
    onError: (error, { card }) => setNotice((prev) => ({ ...prev, [card]: errorText(error) })),
  });

  const testMutation = useMutation({
    mutationFn: (channel: AlertChannel) => testAlertChannel(channel),
    onSuccess: (_data, channel) => setNotice((prev) => ({ ...prev, [channel]: 'Test sent.' })),
    onError: (error, channel) => setNotice((prev) => ({ ...prev, [channel]: errorText(error) })),
  });

  const clearSecretMutation = useMutation({
    mutationFn: clearRemoteAlertSecret,
    onSuccess: (data) => queryClient.setQueryData(['remote-alerts'], data),
  });

  if (configQuery.isLoading || !form || !configQuery.data) {
    return (
      <p className="empty-state">
        {configQuery.error ? errorText(configQuery.error) : 'Loading settings...'}
      </p>
    );
  }

  const config = configQuery.data;
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  const save = (card: string, patch: RemoteAlertConfigUpdate) =>
    saveMutation.mutate({ card, patch });
  const busy = saveMutation.isPending || testMutation.isPending;
  const noticeFor = (key: string) =>
    notice[key] ? <p className="config-hint">{notice[key]}</p> : null;

  if (view === 'access') {
    return (
      <TailscaleAccessPanel
        config={config}
        form={form}
        set={set}
        save={save}
        busy={busy}
        noticeFor={noticeFor}
      />
    );
  }
  return (
    <>
      <AlertLevelsCard
        tiers={config.alertTiers ?? {}}
        coordsUnencrypted={config.coordsUnencrypted ?? false}
        busy={busy}
        onSave={(alertTiers, coordsUnencrypted) =>
          save('levels', { alertTiers, coordsUnencrypted })
        }
        notice={notice.levels}
      />

      <PushAdminCard
        config={config}
        onTest={() => testMutation.mutate('push')}
        busy={busy}
        notice={notice.push}
      />

      <ChannelRow
        title="Signal"
        on={config.signalEnabled && Boolean(config.signalNumber)}
        status={config.signalEnabled ? (config.signalNumber ? 'On' : 'Not linked') : 'Off'}
        hint="End-to-end encrypted. Link a dedicated Signal number; alerts go to a private AntiHunter group."
      >
        <label className="control-checkbox">
          <input
            type="checkbox"
            checked={form.signalEnabled}
            onChange={(event) => set('signalEnabled', event.target.checked)}
          />
          <span>Send alerts to Signal</span>
        </label>
        <SignalLink />
        <div className="controls-row">
          <button
            type="button"
            className="control-chip"
            disabled={busy}
            onClick={() => save('signal', { signalEnabled: form.signalEnabled })}
          >
            Save
          </button>
          <button
            type="button"
            className="control-chip control-chip--ghost"
            disabled={busy}
            onClick={() => testMutation.mutate('signal')}
          >
            Send test
          </button>
        </div>
        {noticeFor('signal')}
      </ChannelRow>

      <ChannelRow
        title="ntfy"
        on={config.ntfyEnabled && Boolean(config.ntfyUrl)}
        status={config.ntfyEnabled ? 'On' : 'Off'}
        hint="Publishes alerts to an ntfy topic."
      >
        <label className="control-checkbox">
          <input
            type="checkbox"
            checked={form.ntfyEnabled}
            onChange={(event) => set('ntfyEnabled', event.target.checked)}
          />
          <span>Send alerts to ntfy</span>
        </label>
        <div className="form-grid">
          <label>
            <FieldLabel
              text="Topic URL"
              help="The full address of your ntfy topic. It must start with https://, unless ntfy runs on this machine."
            />
            <input
              className="control-input"
              value={form.ntfyUrl}
              placeholder="https://ntfy.example.com/ahcc-alerts"
              onChange={(event) => set('ntfyUrl', event.target.value)}
            />
          </label>
          <label>
            <FieldLabel
              text="Access token (optional)"
              help="Only needed if the topic requires a login. Create a token in your ntfy account settings."
            />
            <input
              className="control-input"
              type="password"
              autoComplete="off"
              value={form.ntfyToken}
              placeholder={
                config.hasNtfyToken ? 'Saved (leave blank to keep)' : 'Only for protected topics'
              }
              onChange={(event) => set('ntfyToken', event.target.value)}
            />
          </label>
        </div>
        <div className="controls-row">
          <button
            type="button"
            className="control-chip"
            disabled={busy}
            onClick={() => {
              save('ntfy', {
                ntfyEnabled: form.ntfyEnabled,
                ntfyUrl: form.ntfyUrl,
                ntfyToken: form.ntfyToken,
              });
              set('ntfyToken', '');
            }}
          >
            Save
          </button>
          <button
            type="button"
            className="control-chip control-chip--ghost"
            disabled={busy}
            onClick={() => testMutation.mutate('ntfy')}
          >
            Send test
          </button>
          {config.hasNtfyToken && (
            <button
              type="button"
              className="control-chip control-chip--danger"
              onClick={() => clearSecretMutation.mutate('ntfyToken')}
            >
              Remove token
            </button>
          )}
        </div>
        {noticeFor('ntfy')}
      </ChannelRow>

      <ChannelRow
        title="Matrix"
        on={config.matrixEnabled && config.hasMatrixAccessToken}
        status={config.matrixEnabled ? 'On' : 'Off'}
        hint="Your own homeserver, not end-to-end encrypted. Enter homeserver, room and a bot token."
      >
        <label className="control-checkbox">
          <input
            type="checkbox"
            checked={form.matrixEnabled}
            onChange={(event) => set('matrixEnabled', event.target.checked)}
          />
          <span>Send alerts to Matrix</span>
        </label>
        <div className="form-grid">
          <label>
            <FieldLabel text="Homeserver URL" help="The https:// address of your Matrix server." />
            <input
              className="control-input"
              value={form.matrixHomeserverUrl}
              placeholder="https://matrix.example.com"
              onChange={(event) => set('matrixHomeserverUrl', event.target.value)}
            />
          </label>
          <label>
            <FieldLabel
              text="Room ID"
              help="The room's internal ID, which starts with !. In Element, open Room settings → Advanced."
            />
            <input
              className="control-input"
              value={form.matrixRoomId}
              placeholder="!abc123:example.com"
              onChange={(event) => set('matrixRoomId', event.target.value)}
            />
          </label>
        </div>
        <label className="form-field">
          <FieldLabel
            text="Bot access token"
            help="The token of the account that posts alerts. That account must already be in the room. In Element, open Settings → Help & About."
          />
          <input
            className="control-input"
            type="password"
            autoComplete="off"
            value={form.matrixAccessToken}
            placeholder={config.hasMatrixAccessToken ? 'Saved (leave blank to keep)' : ''}
            onChange={(event) => set('matrixAccessToken', event.target.value)}
          />
        </label>
        <div className="controls-row">
          <button
            type="button"
            className="control-chip"
            disabled={busy}
            onClick={() => {
              save('matrix', {
                matrixEnabled: form.matrixEnabled,
                matrixHomeserverUrl: form.matrixHomeserverUrl,
                matrixRoomId: form.matrixRoomId,
                matrixAccessToken: form.matrixAccessToken,
              });
              set('matrixAccessToken', '');
            }}
          >
            Save
          </button>
          <button
            type="button"
            className="control-chip control-chip--ghost"
            disabled={busy}
            onClick={() => testMutation.mutate('matrix')}
          >
            Send test
          </button>
          {config.hasMatrixAccessToken && (
            <button
              type="button"
              className="control-chip control-chip--danger"
              onClick={() => clearSecretMutation.mutate('matrixAccessToken')}
            >
              Remove token
            </button>
          )}
        </div>
        {noticeFor('matrix')}
      </ChannelRow>

      <section className="remote-subsection">
        <div className="channel-row__head">
          <h3>Webhooks</h3>
        </div>
        <p className="field-hint">
          Discord, Slack, IFTTT or Home Assistant. Pick a preset and paste the URL.
        </p>
        <WebhooksSection />
      </section>

      <MatterCard
        enabled={form.matterEnabled}
        onEnabled={(value) => set('matterEnabled', value)}
        networkInterface={form.matterInterface}
        onNetworkInterface={(value) => set('matterInterface', value)}
        onSave={() =>
          save('matter', {
            matterEnabled: form.matterEnabled,
            matterInterface: form.matterInterface,
          })
        }
        onTest={() => testMutation.mutate('matter')}
        busy={busy}
        notice={notice.matter}
      />
    </>
  );
}

function FieldLabel({ text, help }: { text: string; help: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <span>
        {text}
        <button
          type="button"
          className="info-button"
          aria-label={`About ${text}`}
          aria-expanded={open}
          onClick={(event) => {
            event.preventDefault();
            setOpen((value) => !value);
          }}
        >
          <MdInfoOutline aria-hidden />
        </button>
      </span>
      {open && <span className="field-help">{help}</span>}
    </>
  );
}

function ChannelRow(props: {
  title: string;
  status: string;
  on: boolean;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="remote-subsection">
      <div className="channel-row__head">
        <h3>{props.title}</h3>
        <span className={props.on ? 'badge badge--active' : 'badge'}>{props.status}</span>
      </div>
      {props.hint && <p className="field-hint">{props.hint}</p>}
      {props.children}
    </section>
  );
}

function TailscaleAccessPanel({
  config,
  form,
  set,
  save,
  busy,
  noticeFor,
}: {
  config: RemoteAlertConfig;
  form: FormState;
  set: <K extends keyof FormState>(key: K, value: FormState[K]) => void;
  save: (card: string, patch: RemoteAlertConfigUpdate) => void;
  busy: boolean;
  noticeFor: (key: string) => React.ReactNode;
}) {
  const statusQuery = useQuery({
    queryKey: ['tailscale-status'],
    queryFn: getTailscaleStatus,
  });

  if (statusQuery.isLoading) return null;
  if (statusQuery.data && !statusQuery.data.available) return null;

  return (
    <ChannelRow
      title="Remote access (Tailscale)"
      on={config.tailscaleEnabled}
      hint="Reach AHCC over your tailnet. Only the listed logins can connect."
      status={config.tailscaleEnabled ? 'On' : 'Off'}
    >
      <label className="control-checkbox">
        <input
          type="checkbox"
          checked={form.tailscaleEnabled}
          onChange={(event) => set('tailscaleEnabled', event.target.checked)}
        />
        <span>Enable remote access</span>
      </label>
      <TailscaleStatus enabled={config.tailscaleEnabled} />
      <label className="form-field">
        <FieldLabel
          text="Tailscale auth key"
          help="A one-time key that adds AHCC to your tailnet. Create it with Reusable off and the tag:ahcc tag. AHCC deletes the key once it has joined."
        />
        <input
          className="control-input"
          type="password"
          autoComplete="off"
          value={form.tsAuthKey}
          placeholder={
            config.hasTsAuthKey
              ? 'Saved (leave blank to keep)'
              : statusQuery.data?.enrolled
                ? 'Joined. Key deleted.'
                : 'tskey-auth-…'
          }
          onChange={(event) => set('tsAuthKey', event.target.value)}
        />
      </label>
      <p className="config-hint">
        Get a key at{' '}
        <a href="https://login.tailscale.com/admin/settings/keys" target="_blank" rel="noreferrer">
          Tailscale → Settings → Keys
        </a>{' '}
        — click &quot;Generate auth key&quot;, turn on <strong>Tags</strong> and pick{' '}
        <code>tag:ahcc</code>.
      </p>
      <label className="form-field">
        <FieldLabel
          text="Hostname on the tailnet"
          help="The machine name AHCC gets on your tailnet. The default is ahcc."
        />
        <input
          className="control-input"
          value={form.tsHostname}
          placeholder="ahcc"
          onChange={(event) => set('tsHostname', event.target.value)}
        />
      </label>
      <label className="form-field">
        <FieldLabel
          text="Allowed Tailscale logins"
          help="The Tailscale logins that may open AHCC, one per line. Everyone else is refused, and an empty list refuses everyone. People still sign in to AHCC after this."
        />
        <textarea
          className="control-input"
          rows={3}
          value={form.tsAllowedLogins}
          placeholder="you@example.com"
          onChange={(event) => set('tsAllowedLogins', event.target.value)}
        />
      </label>
      <div className="controls-row">
        <button
          type="button"
          className="control-chip"
          disabled={busy}
          onClick={() => {
            save('tailscale', {
              tailscaleEnabled: form.tailscaleEnabled,
              tsAuthKey: form.tsAuthKey,
              tsHostname: form.tsHostname,
              tsAllowedLogins: lines(form.tsAllowedLogins),
            });
            set('tsAuthKey', '');
          }}
        >
          Save
        </button>
      </div>
      {noticeFor('tailscale')}
    </ChannelRow>
  );
}

function TailscaleStatus({ enabled }: { enabled: boolean }) {
  const query = useQuery({
    queryKey: ['tailscale-status'],
    queryFn: getTailscaleStatus,
    enabled,
    refetchInterval: enabled ? 4_000 : false,
  });
  if (!enabled) {
    return null;
  }
  const s = query.data;
  if (!s) {
    return <p className="config-hint">Checking…</p>;
  }
  if (s.running) {
    const url = s.dnsName ? `${s.https ? 'https' : 'http'}://${s.dnsName}` : null;
    return (
      <>
        <p className="config-hint">
          Connected
          {s.tailnet ? ` to ${s.tailnet}` : ''}.{' '}
          {url ? (
            <>
              Open AHCC at{' '}
              <a href={url} target="_blank" rel="noreferrer">
                {url}
              </a>
            </>
          ) : null}
          {s.ip ? (
            <>
              {' '}
              or{' '}
              <a href={`http://${s.ip}`} target="_blank" rel="noreferrer">
                http://{s.ip}
              </a>
            </>
          ) : null}
        </p>
        {s.https ? null : (
          <p className="config-hint">
            For https and phone alerts, turn on HTTPS Certificates in{' '}
            <a href="https://login.tailscale.com/admin/dns" target="_blank" rel="noreferrer">
              Tailscale → DNS
            </a>
            .
          </p>
        )}
      </>
    );
  }
  if (s.lastError) {
    return (
      <>
        {s.dnsName ? (
          <p className="config-hint">
            Address: <code>https://{s.dnsName}</code>
          </p>
        ) : null}
        <p className="config-hint config-hint--warn">{s.lastError}</p>
      </>
    );
  }
  if (s.connecting) {
    return <p className="config-hint">Joining the tailnet…</p>;
  }
  return (
    <p className="config-hint">Not running{s.lastExit ? ` — last exit: ${s.lastExit}` : ''}.</p>
  );
}

function SignalLink() {
  const statusQuery = useQuery({
    queryKey: ['remote-alerts-signal'],
    queryFn: getSignalStatus,
    refetchInterval: (query) => (query.state.data?.linkedNumber ? false : 4_000),
  });
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const status = statusQuery.data;

  useEffect(() => {
    if (status?.linkedNumber && qrUrl) {
      URL.revokeObjectURL(qrUrl);
      setQrUrl(null);
    }
  }, [status?.linkedNumber, qrUrl]);

  if (!status) {
    return <p className="config-hint">Checking Signal…</p>;
  }
  if (!status.reachable) {
    return <SignalSetup />;
  }
  if (status.linkedNumber) {
    return (
      <div className="form-field">
        <p className="config-hint">Linked. Alerts go to the “AntiHunter Alerts” group.</p>
        {status.managed && <SignalUpdateCheck />}
        <SignalConnectorControls />
      </div>
    );
  }
  return (
    <div className="form-field">
      <p className="config-hint config-hint--warn">
        Linking adds AHCC as a Signal device on this account. Use a dedicated Signal number, not
        your personal one. Keep the connector on the AHCC host only.
      </p>
      {qrUrl ? (
        <>
          <img src={qrUrl} alt="Signal link QR code" width={200} height={200} />
          <p className="config-hint">Signal → Settings → Linked devices → + → scan.</p>
        </>
      ) : (
        <button
          type="button"
          className="control-chip"
          onClick={() => {
            setError(null);
            fetchSignalLinkQr()
              .then((blob) => setQrUrl(URL.createObjectURL(blob)))
              .catch((err) => setError(errorText(err)));
          }}
        >
          Link Signal
        </button>
      )}
      {error && <p className="config-hint">{error}</p>}
      <SignalConnectorControls />
    </div>
  );
}

function SignalConnectorControls() {
  const query = useQuery({ queryKey: ['signal-setup'], queryFn: getSignalSetup });
  const [copied, setCopied] = useState<string | null>(null);
  const controls = query.data?.controls;
  if (!controls) {
    return null;
  }
  const copy = (label: string, cmd: string) => {
    void navigator.clipboard?.writeText(cmd);
    setCopied(label);
    window.setTimeout(() => setCopied((current) => (current === label ? null : current)), 1500);
  };
  return (
    <div className="form-field">
      <p className="config-hint">Connector (Docker) — copy a command to run on the AHCC host:</p>
      <div className="controls-row">
        {(['start', 'stop', 'restart'] as const).map((action) => (
          <button
            key={action}
            type="button"
            className="control-chip control-chip--ghost"
            onClick={() => copy(action, controls[action])}
          >
            {copied === action ? 'Copied' : `Copy ${action}`}
          </button>
        ))}
      </div>
    </div>
  );
}

function SignalSetup() {
  const query = useQuery({ queryKey: ['signal-setup'], queryFn: getSignalSetup });
  if (!query.data) {
    return <p className="config-hint">Checking this host…</p>;
  }
  const { platform, arch, supported, steps } = query.data;
  return (
    <div className="form-field">
      <p className="config-hint">
        {supported
          ? 'Getting signal-cli ready…'
          : `This host (${platform}/${arch}) can't self-run signal-cli. Start the connector in Docker — AHCC finds it automatically:`}
      </p>
      <ol className="config-steps">
        {steps.map((step, index) => (
          <li key={index}>
            {step.url ? (
              <a href={step.url} target="_blank" rel="noreferrer">
                {step.text}
              </a>
            ) : (
              step.text
            )}
            {step.cmd && <code>{step.cmd}</code>}
          </li>
        ))}
      </ol>
    </div>
  );
}

function SignalUpdateCheck() {
  const [info, setInfo] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: getSignalUpdate,
    onSuccess: (data) =>
      setInfo(
        data.updateAvailable && data.latest
          ? `signal-cli ${data.current} installed; ${data.latest} available (applied on the next AHCC update)`
          : `signal-cli ${data.current} — up to date`,
      ),
    onError: () => setInfo('Could not check for updates'),
  });
  return (
    <div className="form-field">
      <button
        type="button"
        className="control-chip control-chip--ghost"
        disabled={mutation.isPending}
        onClick={() => mutation.mutate()}
      >
        Check for updates
      </button>
      {info && <p className="config-hint">{info}</p>}
    </div>
  );
}

function AlertLevelsCard(props: {
  tiers: Record<string, AlertTier>;
  coordsUnencrypted: boolean;
  busy: boolean;
  onSave: (tiers: Record<string, AlertTier>, coordsUnencrypted: boolean) => void;
  notice?: string;
}) {
  const [coords, setCoords] = useState(props.coordsUnencrypted);
  useEffect(() => setCoords(props.coordsUnencrypted), [props.coordsUnencrypted]);
  const sourcesQuery = useQuery({
    queryKey: ['remote-alerts-sources', props.tiers],
    queryFn: listAlertSources,
  });
  const [draft, setDraft] = useState<Record<string, AlertTier>>({});
  useEffect(() => {
    const next: Record<string, AlertTier> = {};
    for (const source of sourcesQuery.data ?? []) {
      next[source.key] = source.tier;
    }
    setDraft(next);
  }, [sourcesQuery.data]);

  const rows = sourcesQuery.data ?? [];
  const groups = [...new Set(rows.map((row) => row.group))];
  const setTier = (key: string, tier: AlertTier) => setDraft((prev) => ({ ...prev, [key]: tier }));

  return (
    <section className="remote-subsection">
      <div className="channel-row__head">
        <h3>Alert sources</h3>
      </div>
      <p className="field-hint">Notify: normal alert. Critical: alert marked critical.</p>
      <div>
        <div className="table-scroll">
          <table className="data-table alert-sources-table">
            <thead>
              <tr>
                <th>Source</th>
                <th>Notify</th>
                <th>Critical</th>
              </tr>
            </thead>
            {groups.map((group) => (
              <tbody key={group}>
                <tr className="alert-group-row">
                  <td colSpan={3}>{group}</td>
                </tr>
                {rows
                  .filter((row) => row.group === group)
                  .map((row) => {
                    const tier = draft[row.key] ?? 'off';
                    return (
                      <tr key={row.key}>
                        <td>{row.label}</td>
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`Notify: ${row.label}`}
                            checked={tier === 'alert'}
                            onChange={(event) =>
                              setTier(row.key, event.target.checked ? 'alert' : 'off')
                            }
                          />
                        </td>
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`Critical: ${row.label}`}
                            checked={tier === 'critical'}
                            onChange={(event) =>
                              setTier(row.key, event.target.checked ? 'critical' : 'off')
                            }
                          />
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            ))}
          </table>
        </div>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={coords}
            onChange={(event) => setCoords(event.target.checked)}
          />
          Include GPS coordinates in ntfy, Matrix and webhooks (not encrypted)
        </label>
        <div className="controls-row">
          <button
            type="button"
            className="control-chip"
            disabled={props.busy}
            onClick={() => props.onSave(draft, coords)}
          >
            Save levels
          </button>
        </div>
        {props.notice && <p className="config-hint">{props.notice}</p>}
      </div>
    </section>
  );
}

function PushAdminCard(props: {
  config: RemoteAlertConfig;
  onTest: () => void;
  busy: boolean;
  notice?: string;
}) {
  const queryClient = useQueryClient();
  const subsQuery = useQuery({
    queryKey: ['remote-alerts-push-subs'],
    queryFn: listPushSubscriptions,
  });
  const generateMutation = useMutation({
    mutationFn: generateVapidKeys,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['remote-alerts'] });
      queryClient.invalidateQueries({ queryKey: ['remote-alerts-push-subs'] });
    },
  });
  const removeMutation = useMutation({
    mutationFn: removePushSubscription,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['remote-alerts-push-subs'] }),
  });
  const configured = Boolean(props.config.vapidPublicKey && props.config.hasVapidPrivateKey);

  return (
    <ChannelRow
      title="Phone push"
      on={Boolean(subsQuery.data?.length)}
      status={subsQuery.data?.length ? `${subsQuery.data.length} device(s)` : 'No devices'}
      hint="Registered devices and keys."
    >
      <div>
        <div className="controls-row">
          <button
            type="button"
            className="control-chip control-chip--ghost"
            disabled={!configured || props.busy}
            onClick={props.onTest}
          >
            Send test to all devices
          </button>
          {configured && (
            <button
              type="button"
              className="control-chip control-chip--danger"
              disabled={generateMutation.isPending}
              onClick={() => {
                if (window.confirm('Sign out all devices from push?')) {
                  generateMutation.mutate();
                }
              }}
            >
              Reset keys
            </button>
          )}
        </div>
        {generateMutation.error && (
          <p className="config-hint">{errorText(generateMutation.error)}</p>
        )}
        {props.notice && <p className="config-hint">{props.notice}</p>}
        {subsQuery.data && subsQuery.data.length > 0 && (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Service</th>
                  <th>Added</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {subsQuery.data.map((sub) => (
                  <tr key={sub.endpoint}>
                    <td>{sub.userEmail}</td>
                    <td>{sub.service}</td>
                    <td>{new Date(sub.createdAt).toLocaleString()}</td>
                    <td>
                      <button
                        type="button"
                        className="control-chip control-chip--danger"
                        onClick={() => removeMutation.mutate(sub.endpoint)}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </ChannelRow>
  );
}

function MatterCard(props: {
  enabled: boolean;
  onEnabled: (value: boolean) => void;
  networkInterface: string;
  onNetworkInterface: (value: string) => void;
  onSave: () => void;
  onTest: () => void;
  busy: boolean;
  notice?: string;
}) {
  const queryClient = useQueryClient();
  const statusQuery = useQuery({
    queryKey: ['remote-alerts-matter'],
    queryFn: getMatterStatus,
    refetchInterval: 5_000,
  });
  const interfacesQuery = useQuery({
    queryKey: ['remote-alerts-matter-interfaces'],
    queryFn: getMatterInterfaces,
  });
  const interfaces = interfacesQuery.data ?? [];
  const savedMissing =
    props.networkInterface !== '' &&
    !interfaces.some((entry) => entry.name === props.networkInterface);
  const restartMutation = useMutation({
    mutationFn: restartMatter,
    onSuccess: (data) => queryClient.setQueryData(['remote-alerts-matter'], data),
  });
  const eraseMutation = useMutation({
    mutationFn: eraseMatter,
    onSuccess: (data) => queryClient.setQueryData(['remote-alerts-matter'], data),
  });
  const status = statusQuery.data;
  const qrPayload = status?.qrPairingCode ?? null;
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [showPairing, setShowPairing] = useState(false);
  useEffect(() => {
    if (!qrPayload) {
      setQrDataUrl(null);
      return;
    }
    let stale = false;
    void toDataURL(qrPayload, { margin: 1, width: 200 }).then((url) => {
      if (!stale) {
        setQrDataUrl(url);
      }
    });
    return () => {
      stale = true;
    };
  }, [qrPayload]);
  const state = !status
    ? 'unknown'
    : !status.running
      ? 'stopped'
      : status.commissioned
        ? 'paired'
        : status.commissioned === false
          ? 'waiting to pair'
          : 'starting';

  return (
    <ChannelRow
      title="Apple Home / Google Home"
      on={state === 'paired'}
      status={state}
      hint="Shows AntiHunter as occupancy sensors in Apple/Google Home. Needs a home hub; scan the code to pair."
    >
      <div>
        <label className="control-checkbox">
          <input
            type="checkbox"
            checked={props.enabled}
            onChange={(event) => props.onEnabled(event.target.checked)}
          />
          <span>On</span>
        </label>
        <label className="form-field">
          <FieldLabel
            text="Network"
            help="The network AHCC announces itself on. Pick the one your home hub is on."
          />
          <select
            className="control-input"
            value={props.networkInterface}
            onChange={(event) => props.onNetworkInterface(event.target.value)}
          >
            <option value="">Automatic</option>
            {savedMissing && (
              <option value={props.networkInterface}>{props.networkInterface} (not found)</option>
            )}
            {interfaces.map((entry) => (
              <option key={entry.name} value={entry.name}>
                {entry.name} — {entry.addresses.join(', ')}
              </option>
            ))}
          </select>
        </label>
        {props.enabled && state === 'stopped' && (
          <p className="config-hint">
            Matter isn’t running. On a server install it starts on its own when enabled; pairing
            needs a home hub (Apple TV, HomePod, Nest, or Echo). If it keeps stopping, check the
            backend logs.
          </p>
        )}
        {state === 'starting' && <p className="config-hint">Starting the Matter service…</p>}
        {state === 'paired' && (
          <p className="config-hint">
            Paired. AntiHunter shows as occupancy sensors in your Home app.
          </p>
        )}
        {status?.running && status.commissioned === false && !showPairing && (
          <button
            type="button"
            className="control-chip control-chip--ghost"
            style={{ margin: '0.5rem 0' }}
            onClick={() => setShowPairing(true)}
          >
            Show pairing code
          </button>
        )}
        {status?.running && status.commissioned === false && showPairing && (
          <div className="form-field">
            {qrDataUrl && (
              <>
                <img src={qrDataUrl} alt="Matter pairing QR code" width={200} height={200} />
                <details className="config-hint">
                  <summary>How to pair</summary>
                  Home app → + → Add Accessory → scan (or More options… → AntiHunter → enter the
                  setup code) → accept the uncertified accessory → assign the AntiHunter alert
                  sensors and bridge.
                </details>
              </>
            )}
            <div className="form-grid">
              <label>
                <span>Setup code</span>
                <input
                  className="control-input"
                  style={PAIRING_CODE_STYLE}
                  readOnly
                  value={groupDigits(status.manualPairingCode, [4, 3, 4])}
                />
              </label>
              <label>
                <span>Passcode</span>
                <input
                  className="control-input"
                  style={PAIRING_CODE_STYLE}
                  readOnly
                  value={groupDigits(
                    status.passcode == null ? null : String(status.passcode).padStart(8, '0'),
                    [3, 2, 3],
                  )}
                />
              </label>
            </div>
          </div>
        )}
        {status?.lastExit && state === 'stopped' && (
          <p className="config-hint">Last stop: {status.lastExit}</p>
        )}
        <div className="controls-row">
          <button
            type="button"
            className="control-chip"
            disabled={props.busy}
            onClick={props.onSave}
          >
            Save
          </button>
          <button
            type="button"
            className="control-chip control-chip--ghost"
            disabled={!status?.running || props.busy}
            onClick={props.onTest}
          >
            Test
          </button>
          <button
            type="button"
            className="control-chip control-chip--ghost"
            disabled={restartMutation.isPending}
            onClick={() => restartMutation.mutate()}
          >
            Restart
          </button>
          <button
            type="button"
            className="control-chip control-chip--danger"
            disabled={!status?.running || eraseMutation.isPending}
            onClick={() => {
              if (window.confirm('Unpair from all homes?')) {
                eraseMutation.mutate();
              }
            }}
          >
            Reset pairing
          </button>
        </div>
        {props.notice && <p className="config-hint">{props.notice}</p>}
      </div>
    </ChannelRow>
  );
}
