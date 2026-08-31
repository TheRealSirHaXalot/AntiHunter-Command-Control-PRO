import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface CommandTemplate {
  id: string;
  label: string;
  commandName: string;
  target: string;
  params: string[];
  description?: string;
  builtIn?: boolean;
}

export const DEFAULT_TEMPLATES: CommandTemplate[] = [
  {
    id: 'tmpl-status-all',
    label: 'Status - All nodes',
    commandName: 'STATUS',
    target: '@ALL',
    params: [],
    description: 'Request a full status snapshot from every node.',
    builtIn: true,
  },
  {
    id: 'tmpl-scan-wifi',
    label: 'WiFi Scan - 60s',
    commandName: 'SCAN_START',
    target: '@ALL',
    params: ['0', '60', '1..14'],
    description: 'Start a 60 second WiFi scan across channels 1..14.',
    builtIn: true,
  },
  {
    id: 'tmpl-device-scan-forever',
    label: 'Device Scan - FOREVER',
    commandName: 'DEVICE_SCAN_START',
    target: '@NODE_22',
    params: ['2', '300', 'FOREVER'],
    description: 'Keep NODE_22 scanning for WiFi/BLE devices indefinitely.',
    builtIn: true,
  },
  {
    id: 'tmpl-pcap-wifi-5m',
    label: 'Packet Capture - WiFi 5 min',
    commandName: 'PCAP_START',
    target: '@ALL',
    params: ['0', '300', '0'],
    description: 'Record five minutes of 2.4 GHz WiFi traffic to the node SD card.',
    builtIn: true,
  },
  {
    id: 'tmpl-baseline-5m',
    label: 'Baseline - 5 min',
    commandName: 'BASELINE_START',
    target: '@ALL',
    params: ['300'],
    description: 'Collect a five minute baseline across the mesh.',
    builtIn: true,
  },
  {
    id: 'tmpl-triangulate-mac',
    label: 'Triangulate - MAC',
    commandName: 'TRIANGULATE_START',
    target: '@ALL',
    params: ['AA:BB:CC:DD:EE:FF', '300'],
    description: 'Start triangulating a target MAC address for five minutes.',
    builtIn: true,
  },
];

type TemplateStoreState = {
  templates: CommandTemplate[];
  addTemplate: (template: CommandTemplate) => void;
  updateTemplate: (id: string, update: Partial<CommandTemplate>) => void;
  deleteTemplate: (id: string) => void;
  reset: () => void;
};

export const useTemplateStore = create<TemplateStoreState>()(
  persist(
    (set, _get) => ({
      templates: DEFAULT_TEMPLATES,
      addTemplate: (template) => {
        set((state) => ({
          templates: [...state.templates, template],
        }));
      },
      updateTemplate: (id, update) => {
        set((state) => ({
          templates: state.templates.map((template) =>
            template.id === id ? { ...template, ...update } : template,
          ),
        }));
      },
      deleteTemplate: (id) => {
        set((state) => ({
          templates: state.templates.filter((template) => template.id !== id),
        }));
      },
      reset: () => set({ templates: DEFAULT_TEMPLATES }),
    }),
    {
      name: 'command-center.templates',
    },
  ),
);
