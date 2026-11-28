const { t, serverText, profileName, language } = window.PluginUI;
const $ = (selector) => document.querySelector(selector);
const message = $('#message');
const configuration = $('#configuration');
const forms = {
  rule: $('#rule-form'), zone: $('#zone-form'), action: $('#action-form'),
  scenario: $('#scenario-form'), mode: $('#mode-form'),
};
const ruleForm = forms.rule;
const ruleFields = ruleForm.elements;
const renameForm = $('#rename-device');
const labels = { zone: t("the zone"), rule: t("the trigger"), mode: t("the mode"), action: t("the action"), scenario: t("the scenario") };
const modePhases = { exit: t("Exit delay"), armed: t("Armed"), entry: t("Entry delay"), triggered: t("Alarm") };
const scenarioPhases = { ...modePhases, disarmed: t("On disarm") };
const commandNames = {
  on: t("Turn on"), off: t("Turn off"), brightness: t("Brightness (%)"), color: t("Color"), temperature: t("White color temperature (K)"),
  play: t("Play / resume"), pause: t("Pause playback"), stop: t("Stop playback"), volume: 'Volume (%)', mute: t("Mute"), unmute: t("Unmute"),
  profile: t("Play a profile"), 'master-volume': t("Master volume (%)"),
};
const percentCommands = new Set(['brightness', 'volume', 'master-volume']);
const settingsForm = $('#settings');
const phases = {
  disarmed: t("Disarmed"), exit: t("Exit delay"), armed: t("Armed"), entry: t("Entry delay"), triggered: t("Alarm"),
};
const success = {
  'pair-device': t("Device paired."), 'rename-device': t("Name saved."), action: t("Action saved."), 'remove-action': t("Action removed."),
  'remove-device': t("Device removed."), zone: t("Zone saved."), 'remove-zone': t("Zone removed."),
  mode: t("Mode saved."), 'remove-mode': t("Mode removed."), rule: t("Trigger saved."), 'remove-rule': t("Trigger removed."),
  settings: t("Settings saved."),
  scenario: t("Scenario saved."), 'remove-scenario': t("Scenario removed."),
  'test-action': t("Action started. The outcome of each command appears in the log."),
  'test-scenario': t("Scenario started. The outcome of each command appears in the log."),
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
  if (response.status === 401) throw new Error(t("Sign-in to Matterbridge is required."));
  const result = await response.json();
  if (result.error || !response.ok) throw new Error(serverText(result.error) || t("The plugin is unavailable."));
  return result;
}

