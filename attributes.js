const sources = {
  power: { cluster: 'onOff', attribute: 'onOff', path: [], activeValue: true },
  contact: { cluster: 'booleanState', attribute: 'stateValue', path: [], activeValue: false },
  occupancy: { cluster: 'occupancySensing', attribute: 'occupancy', path: ['occupied'], activeValue: true },
};
const triggerIds = ['active', 'inactive', 'rising', 'falling', 'change'];
const eventTriggers = new Set(['rising', 'falling', 'change']);
const vocabulary = {
  power: ['Marche / arrêt', 'Accessoire allumé', 'Accessoire éteint', 'L’accessoire s’allume', 'L’accessoire s’éteint', 'L’accessoire change d’état'],
  light: ['Lampe', 'Lampe allumée', 'Lampe éteinte', 'La lampe s’allume', 'La lampe s’éteint', 'La lampe change d’état'],
  outlet: ['Prise', 'Prise allumée', 'Prise éteinte', 'La prise s’allume', 'La prise s’éteint', 'La prise change d’état'],
  contact: ['Porte / fenêtre', 'Porte ou fenêtre ouverte', 'Porte ou fenêtre fermée', 'S’ouvre', 'Se ferme', 'Change d’état'],
  occupancy: ['Mouvement / présence', 'Détection active', 'Aucune détection', 'Début de détection', 'Fin de détection', 'La détection change'],
};

export function signalInfo(id, kind = id) {
  if (!Object.hasOwn(sources, id)) return null;
  const words = vocabulary[kind] ?? vocabulary[id];
  return {
    id, kind, label: words[0], activeLabel: words[1], inactiveLabel: words[2],
    triggers: triggerIds.map((trigger, index) => ({ id: trigger, label: words[index + 1] })),
  };
}

export function signalsOf(endpoint) {
  const deviceTypes = endpoint.maybeStateOf('descriptor')?.deviceTypeList?.map(({ deviceType }) => Number(deviceType)) ?? [];
  return Object.entries(sources).flatMap(([id, source]) => {
    if (!endpoint.behaviors.supported[source.cluster]) return [];
    if (id === 'contact' && !deviceTypes.includes(0x0015)) return [];
    let kind = id;
    if (id === 'power') {
      if (deviceTypes.some((type) => [0x0100, 0x0101, 0x010c, 0x010d].includes(type))) kind = 'light';
      else if (deviceTypes.some((type) => [0x010a, 0x010b].includes(type))) kind = 'outlet';
    }
    let raw = endpoint.maybeStateOf(source.cluster)?.[source.attribute];
    for (const field of source.path) raw = raw?.[field];
    return [{ ...signalInfo(id, kind), value: typeof raw === 'boolean' ? raw === source.activeValue : null }];
  });
}

export function isSupportedRule(rule) {
  return Object.hasOwn(sources, rule.signal) && triggerIds.includes(rule.trigger);
}

export function isEventRule(rule) {
  return eventTriggers.has(rule.trigger);
}

export function matchesEvent(rule, before, after) {
  if (typeof before !== 'boolean' || typeof after !== 'boolean' || before === after) return false;
  return rule.trigger === 'change' || (rule.trigger === 'rising' && after) || (rule.trigger === 'falling' && !after);
}
