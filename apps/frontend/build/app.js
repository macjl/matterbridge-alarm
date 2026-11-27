const $ = (selector) => document.querySelector(selector);
const message = $('#message');
const configuration = $('#configuration');
const forms = { zone: $('#zone-form'), rule: $('#rule-form'), mode: $('#mode-form'), action: $('#action-form') };
const ruleForm = forms.rule;
const ruleFields = ruleForm.elements;
const labels = { zone: 'la zone', rule: 'le déclencheur', mode: 'le mode', action: 'l’action' };
const actionEvents = { exit: 'Pré-armement', armed: 'Armé', entry: 'Pré-alarme', triggered: 'Alarme' };
const commandNames = {
  on: 'Allumer', off: 'Éteindre', brightness: 'Luminosité (%)', color: 'Couleur', temperature: 'Température du blanc (K)',
  play: 'Lire / reprendre', pause: 'Mettre en pause', stop: 'Arrêter la lecture', volume: 'Volume (%)', mute: 'Couper le son', unmute: 'Rétablir le son',
  profile: 'Lire un profil',
};
const settingsForm = $('#settings');
const phases = {
  disarmed: 'Désarmée', exit: 'Pré-armement', armed: 'Armée', entry: 'Pré-alarme', triggered: 'Alarme',
};
const success = {
  'pair-device': 'Appareil jumelé.', action: 'Action enregistrée.', 'remove-action': 'Action retirée.',
  'remove-device': 'Appareil retiré.', zone: 'Zone enregistrée.', 'remove-zone': 'Zone retirée.',
  mode: 'Mode enregistré.', 'remove-mode': 'Mode retiré.', rule: 'Déclencheur enregistré.', 'remove-rule': 'Déclencheur retiré.',
  settings: 'Réglages enregistrés.',
  'disarm-actions': 'Actions de Désarmer enregistrées.',
  'test-action': 'Action lancée. Le résultat de chaque commande apparaît dans le journal.',
};

let busy = false;
let current;
const editing = {};
const endpoints = new Map();
let revision = 0;

