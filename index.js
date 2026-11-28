import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  MatterbridgeDynamicPlatform,
  MatterbridgeEndpoint,
  bridgedNode,
  doorLock,
  occupancySensor,
  onOffPlugInUnit,
} from 'matterbridge';
import { ChangeNotificationService, ClientNode, ControllerBehavior, NetworkClient, Seconds, ServerNode } from 'matterbridge/matter';
import { BasicInformationClient, BridgedDeviceBasicInformationClient, DoorLockServer, FixedLabelServer } from 'matterbridge/matter/behaviors';
import { BridgedDeviceBasicInformation, Descriptor, DoorLock, FixedLabel, OccupancySensing, OnOff } from 'matterbridge/matter/clusters';
import { ManualPairingCodeCodec, StatusResponse } from 'matterbridge/matter/types';
import { Alarm, integerIn } from './alarm.js';
import { isSupportedRule, signalsOf } from './attributes.js';
import { commandsOf, executeOperation, validOperation } from './actions.js';
import { hasAudioProfiles, readAudioProfiles } from './content.js';

const apiActions = new Set([
  'status', 'pair-device', 'share-device', 'rename-device', 'remove-device', 'settings', 'arm',
  'rule', 'remove-rule', 'zone', 'remove-zone', 'action', 'remove-action', 'test-action',
  'scenario', 'remove-scenario', 'test-scenario', 'mode', 'remove-mode',
]);
const modePhases = ['exit', 'armed', 'entry', 'triggered', 'disarmed'];
const modePresentations = {
  switches: { type: onOffPlugInUnit, groupId: 'alarm-mode-selector', modePrefix: 'alarm-mode-', name: 'Alarme' },
  locks: { type: doorLock, groupId: 'alarm-lock-selector', modePrefix: 'alarm-lock-mode-', name: 'Alarme (serrures)' },
};
const lockCommands = new WeakMap();

export default function initialize(matterbridge, log, config) {
  return new HybridPoc(matterbridge, log, config);
}

class HybridPoc extends MatterbridgeDynamicPlatform {
  controller;
  changes;
  configuring = false;
  activePeers = new Set();
  modeGroups = new Map();
  profileCatalogs = new Map();
  profilesRefreshedAt = 0;

  async onStart() {
    await this.ready;
    if (!this.verifyMatterbridgeVersion('3.11.2', false)) throw new Error('Matterbridge 3.11.2 ou ultérieur est requis pour protéger les API du plugin.');
    this.alarm = new Alarm({
      storagePath: join(this.matterbridge.matterbridgeDirectory, `${this.name}.alarm-state.json`),
      changed: () => this.schedulePublication(),
      onError: (error) => this.reportError(error),
    });
    await this.alarm.start();
    await this.syncAccessories();
    await this.startController();
    this.schedulePublication();
  }

  createModeControl(kind, mode, index, number) {
    const { type, groupId, modePrefix, name } = modePresentations[kind];
    const id = mode ? modePrefix + mode.id : groupId;
    const label = mode?.name ?? 'Désarmer';
    const tagList = modeTags(label, index);
    // Maison discovers children when the parent also has an application device type.
    const device = new MatterbridgeEndpoint(mode ? type : [type, bridgedNode], { id, tagList, number });
    if (mode) device.deviceName = mode.name;
    else device.createDefaultBridgedDeviceBasicInformationClusterServer(name, groupId);
    const { state } = this.alarm.record;
    const active = mode ? state.modeId === mode.id : state.phase === 'disarmed';
    const command = (activate, context) => this.commandModeControl(mode?.id, activate, context);
    if (kind === 'locks') {
      lockCommands.set(device, command);
      device.behaviors.require(AlarmModeLockServer, {
        lockState: lockState(active), lockType: DoorLock.LockType.DeadBolt, actuatorEnabled: true,
        operatingMode: DoorLock.OperatingMode.Normal,
      });
      device.behaviors.require(FixedLabelServer, { labelList: lockLabels(label) });
    } else {
      device.createDefaultOnOffClusterServer(active);
      device.addCommandHandler('OnOff.on', ({ context }) => command(true, context));
      device.addCommandHandler('OnOff.off', ({ context }) => command(false, context));
      rejectAlternativeCommands(device);
    }
    return device.addRequiredClusters();
  }

