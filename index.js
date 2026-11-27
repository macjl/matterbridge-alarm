import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  MatterbridgeDynamicPlatform,
  MatterbridgeEndpoint,
  bridgedNode,
  occupancySensor,
  onOffPlugInUnit,
} from 'matterbridge';
import { ChangeNotificationService, ClientNode, ControllerBehavior, NetworkClient, Seconds, ServerNode } from 'matterbridge/matter';
import { BasicInformationClient, BridgedDeviceBasicInformationClient, DescriptorServer } from 'matterbridge/matter/behaviors';
import { Descriptor, OccupancySensing, OnOff } from 'matterbridge/matter/clusters';
import { ManualPairingCodeCodec, StatusResponse } from 'matterbridge/matter/types';
import { Alarm, integerIn } from './alarm.js';
import { isSupportedRule, normalizeRule, signalsOf } from './attributes.js';
import { commandsOf, executeOperation, validOperation } from './actions.js';
import { hasAudioProfiles, readAudioProfiles } from './content.js';

const apiActions = new Set(['status', 'pair-device', 'share-device', 'remove-device', 'settings', 'disarm-actions', 'zone', 'remove-zone', 'rule', 'remove-rule', 'mode', 'remove-mode', 'action', 'remove-action', 'test-action', 'arm']);
const actionEvents = ['exit', 'armed', 'entry', 'triggered'];

export default function initialize(matterbridge, log, config) {
  return new HybridPoc(matterbridge, log, config);
}

