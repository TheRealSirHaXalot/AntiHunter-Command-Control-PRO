import { NavLink } from 'react-router-dom';

const ITEMS = [
  {
    to: '/alerts/custom',
    label: 'DIGI node Alerts',
    description: 'Vendor, SSID, channel, and device-based rules.',
    end: true,
  },
  {
    to: '/alerts/adsb',
    label: 'ADS-B & ACARS Alerts',
    description: 'Rules for aviation tracks and ACARS message activity.',
    end: true,
  },
  {
    to: '/alerts/events',
    label: 'Event log',
    description: 'Recent alert events and operator notifications.',
    end: false,
  },
  {
    to: '/alerts/remote',
    label: 'Remote alerts',
    description: 'Channels, alert sources, and webhooks.',
    end: false,
  },
];

export function AlertsRail() {
  return (
    <aside className="config-rail alerts-rail">
      <div className="config-rail__title">
        <h2 className="config-rail__heading">Alerts</h2>
        <p className="config-rail__copy">
          Manage alert rules, notification routing, and alert monitoring.
        </p>
      </div>
      <nav className="config-menu" aria-label="Alert pages">
        {ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              `config-menu__item${isActive ? ' config-menu__item--active' : ''}`
            }
          >
            <span className="config-menu__label">{item.label}</span>
            <span className="config-menu__description">{item.description}</span>
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}