  async commandModeControl(modeId, activate, context) {
    const source = this.matterSource(context);
    let error;
    if (modeId) error = await this.alarm.command(modeId, activate, source);
    else if (activate) error = await this.alarm.disarm(source);
    else if (this.alarm.record.state.phase === 'disarmed') error = 'Active un mode pour armer l’alarme.';
    if (error) throw new StatusResponse.FailureError(error);
  }

  async syncModeGroup(kind, enabled, modes) {
    const group = this.modeGroups.get(kind);
    const numbersKey = `alarmModeNumbers:${this.matterbridge.bridgeMode}:${kind}`;
    if (!enabled) {
      if (group) {
        // Unregistering erases Matterbridge's endpoint allocation. Keep it for this same group.
        await this.context.set(numbersKey, {
          parent: group.parent.number,
          modes: Object.fromEntries([...group.controls].map(([id, device]) => [id, device.number])),
        });
        await this.unregisterDevice(group.parent);
        this.modeGroups.delete(kind);
      }
      return;
    }
    if (!group) {
      const numbers = await this.context.get(numbersKey, {});
      const parent = this.createModeControl(kind, undefined, 0, numbers.parent);
      const controls = new Map();
      // Publish the complete composition in the first descriptor a controller reads.
      for (const [index, mode] of modes.entries()) {
        const device = this.createModeControl(kind, mode, index + 1, numbers.modes?.[mode.id]);
        parent.parts.add(device);
        controls.set(mode.id, device);
      }
      await this.registerDevice(parent);
      this.bridgeRoot = parent.ownerOfType(ServerNode.RootEndpoint);
      if (kind === 'locks') await parent.setAttribute(BridgedDeviceBasicInformation, 'nodeLabel', 'Désarmer', this.log);
      this.modeGroups.set(kind, { parent, controls });
      return;
    }
    const { parent, controls } = group;
    for (const [id, device] of controls) {
      if (modes.some((mode) => mode.id === id)) continue;
      await device.delete();
      controls.delete(id);
    }
    for (const [index, mode] of modes.entries()) {
      let device = controls.get(mode.id);
      if (!device) {
        device = this.createModeControl(kind, mode, index + 1);
        await parent.add(device);
        controls.set(mode.id, device);
      }
      await device.setAttribute(Descriptor, 'tagList', modeTags(mode.name, index + 1));
      if (kind === 'locks') await device.setAttribute(FixedLabel, 'labelList', lockLabels(mode.name), this.log);
      device.deviceName = mode.name;
    }
  }

  async syncAccessories() {
    const { modes, settings } = this.alarm.record;
    await this.syncModeGroup('switches', settings.exposeSwitches, modes);
    await this.syncModeGroup('locks', settings.exposeLocks, modes);
    if (settings.detector && !this.alarmDetector) {
      const device = new MatterbridgeEndpoint([occupancySensor, bridgedNode], { id: 'alarm-occupancy' })
        .createDefaultBridgedDeviceBasicInformationClusterServer('Alarme déclenchée', 'alarm-occupancy')
        .createDefaultOccupancySensingClusterServer(this.alarm.record.state.phase === 'triggered')
        .addRequiredClusters();
      await this.registerDevice(device);
      this.alarmDetector = device;
      this.bridgeRoot = device.ownerOfType(ServerNode.RootEndpoint);
    } else if (!settings.detector && this.alarmDetector) {
      await this.unregisterDevice(this.alarmDetector);
      this.alarmDetector = undefined;
    }
  }

