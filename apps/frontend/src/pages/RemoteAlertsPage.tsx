import { RemoteAlertsSection } from './RemoteAlertsSection';
import { AlertsRail } from '../components/AlertsRail';

export function RemoteAlertsPage() {
  return (
    <div className="config-shell alerts-shell">
      <AlertsRail />
      <section className="panel alerts-panel">
        <header className="panel-header alerts-header">
          <div className="alerts-header__intro">
            <h1>Remote alerts</h1>
            <p>Channels, alert sources, and webhooks.</p>
          </div>
        </header>
        <div className="config-content alerts-content">
          <RemoteAlertsSection view="alerts" />
        </div>
      </section>
    </div>
  );
}