async function request(action, fields = {}) {
  if (busy) return;
  busy = true;
  window.PluginUI?.busy(true);
  revision++;
  configuration.inert = true;
  message.textContent = action.startsWith('pair') ? t("Pairing…") : t("Loading…");
  try {
    current = await api(action, action === 'status' ? { ...fields, refreshProfiles: true } : fields);
    const kind = action.replace('remove-', '');
    if (forms[kind]) reset(kind);
    if (action === 'rename-device' || action === 'remove-device') renameForm.hidden = true;
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
  if (state.phase === 'triggered' && state.deadline === null) countdown = t(" · no time limit");
  $('#alarm-status').textContent = [phases[state.phase], mode?.name].filter(Boolean).join(' · ') + countdown + (state.cause ? ` · ${state.cause}` : '');
  const monitoredRuleIds = new Set(zones.filter(({ id }) => mode?.zones.includes(id)).flatMap(({ ruleIds }) => ruleIds));
  const offline = rules.filter(({ id, abnormal }) => abnormal === null && monitoredRuleIds.has(id)).map(({ name }) => name);
  $('#zone-status').textContent = offline.length ? t("Conditions unavailable · {0}", offline.join(', ')) : '';
  for (const rule of rules) {
    const label = document.getElementById(`rule-${rule.id}`);
    if (label) {
      if (!rule.signalInfo) label.textContent = t("Needs replacement");
      else if (rule.abnormal === null) label.textContent = t("Unavailable");
      else if (rule.event) label.textContent = t("Listening");
      else label.textContent = rule.abnormal ? t("Condition met") : t("Condition not met");
    }
  }
  for (const zone of zones) {
    const label = document.getElementById(`zone-${zone.id}`);
    if (!label) continue;
    const conditions = rules.filter(({ id }) => zone.ruleIds.includes(id));
    if (['entry', 'triggered'].includes(state.phase) && state.zoneIds.includes(zone.id)) label.textContent = phases[state.phase];
    else if (conditions.some(({ abnormal }) => abnormal === true)) label.textContent = t("Abnormal");
    else if (conditions.some(({ abnormal }) => abnormal === null)) label.textContent = t("Incomplete status");
    else label.textContent = conditions.length ? t("Normal") : t("No triggers");
  }
  const disarmed = state.phase === 'disarmed';
  const pending = alarm.pendingActions.length;
  $('#actions-status').textContent = pending ? t("Pending action commands: {0}.", pending) : actionRunning ? t("Running a Matter command.") : '';
  const configurable = disarmed && pending === 0 && !actionRunning;
  $('#disarm').disabled = disarmed;
  $('#disarm').dataset.mode = state.modeId ?? '';
  for (const control of configuration.querySelectorAll('[data-activate]')) {
    control.disabled = control.dataset.activate === state.modeId || ['entry', 'triggered'].includes(state.phase);
  }
  for (const candidate of modes) {
    const label = document.getElementById(`mode-${candidate.id}`);
    const active = candidate.id === mode?.id;
    if (label) label.textContent = (active && modePhases[state.phase]) || '';
    const control = document.getElementById(`mode-control-${candidate.id}`);
    if (!control) continue;
    const text = active ? t("Disarm") : t("Activate");
    if (control.textContent !== text) {
      control.textContent = text;
      control.setAttribute('aria-label', `${text} ${candidate.name}`);
    }
    control.dataset.arm = String(!active);
    control.disabled = !active && ['entry', 'triggered'].includes(state.phase);
  }
  for (const element of configuration.querySelectorAll('[data-disarmed], form:not(#pair-device, #rename-device) :is(input, select, button)')) {
    element.disabled = !configurable;
  }
  for (const peer of peers) {
    renderDeviceStatus(peer.id, peer.endpoints.filter((endpoint) => !endpoint.bridged), peer.connected);
    for (const endpoint of peer.endpoints.filter((part) => part.bridged)) {
      renderDeviceStatus(`${peer.id}/${endpoint.number}`, [endpoint], endpoint.connected);
    }
  }
  renderRuleState(peers);
  renderTable('history', history.map(({ at, source, message }) =>
    tableRow(new Date(at).toLocaleString(language), serverText(source), logMessage(source, message))), t("No events recorded."));
}

function logMessage(source, message) {
  if (source !== 'Action Matter' || language !== 'en') return serverText(message);
  const parts = message.split(' · ');
  parts[0] = serverText(parts[0]);
  parts[2] = serverText(parts[2]);
  return parts.map((part, index) => index >= 5 ? serverText(part) : part).join(' · ');
}

function renderConfiguration({ alarm, peers, controllers = [] }) {
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
  const ruleName = (id) => alarm.rules.find((rule) => rule.id === id)?.name;
  const actionName = (id) => alarm.actions.find((action) => action.id === id)?.name;
  const scenarioName = (id) => alarm.scenarios.find((scenario) => scenario.id === id)?.name;
  renderItems('zone', alarm.zones,
    (zone) => tableRow(zone.name, zone.ruleIds.map(ruleName).filter(Boolean).join(', ') || '—', statusLabel('zone', zone.id)),
    t("No zones yet. Group triggers by room or purpose."));
  renderItems('scenario', alarm.scenarios,
    (scenario) => tableRow(scenario.name, orderedList(scenario.actionIds.map(actionName).filter(Boolean))),
    t("No scenarios yet. Group actions to reuse in your modes."),
    (scenario) => [button(t("Run"), () => void request('test-scenario', { id: scenario.id }), true)]);
  renderItems('mode', alarm.modes, (mode) => {
    const delays = labeledValues([
      [t("Exit delay"), `${mode.activationSeconds} s`],
      [t("Entry delay"), `${mode.triggerSeconds} s`],
      [t("Alarm"), mode.alarmSeconds === 0 ? t("Unlimited") : `${mode.alarmSeconds} s`],
    ]);
    const scenarios = labeledValues(Object.entries(scenarioPhases).map(([phase, label]) => [
      label, (mode.scenarios[phase] ?? []).map(scenarioName).filter(Boolean).join(', ') || '—',
    ]));
    const row = tableRow(mode.name, mode.zones.map(zoneName).filter(Boolean).join(', ') || t("No zones"), delays, scenarios);
    row.firstElementChild.append(statusLabel('mode', mode.id));
    return row;
  }, t("No modes yet. Create a mode to select the zones to monitor."), (mode) => {
    const control = button(t("Activate"), ({ currentTarget }) =>
      void request('arm', { arm: currentTarget.dataset.arm === 'true', modeId: mode.id }));
    control.id = `mode-control-${mode.id}`;
    return [control];
  });
  renderItems('rule', alarm.rules, (rule) => {
    const peer = peers.find(({ id }) => id === rule.peer);
    const device = peer?.endpoints.find(({ number }) => number === rule.endpoint);
    const deviceName = device?.label || rule.deviceLabel || peer?.label || t("Accessory unavailable");
    return tableRow(rule.name, deviceName, triggerDescription(rule), statusLabel('rule', rule.id));
  }, t("No triggers yet. Choose a Matter device and a detection condition."));

  renderChoices($('#mode-zones'), 'zones', alarm.zones, t("Create a zone first."));
  renderChoices($('#zone-rules'), 'ruleIds', alarm.rules, t("Create a trigger first."));
  renderScenarioChoices(alarm.scenarios);
  renderScenarioSteps(readScenarioSteps());
  renderItems('action', alarm.actions, (action) => tableRow(action.name, orderedList(action.operations.map(operationLabel))),
    t("No actions yet. Add lighting commands or a sound profile."),
    (action) => [button(t("Run"), () => void request('test-action', { id: action.id }), true)]);
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
  ruleFields.device.replaceChildren(new Option(t("Select an accessory"), ''), ...triggerDevices.map(([id, endpoint]) => new Option(endpoint.label, id)));
  ruleFields.device.value = triggerDevices.some(([id]) => id === selectedDevice) ? selectedDevice : '';
  populateSignals(selectedSignal, selectedTrigger);

  renderTable('peers', peers.flatMap((peer) => [
    deviceRow(peer), ...peer.endpoints.filter((endpoint) => endpoint.bridged).map((endpoint) => deviceRow(peer, endpoint)),
  ]), t("No paired devices. Use a Matter sharing code to pair one."));
}

function deviceRow(peer, endpoint) {
  const device = endpoint ?? peer;
  const label = endpoint ? endpoint.customName || endpoint.originalLabel : peer.label;
  const id = endpoint ? `${peer.id}/${endpoint.number}` : peer.id;
  const identifiers = labeledValues([
    [t("Serial number"), device.serialNumber || '—'],
    [t("Matter ID"), id],
  ]);
  const row = tableRow(label, identifiers, statusLabel('contact', id), statusLabel('peer', id));
  if (endpoint) row.classList.add('bridged-accessory');
  if (device.customName && device.originalLabel !== device.customName) {
    const model = document.createElement('small');
    model.className = 'device-original-name';
    model.textContent = device.originalLabel;
    row.firstElementChild.append(model);
  }
  const commands = [button(t("Rename"), () => {
    renameForm.dataset.peer = peer.id;
    renameForm.dataset.endpoint = endpoint ? String(endpoint.number) : '';
    renameForm.elements.name.value = device.customName || '';
    renameForm.elements.name.placeholder = device.originalLabel ?? label;
    renameForm.hidden = false;
    renameForm.elements.name.focus();
  })];
  if (!endpoint) {
    commands.push(button(t("Remove"), () => {
      if (confirm(t("Remove “{0}” from the Matterbridge controller?", peer.label))) void request('remove-device', { peer: peer.id });
    }));
  }
  row.append(commandCell(label, ...commands));
  return row;
}

function renderDeviceStatus(id, endpoints, connected) {
  const status = document.getElementById(`peer-${id}`);
  if (status) status.textContent = connected ? t("Connected") : t("Offline");
  const contact = document.getElementById(`contact-${id}`);
  if (contact) contact.textContent = contactStatus(endpoints, connected);
}

function contactStatus(endpoints, connected) {
  const contacts = endpoints.flatMap((endpoint) => endpoint.signals.filter((signal) => signal.id === 'contact')
    .map((signal) => ({ label: endpoint.label, value: signal.value })));
  return contacts.map(({ label, value }) => {
    const state = !connected || typeof value !== 'boolean' ? t("Unavailable") : value ? t("Open") : t("Closed");
    return contacts.length > 1 ? `${label} · ${state}` : state;
  }).join(' / ') || '—';
}

function statusLabel(kind, id) {
  const label = document.createElement('span');
  label.id = `${kind}-${id}`;
  label.className = 'table-status';
  return label;
}

function renderScenarioChoices(scenarios) {
  const container = $('#mode-scenarios');
  if (!scenarios.length) {
    container.replaceChildren(t("Create a scenario first."));
    return;
  }
  const previous = [...container.querySelectorAll('input:checked')];
  container.replaceChildren(...Object.entries(scenarioPhases).map(([event, title]) => {
    const group = document.createElement('fieldset');
    const legend = document.createElement('legend');
    legend.textContent = title;
    group.append(legend);
    const choices = document.createElement('div');
    group.append(choices);
    const name = 'scenarios-' + event;
    renderChoices(choices, name, scenarios, '', previous.filter((input) => input.name === name).map((input) => input.value));
    return group;
  }));
}

function readScenarioSteps() {
  return [...$('#scenario-steps').querySelectorAll('select')].map(({ value }) => value);
}

function renderScenarioSteps(actionIds) {
  $('#scenario-steps').replaceChildren();
  const hasActions = current.alarm.actions.length > 0;
  $('#scenario-empty').hidden = hasActions;
  $('#add-scenario-step').hidden = !hasActions;
  if (hasActions) for (const id of actionIds.length ? actionIds : ['']) addScenarioStep(id);
}

function addScenarioStep(id = '') {
  const row = document.createElement('li');
  row.className = 'action-step';
  const label = document.createElement('label');
  const select = document.createElement('select');
  select.required = true;
  select.add(new Option(t("Select an action"), ''));
  for (const action of current.alarm.actions) select.add(new Option(action.name, action.id));
  select.value = current.alarm.actions.some((action) => action.id === id) ? id : '';
  label.append('Action', select);
  row.append(label,
    button(t("Move up"), () => row.previousElementSibling?.before(row), true),
    button(t("Move down"), () => row.nextElementSibling?.after(row), true),
    button(t("Remove"), () => row.remove(), true));
  $('#scenario-steps').append(row);
}

function operationLabel(operation) {
  const target = current?.peers.find((p) => p.id === operation.peer)?.endpoints.find((e) => e.number === operation.endpoint);
  const choice = target?.commands.find((c) => c.id === operation.command)?.choices?.find((c) => c.value === operation.value);
  const value = operation.value === undefined ? '' : ' ' + (operation.command === 'profile' ? profileName(operation.value, choice?.label ?? operation.valueLabel) ?? t("Profile unavailable") : operation.value);
  return `${target?.label || operation.label || operation.peer} · ${commandNames[operation.command]}${value}`;
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
  targetLabel.append(t("Accessory"));
  const target = document.createElement('select');
  target.dataset.target = '';
  target.required = true;
  target.add(new Option(t("Select an accessory"), ''));
  for (const [id, endpoint] of endpoints) {
    if (endpoint.commands.length) target.add(new Option(`${endpoint.label} · endpoint ${endpoint.number}`, id));
  }
  target.value = operation.peer ? deviceKey(operation.peer, operation.endpoint) : '';
  targetLabel.append(target);
  const commandLabel = document.createElement('label');
  commandLabel.append(t("Command"));
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
      select.add(new Option(t("Select a profile"), ''));
      for (const choice of capability.choices ?? []) select.add(new Option(profileName(choice.value, choice.label), choice.value));
      if (value && ![...select.options].some((option) => option.value === value)) select.add(new Option(operation.valueLabel ? t("{0} · unavailable", operation.valueLabel) : t("Profile unavailable"), value));
      select.value = value ?? '';
      valueLabel.append(t("Sound profile"), select);
      return;
    }
    const input = document.createElement('input');
    input.dataset.value = '';
    input.required = true;
    input.type = command.value === 'color' ? 'color' : 'number';
    if (command.value !== 'color') {
      input.min = capability.min ?? (percentCommands.has(command.value) ? 0 : 1000);
      input.max = capability.max ?? (percentCommands.has(command.value) ? 100 : 20000);
      input.step = '1';
    }
    const initialValues = { color: '#ff0000', brightness: 100, volume: 25, 'master-volume': 100 };
    input.value = value ?? initialValues[command.value] ?? capability.min ?? 2700;
    valueLabel.append(commandNames[command.value], input);
  };
  const populateCommands = (selected, value) => {
    const commands = endpoints.get(target.value)?.commands ?? [];
    command.replaceChildren(new Option(t("Select a command"), ''), ...commands.map((entry) => new Option(serverText(entry.label) + (entry.unavailable ? t(" · unavailable") : ''), entry.id)));
    command.value = commands.some(({ id }) => id === selected) ? selected : '';
    populateValue(value);
  };
  target.addEventListener('change', () => populateCommands());
  command.addEventListener('change', () => populateValue());
  row.append(targetLabel, commandLabel, valueLabel);
  row.append(button(t("Move up"), () => row.previousElementSibling?.before(row), true));
  row.append(button(t("Move down"), () => row.nextElementSibling?.after(row), true));
  row.append(button(t("Remove"), () => row.remove(), true));
  $('#action-steps').append(row);
  populateCommands(operation.command, operation.value);
}

