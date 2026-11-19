import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import { MdDelete, MdRefresh } from 'react-icons/md';
import { NavLink, useLocation, useSearchParams } from 'react-router-dom';

import {
  createAlertRule,
  deleteAlertRule,
  listAlertRules,
  updateAlertRule,
} from '../api/alert-rules';
import { apiClient } from '../api/client';
import type {
  AlarmLevel,
  AlertRule,
  AlertRuleMatchMode,
  AlertRulePayload,
  AlertRuleScope,
  InventoryDevice,
} from '../api/types';
import { AlertsRail } from '../components/AlertsRail';
import { useAuthStore } from '../stores/auth-store';

type FormMode = 'create' | 'edit';

interface InventorySelection {
  mac: string;
  vendor?: string | null;
  ssid?: string | null;
  label: string;
}

interface AlertRuleFormState {
  id?: string;
  name: string;
  description: string;
  scope: AlertRuleScope;
  severity: AlarmLevel;
  matchMode: AlertRuleMatchMode;
  isActive: boolean;
  ouiInput: string;
  ssidInput: string;
  channelInput: string;
  macInput: string;
  inventoryMacs: string[];
  inventorySelections: Record<string, InventorySelection>;
  notifyVisual: boolean;
  notifyAudible: boolean;
  notifyEmail: boolean;
  emailInput: string;
  minRssi: string;
  maxRssi: string;
  messageTemplate: string;
  showOnMap: boolean;
  mapColor: string;
  blink: boolean;
  mapLabel: string;
}

const BASE_FORM_STATE: Omit<AlertRuleFormState, 'inventoryMacs' | 'inventorySelections'> = {
  name: '',
  description: '',
  scope: 'PERSONAL',
  severity: 'ALERT',
  matchMode: 'ANY',
  isActive: true,
  ouiInput: '',
  ssidInput: '',
  channelInput: '',
  macInput: '',
  notifyVisual: true,
  notifyAudible: true,
  notifyEmail: false,
  emailInput: '',
  minRssi: '',
  maxRssi: '',
  messageTemplate: '',
  showOnMap: true,
  mapColor: '#f97316',
  blink: false,
  mapLabel: '',
};

const SEVERITY_OPTIONS: AlarmLevel[] = ['INFO', 'NOTICE', 'ALERT', 'CRITICAL'];
const MATCH_MODES: AlertRuleMatchMode[] = ['ANY', 'ALL'];

const createDefaultFormState = (): AlertRuleFormState => ({
  ...BASE_FORM_STATE,
  inventoryMacs: [],
  inventorySelections: {},
});

