#!/bin/bash
# Script de lancement Stremio avec addon de sous-titres français

ADDON_DIR="/home/ninjax/claude/Idées applications/Sous-titre stremio"
LOG_FILE="$ADDON_DIR/server.log"
PID_FILE="$ADDON_DIR/server.pid"

# Vérifier si le serveur tourne déjà via le port 7000
if curl -s http://127.0.0.1:7000/manifest.json > /dev/null 2>&1; then
    echo "[SubAI] Serveur déjà en cours d'exécution"
else
    echo "[SubAI] Démarrage du serveur de sous-titres..."
    cd "$ADDON_DIR" || exit 1
    /usr/bin/node "$ADDON_DIR/server.js" > "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
    sleep 3

    # Vérifier que le serveur a démarré
    if curl -s http://127.0.0.1:7000/manifest.json > /dev/null 2>&1; then
        echo "[SubAI] Serveur démarré sur le port 7000"
    else
        echo "[SubAI] Erreur: le serveur n'a pas démarré"
        cat "$LOG_FILE"
        notify-send "Stremio SubAI" "Erreur: le serveur de sous-titres n'a pas démarré" 2>/dev/null
    fi
fi

# Lancer Stremio
echo "[SubAI] Lancement de Stremio..."
/usr/bin/flatpak run --branch=stable --arch=x86_64 --command=/app/opt/stremio/stremio com.stremio.Stremio "$@"
