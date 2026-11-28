import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Alarm } from '../alarm.js';
const samples = (value) => new Map([[1, new Map([['contact', value]])]]);
async function fixture(t, trigger = 'rising') {
  const dir = await mkdtemp(join(tmpdir(), 'alarm-test-'));
  const alarm = new Alarm({ storagePath: join(dir, 'alarm.json'), changed() {}, onError(error) { throw error; } });
  await alarm.start();
  await alarm.configure((record) => ({ ...record,
    zones: [{ id: 'house', name: 'Maison', ruleIds: ['door'] }, { id: 'garage', name: 'Garage', ruleIds: ['door'] }],
    rules: [{ id: 'door', name: 'Porte', peer: 'sensor', endpoint: 1, signal: 'contact', kind: 'contact', trigger }],
    modes: [{ id: 'away', name: 'Away', zones: ['house', 'garage'], activationSeconds: 0, triggerSeconds: 0, alarmSeconds: 0, scenarios: { triggered: ['intrusion'] } }],
    scenarios: [{ id: 'intrusion', name: 'Intrusion', actionIds: ['light'] }],
    actions: [{ id: 'light', name: 'Éclairage', operations: [{ peer: 'lamp', endpoint: 1, command: 'on' }] }],
  }));
  t.after(async () => { await alarm.stop(); await rm(dir, { recursive: true, force: true }); });
  return alarm;
}
test('Matter lock and switch settings can be enabled independently', async (t) => {
  const a = await fixture(t);
  const flags = () => [a.view.settings.exposeSwitches, a.view.settings.exposeLocks];
  assert.deepEqual(flags(), [true, false]);
  const settings = { homeDisarm: true, detector: true };
  for (const [exposeSwitches, exposeLocks] of [[true, true], [false, true], [false, false]]) {
    await a.saveSettings({ ...settings, exposeSwitches, exposeLocks });
    assert.deepEqual(flags(), [exposeSwitches, exposeLocks]);
  }
  const controller = 'a'.repeat(64);
  await a.saveSettings({ ...settings, trustedControllers: [controller] });
  await a.saveSettings(settings);
  assert.deepEqual(flags(), [false, false]);
  assert.deepEqual(a.view.settings.trustedControllers, [controller]);
  assert.match(await a.saveSettings({ ...settings, exposeLocks: 'true' }), /réglages/);
});

test('an opening event triggers all linked zones and one shared action, not the initial snapshot', async (t) => {
  const a = await fixture(t);
  await a.command('away', true, 'Test');
  await a.report('sensor', samples(true));
  assert.equal(a.view.state.phase, 'armed');
  await a.report('sensor', new Map([['contact', false]]), 1);
  await a.report('sensor', new Map([['contact', true]]), 1);
  assert.equal(a.view.state.phase, 'triggered');
  assert.deepEqual(a.view.state.zoneIds, ['house', 'garage']);
  assert.equal(a.view.pendingActions.length, 1);
  assert.equal(a.view.state.deadline, null);
});
test('state rule detects an already open door at arming; disarming observes the Home policy', async (t) => {
  const a = await fixture(t, 'active');
  await a.report('sensor', samples(true)); await a.command('away', true, 'Test');
  assert.equal(a.view.state.phase, 'triggered');
  assert.match(await a.disarm('Maison'), /désarmement/);
  await a.disarm('Contrôleur Matter autorisé');
  assert.equal(a.view.state.phase, 'disarmed'); assert.equal(a.view.state.modeId, null);
});
test('pre-arming ignores events, pre-alarm survives closing, finite alarm returns to armed', async (t) => {
  const a = await fixture(t);
  await a.configure((r) => ({ ...r, modes: [{ ...r.modes[0], activationSeconds: 10, triggerSeconds: 10, alarmSeconds: 10 }] }));
  await a.report('sensor', samples(false)); await a.command('away', true, 'Test');
  await a.report('sensor', new Map([['contact', true]]), 1);
  assert.equal(a.view.state.phase, 'exit');
  async function expire() { await a.run(async () => { a.record.state.deadline = Date.now() - 1; await a.expire(); }); }
  await expire(); assert.equal(a.view.state.phase, 'armed');
  await a.report('sensor', new Map([['contact', false]]), 1); await a.report('sensor', new Map([['contact', true]]), 1);
  assert.equal(a.view.state.phase, 'entry');
  await a.report('sensor', new Map([['contact', false]]), 1);
  assert.equal(a.view.state.phase, 'entry');
  await expire(); assert.equal(a.view.state.phase, 'triggered');
  await expire(); assert.equal(a.view.state.phase, 'armed');
});
test('restart preserves configuration and pending actions; re-subscription establishes a fresh event baseline', async (t) => {
  const a = await fixture(t);
  await a.setDeviceName('peer', 'Pont Hue');
  await a.setEndpointName('peer', 'device:lamp', 'Éclairage garage');
  await a.report('sensor', samples(false)); await a.command('away', true, 'Test');
  const b = new Alarm({ storagePath: a.storagePath, changed() {}, onError(error) { throw error; } });
  await b.start(); t.after(() => b.stop());
  assert.equal(b.view.state.phase, 'armed'); assert.deepEqual(b.record.rules, a.record.rules);
  assert.deepEqual(b.view.deviceNames, { peer: 'Pont Hue' });
  assert.deepEqual(b.view.endpointNames, { peer: { 'device:lamp': 'Éclairage garage' } });
  await b.report('sensor', samples(true)); assert.equal(b.view.state.phase, 'armed');
  await b.report('sensor', new Map([['contact', false]]), 1); await b.report('sensor', new Map([['contact', true]]), 1);
  assert.equal(b.view.state.phase, 'triggered'); assert.equal(b.view.pendingActions.length, 1);
});

