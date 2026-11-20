import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { MdRefresh, MdSearch } from 'react-icons/md';

import {
  createAdsbAlertRule,
  deleteAdsbAlertRule,
  listAdsbAlertRules,
  updateAdsbAlertRule,
} from '../api/adsb';
import type { AdsbAlertRule, AdsbAlertTarget, AlarmLevel } from '../api/types';
import { AlertsRail } from '../components/AlertsRail';

type FormMode = 'create' | 'edit';

const SEVERITIES: AlarmLevel[] = ['INFO', 'NOTICE', 'ALERT', 'CRITICAL'];

const emptyRule: Omit<AdsbAlertRule, 'id' | 'createdAt' | 'updatedAt'> = {
  name: '',
  description: '',
  enabled: true,
  severity: 'ALERT',
  target: 'adsb',
  notifyVisual: true,
  notifyAudible: false,
  notifyEmail: false,
  emailRecipients: [],
  showOnMap: true,
  mapColor: '#22c55e',
  mapLabel: '',
  blink: false,
  messageTemplate: '',
  conditions: {},
};

export function AdsbAlertsPage() {
  const queryClient = useQueryClient();
  const [formMode, setFormMode] = useState<FormMode>('create');
  const [selectedRuleId, setSelectedRuleId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [form, setForm] =
    useState<Omit<AdsbAlertRule, 'id' | 'createdAt' | 'updatedAt'>>(emptyRule);

  const rulesQuery = useQuery({
    queryKey: ['adsb-alert-rules'],
    queryFn: () => listAdsbAlertRules(),
  });

  const createMutation = useMutation({
    mutationFn: createAdsbAlertRule,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['adsb-alert-rules'] });
      resetForm();
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<AdsbAlertRule> }) =>
      updateAdsbAlertRule(id, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['adsb-alert-rules'] });
      resetForm();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteAdsbAlertRule(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['adsb-alert-rules'] });
      resetForm();
    },
  });

  const resetForm = () => {
    setForm(emptyRule);
    setSelectedRuleId(null);
    setFormMode('create');
  };

  const handleEdit = (rule: AdsbAlertRule) => {
    setSelectedRuleId(rule.id);
    setFormMode('edit');
    setForm({
      name: rule.name,
      description: rule.description ?? '',
      enabled: rule.enabled,
      severity: rule.severity,
      target: rule.target,
      notifyVisual: rule.notifyVisual ?? true,
      notifyAudible: rule.notifyAudible ?? false,
      notifyEmail: rule.notifyEmail ?? false,
      emailRecipients: rule.emailRecipients ?? [],
      showOnMap: rule.showOnMap ?? true,
      mapColor: rule.mapColor ?? '#22c55e',
      mapLabel: rule.mapLabel ?? '',
      blink: rule.blink ?? false,
      messageTemplate: rule.messageTemplate ?? '',
      conditions: { ...rule.conditions },
    });
  };

  const handleSubmit = () => {
    if (!form.name.trim()) return;
    if (formMode === 'create') {
      createMutation.mutate(form);
    } else if (selectedRuleId) {
      updateMutation.mutate({ id: selectedRuleId, body: form });
    }
  };

  const filteredRules = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return rulesQuery.data ?? [];
    return (rulesQuery.data ?? []).filter((rule) => {
      return (
        rule.name.toLowerCase().includes(term) ||
        (rule.description ?? '').toLowerCase().includes(term) ||
        (rule.conditions.callsignContains ?? '').toLowerCase().includes(term) ||
        (rule.conditions.icaoEquals ?? '').toLowerCase().includes(term) ||
        (rule.conditions.tailContains ?? '').toLowerCase().includes(term) ||
        (rule.conditions.flightContains ?? '').toLowerCase().includes(term)
      );
    });
  }, [rulesQuery.data, search]);

  const renderAdsbConditions = () => (
    <>
      <h3>Conditions (ADS-B)</h3>
      <div className="config-row">
        <span className="config-label">Callsign contains</span>
        <input
          value={form.conditions.callsignContains ?? ''}
          onChange={(e) =>
            setForm((prev) => ({
              ...prev,
              conditions: { ...prev.conditions, callsignContains: e.target.value || null },
            }))
          }
        />
      </div>
      <div className="config-row">
        <span className="config-label">ICAO equals</span>
        <input
          value={form.conditions.icaoEquals ?? ''}
          onChange={(e) =>
            setForm((prev) => ({
              ...prev,
              conditions: { ...prev.conditions, icaoEquals: e.target.value || null },
            }))
          }
        />
      </div>
      <div className="config-row">
        <span className="config-label">Registration contains</span>
        <input
          value={form.conditions.registrationContains ?? ''}
          onChange={(e) =>
            setForm((prev) => ({
              ...prev,
              conditions: { ...prev.conditions, registrationContains: e.target.value || null },
            }))
          }
        />
      </div>
      <div className="config-row">
        <span className="config-label">Departure (ICAO/IATA)</span>
        <input
          value={form.conditions.depEquals ?? ''}
          onChange={(e) =>
            setForm((prev) => ({
              ...prev,
              conditions: { ...prev.conditions, depEquals: e.target.value || null },
            }))
          }
        />
      </div>
      <div className="config-row">
        <span className="config-label">Destination (ICAO/IATA)</span>
        <input
          value={form.conditions.destEquals ?? ''}
          onChange={(e) =>
            setForm((prev) => ({
              ...prev,
              conditions: { ...prev.conditions, destEquals: e.target.value || null },
            }))
          }
        />
      </div>
      <div className="config-row">
        <span className="config-label">Min altitude</span>
        <input
          type="number"
          value={form.conditions.minAlt ?? ''}
          onChange={(e) =>
            setForm((prev) => ({
              ...prev,
              conditions: {
                ...prev.conditions,
                minAlt: e.target.value ? Number(e.target.value) : null,
              },
            }))
          }
        />
      </div>
      <div className="config-row">
        <span className="config-label">Max altitude</span>
        <input
          type="number"
          value={form.conditions.maxAlt ?? ''}
          onChange={(e) =>
            setForm((prev) => ({
              ...prev,
              conditions: {
                ...prev.conditions,
                maxAlt: e.target.value ? Number(e.target.value) : null,
              },
            }))
          }
        />
      </div>
      <div className="config-row">
        <span className="config-label">Min speed</span>
        <input
          type="number"
          value={form.conditions.minSpeed ?? ''}
          onChange={(e) =>
            setForm((prev) => ({
              ...prev,
              conditions: {
                ...prev.conditions,
                minSpeed: e.target.value ? Number(e.target.value) : null,
              },
            }))
          }
        />
      </div>
      <div className="config-row">
        <span className="config-label">Max speed</span>
        <input
          type="number"
          value={form.conditions.maxSpeed ?? ''}
          onChange={(e) =>
            setForm((prev) => ({
              ...prev,
              conditions: {
                ...prev.conditions,
                maxSpeed: e.target.value ? Number(e.target.value) : null,
              },
            }))
          }
        />
      </div>
    </>
  );

  const renderAcarsConditions = () => (
    <>
      <h3>Conditions (ACARS)</h3>
      <div className="config-row">
        <span className="config-label">Tail contains</span>
        <input
          value={form.conditions.tailContains ?? ''}
          onChange={(e) =>
            setForm((prev) => ({
              ...prev,
              conditions: { ...prev.conditions, tailContains: e.target.value || null },
            }))
          }
        />
      </div>
      <div className="config-row">
        <span className="config-label">Flight/callsign contains</span>
        <input
          value={form.conditions.flightContains ?? ''}
          onChange={(e) =>
            setForm((prev) => ({
              ...prev,
              conditions: { ...prev.conditions, flightContains: e.target.value || null },
            }))
          }
        />
      </div>
      <div className="config-row">
        <span className="config-label">Label equals</span>
        <input
          value={form.conditions.labelEquals ?? ''}
          onChange={(e) =>
            setForm((prev) => ({
              ...prev,
              conditions: { ...prev.conditions, labelEquals: e.target.value || null },
            }))
          }
        />
      </div>
      <div className="config-row">
        <span className="config-label">Text contains</span>
        <input
          value={form.conditions.textContains ?? ''}
          onChange={(e) =>
            setForm((prev) => ({
              ...prev,
              conditions: { ...prev.conditions, textContains: e.target.value || null },
            }))
          }
        />
      </div>
      <div className="config-row">
        <span className="config-label">Frequency equals</span>
        <input
          type="number"
          value={form.conditions.freqEquals ?? ''}
          onChange={(e) =>
            setForm((prev) => ({
              ...prev,
              conditions: {
                ...prev.conditions,
                freqEquals: e.target.value ? Number(e.target.value) : null,
              },
            }))
          }
        />
      </div>
      <div className="config-row">
        <span className="config-label">Min signal level</span>
        <input
          type="number"
          value={form.conditions.minSignal ?? ''}
          onChange={(e) =>
            setForm((prev) => ({
              ...prev,
              conditions: {
                ...prev.conditions,
                minSignal: e.target.value ? Number(e.target.value) : null,
              },
            }))
          }
        />
      </div>
      <div className="config-row">
        <span className="config-label">Max noise</span>
        <input
          type="number"
          value={form.conditions.maxNoise ?? ''}
          onChange={(e) =>
            setForm((prev) => ({
              ...prev,
              conditions: {
                ...prev.conditions,
                maxNoise: e.target.value ? Number(e.target.value) : null,
              },
            }))
          }
        />
      </div>
    </>
  );

  return (
    <div className="config-shell alerts-shell">
      <AlertsRail />

      <section className="panel alerts-panel">
        <header className="panel-header alerts-header">
          <div className="alerts-header__intro alerts-header__intro--centered">
            <h1>ADS-B &amp; ACARS Alerts</h1>
            <p>Trigger alerts on specific aircraft, routes, or message patterns.</p>
          </div>
          <div className="controls-row alerts-header__controls">
            <label className="alerts-header__search">
              <span>Search alerts</span>
              <div className="input-with-icon">
                <MdSearch />
                <input
                  value={search}
                  placeholder="Search by name or condition"
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
            </label>
            <div className="alerts-header__actions">
              <button
                type="button"
                className="control-chip control-chip--ghost"
                onClick={() =>
                  void queryClient.invalidateQueries({ queryKey: ['adsb-alert-rules'] })
                }
                aria-label="Refresh ADS-B & ACARS alert rules"
              >
                <MdRefresh /> Refresh
              </button>
              <button
                type="button"
                className="control-chip"
                onClick={() => {
                  resetForm();
                }}
              >
                New rule
              </button>
            </div>
          </div>
        </header>

        <div className="config-content alerts-content">
          <section className="config-card alerts-rules-card">
            <header>
              <h2>Rules</h2>
              <p>Select a rule to edit or create a new one.</p>
            </header>
            <div className="config-grid alerts-stack">
              <div className="config-card__body">
                {filteredRules.length ? (
                  <div className="config-menu alerts-rules-list">
                    {filteredRules.map((rule) => {
                      const summaryParts = [
                        rule.conditions.callsignContains
                          ? `Callsign contains ${rule.conditions.callsignContains}`
                          : null,
                        rule.conditions.icaoEquals ? `ICAO ${rule.conditions.icaoEquals}` : null,
                        rule.conditions.depEquals ? `Dep ${rule.conditions.depEquals}` : null,
                        rule.conditions.destEquals ? `Dest ${rule.conditions.destEquals}` : null,
                        rule.conditions.tailContains
                          ? `Tail contains ${rule.conditions.tailContains}`
                          : null,
                        rule.conditions.flightContains
                          ? `Flight contains ${rule.conditions.flightContains}`
                          : null,
                        rule.conditions.labelEquals ? `Label ${rule.conditions.labelEquals}` : null,
                        rule.conditions.textContains
                          ? `Text contains ${rule.conditions.textContains}`
                          : null,
                      ].filter(Boolean);
                      const summary =
                        summaryParts.length > 0 ? summaryParts.join(' | ') : 'No conditions set';
                      return (
                        <button
                          key={rule.id}
                          type="button"
                          className={`config-menu__item${
                            selectedRuleId === rule.id ? ' config-menu__item--active' : ''
                          }`}
                          onClick={() => handleEdit(rule)}
                        >
                          <div className="config-menu__label">{rule.name}</div>
                          <div className="config-menu__description">
                            {rule.target.toUpperCase()} | {rule.enabled ? 'Enabled' : 'Disabled'} |{' '}
                            {rule.severity}
                          </div>
                          <div className="config-menu__description">{summary}</div>
                          <div className="config-menu__actions">
                            <button
                              type="button"
                              className="control-chip control-chip--ghost"
                              onClick={(e) => {
                                e.stopPropagation();
                                void deleteMutation.mutateAsync(rule.id);
                              }}
                            >
                              Delete
                            </button>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <p className="muted">No ADS-B/ACARS alert rules yet.</p>
                )}
              </div>

              <div className="config-card__body">
                <div className="config-row">
                  <span className="config-label">Name</span>
                  <input
                    value={form.name}
                    onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
                  />
                </div>
                <div className="config-row">
                  <span className="config-label">Description</span>
                  <textarea
                    value={form.description ?? ''}
                    onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
                  />
                </div>
                <div className="config-row">
                  <span className="config-label">Target</span>
                  <select
                    value={form.target}
                    onChange={(e) =>
                      setForm((prev) => ({ ...prev, target: e.target.value as AdsbAlertTarget }))
                    }
                  >
                    <option value="adsb">ADS-B</option>
                    <option value="acars">ACARS</option>
                  </select>
                </div>
                <div className="config-row">
                  <span className="config-label">Severity</span>
                  <select
                    value={form.severity}
                    onChange={(e) =>
                      setForm((prev) => ({ ...prev, severity: e.target.value as AlarmLevel }))
                    }
                  >
                    {SEVERITIES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="config-row">
                  <span className="config-label">Enabled</span>
                  <label className="switch" aria-label="Toggle alert rule enabled">
                    <input
                      type="checkbox"
                      checked={form.enabled}
                      onChange={(e) => setForm((prev) => ({ ...prev, enabled: e.target.checked }))}
                    />
                    <span />
                  </label>
                </div>

                <article className="config-card">
                  <header>
                    <h3>Notifications &amp; routing</h3>
                    <p>
                      Choose how this alert notifies operators and where messages are delivered.
                    </p>
                  </header>
                  <div className="config-grid alerts-stack">
                    <div className="config-row">
                      <label className="switch">
                        <input
                          type="checkbox"
                          checked={form.notifyVisual ?? true}
                          onChange={(e) =>
                            setForm((prev) => ({ ...prev, notifyVisual: e.target.checked }))
                          }
                        />
                        <span />
                        <span className="config-label">Visual alert</span>
                      </label>
                      <label className="switch">
                        <input
                          type="checkbox"
                          checked={form.notifyAudible ?? false}
                          onChange={(e) =>
                            setForm((prev) => ({ ...prev, notifyAudible: e.target.checked }))
                          }
                        />
                        <span />
                        <span className="config-label">Audible alert</span>
                      </label>
                      <label className="switch">
                        <input
                          type="checkbox"
                          checked={form.notifyEmail ?? false}
                          onChange={(e) =>
                            setForm((prev) => ({ ...prev, notifyEmail: e.target.checked }))
                          }
                        />
                        <span />
                        <span className="config-label">Email</span>
                      </label>
                    </div>

                    <div className="config-row">
                      <span className="config-label">Email recipients</span>
                      <textarea
                        placeholder="one@example.com; two@example.com"
                        value={(form.emailRecipients ?? []).join('; ')}
                        onChange={(e) =>
                          setForm((prev) => ({
                            ...prev,
                            emailRecipients: e.target.value
                              .split(/[,;\n]+/)
                              .map((val) => val.trim())
                              .filter(Boolean),
                          }))
                        }
                        disabled={!form.notifyEmail}
                      />
                    </div>

                    <div className="config-row">
                      <label className="switch">
                        <input
                          type="checkbox"
                          checked={form.showOnMap ?? true}
                          onChange={(e) =>
                            setForm((prev) => ({ ...prev, showOnMap: e.target.checked }))
                          }
                        />
                        <span />
                        <span className="config-label">Show on map</span>
                      </label>
                      <label className="switch">
                        <input
                          type="checkbox"
                          checked={form.blink ?? false}
                          onChange={(e) =>
                            setForm((prev) => ({ ...prev, blink: e.target.checked }))
                          }
                        />
                        <span />
                        <span className="config-label">Blink marker</span>
                      </label>
                    </div>

                    <div className="config-row">
                      <span className="config-label">Map label</span>
                      <input
                        value={form.mapLabel ?? ''}
                        onChange={(e) => setForm((prev) => ({ ...prev, mapLabel: e.target.value }))}
                        placeholder="Optional label to show with map marker"
                      />
                    </div>
                    <div className="config-row">
                      <span className="config-label">Map color</span>
                      <input
                        type="color"
                        value={form.mapColor ?? '#22c55e'}
                        onChange={(e) => setForm((prev) => ({ ...prev, mapColor: e.target.value }))}
                      />
                    </div>
                    <div className="config-row">
                      <span className="config-label">Custom message</span>
                      <textarea
                        placeholder="Optional custom message to show in alerts."
                        value={form.messageTemplate ?? ''}
                        onChange={(e) =>
                          setForm((prev) => ({ ...prev, messageTemplate: e.target.value }))
                        }
                      />
                    </div>
                  </div>
                </article>

                {form.target === 'adsb' ? renderAdsbConditions() : renderAcarsConditions()}

                <div className="controls-row">
                  <button type="button" className="submit-button" onClick={handleSubmit}>
                    {formMode === 'create' ? 'Create rule' : 'Save changes'}
                  </button>
                  <button type="button" className="control-chip" onClick={resetForm}>
                    Reset
                  </button>
                </div>
              </div>
            </div>
          </section>
        </div>
      </section>
    </div>
  );
}