  schedulePublication() {
    this.scheduleActions();
    const { phase, modeId } = this.alarm.record.state;
    const signal = `${modeId}:${phase}`;
    if (this.shuttingDown || this.lastSignal === signal) return;
    this.lastSignal = signal;
    // Matter command handlers may hold the endpoint transaction until they return.
    this.published = (this.published ?? Promise.resolve()).then(async () => {
      await new Promise((resolve) => setImmediate(resolve));
      if (this.shuttingDown) return;
      const switches = this.modeGroups.get('switches');
      if (switches) {
        for (const [id, device] of switches.controls) await device.setAttribute(OnOff, 'onOff', modeId === id, this.log);
        await switches.parent.setAttribute(OnOff, 'onOff', phase === 'disarmed', this.log);
      }
      const locks = this.modeGroups.get('locks');
      if (locks) {
        for (const [id, device] of locks.controls) await publishLockState(device, modeId === id);
        await publishLockState(locks.parent, phase === 'disarmed');
      }
      await this.alarmDetector?.setAttribute(OccupancySensing, 'occupancy', { occupied: phase === 'triggered' }, this.log);
    }).catch((error) => this.reportError(error));
  }

  async startController() {
    this.controller = await ServerNode.create(ServerNode.RootEndpointWithoutGroupcast.with(ControllerBehavior), {
      id: 'hybrid-poc-controller',
      commissioning: { enabled: false },
      controller: { adminFabricLabel: 'Matterbridge Alarm' },
      network: { port: 0 },
      subscriptions: { persistenceEnabled: false },
    });
    this.changes = this.controller.env.get(ChangeNotificationService).change;
    this.changes.on(this.onChange);
    for (const peer of this.controller.peers.commissioned) this.observeSubscription(peer);
    await this.controller.start();
  }

  async onFetch(method, path, _query, body) {
    if (method !== 'POST' || !apiActions.has(path)) return undefined;
    if (!this.controller?.lifecycle.isOnline) return { error: 'Le contrôleur Matter démarre. Réessaie dans quelques secondes.' };
    if (path === 'status') {
      if (body.refreshProfiles === true) await this.refreshProfiles(true);
      else void this.refreshProfiles();
      return this.status();
    }
    if (path === 'arm') {
      if (typeof body.arm !== 'boolean' || typeof body.modeId !== 'string') return { error: 'Commande invalide.' };
      const error = await this.alarm.command(body.modeId, body.arm, 'Interface web');
      return error ? { error } : this.status();
    }
    if (path === 'share-device') {
      const peer = typeof body.peer === 'string' && this.controller.peers.get(body.peer);
      if (!peer?.lifecycle.isConnected) return { error: 'Appareil Matter indisponible.' };
      const window = await peer.openEnhancedCommissioningWindow();
      return { code: window.manualPairingCode };
    }
    if (this.runningActions) return { error: 'Attends la fin des actions avant de modifier la configuration.' };
    if (this.configuring) return { error: 'Une configuration est déjà en cours.' };
    this.configuring = true;
    try {
      const error = await this.configure(path, body);
      if (error) return { error };
      if (['mode', 'remove-mode', 'settings'].includes(path)) {
        const sync = (this.published ?? Promise.resolve()).then(() => this.syncAccessories());
        this.published = sync.catch((failure) => this.reportError(failure));
        await sync;
      }
      if (path === 'pair-device') await this.refreshProfiles(true);
      return this.status();
    } finally {
      this.configuring = false;
    }
  }

  status() {
    return {
      alarm: this.alarm.view,
      controllers: this.controllers(),
      accessories: {
        modes: this.modeGroupStatus('switches'),
        ...(this.modeGroups.has('locks') ? { locks: this.modeGroupStatus('locks') } : {}),
      },
      actionRunning: Boolean(this.runningActions),
      peers: this.deviceStatus(),
    };
  }

  modeGroupStatus(kind) {
    const group = this.modeGroups.get(kind);
    if (!group) return null;
    const { parent, controls } = group;
    return {
      name: modePresentations[kind].name,
      endpoint: parent.maybeNumber,
      parts: parent.getAttribute(Descriptor, 'partsList'),
      [kind]: [
        { modeId: null, name: 'Désarmer', endpoint: parent.maybeNumber },
        ...this.alarm.record.modes.map(({ id, name }) => ({ modeId: id, name, endpoint: controls.get(id)?.maybeNumber })),
      ],
    };
  }

