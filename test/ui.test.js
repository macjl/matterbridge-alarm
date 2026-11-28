import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
const tick = () => new Promise((resolve) => setTimeout(resolve, 15));
const root = new URL('../apps/frontend/build/', import.meta.url);
async function page(t, state, anonymous = false, languages = ['fr-FR']) {
  const dom = new JSDOM(await readFile(new URL('index.html', root), 'utf8'), {
    runScripts: 'outside-only', url: 'http://localhost/plugins/plugin/', pretendToBeVisual: true,
  });
  t.after(() => dom.window.close()); const w = dom.window, requests = [];
  Object.defineProperty(w.navigator, 'languages', { value: languages });
  let poll;
  w.setInterval = (callback) => { poll = callback; }; w.confirm = () => true;
  w.fetch = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return { status: anonymous ? 401 : 200, ok: !anonymous, json: async () => w.JSON.parse(JSON.stringify(anonymous ? { error: 'Unauthorized' } : state)) };
  };
  w.eval(await readFile(new URL('locale.js', root), 'utf8'));
  w.eval(await readFile(new URL('ui.js', root), 'utf8')); w.eval(await readFile(new URL('app.js', root), 'utf8')); await tick();
  return { w, d: w.document, requests, poll };
}
const state = { alarm: { settings: { homeDisarm: true, detector: true, exposeSwitches: true, exposeLocks: false, trustedControllers: [] }, state: { phase: 'disarmed', modeId: null, deadline: null, zoneIds: [] }, modes: [], zones: [], rules: [], actions: [], pendingActions: [], scenarios: [], history: [] }, controllers: [], peers: [], actionRunning: false };
test('settings submit both Matter group checkboxes independently', async (t) => {
  const { d, requests } = await page(t, state);
  const form = d.getElementById('settings');
  assert.equal(form.elements.exposeSwitches.checked, true);
  assert.equal(form.elements.exposeLocks.checked, false);
  assert.match(form.textContent, /Groupe de serrures/);
  form.elements.exposeLocks.checked = true;
  form.requestSubmit();
  await tick();
  assert.equal(requests.at(-1).url, './api/settings');
  assert.equal(requests.at(-1).body.exposeSwitches, true);
  assert.equal(requests.at(-1).body.exposeLocks, true);
  form.elements.exposeSwitches.checked = false;
  form.elements.exposeLocks.checked = false;
  form.requestSubmit();
  await tick();
  assert.equal(requests.at(-1).body.exposeSwitches, false);
  assert.equal(requests.at(-1).body.exposeLocks, false);
});
test('alarm empty setup, keyboard tabs, native auth and editing forms are available without prototype audio controls', async (t) => {
  const { d, w, requests } = await page(t, state);
  assert.equal(d.getElementById('configuration').hidden, false);
  assert.equal(d.getElementById('mode-count').textContent, '0');
  assert.match(d.getElementById('modes').textContent, /Aucun mode/);
  assert.equal(d.querySelector('#modes td').colSpan, 5);
  assert.equal(d.getElementById('sound-test'), null); assert.equal(d.querySelector('[name=siren]'), null);
  const tab = d.getElementById('tab-overview'); tab.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal(d.getElementById('panel-devices').hidden, false); assert.equal(d.getElementById('panel-overview').hidden, true);
  const form = d.getElementById('zone-form'); form.closest('details').open = true; form.elements.name.value = 'Étage'; form.requestSubmit(); await tick();
  assert.equal(requests.at(-1).body.name, 'Étage'); assert.ok(requests.every((r) => !Object.hasOwn(r.body, 'key')));
});
test('unauthenticated alarm page links to Matterbridge and retains the reload button', async (t) => {
  const { d } = await page(t, state, true);
  assert.equal(d.getElementById('auth-message').hidden, false); assert.equal(d.getElementById('configuration').hidden, true);
  assert.equal(d.querySelector('#auth-message a').getAttribute('href'), '/');
});

test('English localizes server history while preserving names and falls back from an unsupported locale', async (t) => {
  const config = structuredClone(state);
  config.alarm.history = [
    { at: 1795778400000, source: 'Interface web', message: 'Surveillance active · Nuit.' },
    { at: 1795778400001, source: 'Action Matter', message: 'Exécutée · Lampe du garage · Désarmement · Garage · off.' },
  ];
  const { d } = await page(t, config, false, ['de-DE']);
  assert.equal(d.documentElement.lang, 'en');
  assert.equal(d.getElementById('tab-rules').textContent, 'Triggers');
  assert.match(d.getElementById('history').textContent, /Monitoring active · Nuit\./);
  assert.match(d.getElementById('history').textContent, /Completed · Lampe du garage · Disarm/);
});

