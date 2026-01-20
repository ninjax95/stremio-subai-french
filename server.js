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

// ============================================
// MANIFEST DE L'ADDON
// ============================================

const manifest = {
    id: 'org.stremio.frenchsubtitles',
    version: '1.0.0',
    name: 'SubAI Français',
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
        console.log(`[Ollama] Disponible. Modèle ${CONFIG.OLLAMA_MODEL}: ${hasModel ? 'OK' : 'Non trouvé'}`);
        return hasModel;
    } catch (error) {
        console.log(`[Ollama] Non disponible: ${error.message}`);
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
async function translateSRT(srtContent, imdbId) {
    const cacheFile = path.join(CONFIG.SUBTITLES_DIR, `${imdbId}_fr.srt`);

    // Vérifier si déjà traduit
    if (fs.existsSync(cacheFile)) {
        console.log(`[Translate] Utilisation du cache pour ${imdbId}`);
        return fs.readFileSync(cacheFile, 'utf8');
    }

    console.log(`[Mixtral] Début de la traduction pour ${imdbId}...`);

    const parser = new SrtParser();
    let parsed;

    try {
        parsed = parser.fromSrt(srtContent);
    } catch (e) {
        console.error(`[Translate] Erreur parsing SRT: ${e.message}`);
        return null;
    }

    if (!parsed || parsed.length === 0) {
        console.error(`[Translate] SRT vide ou invalide`);
        return null;
    }

    const batchSize = 20; // 20 sous-titres par lot
    const totalBatches = Math.ceil(parsed.length / batchSize);
    console.log(`[Mixtral] ${parsed.length} sous-titres en ${totalBatches} lots...`);

    const translatedParts = [];

    // Fonction pour sauvegarder le fichier partiel
    const savePartial = () => {
        const partialSRT = translatedParts.map((sub, idx) => {
            return `${idx + 1}\n${sub.startTime} --> ${sub.endTime}\n${sub.text}\n`;
        }).join('\n');
        fs.writeFileSync(cacheFile, partialSRT, 'utf8');
    };

    for (let i = 0; i < parsed.length; i += batchSize) {
        const batch = parsed.slice(i, i + batchSize);
        const batchNum = Math.floor(i / batchSize) + 1;

        console.log(`[Mixtral] Lot ${batchNum}/${totalBatches}`);

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
            // En cas d'erreur, garder les originaux
            batch.forEach(sub => translatedParts.push(sub));
        }

        // Sauvegarder après chaque lot
        savePartial();
        console.log(`[Mixtral] Sauvegardé ${translatedParts.length}/${parsed.length} sous-titres`);
    }

    console.log(`[Mixtral] Traduction terminée!`);

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
    console.log(`\n========================================`);
    console.log(`[Subtitles] Requête: ${args.type}/${args.id}`);
    console.log(`========================================`);

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
        console.log(`\n[Étape 1] Recherche de sous-titres français...`);

        // Recherche parallèle sur les différentes sources
        const [opensubsFr, osLegacyFr] = await Promise.all([
            searchOpenSubtitles(imdbId, season, episode, 'fr'),
            searchOpenSubtitlesLegacy(imdbId, season, episode, 'fr')
        ]);

        // Ajouter les sous-titres français trouvés (dédupliqués)
        const frenchSubs = [...opensubsFr, ...osLegacyFr];

        if (frenchSubs.length > 0) {
            console.log(`[Résultat] ${frenchSubs.length} sous-titres français trouvés!`);

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
            console.log(`\n[Étape 2] Pas de français, recherche anglais...`);

            // Chercher des sous-titres anglais
            const [opensubsEn, osLegacyEn] = await Promise.all([
                searchOpenSubtitles(imdbId, season, episode, 'en'),
                searchOpenSubtitlesLegacy(imdbId, season, episode, 'en')
            ]);

            const englishSubs = [...opensubsEn, ...osLegacyEn];

            if (englishSubs.length > 0) {
                console.log(`[Résultat] ${englishSubs.length} sous-titres anglais trouvés`);

                // Vérifier si une traduction existe déjà en cache
                const cacheFile = path.join(CONFIG.SUBTITLES_DIR, `${imdbId}_fr.srt`);
                if (fs.existsSync(cacheFile)) {
                    console.log(`[Cache] Traduction française trouvée en cache!`);
                    subtitles.unshift({
                        id: 'subai-french-translated',
                        url: `http://127.0.0.1:${CONFIG.PORT}/subtitles/${imdbId}_fr.srt`,
                        lang: 'fre',
                        title: 'SubAI (IA)'
                    });
                } else {
                    // Vérifier si Ollama est disponible et lancer traduction en ARRIÈRE-PLAN
                    const ollamaAvailable = await checkOllama();
                    if (ollamaAvailable && englishSubs.length > 0) {
                        const bestEnglish = englishSubs[0];
                        console.log(`[Translate] Lancement traduction en arrière-plan...`);

                        // Traduction asynchrone (sans bloquer la réponse)
                        downloadSubtitle(bestEnglish.url).then(srtContent => {
                            if (srtContent) {
                                console.log(`[Translate] Traduction démarrée pour ${imdbId}...`);
                                translateSRT(srtContent, imdbId).then(result => {
                                    if (result) {
                                        console.log(`[Translate] Traduction terminée pour ${imdbId}! Disponible au prochain chargement.`);
                                    }
                                }).catch(err => console.error(`[Translate] Erreur: ${err.message}`));
                            }
                        }).catch(err => console.error(`[Download] Erreur: ${err.message}`));
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

        console.log(`\n[Final] Retour de ${subtitles.length} sous-titres au total`);
        return { subtitles };

    } catch (error) {
        console.error(`[Erreur] Handler: ${error.message}`);
        console.error(error.stack);
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
║  🔧 Pour installer dans Stremio:                       ║
║     1. Ouvrir Stremio                                  ║
║     2. Aller dans les paramètres (⚙️)                   ║
║     3. Cliquer sur "Addons"                            ║
║     4. Cliquer sur "Community Addons"                  ║
║     5. Coller l'URL du manifest dans la barre          ║
║                                                        ║
║  🤖 Ollama (traduction IA):                            ║
║     URL: ${CONFIG.OLLAMA_URL.padEnd(35)}    ║
║     Modèle: ${CONFIG.OLLAMA_MODEL.padEnd(32)}    ║
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
