# 🎬 Stremio French Subtitles + AI

Addon Stremio pour obtenir des sous-titres français, avec traduction automatique via IA (Ollama) quand aucun sous-titre français n'est disponible.

## Fonctionnalités

- 🔍 **Recherche multi-sources**: OpenSubtitles + SubDL
- 🇫🇷 **Priorité au français**: Cherche d'abord les sous-titres français existants
- 🤖 **Traduction IA**: Si pas de français, traduit automatiquement depuis l'anglais avec Ollama
- 💾 **Cache intelligent**: Les sous-titres traduits sont sauvegardés pour une réutilisation instantanée
- 🎯 **Support complet**: Films et séries (avec détection saison/épisode)

## Installation rapide

### 1. Prérequis

- Node.js 18+ installé
- (Optionnel) Ollama pour la traduction IA

### 2. Installation

```bash
cd "Sous-titre stremio"
npm install
```

### 3. Lancer l'addon

```bash
npm start
```

### 4. Ajouter à Stremio

1. Ouvrir Stremio
2. Aller dans **Paramètres** (⚙️) → **Addons**
3. Coller cette URL dans la barre de recherche:
   ```
   http://127.0.0.1:7000/manifest.json
   ```
4. Cliquer sur **Install**

## Configuration Ollama (traduction IA)

Pour activer la traduction automatique:

### 1. Installer Ollama

```bash
# Linux
curl -fsSL https://ollama.ai/install.sh | sh

# Ou télécharger depuis https://ollama.ai
```

### 2. Télécharger un modèle

```bash
# Mistral (recommandé - bon équilibre vitesse/qualité)
ollama pull mistral

# Ou Llama 3 (meilleure qualité, plus lent)
ollama pull llama3

# Ou Gemma (léger et rapide)
ollama pull gemma
```

### 3. Lancer Ollama

```bash
ollama serve
```

L'addon détectera automatiquement Ollama au démarrage.

## Variables d'environnement

| Variable | Défaut | Description |
|----------|--------|-------------|
| `PORT` | `7000` | Port du serveur |
| `OLLAMA_URL` | `http://localhost:11434` | URL d'Ollama |
| `OLLAMA_MODEL` | `mistral` | Modèle à utiliser |
| `OPENSUBTITLES_API_KEY` | `` | Clé API OpenSubtitles (optionnel) |

Exemple:
```bash
OLLAMA_MODEL=llama3 npm start
```

## Comment ça marche

```
1. Tu lances un film/série dans Stremio
           ↓
2. L'addon cherche des sous-titres français
   - OpenSubtitles
   - SubDL
           ↓
3. Si trouvé → Affiche les sous-titres français
   Si pas trouvé ↓
           ↓
4. Cherche des sous-titres anglais
           ↓
5. Traduit avec Ollama (IA locale)
           ↓
6. Sauvegarde et affiche le sous-titre traduit
```

## Résolution de problèmes

### "Ollama non disponible"

1. Vérifie qu'Ollama est lancé: `ollama serve`
2. Vérifie que le modèle est installé: `ollama list`
3. Si non installé: `ollama pull mistral`

### "Pas de sous-titres trouvés"

- Le film/série est peut-être trop récent
- Vérifie que le contenu a un ID IMDb valide
- Les sources peuvent être temporairement indisponibles

### "Traduction lente"

- Normal pour la première traduction (dépend de ton GPU/CPU)
- Les traductions sont mises en cache pour les utilisations futures
- Essaie un modèle plus léger: `OLLAMA_MODEL=gemma npm start`

## Structure du projet

```
Sous-titre stremio/
├── server.js          # Serveur principal
├── package.json       # Dépendances
├── subtitles_cache/   # Cache des sous-titres traduits
└── README.md          # Ce fichier
```

## Licence

MIT