  deviceStatus() {
    const devices = this.controller.peers.commissioned.map((peer) => {
      const info = peer.maybeStateOf(BasicInformationClient);
      const originalLabel = info?.nodeLabel || info?.productName || peer.id;
      const customName = this.alarm.record.deviceNames[peer.id] ?? '';
      return { peer, originalLabel, customName, name: customName || originalLabel, serialNumber: info?.serialNumber?.trim() || null };
    });
    const counts = new Map();
    for (const { name } of devices) counts.set(name, (counts.get(name) ?? 0) + 1);

    return devices.map(({ peer, originalLabel, customName, name, serialNumber }) => {
      const label = counts.get(name) > 1 ? `${name} · ${peer.id}` : name;
      const connected = this.activePeers.has(peer);
      const endpoints = peer.endpoints.map((endpoint) => {
        const info = endpoint.maybeStateOf(BridgedDeviceBasicInformationClient);
        const bridge = info ?? bridgedInfo(endpoint);
        const nativeLabel = this.endpointLabel(peer, endpoint);
        const accessoryLabel = nativeLabel || `Accessoire ${endpoint.number}`;
        const customName = this.customEndpointName(peer, endpoint);
        let endpointName = label;
        if (bridge) endpointName = `${customName || accessoryLabel} · ${label}`;
        else if (nativeLabel && nativeLabel !== originalLabel) {
          endpointName = label === originalLabel ? nativeLabel : `${nativeLabel} · ${label}`;
        }
        return {
          number: endpoint.number, label: endpointName,
          bridged: Boolean(bridge), bridgeDevice: Boolean(info), customName, originalLabel: accessoryLabel,
          serialNumber: info?.serialNumber?.trim() || null, connected: connected && bridge?.reachable !== false,
          signals: signalsOf(endpoint).map((signal) => ({
            ...signal, value: this.alarm.values.get(peer.id)?.get(endpoint.number)?.get(signal.id) ?? null,
          })),
          commands: commandsOf(endpoint, this.profileCatalogs.get(`${peer.id}:${endpoint.number}`)),
        };
      }).filter(({ signals, commands, bridgeDevice }) => signals.length || commands.length || bridgeDevice);
      return { id: peer.id, label, originalLabel, customName, serialNumber, connected, endpoints };
    });
  }

  controllers() {
    return (this.bridgeRoot?.stateOf('operationalCredentials').fabrics ?? []).map((fabric) => ({
      id: controllerId(fabric), label: fabric.label || 'Contrôleur Matter',
      trusted: (this.alarm.record.settings.trustedControllers ?? []).includes(controllerId(fabric)),
    }));
  }

  matterSource(context) {
    // Labels and fabric indexes can change or be reused; trust the authenticated CA and fabric ID.
    const id = controllerId(context?.session?.fabric);
    return id && (this.alarm.record.settings.trustedControllers ?? []).includes(id) ? 'Contrôleur Matter autorisé' : 'Maison';
  }