export function AlertsPage() {
  const queryClient = useQueryClient();
  const location = useLocation();
  const userRole = useAuthStore((state) => state.user?.role ?? 'VIEWER');
  const isAdsbAlerts = location.pathname.includes('/alerts/adsb');

  const [search, setSearch] = useState('');
  const [formMode, setFormMode] = useState<FormMode>('create');
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedRuleId, setSelectedRuleIdState] = useState<string | null>(null);
  const setSelectedRuleId = (id: string | null) => {
    setSelectedRuleIdState(id);
    setSearchParams(id ? { rule: id } : {}, { replace: true });
  };
  const [formState, setFormState] = useState<AlertRuleFormState>(() => createDefaultFormState());
  const [inventorySearch, setInventorySearch] = useState('');
  const [ouiSearch, setOuiSearch] = useState('');

  const rulesQuery = useQuery({
    queryKey: ['alert-rules', search],
    queryFn: () => listAlertRules(search.trim() ? { search: search.trim() } : {}),
    staleTime: 15_000,
  });

  const inventorySearchQuery = useQuery({
    queryKey: ['inventory-search', inventorySearch],
    queryFn: () =>
      inventorySearch.trim().length >= 2
        ? apiClient.get<InventoryDevice[]>(
            `/inventory?search=${encodeURIComponent(inventorySearch.trim())}`,
          )
        : [],
    enabled: inventorySearch.trim().length >= 2,
  });

  const ouiSearchQuery = useQuery({
    queryKey: ['oui-search', ouiSearch],
    queryFn: () =>
      ouiSearch.trim().length >= 2
        ? apiClient.get<Array<{ oui: string; vendor: string }>>(
            `/oui/cache?limit=25&search=${encodeURIComponent(ouiSearch.trim())}`,
          )
        : [],
    enabled: ouiSearch.trim().length >= 2,
  });

  const createMutation = useMutation({
    mutationFn: (payload: AlertRulePayload) => createAlertRule(payload),
    onSuccess: (rule) => {
      queryClient.invalidateQueries({ queryKey: ['alert-rules'] });
      setSelectedRuleId(rule.id);
      setFormMode('edit');
      setFormState(buildFormState(rule));
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: AlertRulePayload }) =>
      updateAlertRule(id, payload),
    onSuccess: (rule) => {
      queryClient.invalidateQueries({ queryKey: ['alert-rules'] });
      setSelectedRuleId(rule.id);
      setFormState(buildFormState(rule));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteAlertRule(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['alert-rules'] });
      setFormState(createDefaultFormState());
      setFormMode('create');
      setSelectedRuleId(null);
    },
  });

  const isSaving = createMutation.isPending || updateMutation.isPending;
  const isDeleting = deleteMutation.isPending;

  const handleSelectRule = (rule: AlertRule) => {
    setSelectedRuleId(rule.id);
    setFormMode('edit');
    setFormState(buildFormState(rule));
  };

  const ruleParam = searchParams.get('rule');
  useEffect(() => {
    if (selectedRuleId || !ruleParam) {
      return;
    }
    const rule = rulesQuery.data?.find((candidate) => candidate.id === ruleParam);
    if (rule) {
      setSelectedRuleIdState(rule.id);
      setFormMode('edit');
      setFormState(buildFormState(rule));
    }
  }, [ruleParam, rulesQuery.data, selectedRuleId]);
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const payload = buildPayload(formState);
    if (!payload.name.trim()) {
      return;
    }
    if (formMode === 'edit' && formState.id) {
      updateMutation.mutate({ id: formState.id, payload });
    } else {
      createMutation.mutate(payload);
    }
  };

  const handleReset = () => {
    if (formMode === 'edit' && selectedRuleId) {
      const existing = rulesQuery.data?.find((rule) => rule.id === selectedRuleId);
      if (existing) {
        setFormState(buildFormState(existing));
        return;
      }
    }
    setFormState(createDefaultFormState());
  };

  const handleDelete = () => {
    if (formState.id) {
      deleteMutation.mutate(formState.id);
    }
  };

  const handleAddInventoryDevice = (device: InventoryDevice) => {
    const normalized = normalizeMac(device.mac);
    if (!normalized) {
      return;
    }
    setFormState((prev) => {
      if (prev.inventoryMacs.includes(normalized)) {
        return prev;
      }
      return {
        ...prev,
        inventoryMacs: [...prev.inventoryMacs, normalized],
        inventorySelections: {
          ...prev.inventorySelections,
          [normalized]: {
            mac: normalized,
            vendor: device.vendor,
            ssid: device.ssid,
            label: device.vendor ?? device.ssid ?? normalized,
          },
        },
      };
    });
  };

  const handleRemoveInventoryDevice = (mac: string) => {
    setFormState((prev) => {
      const nextSelections = { ...prev.inventorySelections };
      delete nextSelections[mac];
      return {
        ...prev,
        inventoryMacs: prev.inventoryMacs.filter((item) => item !== mac),
        inventorySelections: nextSelections,
      };
    });
  };

  const handleAddOui = (oui: string) => {
    const normalized = formatOui(oui);
    if (!normalized) {
      return;
    }
    const list = parseStringList(formState.ouiInput);
    if (list.includes(normalized)) {
      return;
    }
    list.push(normalized);
    setFormState((prev) => ({ ...prev, ouiInput: list.join('\n') }));
  };
  const canEdit = userRole !== 'VIEWER';
  const canChangeScope = userRole === 'ADMIN';
  const scopeOptions: AlertRuleScope[] = canChangeScope
    ? ['PERSONAL', 'GLOBAL']
    : formState.scope === 'GLOBAL'
      ? ['GLOBAL']
      : ['PERSONAL'];

  const visibleRules = rulesQuery.data ?? [];
  const menuEmpty = visibleRules.length === 0;
  const ouiResults = ouiSearchQuery.data ?? [];
  const inventoryResults = inventorySearchQuery.data ?? [];
  const formTitle = formMode === 'edit' ? 'Edit alert rule' : 'Create alert rule';

  return (
    <div className="config-shell alerts-shell">
      <AlertsRail />

      <section className="panel alerts-panel">
        <header className="panel-header alerts-header">
          <div className="alerts-header__intro">
            <h1>{isAdsbAlerts ? 'ADS-B & ACARS Alerts' : 'Alert automation'}</h1>
            <p>
              {isAdsbAlerts
                ? 'Create alerts for aviation tracks and ACARS messages that matter to you.'
                : 'Automatically highlight devices, vendors, SSIDs, and channels that matter.'}
            </p>
          </div>
          <div className="controls-row alerts-header__controls">
            <label className="alerts-header__search">
              <span>Search alerts</span>
              <input
                type="search"
                placeholder="Type to filter alert rules"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <div className="alerts-header__actions">
              <NavLink to="/alerts/remote" className="control-chip control-chip--ghost">
                Remote alerts
              </NavLink>
              <button
                type="button"
                className="control-chip control-chip--ghost"
                onClick={() => rulesQuery.refetch()}
              >
                <MdRefresh /> Refresh
              </button>
            </div>
          </div>
        </header>

        <div className="config-content alerts-content">
          <section className="config-card alerts-rules-card">
            <header>
              <h2>Alert rules</h2>
              <p>Select an existing rule to edit or create a new one.</p>
              <div className="alerts-rules-actions">
                <button
                  type="button"
                  className="control-chip control-chip--ghost"
                  onClick={() => rulesQuery.refetch()}
                >
                  <MdRefresh /> Refresh
                </button>
              </div>
            </header>
            <div className="config-menu alerts-rules-list">
              {visibleRules.map((rule) => (
                <button
                  type="button"
                  key={rule.id}
                  className={`config-menu__item${
                    rule.id === selectedRuleId ? ' config-menu__item--active' : ''
                  }`}
                  onClick={() => handleSelectRule(rule)}
                >
                  <div className="config-menu__label">{rule.name}</div>
                  <div className="config-menu__description">
                    {rule.description || renderCriteriaSummary(rule)}
                  </div>
                  <div className="alerts-menu__meta">
                    <span className={`chip chip--${rule.severity.toLowerCase()}`}>
                      {rule.severity}
                    </span>
                    <span className="chip chip--ghost">
                      {rule.scope === 'GLOBAL' ? 'Global' : 'Personal'}
                    </span>
                    {rule.isActive ? (
                      <span className="chip chip--success">Active</span>
                    ) : (
                      <span className="chip">Paused</span>
                    )}
                  </div>
                </button>
              ))}
              {menuEmpty && (
                <div className="alerts-menu-empty">
                  <p>No alert rules yet. Create one to get started.</p>
                </div>
              )}
            </div>
          </section>

          <form className="alerts-form" onSubmit={handleSubmit}>
            <div className="config-grid alerts-stack">
              <article className="config-card">
                <header>
                  <h2>{formTitle}</h2>
                  <p>Give the rule a name, severity, and decide how criteria should match.</p>
                </header>
                <div className="config-card__body">
                  <div className="form-grid">
                    <label>
                      <span>Rule name</span>
                      <input
                        type="text"
                        placeholder="Example: Rogue Cisco devices"
                        value={formState.name}
                        onChange={(event) =>
                          setFormState((prev) => ({ ...prev, name: event.target.value }))
                        }
                        disabled={!canEdit}
                        required
                      />
                    </label>
                    <label>
                      <span>Scope</span>
                      <select
                        value={formState.scope}
                        onChange={(event) =>
                          setFormState((prev) => ({
                            ...prev,
                            scope: event.target.value as AlertRuleScope,
                          }))
                        }
                        disabled={!canEdit || !canChangeScope}
                      >
                        {scopeOptions.map((option) => (
                          <option key={option} value={option}>
                            {option === 'GLOBAL' ? 'Global (all users)' : 'Personal'}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>Severity</span>
                      <select
                        value={formState.severity}
                        onChange={(event) =>
                          setFormState((prev) => ({
                            ...prev,
                            severity: event.target.value as AlarmLevel,
                          }))
                        }
                        disabled={!canEdit}
                      >
                        {SEVERITY_OPTIONS.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>Match mode</span>
                      <select
                        value={formState.matchMode}
                        onChange={(event) =>
                          setFormState((prev) => ({
                            ...prev,
                            matchMode: event.target.value as AlertRuleMatchMode,
                          }))
                        }
                        disabled={!canEdit}
                      >
                        {MATCH_MODES.map((option) => (
                          <option key={option} value={option}>
                            {option === 'ANY' ? 'Any criteria' : 'All criteria'}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <label className="form-field">
                    <span>Description (optional)</span>
                    <textarea
                      rows={2}
                      value={formState.description}
                      placeholder="Explain why this alert exists."
                      onChange={(event) =>
                        setFormState((prev) => ({ ...prev, description: event.target.value }))
                      }
                      disabled={!canEdit}
                    />
                  </label>
                  <div className="toggle-row">
                    <label>
                      <input
                        type="checkbox"
                        checked={formState.isActive}
                        onChange={(event) =>
                          setFormState((prev) => ({ ...prev, isActive: event.target.checked }))
                        }
                        disabled={!canEdit}
                      />
                      Enabled
                    </label>
                    <span>
                      {formState.matchMode === 'ALL'
                        ? 'Alert only when every criteria matches'
                        : 'Alert when any criteria matches'}
                    </span>
                  </div>
                </div>
              </article>

              <article className="config-card">
                <header>
                  <h2>Match criteria</h2>
                  <p>Alert when any of these vendors, SSIDs, channels, or devices are observed.</p>
                </header>
                <div className="config-card__body">
                  <div className="form-grid">
                    <label>
                      <span>Vendor OUI prefixes</span>
                      <textarea
                        rows={3}
                        placeholder="00:11:22&#10;AC:DE:48"
                        value={formState.ouiInput}
                        onChange={(event) =>
                          setFormState((prev) => ({ ...prev, ouiInput: event.target.value }))
                        }
                        disabled={!canEdit}
                      />
                    </label>
                    <label>
                      <span>SSIDs</span>
                      <textarea
                        rows={3}
                        placeholder="HiddenNetwork&#10;CorporateGuest"
                        value={formState.ssidInput}
                        onChange={(event) =>
                          setFormState((prev) => ({ ...prev, ssidInput: event.target.value }))
                        }
                        disabled={!canEdit}
                      />
                    </label>
                  </div>
                  <div className="form-grid">
                    <label>
                      <span>Channels</span>
                      <textarea
                        rows={2}
                        placeholder="1&#10;6&#10;11"
                        value={formState.channelInput}
                        onChange={(event) =>
                          setFormState((prev) => ({ ...prev, channelInput: event.target.value }))
                        }
                        disabled={!canEdit}
                      />
                      <small>One per line or comma separated.</small>
                    </label>
                    <label>
                      <span>MAC addresses</span>
                      <textarea
                        rows={3}
                        placeholder="AA:BB:CC:DD:EE:FF"
                        value={formState.macInput}
                        onChange={(event) =>
                          setFormState((prev) => ({ ...prev, macInput: event.target.value }))
                        }
                        disabled={!canEdit}
                      />
                    </label>
                  </div>
                  <div className="form-grid">
                    <label>
                      <span>Minimum RSSI (dBm)</span>
                      <input
                        type="number"
                        placeholder="-80"
                        value={formState.minRssi}
                        onChange={(event) =>
                          setFormState((prev) => ({ ...prev, minRssi: event.target.value }))
                        }
                        disabled={!canEdit}
                      />
                    </label>
                    <label>
                      <span>Maximum RSSI (dBm)</span>
                      <input
                        type="number"
                        placeholder="-20"
                        value={formState.maxRssi}
                        onChange={(event) =>
                          setFormState((prev) => ({ ...prev, maxRssi: event.target.value }))
                        }
                        disabled={!canEdit}
                      />
                    </label>
                  </div>

                  <div className="alerts-inline-search">
                    <div>
                      <label>
                        <span>Search OUI vendor directory</span>
                        <input
                          type="search"
                          placeholder="e.g. Cisco"
                          value={ouiSearch}
                          onChange={(event) => setOuiSearch(event.target.value)}
                          disabled={!canEdit}
                        />
                      </label>
                      <div className="search-results">
                        {ouiSearch.trim().length < 2 && (
                          <small>Type at least two characters.</small>
                        )}
                        {ouiSearch.trim().length >= 2 && ouiResults.length === 0 && (
                          <small>No vendors match that search.</small>
                        )}
                        {ouiResults.map((entry) => (
                          <button
                            type="button"
                            key={entry.oui}
                            onClick={() => handleAddOui(entry.oui)}
                            disabled={!canEdit}
                          >
                            {entry.vendor}
                            <span>{formatOui(entry.oui)}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <label>
                        <span>Add from inventory</span>
                        <input
                          type="search"
                          placeholder="Search MAC, vendor, SSID"
                          value={inventorySearch}
                          onChange={(event) => setInventorySearch(event.target.value)}
                          disabled={!canEdit}
                        />
                      </label>
                      <div className="search-results">
                        {inventorySearch.trim().length < 2 && (
                          <small>Enter two or more characters to search.</small>
                        )}
                        {inventorySearch.trim().length >= 2 && inventoryResults.length === 0 && (
                          <small>No inventory devices match.</small>
                        )}
                        {inventoryResults.map((device) => (
                          <button
                            type="button"
                            key={device.mac}
                            onClick={() => handleAddInventoryDevice(device)}
                            disabled={!canEdit}
                          >
                            {device.vendor ?? 'Unknown vendor'}
                            <span>{normalizeMac(device.mac)}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="inventory-selection">
                    <strong>Devices included in this alert</strong>
                    {formState.inventoryMacs.length === 0 ? (
                      <p>No inventory devices selected.</p>
                    ) : (
                      <ul>
                        {formState.inventoryMacs.map((mac) => {
                          const details = formState.inventorySelections[mac];
                          return (
                            <li key={mac}>
                              <span>
                                {details?.label ?? mac}
                                <small>{mac}</small>
                              </span>
                              <button
                                type="button"
                                onClick={() => handleRemoveInventoryDevice(mac)}
                                disabled={!canEdit}
                              >
                                Remove
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                </div>
              </article>
            </div>

            <div className="config-grid alerts-stack">
              <article className="config-card">
                <header>
                  <h2>Alert message</h2>
                  <p>
                    Delivery is set by this rule&rsquo;s row in Remote alerts &rarr; Alert sources.
                    Customize the alert text below.
                  </p>
                </header>
                <div className="config-card__body">
                  <label className="form-field">
                    <span>Custom message template</span>
                    <textarea
                      rows={2}
                      placeholder="Optional custom message to show in alerts."
                      value={formState.messageTemplate}
                      onChange={(event) =>
                        setFormState((prev) => ({ ...prev, messageTemplate: event.target.value }))
                      }
                      disabled={!canEdit}
                    />
                  </label>
                </div>
              </article>

              <article className="config-card">
                <header>
                  <h2>Map appearance</h2>
                  <p>Decide how this alert should appear on the tactical map.</p>
                </header>
                <div className="config-card__body">
                  <div className="toggle-row">
                    <label>
                      <input
                        type="checkbox"
                        checked={formState.showOnMap}
                        onChange={(event) =>
                          setFormState((prev) => ({ ...prev, showOnMap: event.target.checked }))
                        }
                        disabled={!canEdit}
                      />
                      Show on map
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={formState.blink}
                        onChange={(event) =>
                          setFormState((prev) => ({ ...prev, blink: event.target.checked }))
                        }
                        disabled={!canEdit || !formState.showOnMap}
                      />
                      Blink marker
                    </label>
                  </div>
                  <div className="form-grid">
                    <label>
                      <span>Marker color</span>
                      <input
                        type="color"
                        value={formState.mapColor}
                        onChange={(event) =>
                          setFormState((prev) => ({ ...prev, mapColor: event.target.value }))
                        }
                        disabled={!canEdit || !formState.showOnMap}
                      />
                    </label>
                    <label>
                      <span>Map label</span>
                      <input
                        type="text"
                        placeholder="Optional override"
                        value={formState.mapLabel}
                        onChange={(event) =>
                          setFormState((prev) => ({ ...prev, mapLabel: event.target.value }))
                        }
                        disabled={!canEdit || !formState.showOnMap}
                      />
                    </label>
                  </div>
                </div>
              </article>
            </div>

            <article className="config-card alerts-actions-card">
              <header>
                <h2>Actions</h2>
                <p>Save your changes or reset the form. Delete removes the rule permanently.</p>
              </header>
              <div className="config-card__body">
                <div className="controls-row">
                  <button type="submit" className="control-chip" disabled={!canEdit || isSaving}>
                    {isSaving
                      ? 'Saving�'
                      : formMode === 'edit'
                        ? 'Save changes'
                        : 'Create alert rule'}
                  </button>
                  <button
                    type="button"
                    className="control-chip control-chip--ghost"
                    onClick={handleReset}
                    disabled={!canEdit || isSaving}
                  >
                    Reset
                  </button>
                  {formMode === 'edit' && (
                    <button
                      type="button"
                      className="control-chip control-chip--danger"
                      onClick={handleDelete}
                      disabled={!canEdit || isDeleting}
                    >
                      {isDeleting ? (
                        'Deleting...'
                      ) : (
                        <span>
                          <MdDelete /> Delete rule
                        </span>
                      )}
                    </button>
                  )}
                </div>
              </div>
            </article>
          </form>
        </div>
      </section>
    </div>
  );
}

function buildFormState(rule: AlertRule): AlertRuleFormState {
  const selections: Record<string, InventorySelection> = {};
  for (const mac of rule.inventoryMacs) {
    selections[mac] = { mac, label: mac };
  }
  return {
    id: rule.id,
    name: rule.name,
    description: rule.description ?? '',
    scope: rule.scope,
    severity: rule.severity,
    matchMode: rule.matchMode,
    isActive: rule.isActive,
    ouiInput: rule.ouiPrefixes.join('\n'),
    ssidInput: rule.ssids.join('\n'),
    channelInput: rule.channels.map((channel) => String(channel)).join('\n'),
    macInput: rule.macAddresses.join('\n'),
    inventoryMacs: [...rule.inventoryMacs],
    inventorySelections: selections,
    notifyVisual: rule.notifyVisual,
    notifyAudible: rule.notifyAudible,
    notifyEmail: rule.notifyEmail,
    emailInput: rule.emailRecipients.join('\n'),
    minRssi: typeof rule.minRssi === 'number' ? String(rule.minRssi) : '',
    maxRssi: typeof rule.maxRssi === 'number' ? String(rule.maxRssi) : '',
    messageTemplate: rule.messageTemplate ?? '',
    showOnMap: rule.mapStyle?.showOnMap ?? true,
    mapColor: rule.mapStyle?.color ?? '#f97316',
    blink: rule.mapStyle?.blink ?? false,
    mapLabel: rule.mapStyle?.label ?? '',
  };
}

function buildPayload(state: AlertRuleFormState): AlertRulePayload {
  return {
    name: state.name,
    description: state.description.trim() || undefined,
    scope: state.scope,
    severity: state.severity,
    matchMode: state.matchMode,
    isActive: state.isActive,
    ouiPrefixes: parseOuiList(state.ouiInput),
    ssids: parseStringList(state.ssidInput),
    channels: parseChannelList(state.channelInput),
    macAddresses: parseMacList(state.macInput),
    inventoryMacs: state.inventoryMacs,
    notifyVisual: state.notifyVisual,
    notifyAudible: state.notifyAudible,
    notifyEmail: state.notifyEmail,
    emailRecipients: parseStringList(state.emailInput),
    messageTemplate: state.messageTemplate.trim() || undefined,
    minRssi: state.minRssi.trim() ? Number(state.minRssi) : null,
    maxRssi: state.maxRssi.trim() ? Number(state.maxRssi) : null,
    mapStyle: {
      showOnMap: state.showOnMap,
      color: state.mapColor,
      blink: state.blink,
      label: state.mapLabel.trim() || undefined,
    },
  };
}

function renderCriteriaSummary(rule: AlertRule): string {
  const segments: string[] = [];
  if (rule.ouiPrefixes.length) {
    segments.push(`${rule.ouiPrefixes.length} OUI${rule.ouiPrefixes.length === 1 ? '' : 's'}`);
  }
  if (rule.macAddresses.length) {
    segments.push(`${rule.macAddresses.length} MAC`);
  }
  if (rule.inventoryMacs.length) {
    segments.push(`${rule.inventoryMacs.length} inventory`);
  }
  if (rule.ssids.length) {
    segments.push(`${rule.ssids.length} SSID${rule.ssids.length === 1 ? '' : 's'}`);
  }
  if (rule.channels.length) {
    segments.push(`Channels ${rule.channels.join(', ')}`);
  }
  if (typeof rule.minRssi === 'number') {
    segments.push(`RSSI >= ${rule.minRssi}`);
  }
  if (typeof rule.maxRssi === 'number') {
    segments.push(`RSSI <= ${rule.maxRssi}`);
  }
  return segments.length ? segments.join(' | ') : 'No criteria configured';
}

function parseStringList(value: string): string[] {
  const entries = value
    .split(/[\n,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!seen.has(entry)) {
      deduped.push(entry);
      seen.add(entry);
    }
  }
  return deduped;
}

function parseOuiList(value: string): string[] {
  return parseStringList(value)
    .map((entry) => formatOui(entry))
    .filter(Boolean);
}

function parseChannelList(value: string): number[] {
  return parseStringList(value)
    .map((entry) => Number(entry))
    .filter((num) => Number.isFinite(num));
}

function parseMacList(value: string): string[] {
  return parseStringList(value)
    .map((entry) => normalizeMac(entry))
    .filter(Boolean);
}

function normalizeMac(value: string): string {
  const hex = value.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (hex.length !== 12) {
    return hex.length ? hex : '';
  }
  return hex.match(/.{1,2}/g)!.join(':');
}

function formatOui(value: string): string {
  const hex = value.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (hex.length < 6) {
    return hex;
  }
  const trimmed = hex.slice(0, 6);
  return trimmed.match(/.{1,2}/g)!.join(':');
}
