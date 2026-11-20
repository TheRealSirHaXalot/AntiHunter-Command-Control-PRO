import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormEvent, useEffect, useMemo, useState } from 'react';
import { MdAdd, MdDelete, MdLink, MdRefresh } from 'react-icons/md';

import {
  currentPushSubscription,
  disablePush,
  enablePush,
  pushSupported,
  sendTestPush,
} from '../api/push';
import type { Webhook } from '../api/types';
import {
  createWebhook,
  deleteWebhook,
  listWebhooks,
  testWebhook,
  updateWebhook,
} from '../api/webhooks';
import { useAuthStore } from '../stores/auth-store';

type WebhookFormMode = 'create' | 'edit';

interface WebhookFormState {
  id?: string;
  presetKey: string;
  name: string;
  url: string;
  secret: string;
  enabled: boolean;
  shareWithEveryone: boolean;
  verifyTls: boolean;
  clientCertificate: string;
  clientKey: string;
  caBundle: string;
}

const DEFAULT_FORM_STATE: WebhookFormState = {
  presetKey: '',
  name: '',
  url: '',
  secret: '',
  enabled: true,
  shareWithEveryone: false,
  verifyTls: true,
  clientCertificate: '',
  clientKey: '',
  caBundle: '',
};

const WEBHOOK_PRESETS = [
  {
    key: 'discord',
    label: 'Discord',
    url: 'https://discord.com/api/webhooks/<id>/<token>',
    hint: 'Discord: Server Settings > Integrations > Webhooks > Copy Webhook URL. Posts the alert summary as the message.',
  },
  {
    key: 'slack',
    label: 'Slack',
    url: 'https://hooks.slack.com/services/<path>',
    hint: 'Slack: create an Incoming Webhook for a channel and paste its URL.',
  },
  {
    key: 'ifttt',
    label: 'IFTTT',
    url: 'https://maker.ifttt.com/trigger/<event>/json/with/key/<key>',
    hint: 'IFTTT: Webhooks service > "Receive a web request". Replace <event> and <key>. In the applet, Value1 is the alert text, Value2 the severity, Value3 the MAC.',
  },
  {
    key: 'home-assistant',
    label: 'Home Assistant / Apple Home',
    url: 'https://<home-assistant-host>/api/webhook/<webhook_id>',
    hint: 'Home Assistant: automation with a Webhook trigger; use trigger.json.summary, trigger.json.rule.severity, trigger.json.data.mac. Apple Home: expose the resulting HA entity through the HomeKit Bridge integration.',
  },
] as const;