  async configure(action, body) {
    if (action === 'test-action') return this.alarm.testAction(body.id);
    if (action === 'test-scenario') return this.alarm.testScenario(body.id);
    if (action === 'settings') return this.alarm.saveSettings(body);
    if (action === 'remove-zone') return this.alarm.removeItem('zones', body.id);
    if (action === 'remove-rule') return this.alarm.removeItem('rules', body.id);
    if (action === 'remove-mode') return this.alarm.removeItem('modes', body.id);
    if (action === 'remove-action') return this.alarm.removeItem('actions', body.id);
    if (action === 'remove-scenario') return this.alarm.removeItem('scenarios', body.id);
    if (['zone', 'rule', 'mode', 'action', 'scenario'].includes(action)) {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name || name.length > 80) return 'Renseigne un nom valide.';
      if (body.id !== undefined && typeof body.id !== 'string') return 'Identifiant invalide.';
      const item = { id: body.id ?? randomUUID().replaceAll('-', ''), editing: body.id !== undefined, name };
      if (action === 'rule') return this.saveRule(item, body);
      if (action === 'action') return this.saveAction(item, body);
      if (action === 'zone') {
        const ruleIds = selection(body.ruleIds);
        if (!ruleIds) return 'Vérifie les déclencheurs de la zone.';
        return this.alarm.saveItem('zones', { ...item, ruleIds });
      }
      if (action === 'scenario') {
        const actionIds = selection(body.actionIds);
        if (!actionIds?.length) return 'Sélectionne au moins une action pour ce scénario.';
        return this.alarm.saveItem('scenarios', { ...item, actionIds });
      }
      const savedMode = this.alarm.record.modes.find(({ id }) => id === item.id);
      const {
        activationSeconds, triggerSeconds, alarmSeconds = savedMode?.alarmSeconds ?? 120,
      } = body;
      const zones = selection(body.zones);
      const scenarios = this.scenarioBindings(body.scenarios);
      if (Buffer.byteLength(name, 'utf8') > 27 || !zones || !scenarios
        || !integerIn(activationSeconds, 0, 86400) || !integerIn(triggerSeconds, 0, 86400) || !integerIn(alarmSeconds, 0, 86400)) {
        return 'Vérifie le nom du mode, les zones, les délais et les scénarios.';
      }
      return this.alarm.saveItem('modes', { ...item, activationSeconds, triggerSeconds, alarmSeconds, zones, scenarios });
    }
    if (action === 'pair-device') return this.pair(body.code);
    if (action === 'rename-device') return this.renamePeer(body.peer, body.name, body.endpoint);
    if (action === 'remove-device') return this.removePeer(body.peer);
  }

  scenarioBindings(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return;
    const bindings = {};
    for (const phase of modePhases) {
      const ids = selection(input[phase] ?? []);
      if (!ids) return;
      bindings[phase] = ids;
    }
    return bindings;
  }

  saveAction(item, body) {
    if (!Array.isArray(body.operations) || !body.operations.length || body.operations.length > 100) {
      return 'Ajoute entre 1 et 100 commandes à cette action.';
    }
    const previous = this.alarm.record.actions.find(({ id }) => id === item.id);
    const operations = [];
    for (const operation of body.operations) {
      if (!validOperation(operation)) return 'Vérifie les accessoires, les commandes et leurs valeurs.';
      const { peer, endpoint, command, value } = operation;
      const node = this.controller.peers.get(peer);
      const part = node?.endpoints.find(({ number }) => number === endpoint);
      const capability = part && commandsOf(part, this.profileCatalogs.get(`${peer}:${endpoint}`)).find(({ id }) => id === command);
      const saved = previous?.operations.find((entry) => entry.peer === peer && entry.endpoint === endpoint && entry.command === command);
      if (!capability && !saved) return 'Cette commande est indisponible sur cet accessoire.';
      if (capability?.min !== undefined && (value < capability.min || value > capability.max)) return 'Valeur hors des limites de cet accessoire.';
      const choice = capability?.choices?.find((item) => item.value === value);
      if (command === 'profile' && !choice && saved?.value !== value) return 'Ce profil est indisponible. Actualise la liste des appareils.';
      const label = (part && (this.customEndpointName(node, part) || this.endpointLabel(node, part))) || saved?.label || peer;
      operations.push({ peer, endpoint, command, ...(value === undefined ? {} : { value }), label,
        ...(command === 'profile' ? { valueLabel: choice?.label ?? saved?.valueLabel ?? 'Profil indisponible' } : {}),
      });
    }
    return this.alarm.saveItem('actions', { ...item, operations });
  }

  scheduleActions() {
    if (this.shuttingDown || !this.controller?.lifecycle.isOnline || this.runningActions || !this.alarm.record.pendingActions.length) return;
    this.runningActions = this.runActions().catch((error) => this.reportError(error)).finally(() => {
      this.runningActions = undefined;
      if (this.alarm.record.pendingActions.length && !this.shuttingDown) {
        this.actionRetry = setTimeout(() => this.scheduleActions(), 1000);
      }
    });
  }

  async runActions() {
    // One command at a time preserves the order of alarm and disarm outputs.
    while (!this.shuttingDown && this.alarm.record.pendingActions.length) {
      const job = this.alarm.record.pendingActions[0];
      const deadline = Date.now() + 15000;
      const stillPending = () => this.alarm.record.pendingActions.some(({ id }) => id === job.id);
      while (!this.shuttingDown && stillPending() && !this.controller.peers.get(job.operation.peer)?.lifecycle.isConnected && Date.now() < deadline) {
        await delay(200);
      }
      if (this.shuttingDown) return;
      if (!stillPending()) continue;
      let error;
      try {
        await executeOperation(this.controller, job.operation);
      } catch (failure) {
        error = failure.message;
      }
      await this.alarm.completeAction(job, error);
    }
  }

  saveRule(item, body) {
    const { peer, endpoint, signal, trigger } = body;
    if (typeof peer !== 'string' || !integerIn(endpoint, 1, 65534) || !isSupportedRule({ signal, trigger })) {
      return 'Sélectionne un accessoire, une détection et une condition.';
    }
    const node = this.controller.peers.get(peer);
    const part = node?.endpoints.find(({ number }) => number === endpoint);
    const available = part && signalsOf(part).find(({ id }) => id === signal);
    const previous = this.alarm.record.rules.find(({ id }) => id === item.id);
    const unchanged = previous?.peer === peer && previous.endpoint === endpoint && previous.signal === signal;
    if (!available && !unchanged) return 'Ce type de déclencheur est indisponible sur cet accessoire.';
    const kind = available?.kind ?? previous.kind;
    const deviceLabel = (part && (this.customEndpointName(node, part) || this.endpointLabel(node, part))) || previous?.deviceLabel || peer;
    return this.alarm.saveItem('rules', {
      ...item, peer, endpoint, signal, trigger, kind, deviceLabel,
    });
  }

  async pair(code) {
    const pairingCode = typeof code === 'string' ? code.trim().replace(/[ -]/g, '') : '';
    if (!/^(?:\d{11}|\d{21})$/.test(pairingCode)) return 'Saisis le code numérique de partage Matter.';

    let shortDiscriminator;
    try {
      ({ shortDiscriminator } = ManualPairingCodeCodec.decode(pairingCode));
    } catch {
      return 'Ce code de partage Matter est invalide.';
    }
    let peer;
    try {
      // Different discovery candidates must not share a forced endpoint identity.
      peer = await this.controller.peers.commission({
        pairingCode,
        shortDiscriminator,
        discoveryCapabilities: { onIpNetwork: true },
        autoSubscribe: true,
        timeout: Seconds(30),
      });
    } catch {
      this.log.error('Jumelage Matter échoué.');
      return 'Jumelage échoué. Vérifie que l’appareil est joignable et ouvre une nouvelle fenêtre de jumelage dans Maison.';
    }
    this.observeSubscription(peer);
    if (await peer.act((agent) => agent.get(NetworkClient).subscriptionActive)) this.subscriptionChanged(peer, true);
    this.log.info(`Appareil Matter jumelé (${peer.id}).`);
  }

  async removePeer(id) {
    const peer = typeof id === 'string' && this.controller.peers.get(id);
    if (!peer?.lifecycle.isCommissioned) return 'Appareil Matter introuvable.';
    if (this.alarm.record.rules.some((rule) => rule.peer === id)
      || this.alarm.record.actions.some((action) => action.operations.some((operation) => operation.peer === id))) {
      return 'Retire d’abord les conditions et les commandes d’actions associées à cet appareil.';
    }
    if (this.alarm.record.state.phase !== 'disarmed' || this.alarm.record.pendingActions.length) return 'Désarme l’alarme et attends la fin des actions avant de retirer un appareil.';
    try {
      await peer.decommission();
    } catch {
      return 'Le retrait a échoué. Vérifie que l’appareil Matter est joignable.';
    }
    this.subscriptionChanged(peer, false);
    await this.alarm.forgetDeviceNames(id);
  }

  renamePeer(id, input, number) {
    const peer = typeof id === 'string' && this.controller.peers.get(id);
    if (!peer?.lifecycle.isCommissioned) return 'Appareil Matter introuvable.';
    if (typeof input !== 'string' || input.trim().length > 80 || /[\u0000-\u001f\u007f]/u.test(input)) return 'Renseigne un nom valide.';
    if (number === undefined) return this.alarm.setDeviceName(id, input.trim());
    const endpoint = peer.endpoints.find((part) => part.number === number);
    if (!endpoint || !bridgedInfo(endpoint)) return 'Accessoire Matter introuvable.';
    return this.alarm.setEndpointName(id, endpointNameKey(endpoint), input.trim());
  }

  customEndpointName(peer, endpoint) {
    return this.alarm.record.endpointNames[peer.id]?.[endpointNameKey(endpoint)] ?? '';
  }

  observeSubscription(peer) {
    peer.eventsOf(NetworkClient).subscriptionStatusChanged.on((active) => this.subscriptionChanged(peer, active));
    peer.lifecycle.offline.on(() => this.subscriptionChanged(peer, false));
  }

  subscriptionChanged(peer, active) {
    if (active) this.activePeers.add(peer);
    else this.activePeers.delete(peer);
    const values = new Map();
    if (active) {
      for (const endpoint of peer.endpoints) values.set(endpoint.number, this.endpointValues(endpoint));
    }
    void this.alarm.report(peer.id, values).catch(() => {});
    if (active) void this.refreshProfiles(true);
  }

  async refreshProfiles(force = false) {
    if (!this.controller?.lifecycle.isOnline || this.shuttingDown) return;
    if (this.refreshingProfiles) return this.refreshingProfiles;
    if (!force && Date.now() - this.profilesRefreshedAt < 30000) return;
    this.refreshingProfiles = (async () => {
      for (const peer of this.controller.peers.commissioned) {
        if (!peer.lifecycle.isConnected) continue;
        for (const endpoint of peer.endpoints) {
          if (!hasAudioProfiles(endpoint)) continue;
          const key = `${peer.id}:${endpoint.number}`;
          try { this.profileCatalogs.set(key, await readAudioProfiles(endpoint)); }
          catch (error) { this.log.warn(`Profils audio indisponibles · ${error.message}`); }
        }
      }
      this.profilesRefreshedAt = Date.now();
    })().finally(() => { this.refreshingProfiles = undefined; });
    return this.refreshingProfiles;
  }

  onChange = (change) => {
    if (change.kind !== 'update') return;
    const peer = change.endpoint.ownerOfType(ClientNode.RootEndpoint);
    if (!peer || !this.activePeers.has(peer)) return;
    if (change.behavior.id === 'fixedLabel') void this.refreshProfiles(true);
    if (change.endpoint.behaviors.supported[change.behavior.id]?.cluster) {
      void this.alarm.report(peer.id, this.endpointValues(change.endpoint), change.endpoint.number).catch(() => {});
    }
  };

  endpointValues(endpoint) {
    if (endpoint.maybeStateOf(BridgedDeviceBasicInformationClient)?.reachable === false) return new Map();
    return new Map(signalsOf(endpoint).map(({ id, value }) => [id, value]));
  }

  endpointLabel(peer, endpoint) {
    const bridged = endpoint.maybeStateOf(BridgedDeviceBasicInformationClient);
    const direct = bridged?.nodeLabel || bridged?.productName
      || endpoint.maybeStateOf(BasicInformationClient)?.nodeLabel
      || (endpoint.owner?.number === 0 ? (peer.maybeStateOf(BasicInformationClient)?.nodeLabel || peer.maybeStateOf(BasicInformationClient)?.productName) : '')
      || '';
    if (direct) return direct;
    const descriptor = endpoint.maybeStateOf('descriptor');
    const labelled = descriptor?.tagList?.find((tag) => typeof tag.label === 'string' && tag.label.trim())?.label;
    if (labelled) return labelled;
    if (descriptor?.deviceTypeList?.some(({ deviceType }) => Number(deviceType) === 0x22)) {
      const parent = endpoint.owner?.maybeStateOf(BridgedDeviceBasicInformationClient)?.nodeLabel;
      return parent ? `${parent} · Haut-parleur` : 'Haut-parleur';
    }
    return '';
  }

  reportError(error) {
    this.log.error(`Erreur du moteur d’alarme · ${error.message}`);
  }

  async onShutdown(reason) {
    this.shuttingDown = true;
    clearTimeout(this.actionRetry);
    this.changes?.off(this.onChange);
    try {
      await this.runningActions;
      await this.alarm?.stop();
      await this.published;
      await this.refreshingProfiles;
      await this.controller?.close();
    } finally {
      await super.onShutdown(reason);
    }
  }
}

