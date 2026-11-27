import { readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isEventRule, isSupportedRule, matchesEvent, normalizeRule, signalInfo } from './attributes.js';

const idle = { phase: 'disarmed', modeId: null, deadline: null, cause: null, zoneIds: [], actionKeys: [] };
const defaults = { homeDisarm: false, detector: false, trustedControllers: [] };
const actionEventNames = { exit: 'Pré-armement', armed: 'Armé', entry: 'Pré-alarme', triggered: 'Alarme', disarmed: 'Désarmer', test: 'Essai manuel' };

export class Alarm {
  constructor({ storagePath, changed, onError }) {
    this.storagePath = storagePath;
    this.changed = changed;
    this.onError = onError;
    this.queue = Promise.resolve();
    this.values = new Map();
  }

  async start() {
    this.record = { version: 2, settings: defaults, zones: [], rules: [], modes: [], actions: [], disarmActions: [], pendingActions: [], state: idle, history: [] };
    try {
      const saved = JSON.parse(await readFile(this.storagePath, 'utf8'));
      if (saved.version === 2) {
        this.record = { ...this.record, ...saved, settings: { ...defaults, ...saved.settings }, state: { ...idle, ...saved.state }, rules: saved.rules.map(normalizeRule) };
        for (const item of [...this.record.zones, ...this.record.modes]) delete item.actions?.disarmed;
        this.record.modes = this.record.modes.map((mode) => ({
          ...mode, alarmSeconds: mode.alarmSeconds ?? 120,
        }));

      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    this.schedule();
  }

  get view() {
    return { ...this.record, rules: this.record.rules.map((rule) => ({
      ...rule, ...this.evaluate(rule), event: isEventRule(rule), signalInfo: signalInfo(rule.signal, rule.kind),
    })) };
  }

  evaluate(rule) {
    const value = this.values.get(rule.peer)?.get(rule.endpoint)?.get(rule.signal) ?? null;
    if (!isSupportedRule(rule) || typeof value !== 'boolean') return { value: null, abnormal: null };
    return { value, abnormal: !isEventRule(rule) && value === (rule.trigger === 'active') };
  }

  run(work) {
    const result = this.queue.then(() => {
      if (!this.stopped) return work();
    });
    this.queue = result.catch(this.onError);
    return result;
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    return this.queue;
  }

  command(modeId, activate, source) {
    if (!activate) return this.disarm(source, modeId);
    return this.run(async () => {
      const { state, modes, rules } = this.record;
      if (state.modeId === modeId) return;
      if (['entry', 'triggered'].includes(state.phase)) return 'Désarme l’alarme avant de changer de mode pendant une alerte.';
      const mode = modes.find(({ id }) => id === modeId);
      if (!mode) return 'Ce mode n’existe plus.';
      if (!rules.some((rule) => isSupportedRule(rule) && mode.zones.some((id) => rule.zoneIds.includes(id)))) return 'Ajoute au moins un déclencheur dans les zones de ce mode.';
      if (mode.activationSeconds > 0) {
        await this.transition({ ...idle, phase: 'exit', modeId, deadline: Date.now() + mode.activationSeconds * 1000 }, source, `Activation · ${mode.name}.`);
      } else {
        await this.monitor(mode, source);
      }
    });
  }

  disarm(source, modeId) {
    return this.run(async () => {
      const { state, settings } = this.record;
      if (state.phase === 'disarmed' || (modeId !== undefined && state.modeId !== modeId)) return;
      if (source === 'Maison' && !settings.homeDisarm) return 'Le désarmement depuis Maison est désactivé.';
      await this.transition(idle, source, 'Alarme désarmée.');
    });
  }

  saveSettings(input) {
    const { homeDisarm, detector, trustedControllers = this.record.settings.trustedControllers ?? [] } = input;
    if ([homeDisarm, detector].some((value) => typeof value !== 'boolean')
      || !Array.isArray(trustedControllers) || trustedControllers.length > 64
      || !trustedControllers.every((id) => typeof id === 'string' && /^[0-9a-f]{64}$/.test(id))) {
      return 'Vérifie les autorisations et les réglages de l’alarme.';
    }
    return this.configure((record) => ({ ...record, settings: { ...record.settings, homeDisarm, detector, trustedControllers: [...new Set(trustedControllers)] } }));
  }

  configure(change) {
    return this.run(async () => {
      if (this.record.state.phase !== 'disarmed') return 'Désarme l’alarme pour modifier la configuration.';
      if (this.record.pendingActions.length) return 'Attends la fin des actions avant de modifier la configuration.';
      const next = change(this.record);
      if (typeof next === 'string') return next;
      await this.commit(next);
    });
  }

  saveItem(collection, item) {
    return this.configure((record) => {
      const items = record[collection];
      if (item.editing && !items.some(({ id }) => id === item.id)) return 'Cet élément n’existe plus.';
      const { editing, ...data } = item;
      if (collection === 'modes' && items.some(({ id, name }) => id !== data.id && name.toLowerCase() === data.name.toLowerCase())) {
        return 'Ce nom de mode est déjà utilisé.';
      }
      return { ...record, [collection]: editing ? items.map((entry) => entry.id === data.id ? data : entry) : [...items, data] };
    });
  }

  removeItem(collection, id) {
    return this.configure((record) => {
      if (collection === 'zones' && (record.rules.some(({ zoneIds }) => zoneIds.includes(id)) || record.modes.some(({ zones }) => zones.includes(id)))) {
        return 'Retire d’abord les conditions de cette zone et dissocie-la des modes.';
      }
      if (collection === 'actions' && (record.disarmActions.includes(id)
        || [...record.zones, ...record.modes].some((item) => Object.values(item.actions ?? {}).some((ids) => ids.includes(id))))) {
        return 'Dissocie d’abord cette action des zones, des modes et de Désarmer.';
      }
      return { ...record, [collection]: record[collection].filter((item) => item.id !== id) };
    });
  }

  report(peer, values, endpoint) {
    return this.run(async () => {
      const before = this.values.get(peer)?.get(endpoint);
      if (endpoint === undefined) this.values.set(peer, values);
      else {
        if (!this.values.has(peer)) this.values.set(peer, new Map());
        this.values.get(peer).set(endpoint, values);
      }
      if (!['armed', 'entry', 'triggered'].includes(this.record.state.phase)) return;
      // A subscription snapshot establishes a baseline. Only live changes are events.
      const events = new Set(endpoint === undefined ? [] : this.record.rules.filter((rule) => rule.peer === peer
        && rule.endpoint === endpoint && isSupportedRule(rule) && isEventRule(rule)
        && matchesEvent(rule, before?.get(rule.signal), values.get(rule.signal))).map(({ id }) => id));
      const mode = this.record.modes.find(({ id }) => id === this.record.state.modeId);
      const rule = this.findAbnormal(mode, events);
      if (!rule) return;
      if (this.record.state.phase === 'armed') await this.alert(mode, rule, events);
      else {
        const zoneIds = this.abnormalZones(mode, events);
        const added = this.record.zones.filter(({ id }) => zoneIds.includes(id) && !this.record.state.zoneIds.includes(id));
        if (added.length) {
          await this.transition({ ...this.record.state, zoneIds: [...new Set([...this.record.state.zoneIds, ...zoneIds])] }, 'Objet Matter', `Intrusion · ${added.map(({ name }) => name).join(', ')}.`);
        }
      }
    });
  }

  findAbnormal(mode, events = new Set()) {
    return this.record.rules.find((rule) => mode.zones.some((id) => rule.zoneIds.includes(id))
      && (events.has(rule.id) || this.evaluate(rule).abnormal === true));
  }

  abnormalZones(mode, events = new Set()) {
    return mode.zones.filter((id) => this.record.rules.some((rule) => rule.zoneIds.includes(id)
      && (events.has(rule.id) || this.evaluate(rule).abnormal === true)));
  }

  async monitor(mode, source, newCycle = false) {
    await this.transition({ ...idle, phase: 'armed', modeId: mode.id }, source, `Surveillance active · ${mode.name}.`, newCycle);
    const rule = this.findAbnormal(mode);
    if (rule) await this.alert(mode, rule);
  }

  alert(mode, rule, events) {
    const zones = this.record.zones.filter(({ id }) => mode.zones.includes(id) && rule.zoneIds.includes(id));
    const cause = `${zones.map(({ name }) => name).join(', ')} · ${rule.name}`;
    const zoneIds = this.abnormalZones(mode, events);
    if (mode.triggerSeconds === 0) return this.trigger(mode.id, cause, 'Objet Matter', zoneIds);
    return this.transition({
      phase: 'entry', modeId: mode.id, deadline: Date.now() + mode.triggerSeconds * 1000, cause, zoneIds,
    }, 'Objet Matter', `Préalerte · ${cause}.`);
  }

  schedule() {
    clearTimeout(this.timer);
    const { phase, deadline } = this.record.state;
    if (!['exit', 'entry', 'triggered'].includes(phase) || deadline === null) return;
    this.timer = setTimeout(() => {
      void this.run(() => this.expire()).catch(() => {
        if (!this.stopped) this.timer = setTimeout(() => this.schedule(), 1000);
      });
    }, Math.max(0, deadline - Date.now()));
  }

  async expire() {
    const { phase, modeId, deadline, cause, zoneIds } = this.record.state;
    if (!['exit', 'entry', 'triggered'].includes(phase) || deadline === null) return;
    if (deadline > Date.now()) {
      // A timer can wake before the wall-clock deadline.
      this.schedule();
      return;
    }
    if (phase === 'entry') await this.trigger(modeId, cause, 'Temporisation', zoneIds);
    else if (phase === 'triggered') await this.monitor(this.record.modes.find(({ id }) => id === modeId), 'Réarmement automatique', true);
    else await this.monitor(this.record.modes.find(({ id }) => id === modeId), 'Temporisation');
  }

  trigger(modeId, cause, source, zoneIds) {
    const { alarmSeconds = 120 } = this.record.modes.find(({ id }) => id === modeId);
    const now = Date.now();
    return this.transition({
      phase: 'triggered', modeId, deadline: alarmSeconds === 0 ? null : now + alarmSeconds * 1000,
      cause, zoneIds,
    }, source, `Alarme déclenchée · ${cause}.`);
  }

  transition(state, source, message, newCycle = false) {
    const previous = this.record.state;
    const sameCycle = previous.modeId === state.modeId && !newCycle;
    const activationId = sameCycle ? previous.activationId : randomUUID();
    state = { ...idle, ...state, activationId, actionKeys: sameCycle ? previous.actionKeys : [] };
    let pendingActions = this.record.pendingActions;
    if (state.phase !== 'disarmed') pendingActions = pendingActions.filter((item) => item.event !== 'test');
    if (previous.modeId && !sameCycle) {
      pendingActions = pendingActions.filter((item) => item.activationId !== previous.activationId);
    }
    const changed = previous.phase !== state.phase || !sameCycle;
    if (changed || ['entry', 'triggered'].includes(state.phase)) {
      const activeMode = this.record.modes.find(({ id }) => id === state.modeId);
      let zones = state.zoneIds;
      if (state.phase === 'exit' || state.phase === 'armed') zones = activeMode.zones;
      else if (!changed) zones = state.zoneIds.filter((id) => !previous.zoneIds.includes(id));
      const mode = changed ? activeMode : undefined;
      const planned = this.planActions(state.phase, mode, zones, activationId)
        .filter((item) => !state.actionKeys.includes(item.event + ':' + item.actionId));
      state.actionKeys = [...new Set([...state.actionKeys, ...planned.map((item) => item.event + ':' + item.actionId)])];
      pendingActions = [...pendingActions, ...planned];
    }
    const history = [{ at: Date.now(), source, message }, ...this.record.history].slice(0, 50);
    return this.commit({ ...this.record, state, pendingActions, history });
  }

  planActions(event, mode, zoneIds, activationId) {
    const zones = this.record.zones.filter(({ id }) => zoneIds.includes(id));
    const ids = new Set(event === 'disarmed' ? this.record.disarmActions : [mode, ...zones].flatMap((item) => item?.actions?.[event] ?? []));
    return this.record.actions.filter(({ id }) => ids.has(id)).flatMap((action) => action.operations.map((operation) => ({
      id: randomUUID(), actionId: action.id, name: action.name, event, activationId, operation,
    })));
  }

  testAction(id) {
    return this.configure((record) => {
      const action = record.actions.find((item) => item.id === id);
      if (!action) return 'Action introuvable.';
      return {
        ...record,
        pendingActions: action.operations.map((operation) => ({
          id: randomUUID(), actionId: action.id, name: action.name, event: 'test', activationId: record.state.activationId, operation,
        })),
      };
    });
  }

  completeAction(job, error) {
    return this.run(async () => {
      const result = error ? 'Échec' : 'Exécutée';
      const target = job.operation.label || job.operation.peer;
      const message = `${result} · ${job.name} · ${actionEventNames[job.event]} · ${target} · ${job.operation.command}${error ? ' · ' + error : ''}.`;
      await this.commit({
        ...this.record,
        pendingActions: this.record.pendingActions.filter(({ id }) => id !== job.id),
        history: [{ at: Date.now(), source: 'Action Matter', message }, ...this.record.history].slice(0, 50),
      });
    });
  }

  async commit(record) {
    const temp = `${this.storagePath}.tmp`;
    await writeFile(temp, JSON.stringify(record), { mode: 0o600, flush: true });
    await rename(temp, this.storagePath);
    this.record = record;
    if (!this.stopped) {
      this.schedule();
      this.changed(record);
    }
  }
}

export function integerIn(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}
