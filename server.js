const { addonBuilder, serveHTTP, getRouter } = require('stremio-addon-sdk');
const axios = require('axios');
const NodeCache = require('node-cache');
const fs = require('fs');
const path = require('path');
const SrtParser = require('srt-parser-2').default || require('srt-parser-2');
const express = require('express');
const translate = require('google-translate-api-x');

// ============================================
// CONFIGURATION
// ============================================

const CONFIG = {
    // Port du serveur
    PORT: process.env.PORT || 7000,

    // Ollama (traduction IA locale)
    OLLAMA_URL: process.env.OLLAMA_URL || 'http://localhost:11434',
    OLLAMA_MODEL: process.env.OLLAMA_MODEL || 'mixtral', // meilleur pour traduction

    // OpenSubtitles (optionnel - fonctionne sans clé avec limitations)
    OPENSUBTITLES_API_KEY: process.env.OPENSUBTITLES_API_KEY || '',

    // OMDb API pour récupérer les titres (gratuit 1000 req/jour)
    // Obtenir une clé sur: http://www.omdbapi.com/apikey.aspx
    OMDB_API_KEY: process.env.OMDB_API_KEY || 'e6235f29',

    // Langues prioritaires pour la recherche
    TARGET_LANG: 'fr',  // Langue cible
    FALLBACK_LANG: 'en', // Langue pour traduction si pas de français

    // Cache (24h par défaut)
    CACHE_TTL: 86400,

    // Dossier pour stocker les sous-titres traduits
    SUBTITLES_DIR: path.join(__dirname, 'subtitles_cache')
};

// Créer le dossier de cache si nécessaire
if (!fs.existsSync(CONFIG.SUBTITLES_DIR)) {
    fs.mkdirSync(CONFIG.SUBTITLES_DIR, { recursive: true });
}

// Cache en mémoire pour les résultats de recherche
const cache = new NodeCache({ stdTTL: CONFIG.CACHE_TTL });

// Cache pour les titres des films/séries
const titlesCache = new NodeCache({ stdTTL: 86400 * 7 }); // 7 jours

// ============================================
// SYSTÈME D'ÉVÉNEMENTS EN TEMPS RÉEL
// ============================================

// État global pour le monitoring
const state = {
    status: 'idle', // idle, searching, translating, done, error
    currentMedia: null,
    progress: 0,
    totalSubtitles: 0,
    translatedSubtitles: 0,
    currentBatch: 0,
    totalBatches: 0,
    logs: [],
    ollamaAvailable: false,
    ollamaModel: CONFIG.OLLAMA_MODEL
};

// Gestion des traductions en cours
let currentTranslation = {
    mediaId: null,
    shouldCancel: false
};

// Clients SSE connectés
const sseClients = new Set();

// Envoyer un événement à tous les clients
function broadcast(event, data) {
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    sseClients.forEach(client => {
        client.write(message);
    });
}

// Logger avec broadcast
function log(message, type = 'info') {
    const timestamp = new Date().toLocaleTimeString('fr-FR');
    const logEntry = { timestamp, message, type };
    state.logs.push(logEntry);
    if (state.logs.length > 100) state.logs.shift(); // Garder les 100 derniers
    console.log(`[${timestamp}] ${message}`);
    broadcast('log', logEntry);
}

// Mettre à jour l'état et broadcaster
function updateState(updates) {
    Object.assign(state, updates);
    broadcast('state', state);
}

// ============================================
// MANIFEST DE L'ADDON
// ============================================

const manifest = {
    id: 'org.stremio.frenchsubtitles',
    version: '1.0.0',
    name: 'SubAI',
    description: 'Sous-titres français avec traduction IA automatique via Ollama',
    logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c3/Flag_of_France.svg/320px-Flag_of_France.svg.png',
    types: ['movie', 'series'],
    resources: [
        {
            name: 'subtitles',
            types: ['movie', 'series'],
            idPrefixes: ['tt']
        }
    ],
    catalogs: [],
    behaviorHints: {
        configurable: false,
        configurationRequired: false
    }
};

const builder = new addonBuilder(manifest);

// ============================================
// SOURCES DE SOUS-TITRES
// ============================================

/**
 * Recherche via l'addon OpenSubtitles officiel de Stremio (proxy gratuit)
 */