test('the active mode filters zones and runs ordered scenario actions once per phase', async (t) => {
  const a = await fixture(t);
  const op = (command) => [{ peer: 'lamp', endpoint: 1, command }];
  await a.configure((record) => ({ ...record,
    zones: [record.zones[0], { ...record.zones[1], ruleIds: ['motion'], actions: { triggered: ['day'] } }],
    rules: [...record.rules, { id: 'motion', name: 'Garage', peer: 'motion', endpoint: 1, signal: 'contact', trigger: 'rising' }],
    actions: [...record.actions, { id: 'day', name: 'Jour', operations: op('on') }, { id: 'quiet', name: 'Nuit', operations: op('off') }],
    scenarios: [...record.scenarios,
      { id: 'night', name: 'Éclairage de nuit', actionIds: ['quiet', 'light'] },
      { id: 'shared', name: 'Éclairage commun', actionIds: ['light'] },
      { id: 'full', name: 'Alerte complète', actionIds: ['day', 'light'] }],
    modes: [{ ...record.modes[0], scenarios: { triggered: ['full'], disarmed: ['full'] } },
      { ...record.modes[0], id: 'night', name: 'Nuit', zones: ['house'], scenarios: { triggered: ['night', 'shared'], disarmed: ['shared'] } }],
  }));
  await a.report('sensor', samples(false)); await a.report('motion', samples(false));
  await a.command('night', true, 'Test');
  await a.report('motion', new Map([['contact', true]]), 1);
  assert.equal(a.view.state.phase, 'armed');
  await a.report('sensor', new Map([['contact', true]]), 1);
  assert.deepEqual(a.view.state.zoneIds, ['house']);
  assert.deepEqual(a.view.pendingActions.map(({ actionId }) => actionId), ['quiet', 'light']);
  await a.disarm('Test');
  assert.deepEqual(a.view.pendingActions.map(({ actionId, event }) => [actionId, event]), [['light', 'disarmed']]);
  await a.completeAction(a.view.pendingActions[0]);
  await a.command('away', true, 'Test');
  await a.report('motion', new Map([['contact', false]]), 1);
  await a.report('motion', new Map([['contact', true]]), 1);
  assert.deepEqual(a.view.state.zoneIds, ['garage']);
  assert.deepEqual(a.view.pendingActions.map(({ actionId }) => actionId), ['day', 'light']);
  await a.report('sensor', new Map([['contact', false]]), 1);
  await a.report('sensor', new Map([['contact', true]]), 1);
  assert.deepEqual(a.view.state.zoneIds, ['garage', 'house']);
  assert.deepEqual(a.view.pendingActions.map(({ actionId }) => actionId), ['day', 'light']);
  assert.match(a.view.history[0].message, /Maison · Porte/);
  await a.disarm('Test');
  assert.deepEqual(a.view.pendingActions.map(({ actionId, event }) => [actionId, event]), [['day', 'disarmed'], ['light', 'disarmed']]);
});

