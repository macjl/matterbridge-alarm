#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
for plugin in matterbridge-securitysystem-core matterbridge-securitysystem-audio matterbridge-securitysystem-keypad; do test -f "$root/$plugin/Dockerfile"; done
docker build -t matterbridge-securitysystem-core:local "$root/matterbridge-securitysystem-core"
docker build --build-arg MATTERBRIDGE_BASE_IMAGE=matterbridge-securitysystem-core:local -t matterbridge-securitysystem-stack:audio "$root/matterbridge-securitysystem-audio"
docker build --build-arg MATTERBRIDGE_BASE_IMAGE=matterbridge-securitysystem-stack:audio -t matterbridge-securitysystem-stack:local "$root/matterbridge-securitysystem-keypad"