function renderChoices(list, name, items, empty, selected) {
  const checked = new Set(selected ?? [...list.querySelectorAll('input:checked')].map(({ value }) => value));
  list.replaceChildren(...items.map((item) => {
    const label = document.createElement('label');
    label.className = 'check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.name = name;
    input.value = item.id;
    input.checked = checked.has(item.id);
    label.append(input, item.name);
    return label;
  }));
  if (!items.length) list.append(empty);
}

function renderItems(kind, items, makeRow, empty, extraCommands = () => []) {
  renderTable(`${kind}s`, items.map((entry) => {
    const row = makeRow(entry);
    row.append(commandCell(entry.name, ...extraCommands(entry), button(t("Edit"), () => edit(kind, entry), true), button(t("Remove"), () => {
      if (confirm(t("Remove “{0}”?", entry.name))) void request(`remove-${kind}`, { id: entry.id });
    }, true)));
    return row;
  }), empty);
}

function edit(kind, item) {
  const form = forms[kind];
  const fields = form.elements;
  if (form.closest('details')) form.closest('details').open = true;
  editing[kind] = item.id;
  fields.namedItem('name').value = item.name;
  if (kind === 'action') renderActionSteps(item.operations);
  if (kind === 'scenario') renderScenarioSteps(item.actionIds);
  if (kind === 'zone') renderChoices($('#zone-rules'), 'ruleIds', current.alarm.rules, t("Create a trigger first."), item.ruleIds);
  if (kind === 'mode') {
    for (const input of form.querySelectorAll('[name=zones]')) input.checked = item.zones.includes(input.value);
    for (const phase of Object.keys(scenarioPhases)) {
      for (const input of form.querySelectorAll(`[name="scenarios-${phase}"]`)) {
        input.checked = (item.scenarios[phase] ?? []).includes(input.value);
      }
    }
    fields.activationSeconds.value = item.activationSeconds;
    fields.triggerSeconds.value = item.triggerSeconds;
    fields.alarmSeconds.value = item.alarmSeconds;
  } else if (kind === 'rule') {
    fields.device.value = deviceKey(item.peer, item.endpoint);
    populateSignals(item.signal, item.trigger);
  }
  form.querySelector('.save').textContent = t("Save {0}", labels[kind]);
  form.querySelector('.cancel').hidden = false;
  window.PluginUI?.show(kind + 's');
  fields.namedItem('name').focus();
}