function bridgedInfo(endpoint) {
  for (let part = endpoint; part?.number > 0; part = part.owner) {
    const info = part.maybeStateOf(BridgedDeviceBasicInformationClient);
    if (info) return info;
  }
}

function endpointNameKey(endpoint) {
  const uniqueId = endpoint.maybeStateOf(BridgedDeviceBasicInformationClient)?.uniqueId?.trim();
  return uniqueId ? `device:${uniqueId}` : `endpoint:${endpoint.number}`;
}

function selection(ids) {
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) return;
  return [...new Set(ids)];
}

function rejectAlternativeCommands(device) {
  for (const command of ['toggle', 'offWithEffect', 'onWithRecallGlobalScene', 'onWithTimedOff']) {
    device.addCommandHandler(`OnOff.${command}`, () => {
      throw new StatusResponse.FailureError('Utilise une commande explicite de mode.');
    });
  }
}

function controllerId(fabric) {
  if (!fabric?.rootPublicKey || fabric.fabricId === undefined) return '';
  return createHash('sha256').update(Buffer.from(fabric.rootPublicKey)).update(String(fabric.fabricId)).digest('hex');
}

class AlarmModeLockServer extends DoorLockServer.enable({
  events: { lockOperation: true, lockOperationError: true },
}) {
  async handleLockOperation({ actuation, source }) {
    if (source !== DoorLock.OperationSource.Remote) {
      throw new StatusResponse.FailureError('Utilise une commande explicite de mode.');
    }
    await lockCommands.get(this.endpoint)(actuation === 'lock', this.context);
  }

  publishState(locked) {
    const next = lockState(locked);
    if (this.state.lockState === next) return;
    this.state.lockState = next;
    this.events.lockOperation.emit({
      lockOperationType: locked ? DoorLock.LockOperationType.Lock : DoorLock.LockOperationType.Unlock,
      operationSource: DoorLock.OperationSource.Unspecified,
      userIndex: null, fabricIndex: null, sourceNode: null, credentials: null,
    }, this.context);
  }
}

function lockState(locked) {
  return locked ? DoorLock.LockState.Locked : DoorLock.LockState.Unlocked;
}

function publishLockState(device, locked) {
  return device.act((agent) => agent.get(AlarmModeLockServer).publishState(locked));
}

function lockLabels(label) {
  // Longer mode names are available in Descriptor.TagList.
  return Buffer.byteLength(label, 'utf8') <= 16 ? [{ label: 'name', value: label }] : [];
}

function modeTags(label, index) {
  return [
    // Standard Switches namespace, plus a labelled vendor tag for each control.
    { mfgCode: null, namespaceId: 0x43, tag: index === 0 ? 1 : 0 },
    { mfgCode: 0xfff1, namespaceId: 0x43, tag: index % 256, label },
  ];
}