async function searchOpenSubtitles(imdbId, season, episode, language) {
    const cacheKey = `opensubtitles_${imdbId}_${season}_${episode}_${language}`;
    const cached = cache.get(cacheKey);
    if (cached) {
        console.log(`[OpenSubtitles] Cache hit pour ${imdbId}`);
        return cached;
    }

    try {
        // Utiliser l'addon OpenSubtitles officiel Stremio comme proxy
        const contentId = season && episode ? `${imdbId}:${season}:${episode}` : imdbId;
        const contentType = season ? 'series' : 'movie';

        console.log(`[OpenSubtitles] Recherche: ${contentId} (${language})`);

        const response = await axios.get(
            `https://opensubtitles-v3.strem.io/subtitles/${contentType}/${contentId}.json`,
            {
                timeout: 15000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            }
        );

        // Filtrer par langue
        const langCode = language === 'fr' ? 'fre' : 'eng';
        const subtitles = (response.data.subtitles || [])
            .filter(s => s.lang === langCode)
            .slice(0, 10)
            .map((item, index) => ({
                id: `opensubtitles_${item.id || index}`,
                url: item.url,
                lang: item.lang,
                source: 'OpenSubtitles'
            }));

        cache.set(cacheKey, subtitles);
        console.log(`[OpenSubtitles] Trouvé ${subtitles.length} sous-titres ${langCode}`);
        return subtitles;

    } catch (error) {
        console.error(`[OpenSubtitles] Erreur: ${error.message}`);
        return [];
    }
}

/**
 * Recherche sur OpenSubtitles.org (ancienne API REST)
 */
async function searchOpenSubtitlesLegacy(imdbId, season, episode, language) {
    const cacheKey = `oslegacy_${imdbId}_${season}_${episode}_${language}`;
    const cached = cache.get(cacheKey);
    if (cached) {
        console.log(`[OS-Legacy] Cache hit pour ${imdbId}`);
        return cached;
    }

    try {
        // API REST ancienne version (plus permissive)
        const imdbNum = imdbId.replace('tt', '');
        let url = `https://rest.opensubtitles.org/search/imdbid-${imdbNum}/sublanguageid-${language === 'fr' ? 'fre' : 'eng'}`;

        if (season && episode) {
            url += `/season-${season}/episode-${episode}`;
        }

        console.log(`[OS-Legacy] Recherche: ${imdbId} (${language})`);

        const response = await axios.get(url, {
            timeout: 15000,
            headers: {
                'User-Agent': 'TemporaryUserAgent',
                'X-User-Agent': 'TemporaryUserAgent'
            }
        });

        const subtitles = (response.data || []).slice(0, 5).map((item, index) => ({
            id: `oslegacy_${item.IDSubtitleFile || index}`,
            url: item.SubDownloadLink?.replace('.gz', '') || null,
            lang: language === 'fr' ? 'fre' : 'eng',
            source: 'OpenSubtitles',
            rating: parseFloat(item.SubRating) || 0
        })).filter(s => s.url);

        cache.set(cacheKey, subtitles);
        console.log(`[OS-Legacy] Trouvé ${subtitles.length} sous-titres`);
        return subtitles;

    } catch (error) {
        console.error(`[OS-Legacy] Erreur: ${error.message}`);
        return [];
    }
}

/**
 * Recherche sur Addic7ed (séries uniquement, bonne qualité FR)
 */
async function searchAddic7ed(imdbId, season, episode, language) {
    // Addic7ed est surtout pour les séries
    if (!season || !episode) return [];

    const cacheKey = `addic7ed_${imdbId}_${season}_${episode}_${language}`;
    const cached = cache.get(cacheKey);
    if (cached) {
        console.log(`[Addic7ed] Cache hit pour ${imdbId}`);
        return cached;
    }

    // Pour Addic7ed, on passe par un service communautaire
    console.log(`[Addic7ed] Non implémenté (nécessite scraping)`);
    return [];
}

/**
 * Télécharge le contenu d'un sous-titre
 */
async function downloadSubtitle(url) {
    try {
        const response = await axios.get(url, {
            timeout: 15000,
            responseType: 'text',
            headers: {
                'User-Agent': 'Stremio French Subtitles v1.0.0'
            }
        });
        return response.data;
    } catch (error) {
        console.error(`[Download] Erreur: ${error.message}`);
        return null;
    }
}

// ============================================
// RÉCUPÉRATION DES TITRES
// ============================================

/**
 * Récupère le titre d'un film/série depuis OMDb
 */
async function getMediaTitle(imdbId) {
    // Vérifier le cache
    const cached = titlesCache.get(imdbId);
    if (cached) return cached;

    if (!CONFIG.OMDB_API_KEY) {
        return null;
    }

    try {
        const response = await axios.get(`http://www.omdbapi.com/`, {
            params: {
                i: imdbId,
                apikey: CONFIG.OMDB_API_KEY
            },
            timeout: 5000
        });

        if (response.data && response.data.Title) {
            const title = response.data.Title;
            titlesCache.set(imdbId, title);
            console.log(`[OMDb] ${imdbId} -> ${title}`);
            return title;
        }
    } catch (error) {
        console.error(`[OMDb] Erreur: ${error.message}`);
    }

    return null;
}

