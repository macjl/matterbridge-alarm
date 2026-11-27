# Changelog

## 0.11.0-alpha.2

- Adoption du nom `matterbridge-securitysystem-core` sur GitHub, dans le paquet, dans Docker et dans l’interface de configuration.
- Conservation des identifiants des accessoires et des contrôleurs Matter.

## 0.11.0-alpha.1 — 2026-11-27

- Première préversion du projet structurée pour GitHub, à partir du prototype local 0.10.1.
- Interface unifiée : navigation par onglets, formulaires repliables, états vides, clavier, thèmes clair/sombre et mobile.
- Authentification administrative native Matterbridge, sans clé supplémentaire.
- Licence Apache-2.0, dépendances verrouillées, CI et tests reproductibles.
- Conservation des noms techniques, identités Matter et stockage existants.
- Retrait du moteur sonore local et de ses boutons de test : les sons sont des actions vers le plugin Audio. Les anciens champs audio sont conservés dans les données chargées mais ne pilotent plus la sortie.

Les versions antérieures étaient des prototypes déployés localement, sans release GitHub.