class HybridPoc extends MatterbridgeDynamicPlatform {
  controller;
  changes;
  configuring = false;
  activePeers = new Set();
  modeSwitches = new Map();
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
    await this.registerDisarmSwitch();
    await this.syncAccessories();
    await this.startController();
    this.schedulePublication();
  }

  async registerDisarmSwitch() {
    // The parent is an application endpoint too. Its On/Off control is Désarmer.
    // A new identity avoids reusing the container-only endpoint cached by Home.
    const device = new MatterbridgeEndpoint([onOffPlugInUnit, bridgedNode], { id: 'alarm-mode-selector', tagList: modeTags('Désarmer', 0) })
      .createDefaultBridgedDeviceBasicInformationClusterServer('Alarme', 'alarm-mode-selector')
      .createDefaultOnOffClusterServer(this.alarm.record.state.phase === 'disarmed')
      .addRequiredClusters();
    this.modeAccessory = device;
    device.addCommandHandler('OnOff.on', async ({ context }) => {
      const error = await this.alarm.disarm(this.matterSource(context));
      if (error) throw new StatusResponse.FailureError(error);
    });
    device.addCommandHandler('OnOff.off', () => {
      if (this.alarm.record.state.phase === 'disarmed') {
        throw new StatusResponse.FailureError('Active un mode pour armer l’alarme.');
      }
    });
    rejectAlternativeCommands(device);
    // Include the complete initial composition in the first descriptor Home reads.
    for (const [index, mode] of this.alarm.record.modes.entries()) {
      const child = this.createModeSwitch(mode, index);
      device.parts.add(child);
      this.modeSwitches.set(mode.id, child);
    }
    await this.registerDevice(this.modeAccessory);
    this.modeAccessory.stateOf(DescriptorServer);
    device.stateOf('onOff');
    this.disarmSwitch = device;
    await device.setAttribute(OnOff, 'onOff', this.alarm.record.state.phase === 'disarmed', this.log);
  }

  createModeSwitch(mode, index) {
    const id = `alarm-mode-${mode.id}`;
    const device = new MatterbridgeEndpoint(onOffPlugInUnit, { id, tagList: modeTags(mode.name, index + 1) })
      .createDefaultOnOffClusterServer(this.alarm.record.state.modeId === mode.id)
      .addRequiredClusters();
    device.deviceName = mode.name;
    for (const [command, activate] of [['on', true], ['off', false]]) {
      device.addCommandHandler(`OnOff.${command}`, async ({ context }) => {
        const error = await this.alarm.command(mode.id, activate, this.matterSource(context));
        if (error) throw new StatusResponse.FailureError(error);
      });
    }
    rejectAlternativeCommands(device);
    return device;
  }

  async syncAccessories() {
    const { modes, settings } = this.alarm.record;
    for (const [id, device] of this.modeSwitches) {
      if (modes.some((mode) => mode.id === id)) continue;
      await device.delete();
      this.modeSwitches.delete(id);
    }
    for (const [index, mode] of modes.entries()) {
      const label = mode.name;
      const tagList = modeTags(label, index + 1);
      let device = this.modeSwitches.get(mode.id);
      if (!device) {
        device = this.createModeSwitch(mode, index);
        // Build the child completely before adding it to the live composed accessory.
        await this.modeAccessory.add(device);
        this.modeSwitches.set(mode.id, device);
      }
      await device.setAttribute(Descriptor, 'tagList', tagList);
      await device.setAttribute(OnOff, 'onOff', this.alarm.record.state.modeId === mode.id, this.log);
      device.deviceName = label;
    }
    if (settings.detector && !this.alarmDetector) {
      const device = new MatterbridgeEndpoint([occupancySensor, bridgedNode], { id: 'alarm-occupancy' })
        .createDefaultBridgedDeviceBasicInformationClusterServer('Alarme déclenchée', 'alarm-occupancy')
        .createDefaultOccupancySensingClusterServer(this.alarm.record.state.phase === 'triggered')
        .addRequiredClusters();
      await this.registerDevice(device);
      this.alarmDetector = device;
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
      for (const [id, device] of this.modeSwitches) await device.setAttribute(OnOff, 'onOff', modeId === id, this.log);
      await this.disarmSwitch?.setAttribute(OnOff, 'onOff', phase === 'disarmed', this.log);
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
        await this.published;
        await this.syncAccessories();
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
        modes: {
          name: 'Alarme', endpoint: this.modeAccessory.maybeNumber,
          parts: this.modeAccessory.getAttribute(Descriptor, 'partsList'),
          switches: [
            { modeId: null, name: 'Désarmer', endpoint: this.disarmSwitch.maybeNumber },
            ...this.alarm.record.modes.map((mode) => ({ modeId: mode.id, name: mode.name, endpoint: this.modeSwitches.get(mode.id)?.maybeNumber })),
          ],
        },
      },
      actionRunning: Boolean(this.runningActions),
      peers: this.controller.peers.commissioned.map((peer) => ({
        id: peer.id,
        label: peer.maybeStateOf(BasicInformationClient)?.nodeLabel || peer.maybeStateOf(BasicInformationClient)?.productName || peer.id,
        connected: this.activePeers.has(peer),
        endpoints: peer.endpoints.map((endpoint) => ({
          number: endpoint.number, label: this.endpointLabel(peer, endpoint),
          signals: signalsOf(endpoint).map((signal) => ({
            ...signal, value: this.alarm.values.get(peer.id)?.get(endpoint.number)?.get(signal.id) ?? null,
          })),
          commands: commandsOf(endpoint, this.profileCatalogs.get(`${peer.id}:${endpoint.number}`)),
        })).filter(({ signals, commands }) => signals.length || commands.length),
      })),
    };
  }

  controllers() {
    const root = this.modeAccessory.ownerOfType(ServerNode.RootEndpoint);
    return (root?.stateOf('operationalCredentials').fabrics ?? []).map((fabric) => ({
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
    if (action === 'disarm-actions') {
      const bindings = this.actionBindings({ disarmed: body.actions }, ['disarmed']);
      if (!bindings || !Array.isArray(body.actions)) return 'Vérifie les actions du mode Désarmer.';
      return this.alarm.configure((record) => ({ ...record, disarmActions: bindings.disarmed }));
    }
    if (action === 'settings') return this.alarm.saveSettings(body);
    if (action === 'remove-zone') return this.alarm.removeItem('zones', body.id);
    if (action === 'remove-rule') return this.alarm.removeItem('rules', body.id);
    if (action === 'remove-mode') return this.alarm.removeItem('modes', body.id);
    if (action === 'remove-action') return this.alarm.removeItem('actions', body.id);
    if (['zone', 'rule', 'mode', 'action'].includes(action)) {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name || name.length > 80) return 'Renseigne un nom valide.';
      if (body.id !== undefined && typeof body.id !== 'string') return 'Identifiant invalide.';
      const item = { id: body.id ?? randomUUID().replaceAll('-', ''), editing: body.id !== undefined, name };
      if (action === 'rule') return this.saveRule(item, body);
      if (action === 'action') return this.saveAction(item, body);
      const bindings = this.actionBindings(body.actions);
      if (!bindings) return 'Vérifie les actions associées aux événements.';
      item.actions = bindings;
      if (action === 'zone') return this.alarm.saveItem('zones', item);
      const savedMode = this.alarm.record.modes.find(({ id }) => id === item.id);
      const {
        activationSeconds, triggerSeconds, zones, alarmSeconds = savedMode?.alarmSeconds ?? 120,
      } = body;
      if (Buffer.byteLength(name, 'utf8') > 27 || !Array.isArray(zones)
        || !zones.every((id) => this.alarm.record.zones.some((zone) => zone.id === id))
        || !integerIn(activationSeconds, 0, 86400) || !integerIn(triggerSeconds, 0, 86400) || !integerIn(alarmSeconds, 0, 86400)) {
        return 'Vérifie le nom du mode, les zones, les délais.';
      }
      return this.alarm.saveItem('modes', { ...item, activationSeconds, triggerSeconds, alarmSeconds, zones: [...new Set(zones)] });
    }
    if (action === 'pair-device') return this.pair(body.code);
    if (action === 'remove-device') return this.removePeer(body.peer);
  }

  actionBindings(input = {}, events = actionEvents) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return;
    const bindings = {};
    for (const event of events) {
      const ids = input[event] ?? [];
      if (!Array.isArray(ids) || !ids.every((id) => this.alarm.record.actions.some((action) => action.id === id))) return;
      bindings[event] = [...new Set(ids)];
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
      const label = (part && this.endpointLabel(node, part)) || saved?.label || peer;
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
    const rule = normalizeRule({ ...body, ...item });
    const { zoneIds, peer, endpoint, signal, trigger } = rule;
    if (!Array.isArray(zoneIds) || !zoneIds.length || !zoneIds.every((id) => this.alarm.record.zones.some((zone) => zone.id === id))
      || typeof peer !== 'string' || !integerIn(endpoint, 1, 65534) || !isSupportedRule(rule)) {
      return 'Sélectionne au moins une zone, un accessoire et un déclencheur.';
    }
    const node = this.controller.peers.get(peer);
    const part = node?.endpoints.find(({ number }) => number === endpoint);
    const available = part && signalsOf(part).find(({ id }) => id === signal);
    const previous = this.alarm.record.rules.find(({ id }) => id === item.id);
    const unchanged = previous?.peer === peer && previous.endpoint === endpoint && previous.signal === signal;
    if (!available && !unchanged) return 'Ce type de déclencheur est indisponible sur cet accessoire.';
    const kind = available?.kind ?? previous.kind;
    const deviceLabel = (part && this.endpointLabel(node, part)) || previous?.deviceLabel || peer;
    return this.alarm.saveItem('rules', {
      ...item, zoneIds: [...new Set(zoneIds)], peer, endpoint, signal, trigger, kind, deviceLabel,
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
    const direct = endpoint.maybeStateOf(BridgedDeviceBasicInformationClient)?.nodeLabel
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

function modeTags(label, index) {
  return [
    // Standard Switches namespace, plus a labelled vendor tag for each control.
    { mfgCode: null, namespaceId: 0x43, tag: index === 0 ? 1 : 0 },
    { mfgCode: 0xfff1, namespaceId: 0x43, tag: index % 256, label },
  ];
}