// ============================================
// TRADUCTION IA AVEC OLLAMA
// ============================================

/**
 * Vérifie si Ollama est disponible
 */
async function checkOllama() {
    try {
        const response = await axios.get(`${CONFIG.OLLAMA_URL}/api/tags`, { timeout: 5000 });
        const models = response.data.models || [];
        const hasModel = models.some(m => m.name.includes(CONFIG.OLLAMA_MODEL));
        const available = hasModel;
        updateState({ ollamaAvailable: available });
        if (available) {
            log(`Ollama connecté (${CONFIG.OLLAMA_MODEL})`, 'success');
        }
        return available;
    } catch (error) {
        updateState({ ollamaAvailable: false });
        return false;
    }
}

/**
 * Traduit un texte avec Mixtral (lots de texte)
 */
async function translateWithMixtral(text) {
    try {
        const prompt = `Traduis ce texte de l'anglais vers le français. Réponds UNIQUEMENT avec la traduction, rien d'autre.

${text}`;

        const response = await axios.post(`${CONFIG.OLLAMA_URL}/api/generate`, {
            model: CONFIG.OLLAMA_MODEL,
            prompt: prompt,
            stream: false,
            options: {
                temperature: 0.1,
                num_predict: 2000
            }
        }, {
            timeout: 60000
        });

        return response.data.response?.trim() || text;
    } catch (error) {
        console.error(`[Mixtral] Erreur: ${error.message}`);
        return text;
    }
}

/**
 * Traduit un fichier SRT complet avec Mixtral (par lots)
 */
async function translateSRT(srtContent, mediaId) {
    const cacheFile = path.join(CONFIG.SUBTITLES_DIR, `${mediaId}_fr.srt`);

    // Vérifier si déjà traduit
    if (fs.existsSync(cacheFile)) {
        log(`Traduction en cache pour ${mediaId}`, 'success');
        updateState({ status: 'done', progress: 100 });
        return fs.readFileSync(cacheFile, 'utf8');
    }

    log(`Debut de la traduction pour ${mediaId}...`, 'info');
    updateState({ status: 'translating', currentMedia: mediaId, progress: 0 });

    const parser = new SrtParser();
    let parsed;

    try {
        parsed = parser.fromSrt(srtContent);
    } catch (e) {
        log(`Erreur parsing SRT: ${e.message}`, 'error');
        updateState({ status: 'error' });
        return null;
    }

    if (!parsed || parsed.length === 0) {
        log(`SRT vide ou invalide`, 'error');
        updateState({ status: 'error' });
        return null;
    }

    const batchSize = 20; // 20 sous-titres par lot
    const totalBatches = Math.ceil(parsed.length / batchSize);

    updateState({
        totalSubtitles: parsed.length,
        totalBatches: totalBatches,
        translatedSubtitles: 0,
        currentBatch: 0
    });

    log(`${parsed.length} sous-titres à traduire (${totalBatches} lots)`, 'info');

    const translatedParts = [];

    // Fonction pour sauvegarder le fichier partiel
    const savePartial = () => {
        const partialSRT = translatedParts.map((sub, idx) => {
            return `${idx + 1}\n${sub.startTime} --> ${sub.endTime}\n${sub.text}\n`;
        }).join('\n');
        fs.writeFileSync(cacheFile, partialSRT, 'utf8');
    };

    for (let i = 0; i < parsed.length; i += batchSize) {
        // Vérifier si la traduction a été annulée
        if (currentTranslation.shouldCancel && currentTranslation.mediaId !== mediaId) {
            log(`Traduction annulee pour ${mediaId}`, 'info');
            updateState({ status: 'idle', progress: 0 });
            // Supprimer le fichier partiel
            if (fs.existsSync(cacheFile)) {
                fs.unlinkSync(cacheFile);
            }
            return null;
        }

        const batch = parsed.slice(i, i + batchSize);
        const batchNum = Math.floor(i / batchSize) + 1;
        const progress = Math.round((i / parsed.length) * 100);

        updateState({
            currentBatch: batchNum,
            progress: progress,
            translatedSubtitles: translatedParts.length
        });

        log(`Traduction lot ${batchNum}/${totalBatches} (${progress}%)`, 'progress');

        // Créer le texte à traduire (chaque ligne numérotée)
        const textToTranslate = batch.map((sub, idx) => `[${idx + 1}] ${sub.text}`).join('\n');

        try {
            const translated = await translateWithMixtral(textToTranslate);
            const lines = translated.split('\n');

            batch.forEach((sub, idx) => {
                // Essayer de trouver la ligne correspondante
                let translatedText = lines[idx] || sub.text;
                // Enlever le numéro [X] si présent
                translatedText = translatedText.replace(/^\[\d+\]\s*/, '');
                translatedParts.push({
                    ...sub,
                    text: translatedText.trim() || sub.text
                });
            });
        } catch (e) {
            log(`Erreur lot ${batchNum}: ${e.message}`, 'error');
            // En cas d'erreur, garder les originaux
            batch.forEach(sub => translatedParts.push(sub));
        }

        // Sauvegarder après chaque lot
        savePartial();

        updateState({ translatedSubtitles: translatedParts.length });
    }

    log(`Traduction terminée! ${parsed.length} sous-titres traduits`, 'success');
    updateState({ status: 'done', progress: 100, translatedSubtitles: parsed.length });

    // Retourner le contenu final
    return fs.readFileSync(cacheFile, 'utf8');
}