async function api(action, fields = {}) {
  const response = await fetch(`./api/${action}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
    cache: 'no-store',
  });
  $('#auth-message').hidden = response.status !== 401;
  if (response.status === 401) throw new Error('Connexion à Matterbridge requise.');
  const result = await response.json();
  if (result.error || !response.ok) throw new Error(result.error || 'Le plugin est indisponible.');
  return result;
}

async function request(action, fields = {}) {
  if (busy) return;
  busy = true;
  window.PluginUI?.busy(true);
  revision++;
  configuration.inert = true;
  message.textContent = action.startsWith('pair') ? 'Jumelage en cours…' : 'Chargement…';
  try {
    current = await api(action, action === 'status' ? { ...fields, refreshProfiles: true } : fields);
    const kind = action.replace('remove-', '');
    if (forms[kind]) reset(kind);
    renderConfiguration(current);
    renderStatus(current);
    message.textContent = success[action] || '';
  } catch (error) {
    if (action === 'status') configuration.hidden = true;
    message.textContent = error.message;
  } finally {
    configuration.inert = false;
    busy = false;
    window.PluginUI?.busy(false);
  }
}

function renderStatus({ alarm, peers, actionRunning }) {
  const { state, history, modes, rules, zones } = alarm;
  const mode = modes.find(({ id }) => id === state.modeId);
  const remaining = state.deadline === null ? 0 : Math.max(0, Math.ceil((state.deadline - Date.now()) / 1000));
  let countdown = '';
  if (['exit', 'entry', 'triggered'].includes(state.phase) && state.deadline !== null) countdown = ` · ${remaining} s`;
  if (state.phase === 'triggered' && state.deadline === null) countdown = ' · durée illimitée';
  $('#alarm-status').textContent = [phases[state.phase], mode?.name].filter(Boolean).join(' · ') + countdown + (state.cause ? ` · ${state.cause}` : '');
  const offline = mode ? rules.filter(({ zoneIds, abnormal }) => abnormal === null && mode.zones.some((id) => zoneIds.includes(id))).map(({ name }) => name) : [];
  $('#zone-status').textContent = offline.length ? `Conditions indisponibles · ${offline.join(', ')}` : '';
  for (const rule of rules) {
    const label = document.getElementById(`rule-${rule.id}`);
    if (label) {
      if (!rule.signalInfo) label.textContent = 'À remplacer';
      else if (rule.abnormal === null) label.textContent = 'Indisponible';
      else if (rule.event) label.textContent = 'À l’écoute';
      else label.textContent = rule.abnormal ? 'Condition remplie' : 'Condition non remplie';
    }
  }
  for (const zone of zones) {
    const label = document.getElementById(`zone-${zone.id}`);
    if (!label) continue;
    const conditions = rules.filter(({ zoneIds }) => zoneIds.includes(zone.id));
    if (['entry', 'triggered'].includes(state.phase) && state.zoneIds.includes(zone.id)) label.textContent = phases[state.phase];
    else if (conditions.some(({ abnormal }) => abnormal === true)) label.textContent = 'Anormale';
    else if (conditions.some(({ abnormal }) => abnormal === null)) label.textContent = 'État incomplet';
    else label.textContent = conditions.length ? 'Normale' : 'Aucun déclencheur';
  }
  const disarmed = state.phase === 'disarmed';
  const pending = alarm.pendingActions.length;
  $('#actions-status').textContent = pending ? `${pending} commande(s) d’action en attente.` : actionRunning ? 'Une commande Matter est en cours.' : '';
  const configurable = disarmed && pending === 0 && !actionRunning;
  $('#disarm').disabled = disarmed;
  $('#disarm').dataset.mode = state.modeId ?? '';
  for (const control of configuration.querySelectorAll('[data-activate]')) {
    control.disabled = control.dataset.activate === state.modeId || ['entry', 'triggered'].includes(state.phase);
  }
  for (const element of configuration.querySelectorAll('[data-disarmed], #mode-form :is(input,button), #zone-form :is(input,button), #disarm-actions-form :is(input,button), #rule-form :is(input,select,button), #settings :is(input,button), #action-form :is(input,select,button)')) {
    element.disabled = !configurable;
  }
  for (const peer of peers) {
    const label = document.getElementById(`peer-${peer.id}`);
    if (label) label.textContent = `${peer.label} · ${peer.connected ? 'connecté' : 'hors ligne'}`;
  }
  renderRuleState(peers);
  const journal = $('#history');
  const entries = history.map((entry) => listItem(`${new Date(entry.at).toLocaleString('fr-FR')} · ${entry.source} · ${entry.message}`));
  journal.replaceChildren(...(entries.length ? entries : [listItem('Aucun événement enregistré.')]));
}

function renderConfiguration({ alarm, peers, actionRunning, controllers = [] }) {
  configuration.hidden = false;
  for (const [id, value] of [['mode-count', alarm.modes.length], ['zone-count', alarm.zones.length], ['rule-count', alarm.rules.length]]) document.getElementById(id).textContent = value;
  for (const [name, value] of Object.entries(alarm.settings)) {
    const input = settingsForm.elements.namedItem(name);
    if (!input) continue;
    if (typeof value === 'boolean') input.checked = value;
    else input.value = value;
  }
  $('#mode-shortcuts').replaceChildren(...alarm.modes.map((mode) => {
    const activate = button(mode.name, () => void request('arm', { arm: true, modeId: mode.id }));
    activate.dataset.activate = mode.id; return activate;
  }));
  $('#trusted-controllers').replaceChildren(...controllers.map((controller) => {
    const label = document.createElement('label'); label.className = 'check';
    const input = document.createElement('input'); input.type = 'checkbox'; input.name = 'trustedControllers';
    input.value = controller.id; input.checked = controller.trusted;
    label.append(input, controller.label); return label;
  }));

  const zoneName = (id) => alarm.zones.find((zone) => zone.id === id)?.name;
  renderItems('zone', alarm.zones, (zone) => {
    const item = listItem(`${zone.name} · `);
    const status = document.createElement('span');
    status.id = `zone-${zone.id}`;
    item.append(status, document.createTextNode(bindingSummary(zone)));
    return item;
  });
  renderItems('mode', alarm.modes, (mode) => {
    const alarmDuration = mode.alarmSeconds === 0 ? 'alarme illimitée' : `alarme ${mode.alarmSeconds} s`;
    const item = listItem(`${mode.name} · ${mode.zones.map(zoneName).join(', ') || 'Aucune zone'} · activation ${mode.activationSeconds} s · préalerte ${mode.triggerSeconds} s · ${alarmDuration}`);
    const activate = button('Activer', () => void request('arm', { arm: true, modeId: mode.id }));
    activate.dataset.activate = mode.id;
    item.append(activate, document.createTextNode(bindingSummary(mode)));
    return item;
  });
  renderItems('rule', alarm.rules, (rule) => {
    const peer = peers.find(({ id }) => id === rule.peer);
    const device = peer?.endpoints.find(({ number }) => number === rule.endpoint);
    const deviceName = device?.label || rule.deviceLabel || peer?.label || 'Accessoire indisponible';
    const item = listItem(`${rule.name} · ${deviceName} · ${rule.zoneIds.map(zoneName).join(', ')} · ${triggerDescription(rule)} · `);
    const status = document.createElement('span');
    status.id = `rule-${rule.id}`;
    item.append(status);
    return item;
  });

  renderZoneChoices('mode', alarm.zones);
  renderZoneChoices('rule', alarm.zones);
  renderActionChoices('mode', alarm.actions);
  renderActionChoices('zone', alarm.actions);
  $('#disarm-actions').replaceChildren(...alarm.actions.map((action) => {
    const label = document.createElement('label');
    label.className = 'check';
    const input = document.createElement('input');
    Object.assign(input, { type: 'checkbox', name: 'actions', value: action.id, checked: alarm.disarmActions.includes(action.id) });
    label.append(input, action.name);
    return label;
  }));
  if (!alarm.actions.length) $('#disarm-actions').append('Crée d’abord une action.');
  renderItems('action', alarm.actions, (action) => {
    const item = listItem(`${action.name} · ${action.operations.map(operationLabel).join(' → ')}`);
    const test = button('Exécuter', () => request('test-action', { id: action.id }), true);
    test.disabled = alarm.state.phase !== 'disarmed' || actionRunning;
    item.append(test);
    return item;
  });
  const draftOperations = readActionSteps();

  const selectedDevice = ruleFields.device.value;
  const selectedSignal = ruleFields.signal.value;
  const selectedTrigger = ruleFields.trigger.value;
  endpoints.clear();
  for (const peer of peers) {
    for (const endpoint of peer.endpoints) {
      const id = deviceKey(peer.id, endpoint.number);
      endpoints.set(id, { label: endpoint.label || peer.label, number: endpoint.number, signals: endpoint.signals, commands: endpoint.commands });
    }
  }
  for (const rule of alarm.rules) {
    const id = deviceKey(rule.peer, rule.endpoint);
    if (!endpoints.has(id)) endpoints.set(id, { label: rule.deviceLabel || rule.name, number: rule.endpoint, signals: [], commands: [] });
    const signals = endpoints.get(id).signals;
    if (rule.signalInfo && !signals.some((signal) => signal.id === rule.signal)) {
      signals.push({ ...rule.signalInfo, value: null, unavailable: true });
    }
  }
  for (const action of alarm.actions) {
    for (const operation of action.operations) {
      const id = deviceKey(operation.peer, operation.endpoint);
      if (!endpoints.has(id)) endpoints.set(id, { label: operation.label, number: operation.endpoint, signals: [], commands: [] });
      const commands = endpoints.get(id).commands;
      if (!commands.some(({ id }) => id === operation.command)) {
        commands.push({ id: operation.command, label: commandNames[operation.command], unavailable: true });
      }
    }
  }
  renderActionSteps(draftOperations);
  const triggerDevices = Array.from(endpoints).filter(([, endpoint]) => endpoint.signals.length);
  ruleFields.device.replaceChildren(new Option('Choisir un accessoire', ''), ...triggerDevices.map(([id, endpoint]) => new Option(endpoint.label, id)));
  ruleFields.device.value = triggerDevices.some(([id]) => id === selectedDevice) ? selectedDevice : '';
  populateSignals(selectedSignal, selectedTrigger);

  $('#peers').replaceChildren(...peers.map((peer) => {
    const item = listItem('');
    const label = document.createElement('span');
    label.id = `peer-${peer.id}`;
    item.append(label, button('Retirer', () => {
      if (confirm(`Retirer « ${peer.label} » du contrôleur Matterbridge ?`)) void request('remove-device', { peer: peer.id });
    }));
    return item;
  }));
  for (const [id, text] of [['modes', 'Aucun mode. Créer un mode pour choisir les zones à surveiller.'], ['zones', 'Aucune zone. Regrouper les déclencheurs par pièce ou par usage.'], ['rules', 'Aucun déclencheur. Associer un appareil Matter à une ou plusieurs zones.'], ['actions', 'Aucune action. Ajouter des commandes d’éclairage ou un profil sonore.'], ['peers', 'Aucun appareil associé. Utiliser un code de partage Matter pour en ajouter un.']]) window.PluginUI?.empty(id, text);
}

function bindingSummary(item) {
  const summary = Object.entries(actionEvents).flatMap(([event, label]) => {
    const names = (item.actions?.[event] ?? []).map((id) => current.alarm.actions.find((action) => action.id === id)?.name).filter(Boolean);
    return names.length ? [label + ' · ' + names.join(', ')] : [];
  });
  return summary.length ? ' · ' + summary.join(' / ') : '';
}

function renderActionChoices(kind, actions) {
  const container = $(`#${kind}-actions`);
  const selected = new Set([...container.querySelectorAll('input:checked')].map((input) => input.name + ':' + input.value));
  container.replaceChildren(...Object.entries(actionEvents).map(([event, title]) => {
    const group = document.createElement('fieldset');
    const legend = document.createElement('legend');
    legend.textContent = title;
    group.append(legend);
    for (const action of actions) {
      const label = document.createElement('label');
      label.className = 'check';
      const input = document.createElement('input');
      Object.assign(input, { type: 'checkbox', name: 'actions-' + event, value: action.id });
      input.dataset.actionEvent = event;
      input.checked = selected.has(input.name + ':' + input.value);
      label.append(input, action.name);
      group.append(label);
    }
    if (!actions.length) group.append('Crée d’abord une action.');
    return group;
  }));
}

function operationLabel(operation) {
  const choice = current?.peers.find((p) => p.id === operation.peer)?.endpoints.find((e) => e.number === operation.endpoint)
    ?.commands.find((c) => c.id === operation.command)?.choices?.find((c) => c.value === operation.value);
  const value = operation.value === undefined ? '' : ' ' + (operation.command === 'profile' ? choice?.label ?? operation.valueLabel ?? 'Profil indisponible' : operation.value);
  return `${operation.label || operation.peer} · ${commandNames[operation.command]}${value}`;
}

function readActionSteps() {
  return [...$('#action-steps').children].map((row) => {
    const target = row.querySelector('[data-target]').value;
    const [peer, endpoint] = target ? JSON.parse(target) : ['', 0];
    const command = row.querySelector('[data-command]').value;
    const field = row.querySelector('[data-value]');
    const value = field?.type === 'number' ? Number(field.value) : field?.value;
    return { peer, endpoint, command, ...(value === undefined ? {} : { value }) };
  });
}

function renderActionSteps(operations) {
  $('#action-steps').replaceChildren();
  for (const operation of operations.length ? operations : [{}]) addActionStep(operation);
}

function addActionStep(operation = {}) {
  const row = document.createElement('li');
  row.className = 'action-step';
  const targetLabel = document.createElement('label');
  targetLabel.append('Accessoire');
  const target = document.createElement('select');
  target.dataset.target = '';
  target.required = true;
  target.add(new Option('Choisir un accessoire', ''));
  for (const [id, endpoint] of endpoints) {
    if (endpoint.commands.length) target.add(new Option(`${endpoint.label} · endpoint ${endpoint.number}`, id));
  }
  target.value = operation.peer ? deviceKey(operation.peer, operation.endpoint) : '';
  targetLabel.append(target);
  const commandLabel = document.createElement('label');
  commandLabel.append('Commande');
  const command = document.createElement('select');
  command.dataset.command = '';
  command.required = true;
  commandLabel.append(command);
  const valueLabel = document.createElement('label');
  const populateValue = (value) => {
    valueLabel.replaceChildren();
    const capability = endpoints.get(target.value)?.commands.find(({ id }) => id === command.value);
    if (!capability || ['on', 'off', 'play', 'pause', 'stop', 'mute', 'unmute'].includes(command.value)) return;
    if (command.value === 'profile') {
      const select = document.createElement('select');
      select.dataset.value = '';
      select.required = true;
      select.add(new Option('Choisir un profil', ''));
      for (const choice of capability.choices ?? []) select.add(new Option(choice.label, choice.value));
      if (value && ![...select.options].some((option) => option.value === value)) select.add(new Option(operation.valueLabel ? `${operation.valueLabel} · indisponible` : 'Profil indisponible', value));
      select.value = value ?? '';
      valueLabel.append('Profil sonore', select);
      return;
    }
    const input = document.createElement('input');
    input.dataset.value = '';
    input.required = true;
    input.type = command.value === 'color' ? 'color' : 'number';
    if (command.value !== 'color') {
      input.min = capability.min ?? (['brightness', 'volume'].includes(command.value) ? 0 : 1000);
      input.max = capability.max ?? (['brightness', 'volume'].includes(command.value) ? 100 : 20000);
      input.step = '1';
    }
    input.value = value ?? (command.value === 'color' ? '#ff0000' : command.value === 'brightness' ? 100 : command.value === 'volume' ? 25 : capability.min ?? 2700);
    valueLabel.append(commandNames[command.value], input);
  };
  const populateCommands = (selected, value) => {
    const commands = endpoints.get(target.value)?.commands ?? [];
    command.replaceChildren(new Option('Choisir une commande', ''), ...commands.map((entry) => new Option(entry.label + (entry.unavailable ? ' · indisponible' : ''), entry.id)));
    command.value = commands.some(({ id }) => id === selected) ? selected : '';
    populateValue(value);
  };
  target.addEventListener('change', () => populateCommands());
  command.addEventListener('change', () => populateValue());
  row.append(targetLabel, commandLabel, valueLabel);
  row.append(button('Monter', () => row.previousElementSibling?.before(row), true));
  row.append(button('Descendre', () => row.nextElementSibling?.after(row), true));
  row.append(button('Retirer', () => row.remove(), true));
  $('#action-steps').append(row);
  populateCommands(operation.command, operation.value);
}

function renderZoneChoices(kind, zones) {
  const list = $(`#${kind}-zones`);
  const checked = new Set([...list.querySelectorAll('input:checked')].map(({ value }) => value));
  list.replaceChildren(...zones.map((zone) => {
    const label = document.createElement('label');
    label.className = 'check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.name = 'zones';
    input.value = zone.id;
    input.checked = checked.has(zone.id);
    label.append(input, zone.name);
    return label;
  }));
}

function renderItems(kind, items, makeItem) {
  const list = $(`#${kind}s`);
  list.replaceChildren(...items.map((entry) => {
    const item = makeItem(entry);
    item.append(button('Modifier', () => edit(kind, entry), true), button('Retirer', () => {
      if (confirm(`Retirer « ${entry.name} » ?`)) void request(`remove-${kind}`, { id: entry.id });
    }, true));
    return item;
  }));
}

function edit(kind, item) {
  const form = forms[kind];
  const fields = form.elements;
  if (form.closest('details')) form.closest('details').open = true;
  editing[kind] = item.id;
  fields.namedItem('name').value = item.name;
  if (kind === 'action') renderActionSteps(item.operations);
  if (kind === 'zone' || kind === 'mode') {
    for (const input of form.querySelectorAll('[data-action-event]')) {
      input.checked = item.actions?.[input.dataset.actionEvent]?.includes(input.value) ?? false;
    }
  }
  if (kind === 'mode') {
    fields.activationSeconds.value = item.activationSeconds;
    fields.triggerSeconds.value = item.triggerSeconds;
    fields.alarmSeconds.value = item.alarmSeconds;
  } else if (kind === 'rule') {
    fields.device.value = deviceKey(item.peer, item.endpoint);
    populateSignals(item.signal, item.trigger);
  }
  const zoneIds = item.zoneIds ?? item.zones ?? [];
  for (const input of form.querySelectorAll('[name=zones]')) input.checked = zoneIds.includes(input.value);
  form.querySelector('.save').textContent = `Enregistrer ${labels[kind]}`;
  form.querySelector('.cancel').hidden = false;
  window.PluginUI?.show(({ mode: 'modes', zone: 'zones', rule: 'rules', action: 'actions' })[kind]);
  fields.namedItem('name').focus();
}

function reset(kind) {
  const form = forms[kind];
  delete editing[kind];
  form.reset();
  if (kind === 'rule') populateSignals();
  if (kind === 'action') renderActionSteps([]);
  form.querySelector('.save').textContent = `Ajouter ${labels[kind]}`;
  form.querySelector('.cancel').hidden = true;
}

const deviceKey = (peer, endpoint) => JSON.stringify([peer, endpoint]);
function triggerDescription(rule) {
  const peer = current?.peers.find(({ id }) => id === rule.peer);
  const signal = peer?.endpoints.find(({ number }) => number === rule.endpoint)?.signals.find(({ id }) => id === rule.signal);
  return (signal ?? rule.signalInfo)?.triggers.find(({ id }) => id === rule.trigger)?.label || 'Déclencheur à remplacer';
}

function populateSignals(selected, trigger) {
  const signals = endpoints.get(ruleFields.device.value)?.signals ?? [];
  ruleFields.signal.replaceChildren(new Option('Choisir une détection', ''), ...signals.map((signal) => new Option(signal.label + (signal.unavailable ? ' · indisponible' : ''), signal.id)));
  if (signals.some(({ id }) => id === selected)) ruleFields.signal.value = selected;
  else ruleFields.signal.value = signals.length === 1 ? signals[0].id : '';
  populateTriggers(trigger);
}

function populateTriggers(selected) {
  const signal = endpoints.get(ruleFields.device.value)?.signals.find(({ id }) => id === ruleFields.signal.value);
  const choices = signal?.triggers ?? [];
  ruleFields.trigger.replaceChildren(...choices.map(({ id, label }) => new Option(label, id)));
  if (choices.some(({ id }) => id === selected)) ruleFields.trigger.value = selected;
  renderRuleState();
}

function renderRuleState(peers = current?.peers ?? []) {
  const target = ruleFields.device.value;
  const output = $('#rule-state');
  if (!target || !ruleFields.signal.value) {
    output.textContent = '';
    return;
  }
  const [peerId, number] = JSON.parse(target);
  const peer = peers.find(({ id }) => id === peerId);
  const signal = peer?.endpoints.find((endpoint) => endpoint.number === number)?.signals.find(({ id }) => id === ruleFields.signal.value);
  if (!peer?.connected || typeof signal?.value !== 'boolean') output.textContent = 'État actuel indisponible.';
  else output.textContent = 'État actuel · ' + (signal.value ? signal.activeLabel : signal.inactiveLabel);
}

function listItem(text) {
  const item = document.createElement('li');
  item.textContent = text;
  return item;
}

function button(text, handler, disarmed = false) {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = text;
  if (disarmed) element.dataset.disarmed = '';
  element.addEventListener('click', handler);
  return element;
}

$('#refresh').addEventListener('click', () => void request('status'));
$('#disarm').addEventListener('click', (event) => void request('arm', { arm: false, modeId: event.currentTarget.dataset.mode }));
$('#add-action-step').addEventListener('click', () => addActionStep());
$('#disarm-actions-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void request('disarm-actions', { actions: new FormData(event.currentTarget).getAll('actions') });
});
ruleFields.device.addEventListener('change', () => populateSignals());
ruleFields.signal.addEventListener('change', () => populateTriggers());
for (const [kind, form] of Object.entries(forms)) {
  form.querySelector('.cancel').addEventListener('click', () => reset(kind));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const values = new FormData(form);
    const item = { id: editing[kind], name: values.get('name') };
    if (kind === 'action') item.operations = readActionSteps();
    if (kind === 'mode' || kind === 'zone') {
      item.actions = Object.fromEntries(Object.keys(actionEvents).map((event) => [event, values.getAll('actions-' + event)]));
    }
    if (kind === 'mode') Object.assign(item, {
      zones: values.getAll('zones'),
      activationSeconds: Number(values.get('activationSeconds')),
      triggerSeconds: Number(values.get('triggerSeconds')),
      alarmSeconds: Number(values.get('alarmSeconds')),
    });
    if (kind === 'rule') {
      const [peer, endpoint] = JSON.parse(values.get('device'));
      Object.assign(item, { zoneIds: values.getAll('zones'), peer, endpoint, signal: values.get('signal'), trigger: values.get('trigger') });
    }
    void request(kind, item);
  });
}

settingsForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const values = new FormData(settingsForm);
  void request('settings', {
    detector: values.has('detector'),
    homeDisarm: values.has('homeDisarm'),
    trustedControllers: values.getAll('trustedControllers'),
  });
});

$('#pair-device').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = event.currentTarget.elements.namedItem('code');
  const code = input.value;
  input.value = '';
  void request('pair-device', { code });
});

let polling = false;
setInterval(async () => {
  if (configuration.hidden || document.hidden || busy || polling) return;
  polling = true;
  const requestedRevision = revision;
  try {
    const latest = await api('status');
    if (!busy && requestedRevision === revision) renderStatus(latest);
  } catch {
    if (!busy && requestedRevision === revision) $('#alarm-status').textContent = 'État indisponible · actualise la page.';
  } finally {
    polling = false;
  }
}, 2000);
void request('status');
