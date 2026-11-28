# Changelog

## 0.11.0-alpha.3

- Guide configuration through Devices → Triggers → Zones → Actions → Scenarios → Modes.
- Build zones from triggers and reusable scenarios from ordered actions.
- Run a complete scenario manually while disarmed and see each command result in the log.
- Select scenarios per mode and state. Use the mode being left to select disarm scenarios.
- Disarm the active mode directly from its row in Modes.
- Choose independently whether to expose a Matter switch group or a Matter lock group for alarm modes.
- Keep the disarm lock and mode locks mutually exclusive, with Matter labels for each control.
- Show contact state and identifiers in Devices. Group bridged accessories under their bridges and let users rename them.
- Set Master output volume through the Audio Speaker.
- Offer English and French configuration interfaces based on browser language.

## 0.11.0-alpha.2

- Adopt the package name `matterbridge-securitysystem-core` in the repository, Docker image, and configuration interface.
- Preserve Matter accessory and controller IDs.

## 0.11.0-alpha.1 — 2026-11-27

- Prepare the first public preview from local prototype 0.10.1.
- Standardize tabs, collapsible editors, empty states, keyboard navigation, dark mode, and mobile layouts.
- Use native Matterbridge authentication.
- Add the Apache-2.0 license, locked dependencies, and reproducible CI and tests.
- Preserve technical names, Matter identities, and storage.
- Move sound playback and test controls to the Audio plugin.

Earlier versions were local prototypes.