// ============================================
// SERVEUR LOCAL DE SOUS-TITRES
// ============================================

// Servir les sous-titres traduits localement
async function serveTranslatedSubtitle(imdbId) {
    const cacheFile = path.join(CONFIG.SUBTITLES_DIR, `${imdbId}_fr.srt`);
    if (fs.existsSync(cacheFile)) {
        return `http://127.0.0.1:${CONFIG.PORT}/subtitles/${imdbId}_fr.srt`;
    }
    return null;
}

// ============================================
// HANDLER PRINCIPAL DES SOUS-TITRES
// ============================================

builder.defineSubtitlesHandler(async (args) => {
    const mediaId = args.id;
    log(`Nouvelle requête: ${args.type}/${mediaId}`, 'info');

    // Annuler la traduction en cours si c'est un média différent
    if (currentTranslation.mediaId && currentTranslation.mediaId !== mediaId) {
        log(`Annulation de la traduction en cours pour ${currentTranslation.mediaId}`, 'info');
        currentTranslation.shouldCancel = true;
    }

    // Réinitialiser pour ce nouveau média
    currentTranslation = {
        mediaId: mediaId,
        shouldCancel: false
    };

    updateState({ status: 'searching', currentMedia: mediaId });

    try {
        // Parser l'ID (tt1234567 ou tt1234567:1:2 pour les séries)
        const parts = args.id.split(':');
        const imdbId = parts[0];
        const season = parts[1] || null;
        const episode = parts[2] || null;

        const subtitles = [];

        // ============================================
        // ÉTAPE 1: Chercher des sous-titres français existants
        // ============================================
        log(`Recherche de sous-titres français...`, 'info');

        // Recherche parallèle sur les différentes sources
        const [opensubsFr, osLegacyFr] = await Promise.all([
            searchOpenSubtitles(imdbId, season, episode, 'fr'),
            searchOpenSubtitlesLegacy(imdbId, season, episode, 'fr')
        ]);

        // Ajouter les sous-titres français trouvés (dédupliqués)
        const frenchSubs = [...opensubsFr, ...osLegacyFr];

        if (frenchSubs.length > 0) {
            log(`${frenchSubs.length} sous-titres français trouvés!`, 'success');
            updateState({ status: 'done' });

            frenchSubs.forEach(sub => {
                subtitles.push({
                    id: sub.id,
                    url: sub.url,
                    lang: 'fre',
                    // Afficher la source dans le nom
                    ...(sub.source && { id: `${sub.source} - ${sub.id}` })
                });
            });
        }

        // ============================================
        // ÉTAPE 2: Si pas de français, chercher anglais + traduire
        // ============================================
        if (frenchSubs.length === 0) {
            log(`Pas de français trouvé, recherche anglais...`, 'info');

            // Chercher des sous-titres anglais
            const [opensubsEn, osLegacyEn] = await Promise.all([
                searchOpenSubtitles(imdbId, season, episode, 'en'),
                searchOpenSubtitlesLegacy(imdbId, season, episode, 'en')
            ]);

            const englishSubs = [...opensubsEn, ...osLegacyEn];

            if (englishSubs.length > 0) {
                log(`${englishSubs.length} sous-titres anglais trouvés`, 'info');

                // Vérifier si une traduction existe déjà en cache
                const cacheFile = path.join(CONFIG.SUBTITLES_DIR, `${mediaId}_fr.srt`);
                if (fs.existsSync(cacheFile)) {
                    log(`Traduction française en cache!`, 'success');
                    updateState({ status: 'done' });
                    subtitles.unshift({
                        id: 'SubAI',
                        url: `http://127.0.0.1:${CONFIG.PORT}/subtitles/${mediaId}_fr.srt`,
                        lang: 'fra'
                    });
                } else {
                    // Vérifier si Ollama est disponible et lancer traduction en ARRIÈRE-PLAN
                    const ollamaAvailable = await checkOllama();
                    if (ollamaAvailable && englishSubs.length > 0) {
                        const bestEnglish = englishSubs[0];
                        log(`Lancement traduction en arrière-plan...`, 'info');

                        // Traduction asynchrone (sans bloquer la réponse)
                        downloadSubtitle(bestEnglish.url).then(srtContent => {
                            if (srtContent) {
                                log(`Telechargement termine, traduction en cours...`, 'info');
                                translateSRT(srtContent, mediaId).then(result => {
                                    if (result) {
                                        log(`Traduction disponible!`, 'success');
                                    }
                                }).catch(err => log(`Erreur traduction: ${err.message}`, 'error'));
                            }
                        }).catch(err => log(`Erreur telechargement: ${err.message}`, 'error'));
                    } else if (!ollamaAvailable) {
                        log(`Ollama non disponible - traduction impossible`, 'error');
                        updateState({ status: 'idle' });
                    }
                }

                // Ajouter les sous-titres anglais originaux
                englishSubs.forEach(sub => {
                    subtitles.push({
                        id: `${sub.source}_en_${sub.id}`,
                        url: sub.url,
                        lang: 'eng'
                    });
                });
            }
        }

        log(`Retour de ${subtitles.length} sous-titres`, 'success');
        return { subtitles };

    } catch (error) {
        log(`Erreur: ${error.message}`, 'error');
        updateState({ status: 'error' });
        return { subtitles: [] };
    }
});

