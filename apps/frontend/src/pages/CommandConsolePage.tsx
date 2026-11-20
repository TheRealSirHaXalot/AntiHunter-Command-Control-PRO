import { useMutation, useQuery } from '@tanstack/react-query';
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { apiClient } from '../api/client';
import { CommandRequest, CommandResponse, SiteSummary } from '../api/types';
import {
  COMMAND_GROUP_ORDER,
  CommandDefinition,
  CommandParameter,
  MESH_COMMANDS,
} from '../data/mesh-commands';
import { useAuthStore } from '../stores/auth-store';
import { NodeSummary, useNodeStore } from '../stores/node-store';
import { useTemplateStore, CommandTemplate } from '../stores/template-store';
import { TerminalLevel, useTerminalStore } from '../stores/terminal-store';
import { useTriangulationStore } from '../stores/triangulation-store';

type CommandFormState = {
  target: string;
  paramValues: Record<string, string>;
  includeForever: boolean;
  includeProbe: boolean;
  includeBroadcastAll: boolean;
  siteId?: string;
};

type TerminalEntryInput = {
  message: string;
  level: TerminalLevel;
  source: string;
  timestamp?: string;
  link?: string;
};

const defaultCommand = MESH_COMMANDS[0];
const TRIANGULATE_DEBOUNCE_MS = 3000;
const NODE_ONLINE_THRESHOLD_MS = 11 * 60 * 1000; // match Nodes page status