export function PushNotificationsCard() {
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const supported = pushSupported();

  useEffect(() => {
    if (!supported) {
      return;
    }
    void currentPushSubscription()
      .then(async (sub) => {
        if (sub && Notification.permission === 'granted') {
          await enablePush();
        }
      })
      .catch((error: unknown) => setStatus(error instanceof Error ? error.message : String(error)))
      .finally(() => {
        void currentPushSubscription().then((sub) => setSubscribed(Boolean(sub)));
      });
  }, [supported]);

  const run = async (action: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setStatus(null);
    try {
      await action();
      setSubscribed(Boolean(await currentPushSubscription()));
      setStatus(done);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const handleTest = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const result = await sendTestPush();
      if (!result.configured) {
        setStatus('Push is not configured on the server.');
      } else if (result.failed > 0) {
        const first = result.failures[0];
        setStatus(
          `Push service rejected it (${first?.status ?? 'error'}): ${first?.message ?? 'unknown'}.`,
        );
      } else if (result.sent === 0) {
        setStatus('No subscribed device for your account. Enable it here first.');
      } else {
        setStatus(
          `Accepted for ${result.sent} device(s). If nothing appears, the block is in macOS notification settings or Focus.`,
        );
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="remote-subsection">
      <div className="channel-row__head">
        <h3>Alerts on this device</h3>
        <span className={subscribed ? 'badge badge--active' : 'badge'}>
          {subscribed ? 'On' : supported ? 'Off' : 'Unavailable'}
        </span>
      </div>
      <p className="field-hint">Encrypted push alerts to this browser, even when it is closed.</p>
      <div>
        {!supported ? (
          <p className="empty-state">
            Device push is not available here. It needs a secure page (HTTPS or localhost) and a
            browser that supports web push. If you opened AHCC by http:// IP, switch to HTTPS or
            MagicDNS and this button appears.
          </p>
        ) : (
          <div className="controls-row">
            {subscribed ? (
              <>
                <button type="button" className="control-chip" disabled={busy} onClick={handleTest}>
                  Send test
                </button>
                <button
                  type="button"
                  className="control-chip control-chip--ghost"
                  disabled={busy}
                  onClick={() => run(disablePush, 'Disabled on this device.')}
                >
                  Disable
                </button>
              </>
            ) : (
              <button
                type="button"
                className="control-chip"
                disabled={busy || subscribed === null}
                onClick={() => run(enablePush, 'Enabled on this device.')}
              >
                Enable on this device
              </button>
            )}
          </div>
        )}
        {status && <p className="config-hint">{status}</p>}
      </div>
    </section>
  );
}

export function WebhooksSection() {
  const queryClient = useQueryClient();
  const role = useAuthStore((state) => state.user?.role ?? 'VIEWER');
  const [formMode, setFormMode] = useState<WebhookFormMode>('create');
  const [formState, setFormState] = useState<WebhookFormState>({ ...DEFAULT_FORM_STATE });

  const webhooksQuery = useQuery({
    queryKey: ['webhooks'],
    queryFn: listWebhooks,
    staleTime: 30_000,
  });

  const createMutation = useMutation({
    mutationFn: createWebhook,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['webhooks'] });
      setFormState({ ...DEFAULT_FORM_STATE });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: Partial<WebhookFormState> }) =>
      updateWebhook(id, payload),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['webhooks'] }),
  });

  const deleteMutation = useMutation({
    mutationFn: deleteWebhook,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['webhooks'] });
      setFormMode('create');
      setFormState({ ...DEFAULT_FORM_STATE });
    },
  });

  const testMutation = useMutation({
    mutationFn: testWebhook,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['webhooks'] }),
  });

  const selectedWebhook = useMemo(() => {
    if (!formState.id) {
      return null;
    }
    return webhooksQuery.data?.find((hook) => hook.id === formState.id) ?? null;
  }, [formState.id, webhooksQuery.data]);

  const handleSelect = (webhook: Webhook) => {
    setFormMode('edit');
    setFormState({
      id: webhook.id,
      presetKey: '',
      name: webhook.name,
      url: webhook.url,
      secret: '',
      enabled: webhook.enabled,
      shareWithEveryone: webhook.shared,
      verifyTls: webhook.verifyTls ?? true,
      clientCertificate: webhook.clientCertificate ?? '',
      clientKey: webhook.clientKey ?? '',
      caBundle: webhook.caBundle ?? '',
    });
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (formMode === 'create') {
      createMutation.mutate({
        name: formState.name,
        url: formState.url,
        secret: formState.secret || undefined,
        enabled: formState.enabled,
        shareWithEveryone: formState.shareWithEveryone,
        verifyTls: formState.verifyTls,
        clientCertificate: formState.clientCertificate,
        clientKey: formState.clientKey,
        caBundle: formState.caBundle,
      });
    } else if (formState.id) {
      updateMutation.mutate({
        id: formState.id,
        payload: {
          name: formState.name,
          url: formState.url,
          secret: formState.secret || undefined,
          enabled: formState.enabled,
          shareWithEveryone: formState.shareWithEveryone,
          verifyTls: formState.verifyTls,
          clientCertificate: formState.clientCertificate,
          clientKey: formState.clientKey,
          caBundle: formState.caBundle,
        },
      });
    }
  };

  const handleReset = () => {
    setFormMode('create');
    setFormState({ ...DEFAULT_FORM_STATE });
  };

  const handleDelete = () => {
    if (formState.id) {
      deleteMutation.mutate(formState.id);
    }
  };

  const handleTest = (id: string) => {
    testMutation.mutate(id);
  };

  const applyPreset = (key: string) => {
    const preset = WEBHOOK_PRESETS.find((item) => item.key === key);
    setFormState((prev) =>
      preset
        ? {
            ...prev,
            presetKey: key,
            name: preset.label,
            url: preset.url,
          }
        : { ...prev, presetKey: '', url: '' },
    );
  };

  const activePreset = WEBHOOK_PRESETS.find((item) => item.key === formState.presetKey);

  return (
    <div className="config-grid webhooks-stack">
      <article className="config-card">
        <header>
          <h3>Registered webhooks</h3>
          <button
            type="button"
            className="control-chip control-chip--ghost"
            onClick={() => queryClient.invalidateQueries({ queryKey: ['webhooks'] })}
          >
            <MdRefresh /> Refresh
          </button>
        </header>
        <div className="config-card__body">
          {webhooksQuery.isLoading ? (
            <p className="empty-state">Loading webhooks...</p>
          ) : webhooksQuery.data && webhooksQuery.data.length > 0 ? (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>URL</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {webhooksQuery.data.map((webhook) => (
                    <tr key={webhook.id}>
                      <td>{webhook.name}</td>
                      <td>{webhook.url}</td>
                      <td>{webhook.enabled ? 'Enabled' : 'Disabled'}</td>
                      <td className="table-actions">
                        <button
                          type="button"
                          className="control-chip"
                          onClick={() => handleSelect(webhook)}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="control-chip control-chip--ghost"
                          onClick={() => handleTest(webhook.id)}
                          disabled={testMutation.isPending}
                        >
                          <MdLink /> Test
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="empty-state">
              No webhooks configured yet. Use the form below to create one.
            </p>
          )}
        </div>
      </article>

      <article className="config-card">
        <header>
          <h3>{formMode === 'create' ? 'Create webhook' : `Edit ${formState.name}`}</h3>
          <p>Define HTTPS callback URLs to notify when alerts trigger.</p>
        </header>
        <form className="config-card__body" onSubmit={handleSubmit}>
          {formMode === 'create' && (
            <label className="form-field">
              <span>Preset</span>
              <select
                className="control-input"
                value={formState.presetKey}
                onChange={(event) => applyPreset(event.target.value)}
              >
                <option value="">Custom URL</option>
                {WEBHOOK_PRESETS.map((preset) => (
                  <option key={preset.key} value={preset.key}>
                    {preset.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {activePreset && <p className="config-hint">{activePreset.hint}</p>}
          {activePreset && activePreset.key !== 'home-assistant' && (
            <p className="config-hint">
              {activePreset.label} can read every alert sent to it. For end-to-end encrypted alerts
              use push notifications or Signal.
            </p>
          )}
          <div className="form-grid">
            <label>
              <span>Name</span>
              <input
                className="control-input"
                type="text"
                value={formState.name}
                onChange={(event) =>
                  setFormState((prev) => ({ ...prev, name: event.target.value }))
                }
                required
              />
            </label>
            <label>
              <span>Destination URL</span>
              <input
                className="control-input"
                type="url"
                value={formState.url}
                onChange={(event) => setFormState((prev) => ({ ...prev, url: event.target.value }))}
                required
                placeholder="https://example.com/webhooks/alert"
              />
            </label>
          </div>
          <label className="form-field">
            <span>Secret (optional)</span>
            <input
              className="control-input"
              type="text"
              value={formState.secret}
              onChange={(event) =>
                setFormState((prev) => ({ ...prev, secret: event.target.value }))
              }
              placeholder="Used to sign webhook payloads"
            />
          </label>
          <div className="toggle-row">
            <label className="control-checkbox">
              <input
                type="checkbox"
                checked={formState.enabled}
                onChange={(event) =>
                  setFormState((prev) => ({ ...prev, enabled: event.target.checked }))
                }
              />
              <span>Enabled</span>
            </label>
            {role === 'ADMIN' && (
              <label className="control-checkbox">
                <input
                  type="checkbox"
                  checked={formState.shareWithEveryone}
                  onChange={(event) =>
                    setFormState((prev) => ({ ...prev, shareWithEveryone: event.target.checked }))
                  }
                />
                <span>Shared with all operators</span>
              </label>
            )}
          </div>
          <details className="webhook-security webhook-advanced">
            <summary>Advanced (TLS &amp; client certificates)</summary>
            <label className="control-checkbox">
              <input
                type="checkbox"
                checked={formState.verifyTls}
                onChange={(event) =>
                  setFormState((prev) => ({ ...prev, verifyTls: event.target.checked }))
                }
              />
              <span>Verify server certificates</span>
            </label>
            <p className="config-hint">
              Disable only for trusted lab environments or self-signed test endpoints.
            </p>
            <div className="webhook-tls-grid">
              <label className="form-field">
                <span>Client certificate (PEM)</span>
                <textarea
                  className="control-input"
                  rows={4}
                  placeholder="-----BEGIN CERTIFICATE-----"
                  value={formState.clientCertificate}
                  onChange={(event) =>
                    setFormState((prev) => ({
                      ...prev,
                      clientCertificate: event.target.value,
                    }))
                  }
                />
              </label>
              <label className="form-field">
                <span>Client private key (PEM)</span>
                <textarea
                  className="control-input"
                  rows={4}
                  placeholder="-----BEGIN PRIVATE KEY-----"
                  value={formState.clientKey}
                  onChange={(event) =>
                    setFormState((prev) => ({ ...prev, clientKey: event.target.value }))
                  }
                />
              </label>
              <label className="form-field">
                <span>Custom CA bundle (optional)</span>
                <textarea
                  className="control-input"
                  rows={4}
                  placeholder="Paste trusted root/intermediate certificates"
                  value={formState.caBundle}
                  onChange={(event) =>
                    setFormState((prev) => ({ ...prev, caBundle: event.target.value }))
                  }
                />
              </label>
            </div>
            <p className="config-hint">
              Leave certificate fields empty to use the system trust store without mutual TLS.
            </p>
          </details>
          <div className="controls-row">
            <button
              type="submit"
              className="control-chip"
              disabled={createMutation.isPending || updateMutation.isPending}
            >
              {formMode === 'create' ? (
                <>
                  <MdAdd /> Create
                </>
              ) : (
                'Save changes'
              )}
            </button>
            <button
              type="button"
              className="control-chip control-chip--ghost"
              onClick={handleReset}
            >
              Reset
            </button>
            {formMode === 'edit' && (
              <button
                type="button"
                className="control-chip control-chip--danger"
                onClick={handleDelete}
                disabled={deleteMutation.isPending}
              >
                <MdDelete /> Delete
              </button>
            )}
          </div>
        </form>
      </article>

      {selectedWebhook && (
        <article className="config-card">
          <header>
            <h3>Recent deliveries</h3>
            <p>Latest attempts for {selectedWebhook.name}.</p>
          </header>
          <div className="config-card__body">
            {selectedWebhook.recentDeliveries.length === 0 ? (
              <p className="empty-state">No deliveries yet.</p>
            ) : (
              <div className="table-scroll">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Status</th>
                      <th>Code</th>
                      <th>Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedWebhook.recentDeliveries.map((delivery) => (
                      <tr key={delivery.id}>
                        <td>{new Date(delivery.triggeredAt).toLocaleString()}</td>
                        <td>{delivery.success ? 'Success' : 'Failed'}</td>
                        <td>{delivery.statusCode ?? '---'}</td>
                        <td>{delivery.errorMessage ?? '---'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </article>
      )}
    </div>
  );
}
