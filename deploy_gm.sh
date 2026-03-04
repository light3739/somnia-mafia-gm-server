#!/bin/bash
# Скрипт быстрого деплоя gm-server'а на удаленный VPS

echo "Копируем измененные файлы на сервер mafia (213.21.253.190)..."
scp src/index.ts src/chain.ts mafia:/root/gm-server/src/

echo "Собираем проект на сервере и перезапускаем gm-server..."
ssh mafia 'source ~/.nvm/nvm.sh || source ~/.bashrc && cd /root/gm-server && npm run build && pm2 restart gm-server || pm2 start dist/index.js --name gm-server'

echo "Деплой успешно завершен!"