const createTemplateId = () => {
  if (typeof window !== 'undefined' && window.crypto?.randomUUID) {
    return `tmpl-${window.crypto.randomUUID()}`;
  }
  return `tmpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
};

type NodeTargetMeta = {
  value: string;
  baseLabel: string;
  siteId?: string | null;
  siteName?: string | null;
  siteCountry?: string | null;
  siteCity?: string | null;
};

type NodeCommandOption = {
  value: string;
  label: string;
  siteId?: string | null;
  siteLabel?: string | null;
  online?: boolean;
};

function normalizeTarget(value: string | undefined): string {
  if (!value) {
    return '@ALL';
  }
  const trimmed = value.trim().toUpperCase();
  const withoutAt = trimmed.startsWith('@') ? trimmed.slice(1) : trimmed;
  if (withoutAt === 'ALL') {
    return '@ALL';
  }
  if (withoutAt.startsWith('NODE_AH')) {
    return `@${withoutAt.replace(/^NODE_/, '')}`;
  }
  return `@${withoutAt}`;
}

function createFormState(
  command: CommandDefinition,
  preset?: { target?: string; params?: string[] },
): CommandFormState {
  const presetParams = preset?.params ?? command.examples?.[0]?.params ?? [];
  const paramValues: Record<string, string> = {};

  const tokenSet = new Set(['FOREVER', '+PROBE', '+ALL']);
  command.parameters.forEach((param, index) => {
    const exampleValue = presetParams[index];
    if (exampleValue && !tokenSet.has(exampleValue.toUpperCase())) {
      paramValues[param.key] = exampleValue;
      return;
    }
    if (param.type === 'select' && param.options?.length) {
      paramValues[param.key] = param.options[0].value;
      return;
    }
    paramValues[param.key] = '';
  });

  const upperPreset = presetParams.map((p) => p.toUpperCase());
  const includeForever =
    command.allowForever === true &&
    (upperPreset.includes('FOREVER') || (preset?.params?.includes('FOREVER') ?? false));
  const includeProbe =
    command.allowProbe === true &&
    (upperPreset.includes('+PROBE') || (preset?.params?.includes('+PROBE') ?? false));
  const includeBroadcastAll =
    command.allowBroadcastAll === true &&
    (upperPreset.includes('+ALL') || (preset?.params?.includes('+ALL') ?? false));

  const targetCandidate =
    preset?.target ?? command.examples?.[0]?.target ?? command.defaultTarget ?? '@ALL';

  return {
    target: normalizeTarget(targetCandidate),
    paramValues,
    includeForever,
    includeProbe,
    includeBroadcastAll,
    siteId: undefined,
  };
}

function buildCommandParams(command: CommandDefinition, form: CommandFormState): string[] {
  const parts = command.parameters
    .map((param) => (form.paramValues[param.key] ?? '').trim())
    .filter((value) => value.length > 0);

  if (command.allowForever && form.includeForever) {
    parts.push('FOREVER');
  }
  if (command.allowProbe && form.includeProbe) {
    parts.push('+PROBE');
  }
  if (command.allowBroadcastAll && form.includeBroadcastAll) {
    parts.push('+ALL');
  }

  return parts;
}

function parseCommandText(
  commandText: string,
): { target: string; name: string; params: string[] } | null {
  const trimmed = commandText.trim();
  const firstSpace = trimmed.indexOf(' ');
  if (firstSpace <= 0) {
    return null;
  }
  const target = trimmed.slice(0, firstSpace);
  const rest = trimmed.slice(firstSpace + 1);
  if (!rest) {
    return null;
  }
  const segments = rest.split(':');
  const [name, ...paramSegments] = segments;
  return { target: normalizeTarget(target), name: name.toUpperCase(), params: paramSegments };
}

function normalizeParamValue(param: CommandParameter, raw: string): string {
  switch (param.type) {
    case 'duration':
    case 'number': {
      const numeric = Number(raw.trim());
      if (!Number.isFinite(numeric)) {
        return '';
      }
      const min = param.min ?? (param.type === 'duration' ? 0 : Number.NEGATIVE_INFINITY);
      const max = param.max ?? Number.POSITIVE_INFINITY;
      const clamped = Math.min(Math.max(numeric, min), max);
      return clamped.toString();
    }
    case 'channels':
      return raw.replace(/\s+/g, '');
    case 'pipeList':
      return raw.replace(/\s+/g, '').toUpperCase();
    case 'text':
    default:
      return raw.trim();
  }
}

function deriveNodeTarget(node: NodeSummary): NodeTargetMeta {
  const rawId = (node.id ?? '').toUpperCase().replace(/^@/, '').replace(/\s+/g, '');
  const rawName = (node.name ?? '').toUpperCase().replace(/\s+/g, '');

  const ahCandidate =
    (/^AH\d+$/.test(rawName) && rawName) ||
    (/^AH\d+$/.test(rawId) && rawId) ||
    (rawId.startsWith('NODE_') && /^AH\d+$/.test(rawId.slice(5)) ? rawId.slice(5) : null);

  const fallback = rawName || rawId;
  const labelBase = ahCandidate ?? fallback ?? 'UNKNOWN';
  const safeLabel = labelBase.replace(/^NODE_/, '') || 'UNKNOWN';

  return {
    value: normalizeTarget(safeLabel),
    baseLabel: safeLabel,
    siteId: node.siteId ?? null,
    siteName: node.siteName ?? null,
    siteCountry: node.siteCountry ?? null,
    siteCity: node.siteCity ?? null,
  };
}

function isNodeOnline(node: NodeSummary): boolean {
  const lastTimestamp = node.lastSeen ?? node.ts;
  if (!lastTimestamp) {
    return false;
  }
  const parsed = Date.parse(lastTimestamp);
  if (Number.isNaN(parsed)) {
    return false;
  }
  return Date.now() - parsed <= NODE_ONLINE_THRESHOLD_MS;
}

export function CommandConsolePage() {
  const addEntry = useTerminalStore((state) => state.addEntry);
  const availableNodes = useNodeStore((state) =>
    state.order.map((id) => state.nodes[id]).filter((node): node is NodeSummary => Boolean(node)),
  );
  const templates = useTemplateStore((state) => state.templates);
  const addTemplateToStore = useTemplateStore((state) => state.addTemplate);
  const updateTemplateInStore = useTemplateStore((state) => state.updateTemplate);
  const deleteTemplateFromStore = useTemplateStore((state) => state.deleteTemplate);
  const user = useAuthStore((state) => state.user);
  const role = user?.role ?? null;

  const { data: sites } = useQuery({
    queryKey: ['sites'],
    queryFn: () => apiClient.get<SiteSummary[]>('/sites'),
  });

  const canSendCommands = role === 'ADMIN' || role === 'OPERATOR';

  const commandMap = useMemo(() => new Map(MESH_COMMANDS.map((cmd) => [cmd.name, cmd])), []);
  const groupedCommands = useMemo(() => {
    return COMMAND_GROUP_ORDER.map((group) => ({
      group,
      commands: MESH_COMMANDS.filter((cmd) => cmd.group === group),
    })).filter((entry) => entry.commands.length > 0);
  }, []);

  const [selectedCommandName, setSelectedCommandName] = useState(defaultCommand.name);
  const selectedCommand = commandMap.get(selectedCommandName) ?? defaultCommand;
  const [form, setForm] = useState<CommandFormState>(() => createFormState(defaultCommand));
  const [paramErrors, setParamErrors] = useState<Record<string, string>>({});
  const [targetError, setTargetError] = useState<string | null>(null);
  const [customCommand, setCustomCommand] = useState('@ALL STATUS');
  const [customError, setCustomError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [newTemplateName, setNewTemplateName] = useState('');
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [triangulateLocked, setTriangulateLocked] = useState(false);
  const triangulateCooldownRef = useRef<number | null>(null);
  const startTriangulationCountdown = useTriangulationStore((state) => state.setCountdown);
  const pendingTriangulation = useRef<{ mac?: string; duration?: number } | null>(null);

  useEffect(() => {
    return () => {
      if (triangulateCooldownRef.current) {
        window.clearTimeout(triangulateCooldownRef.current);
        triangulateCooldownRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!sites || sites.length === 0) {
      return;
    }
    const defaultSiteId =
      user?.siteAccess?.find((grant) => grant.level)?.siteId ?? sites[0]?.id ?? undefined;
    setForm((prev) => {
      if (prev.siteId) {
        return prev;
      }
      return { ...prev, siteId: defaultSiteId };
    });
  }, [sites, user]);

  const menuRef = useRef<HTMLDivElement | null>(null);
  const selectorRef = useRef<HTMLButtonElement | null>(null);
  const [menuPosition, setMenuPosition] = useState<{
    top: number;
    left: number;
    width: number;
  } | null>(null);

  const beginTriangulateCooldown = useCallback(() => {
    setTriangulateLocked(true);
    if (triangulateCooldownRef.current) {
      window.clearTimeout(triangulateCooldownRef.current);
    }
    triangulateCooldownRef.current = window.setTimeout(() => {
      setTriangulateLocked(false);
      triangulateCooldownRef.current = null;
    }, TRIANGULATE_DEBOUNCE_MS);
  }, []);

  const updateMenuPosition = useCallback(() => {
    if (typeof window === 'undefined' || !selectorRef.current) {
      return;
    }
    if (window.innerWidth > 768) {
      setMenuPosition(null);
      return;
    }
    const rect = selectorRef.current.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const width = Math.min(480, Math.max(rect.width, viewportWidth - 32));
    const horizontalMargin = 16;
    const left = Math.max(
      horizontalMargin,
      Math.min(viewportWidth - width - horizontalMargin, (viewportWidth - width) / 2),
    );
    const top = rect.bottom + 12;
    setMenuPosition({ top, left, width });
  }, []);

  useEffect(() => {
    if (!menuOpen) {
      setMenuPosition(null);
      return;
    }
    updateMenuPosition();
    if (typeof window === 'undefined' || window.innerWidth > 768) {
      return;
    }
    const handleWindowChange = () => {
      updateMenuPosition();
    };
    window.addEventListener('resize', handleWindowChange);
    window.addEventListener('scroll', handleWindowChange, true);
    return () => {
      window.removeEventListener('resize', handleWindowChange);
      window.removeEventListener('scroll', handleWindowChange, true);
    };
  }, [menuOpen, updateMenuPosition]);

  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    const handleClickAway = (event: MouseEvent) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(event.target as Node) &&
        selectorRef.current &&
        !selectorRef.current.contains(event.target as Node)
      ) {
        setMenuOpen(false);
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickAway);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickAway);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [menuOpen]);

  const mutation = useMutation<CommandResponse, Error, CommandRequest>({
    mutationFn: (body: CommandRequest) => apiClient.post<CommandResponse>('/commands/send', body),
    onSuccess: (data, variables) => {
      const entry: TerminalEntryInput = {
        message: `Command ${data.id} queued`,
        level: 'notice',
        source: 'command',
      };
      addEntry(entry);
      const commandName = variables?.name ?? (data as unknown as { name?: string })?.name ?? '';
      if (
        commandName === 'TRIANGULATE_START' &&
        pendingTriangulation.current?.mac &&
        Number.isFinite(pendingTriangulation.current?.duration)
      ) {
        startTriangulationCountdown(
          pendingTriangulation.current.mac,
          pendingTriangulation.current.duration as number,
        );
      }
      pendingTriangulation.current = null;
    },
    onError: (error: unknown) => {
      const entry: TerminalEntryInput = {
        message: `Command failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        level: 'critical',
        source: 'command',
      };
      addEntry(entry);
    },
  });

  const nodeCommandTargets = useMemo<NodeCommandOption[]>(() => {
    const activeSiteId = form.siteId ?? undefined;
    const dedup = new Map<string, NodeCommandOption>();
    availableNodes.forEach((node) => {
      const nodeSiteId = node.siteId ?? undefined;
      if (activeSiteId && nodeSiteId !== activeSiteId) {
        return;
      }
      const target = deriveNodeTarget(node);
      const locationTokens = [target.siteCountry, target.siteCity].filter(Boolean) as string[];
      const siteLabel =
        locationTokens.length > 0
          ? locationTokens.join(' / ')
          : (target.siteName ?? target.siteId ?? null);
      const online = isNodeOnline(node);
      const statusLabel = online ? 'online' : 'offline';
      const dedupKey = `${target.value}::${target.siteId ?? 'local'}::${siteLabel ?? ''}`;
      if (!dedup.has(dedupKey)) {
        const baseLabel = siteLabel ? `${target.baseLabel} (${siteLabel})` : target.baseLabel;
        const decoratedLabel = `${baseLabel} · ${statusLabel}`;
        dedup.set(dedupKey, {
          value: target.value,
          label: decoratedLabel,
          siteId: target.siteId ?? null,
          siteLabel: siteLabel ?? undefined,
          online,
        });
      }
    });
    return Array.from(dedup.values());
  }, [availableNodes, form.siteId]);

  const singleNodeCommands = useMemo(
    () =>
      new Set([
        'CONFIG_NODEID',
        'TRIANGULATE_START',
        'ERASE_REQUEST',
        'ERASE_FORCE',
        'ERASE_CANCEL',
        'AUTOERASE_ENABLE',
        'AUTOERASE_DISABLE',
        'FACTORY_RESET',
        'CONFIG_ERASE_PSK',
      ]),
    [],
  );
  const isSingleNodeCommand = singleNodeCommands.has(selectedCommand.name);
  const isTriangulateCommand = selectedCommand.name === 'TRIANGULATE_START';

  const targetOptions = useMemo<NodeCommandOption[]>(() => {
    const options: NodeCommandOption[] = isSingleNodeCommand
      ? [...nodeCommandTargets]
      : [{ value: '@ALL', label: '@ALL (broadcast)' }, ...nodeCommandTargets];

    if (
      form.target &&
      !options.some((option) => option.value === normalizeTarget(form.target)) &&
      (!form.siteId || normalizeTarget(form.target) === '@ALL') &&
      normalizeTarget(form.target) !== '@ALL'
    ) {
      const normalized = normalizeTarget(form.target);
      options.push({ value: normalized, label: normalized.replace(/^@/, '') });
    }

    return options;
  }, [nodeCommandTargets, form.target, form.siteId, isSingleNodeCommand]);
  const selectedTargetOption = useMemo(
    () => targetOptions.find((option) => option.value === form.target),
    [targetOptions, form.target],
  );
  const selectedTargetValue = selectedTargetOption?.value ?? null;
  const selectedTargetSiteToken = selectedTargetOption
    ? Object.prototype.hasOwnProperty.call(selectedTargetOption, 'siteId')
      ? (selectedTargetOption.siteId ?? '__NULL_SITE__')
      : '__MISSING_SITE__'
    : '__NO_TARGET__';

  useEffect(() => {
    if (selectedTargetValue) {
      return;
    }
    setForm((prev) => {
      if (isSingleNodeCommand) {
        const fallback = targetOptions[0]?.value ?? '';
        return prev.target === fallback ? prev : { ...prev, target: fallback };
      }
      return prev.target === '@ALL' ? prev : { ...prev, target: '@ALL' };
    });
  }, [selectedTargetValue, isSingleNodeCommand, targetOptions]);

  useEffect(() => {
    if (
      selectedTargetSiteToken === '__NO_TARGET__' ||
      selectedTargetSiteToken === '__MISSING_SITE__'
    ) {
      return;
    }
    const nextSiteId =
      selectedTargetSiteToken === '__NULL_SITE__' ? undefined : (selectedTargetSiteToken as string);
    setForm((prev) => (prev.siteId === nextSiteId ? prev : { ...prev, siteId: nextSiteId }));
  }, [selectedTargetSiteToken]);

  const paramsForCommand = useMemo(
    () => buildCommandParams(selectedCommand, form),
    [selectedCommand, form],
  );

  const commandPayload = useMemo(() => {
    if (paramsForCommand.length === 0) {
      return selectedCommand.name;
    }
    return `${selectedCommand.name}:${paramsForCommand.join(':')}`;
  }, [paramsForCommand, selectedCommand.name]);

  const preview = useMemo(() => {
    const target = form.target.trim();
    if (!target) {
      return commandPayload;
    }
    return `${target} ${commandPayload}`.trim();
  }, [form.target, commandPayload]);

  const setCommand = (
    command: CommandDefinition,
    preset?: { target?: string; params?: string[] },
  ) => {
    setSelectedCommandName(command.name);
    setForm((prev) => ({
      ...createFormState(command, preset),
      siteId: prev.siteId,
    }));
    setParamErrors({});
    setTargetError(null);
    setMenuOpen(false);
  };

  const handleParamInputChange = (param: CommandParameter, rawValue: string) => {
    const value = normalizeParamValue(param, rawValue);
    setForm((prev) => ({
      ...prev,
      paramValues: {
        ...prev.paramValues,
        [param.key]: value,
      },
    }));
    setParamErrors((prev) => {
      if (!prev[param.key]) {
        return prev;
      }
      const next = { ...prev };
      delete next[param.key];
      return next;
    });
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    setCustomError(null);
    const trimmedTarget = form.target.trim();
    const errors: Record<string, string> = {};
    selectedCommand.parameters.forEach((param) => {
      const value = (form.paramValues[param.key] ?? '').trim();
      if (param.required && !value) {
        errors[param.key] = 'Required';
        return;
      }
      if (value && (param.type === 'number' || param.type === 'duration')) {
        const parsed = Number(value);
        if (!Number.isInteger(parsed)) {
          errors[param.key] = 'Must be a whole number';
        } else if (param.min !== undefined && parsed < param.min) {
          errors[param.key] = `Minimum ${param.min}`;
        } else if (param.max !== undefined && parsed > param.max) {
          errors[param.key] = `Maximum ${param.max}`;
        }
      }
    });
    setParamErrors(errors);
    if (!trimmedTarget) {
      setTargetError('Target is required');
    } else if (isSingleNodeCommand && normalizeTarget(trimmedTarget) === '@ALL') {
      setTargetError('Select a specific node for this command');
    } else {
      setTargetError(null);
    }
    if (
      Object.keys(errors).length > 0 ||
      !trimmedTarget ||
      (isSingleNodeCommand && normalizeTarget(trimmedTarget) === '@ALL')
    ) {
      return;
    }

    if (!canSendCommands) {
      setTargetError('You do not have permission to send commands.');
      return;
    }

    if (isTriangulateCommand && triangulateLocked) {
      setTargetError('Triangulation command recently sent. Please wait a moment.');
      return;
    }

    if (isTriangulateCommand) {
      beginTriangulateCooldown();
      const macParam =
        paramsForCommand.length > 0 ? paramsForCommand[0].toUpperCase().trim() : undefined;
      const durationParam = paramsForCommand.length > 1 ? Number(paramsForCommand[1]) : undefined;
      pendingTriangulation.current = { mac: macParam, duration: durationParam };
    }
    mutation.mutate({
      target: trimmedTarget,
      name: selectedCommand.name,
      params: paramsForCommand,
      siteId: form.siteId,
    });
  };

  const handleSaveTemplate = () => {
    const trimmedName = newTemplateName.trim();
    if (!trimmedName) {
      setTemplateError('Template name is required');
      return;
    }
    const lower = trimmedName.toLowerCase();
    if (templates.some((template) => template.label.toLowerCase() === lower)) {
      setTemplateError('A template with this name already exists');
      return;
    }
    const target = form.target.trim() || '@ALL';
    const params = paramsForCommand;
    const id = createTemplateId();
    const template: CommandTemplate = {
      id,
      label: trimmedName,
      commandName: selectedCommand.name,
      target,
      params,
    };
    addTemplateToStore(template);
    setNewTemplateName('');
    setTemplateError(null);
    setEditingTemplateId(null);
  };

  const handleTemplateUse = (template: CommandTemplate) => {
    const definition = commandMap.get(template.commandName);
    if (!definition) {
      return;
    }
    setCommand(definition, { target: template.target, params: template.params });
    setEditingTemplateId(null);
    setNewTemplateName('');
    setTemplateError(null);
  };

  const handleTemplateEdit = (template: CommandTemplate) => {
    const definition = commandMap.get(template.commandName);
    if (!definition) {
      return;
    }
    setCommand(definition, { target: template.target, params: template.params });
    setNewTemplateName(template.label);
    setEditingTemplateId(template.id);
    setTemplateError(null);
  };

  const handleDeleteTemplate = (templateId: string) => {
    deleteTemplateFromStore(templateId);
    if (editingTemplateId === templateId) {
      setEditingTemplateId(null);
      setNewTemplateName('');
      setTemplateError(null);
    }
  };

  const handleUpdateTemplate = () => {
    if (!editingTemplateId) {
      return;
    }
    const trimmedName = newTemplateName.trim();
    if (!trimmedName) {
      setTemplateError('Template name is required');
      return;
    }
    const lower = trimmedName.toLowerCase();
    if (
      templates.some(
        (template) => template.id !== editingTemplateId && template.label.toLowerCase() === lower,
      )
    ) {
      setTemplateError('Another template already uses this name');
      return;
    }
    const target = form.target.trim() || '@ALL';
    const params = paramsForCommand;
    updateTemplateInStore(editingTemplateId, {
      label: trimmedName,
      commandName: selectedCommand.name,
      target,
      params,
    });
    setTemplateError(null);
  };

  const handleCancelTemplateEdit = () => {
    setEditingTemplateId(null);
    setNewTemplateName('');
    setTemplateError(null);
  };

  const handleCustomSubmit = () => {
    const commandLine = customCommand.trim();
    if (!commandLine) {
      setCustomError('Command line is required.');
      return;
    }

    const parsed = parseCommandText(commandLine);
    if (!parsed) {
      setCustomError('Invalid command format. Expected "@TARGET COMMAND[:param]".');
      return;
    }

    if (!canSendCommands) {
      setCustomError('You do not have permission to send commands.');
      return;
    }

    setCustomError(null);
    mutation.mutate({
      target: parsed.target,
      name: parsed.name,
      params: parsed.params,
      siteId: form.siteId,
    });
  };

  return (
    <section className="panel command-console">
      <header className="panel__header">
        <div>
          <h1 className="panel__title">Command Console</h1>
          <p className="panel__subtitle">
            Choose a command, fill in typed parameters, and queue it to the mesh. The left rail
            includes curated templates for quick reuse. Save your own templates when you find a
            useful configuration.
          </p>
        </div>
      </header>

      <div className="console-layout">
        <form className="console-form" onSubmit={handleSubmit}>
          <div className="form-row">
            <label htmlFor="command-selector">Command</label>
            <div className="command-selector-wrapper">
              <button
                id="command-selector"
                ref={selectorRef}
                type="button"
                className="command-selector"
                onClick={() => setMenuOpen((open) => !open)}
                aria-expanded={menuOpen}
              >
                <span>{selectedCommand.name}</span>
                <span className="command-selector__group">{selectedCommand.group}</span>
                <span className="command-selector__chevron" aria-hidden>
                  ?
                </span>
              </button>
              {menuOpen ? (
                <div
                  className="command-menu"
                  ref={menuRef}
                  style={
                    menuPosition
                      ? {
                          position: 'fixed',
                          top: `${menuPosition.top}px`,
                          left: `${menuPosition.left}px`,
                          width: `${menuPosition.width}px`,
                          marginTop: 0,
                          transform: 'none',
                        }
                      : undefined
                  }
                >
                  {groupedCommands.map(({ group, commands }) => (
                    <div key={group} className="command-menu__group">
                      <div className="command-menu__title">{group}</div>
                      {commands.map((command) => (
                        <button
                          key={command.name}
                          type="button"
                          className={`command-menu__item ${command.name === selectedCommand.name ? 'is-active' : ''}`}
                          onClick={() => setCommand(command)}
                        >
                          <span className="command-menu__item-name">{command.name}</span>
                          <span className="command-menu__item-desc">{command.description}</span>
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </div>

          <div className="form-row">
            <div className="form-label">Description</div>
            <p className="command-description">{selectedCommand.description}</p>
          </div>

          <div className="form-row">
            <label htmlFor="command-target">Target</label>
            <select
              id="command-target"
              value={form.target}
              onChange={(event) => {
                const normalized = normalizeTarget(event.target.value);
                const optionMeta = targetOptions.find((option) => option.value === normalized);
                setForm((prev) => ({
                  ...prev,
                  target: normalized,
                  siteId:
                    optionMeta && Object.prototype.hasOwnProperty.call(optionMeta, 'siteId')
                      ? (optionMeta.siteId ?? undefined)
                      : prev.siteId,
                }));
              }}
            >
              {targetOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            {targetError ? <span className="form-error">{targetError}</span> : null}
          </div>

          {sites && sites.length > 1 ? (
            <div className="form-row">
              <div className="form-label">Site</div>
              <select
                value={form.siteId ?? ''}
                disabled={Boolean(selectedTargetOption?.siteId)}
                onChange={(event) =>
                  setForm((prev) => ({
                    ...prev,
                    siteId: event.target.value || undefined,
                  }))
                }
              >
                {sites.map((site) => (
                  <option key={site.id} value={site.id}>
                    {(() => {
                      const locationTokens = [site.country, site.city].filter(Boolean) as string[];
                      const locationLabel =
                        locationTokens.length > 0 ? locationTokens.join(' / ') : null;
                      const baseLabel = site.name ?? site.id;
                      return locationLabel ? `${baseLabel} (${locationLabel})` : baseLabel;
                    })()}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {selectedCommand.parameters.length > 0 ? (
            <div className="form-row">
              <div className="form-label">Parameters</div>
              <div className="form-parameters">
                {selectedCommand.parameters.map((param) => {
                  const value = form.paramValues[param.key] ?? '';
                  return (
                    <div key={param.key} className="parameter-field">
                      <div className="parameter-label">
                        <span>{param.label}</span>
                        {param.required ? <span className="parameter-required">*</span> : null}
                      </div>
                      {param.type === 'select' ? (
                        <select
                          value={value}
                          onChange={(event) => handleParamInputChange(param, event.target.value)}
                        >
                          {param.options?.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <div className="parameter-control">
                          <input
                            value={value}
                            onChange={(event) => handleParamInputChange(param, event.target.value)}
                            placeholder={param.placeholder}
                            type={
                              param.secret
                                ? 'password'
                                : param.type === 'duration' || param.type === 'number'
                                  ? 'number'
                                  : 'text'
                            }
                            autoComplete={param.secret ? 'off' : undefined}
                            inputMode={
                              param.type === 'duration' || param.type === 'number'
                                ? 'numeric'
                                : undefined
                            }
                            min={param.min}
                            max={param.max}
                            step={
                              param.step ??
                              (param.type === 'duration' || param.type === 'number' ? 1 : undefined)
                            }
                          />
                          {param.suffix ? (
                            <span className="parameter-suffix">{param.suffix}</span>
                          ) : null}
                        </div>
                      )}
                      {param.helper ? <small>{param.helper}</small> : null}
                      {paramErrors[param.key] ? (
                        <span className="form-error">{paramErrors[param.key]}</span>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}

          {selectedCommand.allowForever ? (
            <div className="form-row forever-toggle">
              <label>
                <input
                  type="checkbox"
                  checked={form.includeForever}
                  onChange={(event) =>
                    setForm((prev) => ({
                      ...prev,
                      includeForever: event.target.checked,
                    }))
                  }
                />
                Run until STOP
              </label>
              <span>Command continues until a STOP is issued.</span>
            </div>
          ) : null}

          {selectedCommand.allowProbe ? (
            <div className="form-row forever-toggle">
              <label>
                <input
                  type="checkbox"
                  checked={form.includeProbe}
                  onChange={(event) =>
                    setForm((prev) => ({
                      ...prev,
                      includeProbe: event.target.checked,
                    }))
                  }
                />
                +PROBE
              </label>
              <span>Capture probe requests during device scan.</span>
            </div>
          ) : null}

          {selectedCommand.allowBroadcastAll ? (
            <div className="form-row forever-toggle">
              <label>
                <input
                  type="checkbox"
                  checked={form.includeBroadcastAll}
                  onChange={(event) =>
                    setForm((prev) => ({
                      ...prev,
                      includeBroadcastAll: event.target.checked,
                    }))
                  }
                />
                +ALL
              </label>
              <span>Broadcast every probe over mesh, not just target matches.</span>
            </div>
          ) : null}

          <div className="form-row">
            <div className="form-label">Preview</div>
            <code className="preview-line">{preview || 'N/A'}</code>
          </div>

          <button
            type="submit"
            className="submit-button"
            disabled={
              mutation.isPending || !canSendCommands || (isTriangulateCommand && triangulateLocked)
            }
          >
            {mutation.isPending ? 'Sending...' : 'Send Command'}
          </button>

          <div className="form-divider" />

          <div className="custom-command">
            <label htmlFor="custom-command">Custom Command</label>
            <textarea
              id="custom-command"
              className="custom-command__input"
              rows={3}
              value={customCommand}
              onChange={(event) => setCustomCommand(event.target.value)}
              placeholder="@ALL STATUS"
            />
            {customError ? <span className="form-error">{customError}</span> : null}
            <button
              type="button"
              className="secondary-button"
              onClick={handleCustomSubmit}
              disabled={mutation.isPending || !canSendCommands}
            >
              Send Raw Command
            </button>
          </div>

          <div className="form-row template-save">
            <label htmlFor="template-name">Save as Template</label>
            <div className="template-save__controls">
              <input
                id="template-name"
                value={newTemplateName}
                onChange={(event) => setNewTemplateName(event.target.value)}
                placeholder="Template name (e.g., Nightly scan)"
              />
              {editingTemplateId ? (
                <>
                  <button type="button" onClick={handleUpdateTemplate}>
                    Update
                  </button>
                  <button
                    type="button"
                    className="template-cancel"
                    onClick={handleCancelTemplateEdit}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button type="button" onClick={handleSaveTemplate}>
                  Save
                </button>
              )}
            </div>
            {templateError ? <span className="form-error">{templateError}</span> : null}
          </div>

          {mutation.isError ? (
            <p className="error-text">Failed to send command. Check terminal for details.</p>
          ) : null}
          {mutation.isSuccess ? (
            <p className="success-text">Command queued. Track updates in the terminal.</p>
          ) : null}
        </form>

        <section className="console-templates console-templates--stacked">
          <h2>Command Templates</h2>
          <div className="template-list">
            {templates.map((template) => {
              const isEditingTemplate = editingTemplateId === template.id;
              return (
                <article
                  key={template.id}
                  className={`template-card${isEditingTemplate ? ' is-editing' : ''}`}
                >
                  <div className="template-card__header">
                    <div>
                      <strong>{template.label}</strong>
                      <span>{template.commandName}</span>
                    </div>
                    <div className="template-card__actions">
                      <button type="button" onClick={() => handleTemplateUse(template)}>
                        Use
                      </button>
                      <button type="button" onClick={() => handleTemplateEdit(template)}>
                        {isEditingTemplate ? 'Editing…' : 'Edit'}
                      </button>
                      <button
                        type="button"
                        className="template-delete template-card__delete"
                        aria-label={`Delete template ${template.label}`}
                        onClick={() => handleDeleteTemplate(template.id)}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                  <p>
                    {template.description ??
                      `${template.target} ${[template.commandName, ...template.params].join(':')}`}
                  </p>
                </article>
              );
            })}
            {templates.length === 0 ? <p className="template-empty">No templates yet.</p> : null}
          </div>
        </section>
      </div>
    </section>
  );
}
