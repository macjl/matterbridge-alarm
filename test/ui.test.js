import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
const tick = () => new Promise((resolve) => setTimeout(resolve, 15));
const root = new URL('../apps/frontend/build/', import.meta.url);
async function page(t, state, anonymous = false) {
  const dom = new JSDOM(await readFile(new URL('index.html', root), 'utf8'), { runScripts: 'outside-only', url: 'http://localhost/plugins/plugin/' });
  t.after(() => dom.window.close()); const w = dom.window, requests = [];
  w.setInterval = () => {}; w.confirm = () => true;
  w.fetch = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return { status: anonymous ? 401 : 200, ok: !anonymous, json: async () => w.JSON.parse(JSON.stringify(anonymous ? { error: 'Unauthorized' } : state)) };
  };
  w.eval(await readFile(new URL('ui.js', root), 'utf8')); w.eval(await readFile(new URL('app.js', root), 'utf8')); await tick();
  return { w, d: w.document, requests };
}
const state = { alarm: { settings: { homeDisarm: true, detector: true, trustedControllers: [] }, state: { phase: 'disarmed', modeId: null, deadline: null, zoneIds: [] }, modes: [], zones: [], rules: [], actions: [], pendingActions: [], disarmActions: [], history: [] }, controllers: [], peers: [], actionRunning: false };
test('alarm empty setup, keyboard tabs, native auth and editing forms are available without prototype audio controls', async (t) => {
  const { d, w, requests } = await page(t, state);
  assert.equal(d.getElementById('configuration').hidden, false);
  assert.equal(d.getElementById('mode-count').textContent, '0');
  assert.match(d.getElementById('modes').textContent, /Aucun mode/);
  assert.equal(d.getElementById('sound-test'), null); assert.equal(d.querySelector('[name=siren]'), null);
  const tab = d.getElementById('tab-overview'); tab.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal(d.getElementById('panel-modes').hidden, false); assert.equal(d.getElementById('panel-overview').hidden, true);
  const form = d.getElementById('zone-form'); form.closest('details').open = true; form.elements.name.value = 'Étage'; form.requestSubmit(); await tick();
  assert.equal(requests.at(-1).body.name, 'Étage'); assert.ok(requests.every((r) => !Object.hasOwn(r.body, 'key')));
});
test('unauthenticated alarm page links to Matterbridge and retains the reload button', async (t) => {
  const { d } = await page(t, state, true);
  assert.equal(d.getElementById('auth-message').hidden, false); assert.equal(d.getElementById('configuration').hidden, true);
  assert.equal(d.querySelector('#auth-message a').getAttribute('href'), '/');
});