function reset(kind) {
  const form = forms[kind];
  delete editing[kind];
  form.reset();
  if (kind === 'rule') populateSignals();
  if (kind === 'action') renderActionSteps([]);
  if (kind === 'scenario') renderScenarioSteps([]);
  form.querySelector('.save').textContent = t("Add {0}", labels[kind]);
  form.querySelector('.cancel').hidden = true;
}

const deviceKey = (peer, endpoint) => JSON.stringify([peer, endpoint]);
function triggerDescription(rule) {
  const peer = current?.peers.find(({ id }) => id === rule.peer);
  const signal = peer?.endpoints.find(({ number }) => number === rule.endpoint)?.signals.find(({ id }) => id === rule.signal);
  return serverText((signal ?? rule.signalInfo)?.triggers.find(({ id }) => id === rule.trigger)?.label) || t("Trigger needs replacement");
}

function populateSignals(selected, trigger) {
  const signals = endpoints.get(ruleFields.device.value)?.signals ?? [];
  ruleFields.signal.replaceChildren(new Option(t("Select a detection type"), ''), ...signals.map((signal) => new Option(serverText(signal.label) + (signal.unavailable ? t(" · unavailable") : ''), signal.id)));
  if (signals.some(({ id }) => id === selected)) ruleFields.signal.value = selected;
  else ruleFields.signal.value = signals.length === 1 ? signals[0].id : '';
  populateTriggers(trigger);
}