test('manually running a scenario queues all its commands in order while disarmed', async (t) => {
  const a = await fixture(t);
  await a.saveItem('actions', { id: 'prepare', name: 'Préparation', operations: [
    { peer: 'lamp', endpoint: 1, command: 'off' },
    { peer: 'speaker', endpoint: 2, command: 'volume', value: 40 },
  ] });
  await a.saveItem('scenarios', { id: 'manual', name: 'Essai', actionIds: ['prepare', 'light'] });
  assert.equal(await a.testScenario('missing'), 'Scénario introuvable.');

  const state = a.view.state;
  assert.equal(await a.testScenario('manual'), undefined);
  const jobs = a.view.pendingActions;
  assert.deepEqual(jobs.map(({ actionId, event, operation }) => [actionId, event, operation.command]), [
    ['prepare', 'test', 'off'], ['prepare', 'test', 'volume'], ['light', 'test', 'on'],
  ]);
  assert.deepEqual(a.view.state, state);
  assert.match(await a.testScenario('manual'), /Attends la fin des actions/);
  assert.deepEqual(a.view.pendingActions, jobs);

  await a.command('away', true, 'Test');
  assert.deepEqual(a.view.pendingActions, []);
  assert.match(await a.testScenario('manual'), /Désarme l’alarme/);
});

test('disarming during a delay uses the mode being left and repeating the command adds no actions', async (t) => {
  const a = await fixture(t);
  await a.configure((record) => ({ ...record, modes: [{
    ...record.modes[0], activationSeconds: 10, triggerSeconds: 10,
    scenarios: { exit: ['intrusion'], entry: ['intrusion'], disarmed: ['intrusion'] },
  }] }));
  await a.command('away', true, 'Test');
  assert.equal(a.view.state.phase, 'exit');
  assert.equal(a.view.pendingActions[0].event, 'exit');
  await a.disarm('Test');
  assert.deepEqual(a.view.pendingActions.map(({ event }) => event), ['disarmed']);
  await a.completeAction(a.view.pendingActions[0]);
  await a.disarm('Test');
  assert.deepEqual(a.view.pendingActions, []);

  await a.command('away', true, 'Test');
  await a.run(async () => { a.record.state.deadline = Date.now() - 1; await a.expire(); });
  await a.report('sensor', samples(false));
  await a.report('sensor', new Map([['contact', true]]), 1);
  assert.equal(a.view.state.phase, 'entry');
  await a.command('away', false, 'Test');
  assert.equal(a.view.state.phase, 'disarmed');
  assert.deepEqual(a.view.pendingActions.map(({ event }) => event), ['disarmed']);
});

test('deleting a resource still referenced by its group is refused', async (t) => {
  const a = await fixture(t);
  assert.match(await a.removeItem('rules', 'door'), /zones/);
  assert.match(await a.removeItem('actions', 'light'), /scénarios/);
  assert.match(await a.removeItem('scenarios', 'intrusion'), /modes/);
  assert.match(await a.removeItem('zones', 'garage'), /modes/);
  await a.saveItem('scenarios', { id: 'unused', name: 'Inutilisé', actionIds: ['light'] });
  const deleting = a.removeItem('scenarios', 'unused');
  const [mode] = a.view.modes;
  const selecting = a.saveItem('modes', { ...mode, editing: true, scenarios: { disarmed: ['unused'] } });
  assert.equal(await deleting, undefined);
  assert.match(await selecting, /scénarios/);
  assert.deepEqual(a.view.modes[0], mode);
  await a.saveItem('scenarios', { id: 'cleanup', name: 'Rétablir', actionIds: ['light'] });
  await a.saveItem('modes', { ...mode, editing: true, scenarios: { disarmed: ['cleanup'] } });
  assert.match(await a.removeItem('scenarios', 'cleanup'), /modes/);
});
