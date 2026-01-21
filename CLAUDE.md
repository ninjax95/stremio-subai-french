# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Stremio addon that provides French subtitles for movies and TV series. When no French subtitles are available, it automatically translates English subtitles using Ollama (local AI with Mixtral model).

## Commands

```bash
# Install dependencies
npm install

# Start server (port 7000)
npm start

# Start with custom Ollama model
OLLAMA_MODEL=llama3 npm start
```

## Architecture

Single-file Node.js server (`server.js`) using Stremio addon SDK:

1. **Subtitle Handler** - Receives requests from Stremio with IMDB ID (and season/episode for series)
2. **Source Search** - Queries OpenSubtitles (v3 proxy + legacy API) for French subtitles
3. **Fallback Translation** - If no French found, downloads English subtitles and translates via Ollama
4. **Caching** - Translated SRT files saved to `subtitles_cache/` for instant reuse
5. **Express Server** - Serves translated subtitles with CORS headers + Stremio addon routes

Key flow:
```
Stremio request → Search FR subs → Found? Return them
                                 → Not found? Search EN → Translate with Mixtral → Cache → Return
```

## Configuration

Environment variables in `CONFIG` object (server.js:14-34):
- `PORT` (7000) - Server port
- `OLLAMA_URL` (localhost:11434) - Ollama API endpoint
- `OLLAMA_MODEL` (mixtral) - Translation model
- `OPENSUBTITLES_API_KEY` - Optional API key

## Auto-start with Stremio

Script `start-stremio.sh` launches the server before Stremio. Desktop entry at `~/.local/share/applications/com.stremio.Stremio.desktop` points to symlink `~/.local/bin/start-stremio.sh`.

## Stremio Installation

Add addon via URL: `http://127.0.0.1:7000/manifest.json`
