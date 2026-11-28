FROM luligu/matterbridge:3.11.5

COPY package.json index.js alarm.js attributes.js actions.js content.js /usr/local/lib/node_modules/matterbridge-securitysystem-core/
COPY apps/frontend/build/ /usr/local/lib/node_modules/matterbridge-securitysystem-core/apps/frontend/build/
COPY docker-start.sh /usr/local/bin/matterbridge-poc-start

CMD ["/bin/sh", "/usr/local/bin/matterbridge-poc-start"]
