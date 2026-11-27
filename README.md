# Matterbridge Alarme

[![CI](https://github.com/macjl/matterbridge-securitysystem-core/actions/workflows/ci.yml/badge.svg)](https://github.com/macjl/matterbridge-securitysystem-core/actions/workflows/ci.yml)

**Préversion 0.11.0-alpha.2 · Apache-2.0 · Matterbridge ≥ 3.11.2 · Node.js 24 recommandé**

Un moteur d’alarme local qui lit des capteurs Matter et exécute des actions Matter. Les capteurs, le moteur et les actions ne nécessitent pas d’automatisation Apple Maison. Les appareils Thread dépendent toujours d’un routeur de bordure accessible.

![Interface de configuration](docs/images/overview.png)

## Fonctionnement

- Créer les zones, les conditions d’anomalie et les modes de surveillance. Une condition peut appartenir à plusieurs zones.
- Déclencheurs courants : ouverture/fermeture, mouvement/présence, marche/arrêt. Choisir un état présent ou un changement d’état.
- Configurer les délais de pré-armement, de préalarme et le retour automatique à l’état armé. Une durée d’alarme de 0 signifie jusqu’au désarmement.
- Associer des actions aux états Pré-armement, Armé, Préalarme et Alarme des modes et zones. Le désarmement possède une liste commune d’actions.
- Commander l’éclairage, la luminosité, la couleur, le volume et les profils du plugin Audio selon les capacités des appareils.
- Dans Apple Maison : un accessoire composé Alarme regroupe Désarmer et les modes. Un détecteur de présence optionnel signale le déclenchement.

Le système conserve les zones, conditions, actions, jumelages, état et échéances. Les actions sont sérialisées et dédupliquées par cycle. Une commande en attente peut être rejouée après redémarrage : utiliser des commandes explicites, comme Allumer ou Éteindre.

Un événement « S’ouvre » attend une nouvelle ouverture ; une condition « Porte ouverte » détecte aussi une porte déjà ouverte à l’armement. Une reconnexion établit une nouvelle référence pour les événements. Une préalarme reste active même si le capteur revient à la normale.

## Configuration

Ouvrir la page du plugin depuis Matterbridge, puis utiliser les onglets Modes, Zones, Déclencheurs, Actions et Appareils. Partager chaque appareil depuis son contrôleur existant avec un code de partage Matter ; la présence dans Maison seule ne l’ajoute pas à ce contrôleur.

Les sons sont exclusivement des actions vers le [plugin Audio](https://github.com/macjl/matterbridge-securitysystem-audio). Associer un profil à chaque état et une action d’arrêt au désarmement ainsi qu’au retour à l’état armé. Le [plugin Clavier](https://github.com/macjl/matterbridge-securitysystem-keypad) peut armer et désarmer via Matter ; il peut recevoir une autorisation de désarmement indépendante de celle de Maison.

Le détecteur de présence est la présentation retenue pour le déclenchement. Le compagnon Homebridge avec une présentation native d’alarme et la simulation de présence sont des évolutions envisagées, non implémentées.

## Installation locale

```sh
git clone https://github.com/macjl/matterbridge-securitysystem-core.git
cd matterbridge-securitysystem-core
# Enregistrer le dossier dans une installation Matterbridge existante :
matterbridge --add "$PWD"
```

La page de configuration se trouve à `/plugins/matterbridge-securitysystem-core/` sur le serveur web Matterbridge. Se connecter à Matterbridge avant de l’ouvrir ; aucune clé supplémentaire n’est requise. Les API sont protégées par Matterbridge et une version antérieure à 3.11.2 est refusée.

## Docker

```sh
docker build -t matterbridge-securitysystem-core:local .
docker compose up -d --no-build
```

L’image est basée sur Matterbridge 3.11.2 et utilise un volume `/data`. Ne pas supprimer ce volume : il contient notamment les jumelages. HTTP écoute sur 8284 et Matter sur UDP 5545 par défaut. `POC_HTTP_BIND`, `POC_HTTP_PORT`, `POC_MATTER_PORT`, `POC_MDNS_INTERFACE` et `POC_DATA_DIR` restent les paramètres de déploiement compatibles avec le prototype.

Pour réunir les trois plugins dans un conteneur, cloner les trois dépôts côte à côte et utiliser `scripts/build-stack.sh` du dépôt Alarme, puis les overrides `compose.stack.yaml` des dépôts Audio et Clavier. Chaque plugin fonctionne aussi seul. Les images ne contiennent ni code PIN, ni clé privée, ni configuration personnelle.

## Développement et validation

```sh
npm ci
npm run check
npm test
npm pack --dry-run
```

La CI vérifie les sources, les tests et le contenu du paquet avec Node.js 24. Matterbridge fournit ses API à l’exécution ; conformément à ses contraintes, le plugin ne déclare pas Matterbridge ou matter.js dans ses dépendances. Les tests des interfaces utilisent un contrôleur simulé ; les essais Matter réseau utilisent des conteneurs et un stockage jetables. Ils n’accèdent pas à l’installation réelle.

Les tests du moteur couvrent les événements et états, les zones multiples, les temporisations, les autorisations de désarmement, la déduplication des actions et la reprise.

Cette préversion sert à poursuivre les essais. Les scénarios matériels et la configuration de production restent à valider sur l’installation cible.