test('matching contact models display separate identifiers and can be renamed by Matter ID', async (t) => {
  const config = structuredClone(state);
  config.peers = [
    { id: '@1:3', label: 'Capteur · @1:3', originalLabel: 'Capteur', serialNumber: 'TEST123', connected: true, endpoints: [
      { number: 1, label: 'Capteur · @1:3', commands: [], signals: [{ id: 'contact', value: true, triggers: [] }] },
    ] },
    { id: '@1:4', label: 'Capteur · @1:4', originalLabel: 'Capteur', connected: true, endpoints: [
      { number: 1, label: 'Capteur · @1:4', commands: [], signals: [{ id: 'contact', value: false, triggers: [] }] },
    ] },
    { id: '@1:5', label: 'Pont', connected: true, endpoints: [
      { number: 17, label: 'Fenêtre Cuisine · Pont', originalLabel: 'Fenêtre Cuisine', bridged: true, serialNumber: 'BRIDGED17',
        connected: false, commands: [], signals: [{ id: 'contact', value: null, triggers: [] }] },
      { number: 19, label: 'Lampe non pilotable · Pont', originalLabel: 'Lampe non pilotable', bridged: true,
        connected: true, commands: [], signals: [] },
    ] },
  ];
  const { d, requests } = await page(t, config);
  const rows = d.getElementById('peers').rows;
  assert.match(rows[0].cells[1].textContent, /TEST123/);
  assert.match(rows[1].cells[1].textContent, /@1:4/);
  assert.equal(rows[0].cells[2].textContent, 'Ouvert');
  assert.equal(rows[1].cells[2].textContent, 'Fermé');
  assert.equal(rows[2].cells[0].textContent, 'Pont');
  assert.equal(rows[2].cells[2].textContent, '—');
  assert.equal(rows[3].cells[0].textContent, 'Fenêtre Cuisine');
  assert.equal(rows[3].className, 'bridged-accessory');
  assert.match(rows[3].cells[1].textContent, /BRIDGED17.*@1:5\/17/);
  assert.equal(rows[3].cells[2].textContent, 'Indisponible');
  assert.equal(rows[4].cells[0].textContent, 'Lampe non pilotable');
  const form = d.getElementById('rename-device');
  rows[0].querySelector('button').click();
  assert.equal(form.hidden, false);
  form.elements.name.value = 'Porte du garage';
  form.requestSubmit();
  await tick();
  assert.deepEqual(requests.at(-1), { url: './api/rename-device', body: { peer: '@1:3', name: 'Porte du garage' } });
  assert.equal(form.hidden, true);

  assert.equal(rows[3].querySelectorAll('button').length, 1);
  rows[3].querySelector('button').click();
  form.elements.name.value = 'Fenêtre au-dessus de l’évier';
  form.requestSubmit();
  await tick();
  assert.deepEqual(requests.at(-1), {
    url: './api/rename-device', body: { peer: '@1:5', endpoint: 17, name: 'Fenêtre au-dessus de l’évier' },
  });
});

