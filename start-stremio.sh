#!/bin/bash
# Script de lancement Stremio avec addon de sous-titres français

ADDON_DIR="/home/ninjax/claude/Idées applications/Sous-titre stremio"
LOG_FILE="$ADDON_DIR/server.log"
PID_FILE="$ADDON_DIR/server.pid"
MONITOR_URL="http://127.0.0.1:7000/monitor"

# Afficher un header
echo ""
echo "╔════════════════════════════════════════╗"
echo "║   🎬 Stremio + SubAI Français          ║"
echo "╚════════════════════════════════════════╝"
echo ""

# Vérifier si le serveur tourne déjà via le port 7000
if curl -s http://127.0.0.1:7000/manifest.json > /dev/null 2>&1; then
    echo "✓ Serveur SubAI déjà actif sur le port 7000"
    echo "  📊 Monitor: $MONITOR_URL"
    echo "  🌐 Ouverture du monitor..."
    # Ouvrir le monitor dans le navigateur
    (sleep 1 && xdg-open "$MONITOR_URL") > /dev/null 2>&1 &
    # Notification desktop
    notify-send "Stremio SubAI" "✓ Serveur actif\n📊 Monitor ouvert" -t 3000 2>/dev/null
else
    echo "⚙ Démarrage du serveur SubAI..."
    cd "$ADDON_DIR" || exit 1
    /usr/bin/node "$ADDON_DIR/server.js" > "$LOG_FILE" 2>&1 &
    SERVER_PID=$!
    echo $SERVER_PID > "$PID_FILE"
    echo "  PID: $SERVER_PID"

    # Attendre le démarrage (max 5 secondes)
    for i in {1..10}; do
        if curl -s http://127.0.0.1:7000/manifest.json > /dev/null 2>&1; then
            echo "✓ Serveur SubAI démarré avec succès"
            echo "  📊 Monitor: $MONITOR_URL"
            # Ouvrir le monitor dans le navigateur
            xdg-open "$MONITOR_URL" > /dev/null 2>&1 &
            # Notification desktop
            notify-send "Stremio SubAI" "✓ Serveur démarré\n📊 Monitor ouvert" -t 3000 2>/dev/null
            break
        fi
        sleep 0.5
    done

    # Vérification finale
    if ! curl -s http://127.0.0.1:7000/manifest.json > /dev/null 2>&1; then
        echo "✗ ERREUR: Le serveur n'a pas démarré"
        echo "  Logs:"
        tail -10 "$LOG_FILE" | sed 's/^/    /'
        notify-send "Stremio SubAI" "✗ Erreur de démarrage\nVoir les logs" -u critical 2>/dev/null
        exit 1
    fi
fi

echo ""
echo "🚀 Lancement de Stremio..."
echo ""

# Lancer Stremio
/usr/bin/flatpak run --branch=stable --arch=x86_64 --command=/app/opt/stremio/stremio com.stremio.Stremio "$@"