function populateTriggers(selected) {
  const signal = endpoints.get(ruleFields.device.value)?.signals.find(({ id }) => id === ruleFields.signal.value);
  const choices = signal?.triggers ?? [];
  ruleFields.trigger.replaceChildren(...choices.map(({ id, label }) => new Option(serverText(label), id)));
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
  if (!peer?.connected || typeof signal?.value !== 'boolean') output.textContent = t("Current state unavailable.");
  else output.textContent = t("Current state · ") + serverText(signal.value ? signal.activeLabel : signal.inactiveLabel);
}

function listItem(text) {
  const item = document.createElement('li');
  item.textContent = text;
  return item;
}

function orderedList(entries) {
  if (!entries.length) return '—';
  const list = document.createElement('ol');
  list.append(...entries.map(listItem));
  return list;
}

function labeledValues(entries) {
  const list = document.createElement('dl');
  for (const [label, value] of entries) {
    const term = document.createElement('dt');
    const description = document.createElement('dd');
    term.textContent = label;
    description.textContent = value;
    list.append(term, description);
  }
  return list;
}

function tableRow(title, ...values) {
  const row = document.createElement('tr');
  const header = document.createElement('th');
  header.scope = 'row';
  header.textContent = title;
  row.append(header);
  for (const value of values) row.insertCell().append(value);
  return row;
}

