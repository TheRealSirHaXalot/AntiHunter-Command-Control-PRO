import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { MdNotificationsActive, MdRefresh } from 'react-icons/md';

import { clearAlertRuleEvents, listAlertRuleEvents, listAlertRules } from '../api/alert-rules';
import type { AlertRule, AlertRuleEvent } from '../api/types';
import { AlertsRail } from '../components/AlertsRail';

export function AlertsEventLogPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [selectedRuleId, setSelectedRuleId] = useState<string | null>(null);

  const rulesQuery = useQuery({
    queryKey: ['alert-rules', search],
    queryFn: () => listAlertRules(search.trim() ? { search: search.trim() } : {}),
    staleTime: 15_000,
  });

  const eventsQuery = useQuery({
    queryKey: ['alert-rule-events', selectedRuleId ?? 'all'],
    queryFn: () =>
      listAlertRuleEvents({
        ruleId: selectedRuleId ?? undefined,
        limit: 50,
      }),
    refetchInterval: 15_000,
  });

  const visibleRules = rulesQuery.data ?? [];
  const selectedRule = selectedRuleId
    ? (visibleRules.find((rule) => rule.id === selectedRuleId) ?? null)
    : null;
  const recentEvents: AlertRuleEvent[] = eventsQuery.data ?? [];
  const menuEmpty = visibleRules.length === 0;
  const enableScroll = recentEvents.length > 30;

  const handleClearEvents = async () => {
    await clearAlertRuleEvents(selectedRuleId ?? undefined);
    await queryClient.invalidateQueries({ queryKey: ['alert-rule-events'] });
  };

  return (
    <div className="config-shell alerts-shell">
      <AlertsRail />

      <section className="panel alerts-panel">
        <header className="panel-header alerts-header">
          <div className="alerts-header__intro">
            <h1>Alert event log</h1>
            <p>Review the latest alert notifications captured across the system.</p>
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
            <button
              type="button"
              className="control-chip control-chip--ghost"
              onClick={() => rulesQuery.refetch()}
            >
              <MdRefresh /> Refresh rules
            </button>
          </div>
        </header>

        <div className="config-content alerts-content">
          <section className="config-card alerts-rules-card">
            <header>
              <h2>Filter by rule</h2>
              <p>Select a rule to narrow the event log, or view all events.</p>
            </header>
            <div className="config-menu alerts-rules-list">
              {visibleRules.map((rule) => (
                <button
                  type="button"
                  key={rule.id}
                  className={`config-menu__item${
                    rule.id === selectedRuleId ? ' config-menu__item--active' : ''
                  }`}
                  onClick={() => setSelectedRuleId(rule.id === selectedRuleId ? null : rule.id)}
                >
                  <div className="config-menu__label">{rule.name}</div>
                  <div className="config-menu__description">
                    {rule.description || renderCriteriaSummary(rule)}
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

          <section className="config-card alerts-events-card">
            <header>
              <h2>
                <MdNotificationsActive /> Recent alert events
              </h2>
              {selectedRule ? (
                <p>Showing events for {selectedRule.name}.</p>
              ) : (
                <p>Latest 50 matches across all alert rules.</p>
              )}
            </header>
            <div className="alerts-events__actions">
              <button
                type="button"
                className="control-chip control-chip--ghost"
                onClick={handleClearEvents}
              >
                Clear
              </button>
              <button type="button" onClick={() => eventsQuery.refetch()}>
                <MdRefresh /> Refresh
              </button>
            </div>
            {eventsQuery.isLoading ? (
              <p className="empty-state">Loading events.</p>
            ) : (
              <div
                className={`alerts-events__table${enableScroll ? ' alerts-events__table--scroll' : ''}`}
              >
                <table>
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Severity</th>
                      <th>Rule</th>
                      <th>Node / Target</th>
                      <th>Message</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentEvents.length === 0 ? (
                      <tr>
                        <td colSpan={5}>
                          <div className="empty-state">No alert events yet.</div>
                        </td>
                      </tr>
                    ) : (
                      recentEvents.map((event) => (
                        <tr key={event.id}>
                          <td>{formatTimestamp(event.triggeredAt)}</td>
                          <td>
                            <span className={`chip chip--${event.severity.toLowerCase()}`}>
                              {event.severity}
                            </span>
                          </td>
                          <td>{event.ruleName}</td>
                          <td>{event.nodeId || event.mac || event.ssid || '-'}</td>
                          <td>{event.message ?? event.matchedCriteria?.join(', ') ?? '-'}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      </section>
    </div>
  );
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

function formatTimestamp(value: string): string {
  try {
    const date = new Date(value);
    return date.toLocaleString();
  } catch {
    return value;
  }
}