// ============================================
// DÉMARRAGE DU SERVEUR
// ============================================

const addon = builder.getInterface();

// Créer l'app Express
const app = express();

// Servir les fichiers de sous-titres statiques avec CORS
app.use('/subtitles', (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    next();
}, express.static(CONFIG.SUBTITLES_DIR));

// ============================================
// INTERFACE DE MONITORING
// ============================================

// Page HTML de monitoring
app.get('/monitor', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SubAI Monitor</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'Segoe UI', system-ui, sans-serif;
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            color: #fff;
            min-height: 100vh;
            padding: 20px;
        }
        .container {
            max-width: 600px;
            margin: 0 auto;
        }
        h1 {
            text-align: center;
            margin-bottom: 20px;
            font-size: 1.5em;
        }
        h1 span { color: #4fc3f7; }

        .status-card {
            background: rgba(255,255,255,0.1);
            border-radius: 12px;
            padding: 20px;
            margin-bottom: 15px;
            backdrop-filter: blur(10px);
        }
        .status-header {
            display: flex;
            align-items: center;
            gap: 10px;
            margin-bottom: 15px;
        }
        .status-dot {
            width: 12px;
            height: 12px;
            border-radius: 50%;
            background: #666;
        }
        .status-dot.idle { background: #666; }
        .status-dot.searching { background: #ffc107; animation: pulse 1s infinite; }
        .status-dot.translating { background: #4fc3f7; animation: pulse 1s infinite; }
        .status-dot.done { background: #4caf50; }
        .status-dot.error { background: #f44336; }

        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }

        .status-text {
            font-size: 1.1em;
            font-weight: 500;
        }
        .media-name {
            color: #4fc3f7;
            font-size: 0.9em;
            margin-top: 5px;
        }

        .progress-section {
            margin-top: 15px;
        }
        .progress-bar {
            height: 8px;
            background: rgba(255,255,255,0.2);
            border-radius: 4px;
            overflow: hidden;
            margin-bottom: 8px;
        }
        .progress-fill {
            height: 100%;
            background: linear-gradient(90deg, #4fc3f7, #00e5ff);
            border-radius: 4px;
            transition: width 0.3s ease;
            width: 0%;
        }
        .progress-stats {
            display: flex;
            justify-content: space-between;
            font-size: 0.85em;
            color: rgba(255,255,255,0.7);
        }

        .logs-card {
            background: rgba(0,0,0,0.3);
            border-radius: 12px;
            padding: 15px;
            max-height: 300px;
            overflow-y: auto;
        }
        .logs-title {
            font-size: 0.9em;
            color: rgba(255,255,255,0.6);
            margin-bottom: 10px;
        }
        .log-entry {
            font-family: 'Consolas', monospace;
            font-size: 0.8em;
            padding: 4px 0;
            border-bottom: 1px solid rgba(255,255,255,0.05);
        }
        .log-entry:last-child { border-bottom: none; }
        .log-time { color: #888; margin-right: 8px; }
        .log-info { color: #4fc3f7; }
        .log-success { color: #4caf50; }
        .log-error { color: #f44336; }
        .log-progress { color: #ffc107; }

        .ollama-status {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 0.85em;
            padding: 10px;
            background: rgba(0,0,0,0.2);
            border-radius: 8px;
            margin-top: 15px;
        }
        .ollama-status.available { color: #4caf50; }
        .ollama-status.unavailable { color: #f44336; }

        .cache-card {
            background: rgba(0,0,0,0.3);
            border-radius: 12px;
            padding: 15px;
            margin-top: 15px;
        }
        .cache-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 10px;
        }
        .cache-title {
            font-size: 0.9em;
            color: rgba(255,255,255,0.6);
        }
        .cache-count {
            font-size: 0.85em;
            color: #4fc3f7;
            background: rgba(79,195,247,0.2);
            padding: 4px 8px;
            border-radius: 4px;
        }
        .cache-list {
            max-height: 300px;
            overflow-y: auto;
        }
        .cache-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 10px;
            background: rgba(255,255,255,0.05);
            border-radius: 8px;
            margin-bottom: 8px;
        }
        .cache-item:hover {
            background: rgba(255,255,255,0.08);
        }
        .cache-info {
            flex: 1;
        }
        .cache-imdb {
            font-family: 'Consolas', monospace;
            font-size: 0.9em;
            color: #4fc3f7;
            margin-bottom: 4px;
        }
        .cache-meta {
            font-size: 0.75em;
            color: rgba(255,255,255,0.5);
        }
        .btn-delete {
            background: #f44336;
            color: white;
            border: none;
            padding: 6px 12px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 0.85em;
            transition: background 0.2s;
        }
        .btn-delete:hover {
            background: #d32f2f;
        }
        .btn-delete:active {
            transform: scale(0.95);
        }
        .empty-cache {
            text-align: center;
            padding: 20px;
            color: rgba(255,255,255,0.4);
            font-size: 0.9em;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🎬 <span>SubAI</span> Monitor</h1>

        <div class="status-card">
            <div class="status-header">
                <div class="status-dot" id="statusDot"></div>
                <span class="status-text" id="statusText">En attente...</span>
            </div>
            <div class="media-name" id="mediaName"></div>

            <div class="progress-section" id="progressSection" style="display: none;">
                <div class="progress-bar">
                    <div class="progress-fill" id="progressFill"></div>
                </div>
                <div class="progress-stats">
                    <span id="progressPercent">0%</span>
                    <span id="progressDetail">0 / 0 sous-titres</span>
                </div>
            </div>

            <div class="ollama-status" id="ollamaStatus">
                <span>🤖</span>
                <span>Ollama: Vérification...</span>
            </div>
        </div>

        <div class="logs-card">
            <div class="logs-title">📋 Activité</div>
            <div id="logs"></div>
        </div>

        <div class="cache-card">
            <div class="cache-header">
                <span class="cache-title">💾 Sous-titres en cache</span>
                <span class="cache-count" id="cacheCount">0</span>
            </div>
            <div class="cache-list" id="cacheList">
                <div class="empty-cache">Aucun sous-titre en cache</div>
            </div>
        </div>
    </div>

    <script>
        const statusDot = document.getElementById('statusDot');
        const statusText = document.getElementById('statusText');
        const mediaName = document.getElementById('mediaName');
        const progressSection = document.getElementById('progressSection');
        const progressFill = document.getElementById('progressFill');
        const progressPercent = document.getElementById('progressPercent');
        const progressDetail = document.getElementById('progressDetail');
        const ollamaStatus = document.getElementById('ollamaStatus');
        const logsDiv = document.getElementById('logs');

        const statusLabels = {
            idle: 'En attente',
            searching: 'Recherche de sous-titres...',
            translating: 'Traduction en cours...',
            done: 'Terminé',
            error: 'Erreur'
        };

        function updateUI(state) {
            statusDot.className = 'status-dot ' + state.status;
            statusText.textContent = statusLabels[state.status] || state.status;

            if (state.currentMedia) {
                mediaName.textContent = '📺 ' + state.currentMedia;
                mediaName.style.display = 'block';
            } else {
                mediaName.style.display = 'none';
            }

            if (state.status === 'translating' || state.status === 'done') {
                progressSection.style.display = 'block';
                progressFill.style.width = state.progress + '%';
                progressPercent.textContent = state.progress + '%';
                progressDetail.textContent = state.translatedSubtitles + ' / ' + state.totalSubtitles + ' sous-titres';
            } else {
                progressSection.style.display = 'none';
            }

            ollamaStatus.className = 'ollama-status ' + (state.ollamaAvailable ? 'available' : 'unavailable');
            ollamaStatus.innerHTML = '<span>🤖</span><span>Ollama: ' + (state.ollamaAvailable ? 'Connecté (' + state.ollamaModel + ')' : 'Non disponible') + '</span>';
        }

        function addLog(entry) {
            const div = document.createElement('div');
            div.className = 'log-entry';
            div.innerHTML = '<span class="log-time">' + entry.timestamp + '</span><span class="log-' + entry.type + '">' + entry.message + '</span>';
            logsDiv.insertBefore(div, logsDiv.firstChild);

            // Garder max 50 logs visibles
            while (logsDiv.children.length > 50) {
                logsDiv.removeChild(logsDiv.lastChild);
            }
        }

        // Connexion SSE
        console.log('[SubAI] Connexion SSE...');
        const evtSource = new EventSource('/events');

        evtSource.addEventListener('state', (e) => {
            console.log('[SubAI] Event state recu');
            updateUI(JSON.parse(e.data));
        });

        evtSource.addEventListener('log', (e) => {
            console.log('[SubAI] Event log recu');
            addLog(JSON.parse(e.data));
        });

        evtSource.addEventListener('open', () => {
            console.log('[SubAI] SSE connecte');
        });

        evtSource.onerror = (err) => {
            console.error('[SubAI] Erreur SSE:', err);
            statusText.textContent = 'Connexion perdue...';
            statusDot.className = 'status-dot error';
        };

        // Charger l'etat initial
        console.log('[SubAI] Chargement initial...');
        fetch('/api/state')
            .then(r => {
                console.log('[SubAI] Reponse recue:', r.status);
                return r.json();
            })
            .then(state => {
                console.log('[SubAI] Etat recu:', state);
                updateUI(state);
            })
            .catch(err => {
                console.error('[SubAI] Erreur chargement:', err);
                statusText.textContent = 'Erreur de chargement';
                statusDot.className = 'status-dot error';
            });

        // Gestion du cache
        const cacheList = document.getElementById('cacheList');
        const cacheCount = document.getElementById('cacheCount');

        function formatSize(bytes) {
            if (bytes < 1024) return bytes + ' B';
            if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
            return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
        }

        function formatDate(dateStr) {
            const date = new Date(dateStr);
            const now = new Date();
            const diff = now - date;
            const minutes = Math.floor(diff / 60000);
            const hours = Math.floor(minutes / 60);
            const days = Math.floor(hours / 24);

            if (minutes < 1) return 'maintenant';
            if (minutes < 60) return 'il y a ' + minutes + ' min';
            if (hours < 24) return 'il y a ' + hours + 'h';
            return 'il y a ' + days + 'j';
        }

        function formatMediaId(mediaId, title) {
            const parts = mediaId.split(':');
            const displayTitle = title || parts[0];

            if (parts.length === 3) {
                // Serie: "The Walking Dead" - S13E11
                return displayTitle + ' - S' + parts[1].padStart(2, '0') + 'E' + parts[2].padStart(2, '0');
            } else {
                // Film: "Inception"
                return displayTitle;
            }
        }

        function loadCache() {
            fetch('/api/cache')
                .then(r => r.json())
                .then(data => {
                    cacheCount.textContent = data.count;

                    if (data.files.length === 0) {
                        cacheList.innerHTML = '<div class="empty-cache">Aucun sous-titre en cache</div>';
                        return;
                    }

                    cacheList.innerHTML = data.files.map(file => {
                        return '<div class="cache-item">' +
                            '<div class="cache-info">' +
                            '<div class="cache-imdb">' + formatMediaId(file.imdbId, file.title) + '</div>' +
                            '<div class="cache-meta">' + formatSize(file.size) + ' - ' + formatDate(file.modified) + '</div>' +
                            '</div>' +
                            '<button class="btn-delete" onclick="deleteCache(' + "'" + file.filename + "'" + ')">Supprimer</button>' +
                            '</div>';
                    }).join('');
                })
                .catch(err => console.error('Erreur chargement cache:', err));
        }

        window.deleteCache = function(filename) {
            if (!confirm('Supprimer ce sous-titre ?\\n' + filename)) return;

            fetch('/api/cache/' + filename, { method: 'DELETE' })
                .then(r => r.json())
                .then(data => {
                    if (data.success) {
                        loadCache(); // Recharger la liste
                    } else {
                        alert('Erreur: ' + data.error);
                    }
                })
                .catch(err => alert('Erreur: ' + err.message));
        };

        // Charger le cache au démarrage
        loadCache();

        // Recharger le cache toutes les 10 secondes
        setInterval(loadCache, 10000);
    </script>
</body>
</html>`);
});

// Endpoint SSE pour les événements en temps réel
app.get('/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Envoyer l'état initial
    res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);

    // Ajouter le client à la liste
    sseClients.add(res);

    // Nettoyer quand le client se déconnecte
    req.on('close', () => {
        sseClients.delete(res);
    });
});

// API pour récupérer l'état
app.get('/api/state', (req, res) => {
    res.json(state);
});

// API pour lister les sous-titres en cache
app.get('/api/cache', async (req, res) => {
    try {
        const files = fs.readdirSync(CONFIG.SUBTITLES_DIR)
            .filter(f => f.endsWith('.srt'))
            .map(filename => {
                const filepath = path.join(CONFIG.SUBTITLES_DIR, filename);
                const stats = fs.statSync(filepath);
                const mediaId = filename.replace('_fr.srt', '');
                const parts = mediaId.split(':');
                const imdbId = parts[0];

                return {
                    filename,
                    imdbId: mediaId,
                    imdbOnly: imdbId,
                    size: stats.size,
                    modified: stats.mtime,
                    url: `http://127.0.0.1:${CONFIG.PORT}/subtitles/${filename}`
                };
            })
            .sort((a, b) => b.modified - a.modified); // Plus récent en premier

        // Récupérer les titres pour chaque fichier
        const filesWithTitles = await Promise.all(
            files.map(async (file) => {
                const title = await getMediaTitle(file.imdbOnly);
                return {
                    ...file,
                    title: title
                };
            })
        );

        res.json({ files: filesWithTitles, count: filesWithTitles.length });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// API pour supprimer un sous-titre en cache
app.delete('/api/cache/:filename', (req, res) => {
    try {
        const filename = req.params.filename;
        // Sécurité : vérifier que c'est bien un fichier .srt
        if (!filename.endsWith('.srt') || filename.includes('..')) {
            return res.status(400).json({ error: 'Nom de fichier invalide' });
        }

        const filepath = path.join(CONFIG.SUBTITLES_DIR, filename);

        if (!fs.existsSync(filepath)) {
            return res.status(404).json({ error: 'Fichier non trouvé' });
        }

        fs.unlinkSync(filepath);
        log(`Sous-titre supprimé: ${filename}`, 'info');
        res.json({ success: true, message: `${filename} supprimé` });
    } catch (error) {
        log(`Erreur suppression: ${error.message}`, 'error');
        res.status(500).json({ error: error.message });
    }
});

// Intégrer le router Stremio
const addonRouter = getRouter(addon);
app.use(addonRouter);

// Démarrer le serveur sur toutes les interfaces
app.listen(CONFIG.PORT, '0.0.0.0', () => {
    console.log(`Serveur démarré sur le port ${CONFIG.PORT}`);
});

console.log(`
╔════════════════════════════════════════════════════════╗
║     🎬 Stremio French Subtitles + AI                   ║
╠════════════════════════════════════════════════════════╣
║                                                        ║
║  Serveur démarré sur le port ${CONFIG.PORT}                     ║
║                                                        ║
║  📋 Manifest:                                          ║
║     http://127.0.0.1:${CONFIG.PORT}/manifest.json               ║
║                                                        ║
║  📊 Monitor (temps réel):                              ║
║     http://127.0.0.1:${CONFIG.PORT}/monitor                     ║
║                                                        ║
║  🤖 Ollama: ${CONFIG.OLLAMA_MODEL.padEnd(39)}  ║
║                                                        ║
╚════════════════════════════════════════════════════════╝
`);

// Vérifier Ollama au démarrage
checkOllama().then(available => {
    if (!available) {
        console.log(`
⚠️  Ollama n'est pas détecté ou le modèle '${CONFIG.OLLAMA_MODEL}' n'est pas installé.

    Pour activer la traduction IA:
    1. Installer Ollama: https://ollama.ai
    2. Lancer: ollama serve
    3. Installer un modèle: ollama pull ${CONFIG.OLLAMA_MODEL}

    L'addon fonctionnera quand même avec les sous-titres existants.
`);
    }
});