function commandCell(name, ...buttons) {
  const cell = document.createElement('td');
  const controls = document.createElement('div');
  controls.className = 'table-commands';
  for (const control of buttons) control.setAttribute('aria-label', `${control.textContent} ${name}`);
  controls.append(...buttons);
  cell.append(controls);
  return cell;
}

function renderTable(id, rows, empty) {
  const body = document.getElementById(id);
  body.replaceChildren(...rows);
  if (rows.length) return;
  const cell = body.insertRow().insertCell();
  cell.colSpan = body.closest('table').tHead.rows[0].cells.length;
  cell.className = 'table-empty';
  cell.textContent = empty;
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
$('#add-scenario-step').addEventListener('click', () => addScenarioStep());
ruleFields.device.addEventListener('change', () => populateSignals());
ruleFields.signal.addEventListener('change', () => populateTriggers());
for (const [kind, form] of Object.entries(forms)) {
  form.querySelector('.cancel').addEventListener('click', () => reset(kind));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const values = new FormData(form);
    const item = { id: editing[kind], name: values.get('name') };
    if (kind === 'action') item.operations = readActionSteps();
    if (kind === 'zone') item.ruleIds = values.getAll('ruleIds');
    if (kind === 'scenario') item.actionIds = readScenarioSteps();
    if (kind === 'mode') Object.assign(item, {
      zones: values.getAll('zones'),
      scenarios: Object.fromEntries(Object.keys(scenarioPhases).map((phase) => [phase, values.getAll('scenarios-' + phase)])),
      activationSeconds: Number(values.get('activationSeconds')),
      triggerSeconds: Number(values.get('triggerSeconds')),
      alarmSeconds: Number(values.get('alarmSeconds')),
    });
    if (kind === 'rule') {
      const [peer, endpoint] = JSON.parse(values.get('device'));
      Object.assign(item, { peer, endpoint, signal: values.get('signal'), trigger: values.get('trigger') });
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
    exposeSwitches: values.has('exposeSwitches'),
    exposeLocks: values.has('exposeLocks'),
    ...(current.controllers?.length ? { trustedControllers: values.getAll('trustedControllers') } : {}),
  });
});

$('#pair-device').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = event.currentTarget.elements.namedItem('code');
  const code = input.value;
  input.value = '';
  void request('pair-device', { code });
});

renameForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const { peer, endpoint } = renameForm.dataset;
  void request('rename-device', {
    peer, ...(endpoint ? { endpoint: Number(endpoint) } : {}), name: renameForm.elements.name.value,
  });
});
renameForm.querySelector('.cancel').addEventListener('click', () => { renameForm.hidden = true; });

let polling = false;
setInterval(async () => {
  if (configuration.hidden || document.hidden || busy || polling) return;
  polling = true;
  const requestedRevision = revision;
  try {
    const latest = await api('status');
    if (!busy && requestedRevision === revision) renderStatus(latest);
  } catch {
    if (!busy && requestedRevision === revision) $('#alarm-status').textContent = t("Status unavailable. Refresh the page.");
  } finally {
    polling = false;
  }
}, 2000);
void request('status');