test('configuration follows the resource order and submits the new links from their owners', async (t) => {
  const config = structuredClone(state);
  config.alarm.rules = [{ id: 'door', name: 'Porte', zoneIds: ['legacy-do-not-show'], abnormal: null }];
  config.alarm.zones = [{ id: 'doors', name: 'Portes', ruleIds: ['door'] }];
  config.alarm.actions = [
    { id: 'light', name: 'Éclairage', operations: [] },
    { id: 'sound', name: 'Sirène', operations: [] },
  ];
  config.alarm.scenarios = [{ id: 'alert', name: 'Alerte', actionIds: ['light', 'sound'] }];
  config.alarm.modes = [{
    id: 'away', name: 'Away', zones: ['doors'], activationSeconds: 10, triggerSeconds: 20, alarmSeconds: 0,
    scenarios: { triggered: ['alert'], disarmed: ['alert'] },
  }];
  config.alarm.history = [{ at: 1795778400000, source: 'Interface web', message: 'Alarme désarmée.' }];
  config.peers = [{ id: 'contact', label: 'Capteur de porte', connected: true, endpoints: [] }];
  const { d, requests } = await page(t, config);

  assert.deepEqual([...d.querySelectorAll('[role=tab]')].map(({ dataset }) => dataset.panel),
    ['overview', 'devices', 'rules', 'zones', 'actions', 'scenarios', 'modes', 'settings', 'history']);
  assert.equal(d.querySelector('#rule-form fieldset'), null);
  assert.doesNotMatch(d.querySelector('#rules').textContent, /legacy-do-not-show/);
  for (const id of ['peers', 'rules', 'zones', 'actions', 'scenarios', 'modes', 'history']) {
    const body = d.getElementById(id);
    assert.ok(body.closest('table'), id);
    assert.equal(body.rows[0].cells.length, body.closest('table').tHead.rows[0].cells.length, id);
    assert.equal(body.rows[0].cells[0].scope, 'row', id);
  }
  assert.deepEqual([...d.querySelector('#zones tr').cells].slice(0, 3).map((cell) => cell.textContent),
    ['Portes', 'Porte', 'État incomplet']);
  assert.deepEqual([...d.querySelector('#modes tr').cells].slice(0, 2).map((cell) => cell.textContent), ['Away', 'Portes']);
  assert.deepEqual([...d.querySelectorAll('#modes td:nth-child(3) dd')].map((cell) => cell.textContent), ['10 s', '20 s', 'Illimitée']);
  assert.deepEqual([...d.querySelectorAll('#modes td:nth-child(4) dd')].map((cell) => cell.textContent), ['—', '—', '—', 'Alerte', 'Alerte']);
  assert.equal(d.querySelector('#modes td:nth-child(4) dt:last-of-type').textContent, 'Au désarmement');
  assert.equal(d.getElementById('disarm-scenarios-form'), null);
  assert.deepEqual([...d.querySelectorAll('#scenarios ol li')].map((item) => item.textContent), ['Éclairage', 'Sirène']);
  assert.equal(d.querySelector('#history tr').cells[1].textContent, 'Interface web');

  const zone = d.getElementById('zone-form');
  d.querySelector('#zones button').click();
  assert.equal(zone.querySelector('[name=ruleIds]').checked, true);
  zone.requestSubmit();
  await tick();
  assert.deepEqual(requests.at(-1).body, { id: 'doors', name: 'Portes', ruleIds: ['door'] });

  const scenario = d.getElementById('scenario-form');
  d.querySelector('#scenarios button[aria-label="Exécuter Alerte"]').click();
  await tick();
  assert.deepEqual(requests.at(-1), { url: './api/test-scenario', body: { id: 'alert' } });
  assert.match(d.body.textContent, /Scénario lancé/);
  d.querySelector('#scenarios button[aria-label="Modifier Alerte"]').click();
  d.querySelectorAll('#scenario-steps li')[1].querySelector('button').click();
  scenario.requestSubmit();
  await tick();
  assert.deepEqual(requests.at(-1).body, { id: 'alert', name: 'Alerte', actionIds: ['sound', 'light'] });

  const mode = d.getElementById('mode-form');
  d.querySelector('#modes button[aria-label="Modifier Away"]').click();
  assert.equal(mode.querySelector('[name=scenarios-disarmed]').checked, true);
  mode.elements.name.value = 'Nuit';
  mode.querySelector('[name=zones]').checked = true;
  mode.querySelector('[name=scenarios-triggered]').checked = true;
  mode.requestSubmit();
  await tick();
  assert.deepEqual(requests.at(-1).body.scenarios, { exit: [], armed: [], entry: [], triggered: ['alert'], disarmed: ['alert'] });
  assert.deepEqual(requests.at(-1).body.zones, ['doors']);
});

test('the active mode can be disarmed from its row even during an alarm', async (t) => {
  const config = structuredClone(state);
  const mode = { id: 'away', name: 'Away', zones: [], activationSeconds: 10, triggerSeconds: 20, alarmSeconds: 0, scenarios: {} };
  config.alarm.modes = [mode, { ...mode, id: 'night', name: 'Night' }];
  const { d, requests, poll } = await page(t, config);
  const away = d.querySelector('#modes button[aria-label="Activer Away"]');
  const night = d.querySelector('#modes button[aria-label="Activer Night"]');
  assert.equal(away.disabled, false);

  Object.assign(config.alarm.state, { modeId: 'away', phase: 'triggered' });
  await poll();
  assert.equal(away.getAttribute('aria-label'), 'Désarmer Away');
  assert.equal(away.disabled, false);
  assert.equal(night.disabled, true);
  away.click();
  Object.assign(config.alarm.state, { modeId: null, phase: 'disarmed' });
  await tick();
  assert.deepEqual(requests.at(-1), { url: './api/arm', body: { arm: false, modeId: 'away' } });
  assert.equal(d.querySelector('#modes button[aria-label="Activer Away"]').disabled, false);
});
