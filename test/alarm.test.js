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
    zones: [{ id: 'house', name: 'Maison' }, { id: 'garage', name: 'Garage' }],
    rules: [{ id: 'door', name: 'Porte', peer: 'sensor', endpoint: 1, signal: 'contact', kind: 'contact', trigger, zoneIds: ['house', 'garage'] }],
    modes: [{ id: 'away', name: 'Away', zones: ['house', 'garage'], activationSeconds: 0, triggerSeconds: 0, alarmSeconds: 0, actions: { triggered: ['light'] } }],
    actions: [{ id: 'light', name: 'Éclairage', operations: [{ peer: 'lamp', endpoint: 1, command: 'on' }] }],
  }));
  t.after(async () => { await alarm.stop(); await rm(dir, { recursive: true, force: true }); });
  return alarm;
}
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
  const a = await fixture(t); await a.report('sensor', samples(false)); await a.command('away', true, 'Test');
  const b = new Alarm({ storagePath: a.storagePath, changed() {}, onError(error) { throw error; } });
  await b.start(); t.after(() => b.stop());
  assert.equal(b.view.state.phase, 'armed'); assert.deepEqual(b.record.rules, a.record.rules);
  await b.report('sensor', samples(true)); assert.equal(b.view.state.phase, 'armed');
  await b.report('sensor', new Map([['contact', false]]), 1); await b.report('sensor', new Map([['contact', true]]), 1);
  assert.equal(b.view.state.phase, 'triggered'); assert.equal(b.view.pendingActions.length, 1);
});
