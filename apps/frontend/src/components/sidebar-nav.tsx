import { useEffect, useMemo, useState, type ComponentType } from 'react';
import {
  MdChat,
  MdDownload,
  MdEventNote,
  MdExtension,
  MdHub,
  MdMap,
  MdMyLocation,
  MdFingerprint,
  MdNetworkCheck,
  MdNotificationsActive,
  MdOutlineAreaChart,
  MdPerson,
  MdRadar,
  MdSensors,
  MdSettings,
  MdSettingsInputAntenna,
  MdShield,
  MdTerminal,
  MdWifiTethering,
} from 'react-icons/md';
import { NavLink } from 'react-router-dom';

import { useAuthStore } from '../stores/auth-store';

interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  hideOnMobile?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { to: '/map', label: 'Map', icon: MdMap },
  { to: '/console', label: 'Console', icon: MdTerminal },
  { to: '/inventory', label: 'Inventory', icon: MdWifiTethering },
  { to: '/probes', label: 'Probes', icon: MdNetworkCheck },
  { to: '/baseline', label: 'Baseline', icon: MdFingerprint },
  { to: '/alerts', label: 'Alerts', icon: MdNotificationsActive },
  { to: '/targets', label: 'Targets', icon: MdMyLocation },
  { to: '/acars', label: 'ACARS', icon: MdSettingsInputAntenna },
  { to: '/adsb', label: 'ADS-B', icon: MdRadar },
  { to: '/geofences', label: 'Geofences', icon: MdOutlineAreaChart },
  { to: '/nodes', label: 'Nodes', icon: MdSensors },
  { to: '/sentinel', label: 'Sentinel', icon: MdShield },
  { to: '/scheduler', label: 'Scheduler', icon: MdEventNote },
  { to: '/strategy', label: 'Strategy Advisor', icon: MdHub, hideOnMobile: true },
  { to: '/chat', label: 'Chat', icon: MdChat },
  { to: '/addon', label: 'Addon', icon: MdExtension },
  { to: '/config', label: 'Config', icon: MdSettings },
  { to: '/exports', label: 'Exports', icon: MdDownload },
  { to: '/account', label: 'Account', icon: MdPerson },
];

export function SidebarNav() {
  const addons = useAuthStore(
    (state) => state.user?.preferences?.notifications?.addons ?? ({} as Record<string, boolean>),
  );
  const [strategyEnabled, setStrategyEnabled] = useState<boolean>(addons.strategy ?? false);
  const [alertsEnabled, setAlertsEnabled] = useState<boolean>(addons.alerts ?? false);
  const [schedulerEnabled, setSchedulerEnabled] = useState<boolean>(addons.scheduler ?? false);
  const [chatEnabled, setChatEnabled] = useState<boolean>(addons.chat ?? false);
  const [adsbEnabled, setAdsbEnabled] = useState<boolean>(addons.adsb ?? false);
  const [acarsEnabled, setAcarsEnabled] = useState<boolean>(addons.acars ?? false);
  const [sentinelEnabled, setSentinelEnabled] = useState<boolean>(addons.sentinel ?? false);

  useEffect(() => {
    setStrategyEnabled(addons.strategy ?? false);
    setAlertsEnabled(addons.alerts ?? false);
    setSchedulerEnabled(addons.scheduler ?? false);
    setChatEnabled(addons.chat ?? false);
    setAdsbEnabled(addons.adsb ?? false);
    setAcarsEnabled(addons.acars ?? false);
    setSentinelEnabled(addons.sentinel ?? false);
  }, [
    addons.alerts,
    addons.chat,
    addons.scheduler,
    addons.strategy,
    addons.adsb,
    addons.acars,
    addons.sentinel,
  ]);

  const navItems = useMemo(() => {
    return NAV_ITEMS.filter((item) => {
      if (item.to === '/strategy') return strategyEnabled;
      if (item.to === '/alerts') return alertsEnabled;
      if (item.to === '/scheduler') return schedulerEnabled;
      if (item.to === '/chat') return chatEnabled;
      if (item.to === '/adsb') return adsbEnabled;
      if (item.to === '/acars') return acarsEnabled;
      if (item.to === '/sentinel') return sentinelEnabled;
      return true;
    });
  }, [
    strategyEnabled,
    alertsEnabled,
    schedulerEnabled,
    chatEnabled,
    adsbEnabled,
    acarsEnabled,
    sentinelEnabled,
  ]);

  return (
    <aside className="sidebar">
      {navItems.map(({ to, label, icon: Icon, hideOnMobile }) => (
        <NavLink
          key={to}
          to={to}
          className={({ isActive }) =>
            `nav-link ${isActive ? 'active' : ''}${hideOnMobile ? ' nav-link--mobile-hidden' : ''}`
          }
        >
          <Icon className="nav-icon" />
          <span className="nav-text">{label}</span>
        </NavLink>
      ))}
    </aside>
  );
}
