#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
for plugin in matterbridge-alarm matterbridge-audio matterbridge-keypad; do test -f "$root/$plugin/Dockerfile"; done
docker build -t matterbridge-alarm:local "$root/matterbridge-alarm"
docker build --build-arg MATTERBRIDGE_BASE_IMAGE=matterbridge-alarm:local -t matterbridge-stack:audio "$root/matterbridge-audio"
docker build --build-arg MATTERBRIDGE_BASE_IMAGE=matterbridge-stack:audio -t matterbridge-stack:local "$root/matterbridge-keypad"
