# AI Turk Agent Instructions

## Project Overview

AI UI controller based on React + Vite + TypeScript. A chatbot interface that generates dynamic button grids.
Abstracts the backend to support both **pi RPC** and **Claude Code stream-json** (switch via `TURK_BACKEND` in `.env`).
Features WebSocket communication, automatic session context management, and tool support.

## Tech Stack

- **Frontend**: React 19 + TypeScript + Vite 8 + Tailwind v4 + Pixelact UI
- **Font**: Neo-Dunggeunmo (Pixel font for Korean/English, via jsDelivr CDN)
- **Backend**: Node.js + `ws` (WebSocket) + Backend Abstraction (`backend.ts`)
  - `pi` — `pi --mode rpc` (JSONL protocol, default)
  - `claude` — `claude -p --input-format/output-format stream-json` (via Ollama Anthropic-compatible endpoint)
- **Communication**: WebSocket (`/ws`) — real-time streaming (`text_delta` events)
- **Configuration**: `.env` (port, backend type, model)
- **Control**: `turkctl` script (server startup/control)

## Architecture

```
Browser (React) ←WebSocket→ Vite Server ←stdin/stdout→ Backend (pi | claude)
                                   ↑
                            Backend/Model/API settings in .env
```

### Backend Abstraction

`backend.ts` defines the `Backend` interface and implements `PiBackend` (passthrough) and `ClaudeBackend` (translates stream-json → pi events). `App.tsx` always receives the **pi event format**, so it is agnostic to the backend type.

### Core: Automatic HMR Reflection

`npm run dev` supports HMR (Hot Module Replacement).
Code changes are automatically reflected in the browser **without restarting the server**.
When the agent fixes code, it is applied immediately to the screen, allowing development with a single `turkctl start` without manual builds.
Vite server only restarts when `vite.config.ts` or `.env` changes.

### Backend Protocol

- **Common Events (pi format received by App.tsx)**: `pi_ready`, `agent_start`, `message_update` (text_delta/thinking_delta), `tool_execution_start/end`, `agent_end`, `pi_exit`
- **pi Commands (stdin → JSONL)**: `prompt`, `abort`, `new_session`, `set_model`, `get_state`, etc.
- **Claude Backend**: Translates the above commands to Claude stream-json input. Runtime controls (`set_model`/`cycle_thinking_level`, etc.) are handled as no-op with synthetic responses (Claude Code is based on CLI flags).
- **Streaming**: Real-time text output via `text_delta` events.
- **Session**: `--no-session`/`-p` mode (process lifecycle = session).

## /start — Start Server

```bash
cd ~/ai-turk
npm install 2>/dev/null
[ -f .env ] || cp .env.example .env
turkctl start
```

Multiple instances: Specify `.env` file via `TURK_ENV_FILE` environment variable or `--env` flag.
```bash
turkctl --env .env.8003 start      # or TURK_ENV_FILE=.env.8003 turkctl start
```

### Backend Switching (pi ↔ claude)

Select backend via `TURK_BACKEND` in `.env`. Default is `pi`. Backend variables are separated:
- pi: `TURK_PI_BIN` / `TURK_PI_MODEL` / `TURK_PI_ARGS`
- claude: `TURK_CLAUDE_BIN` / `TURK_CLAUDE_MODEL` / `ANTHROPIC_*`

**① Claude Backend — Pure Anthropic Claude (Recommended)**:
```bash
# Add/Uncomment in .env
TURK_BACKEND=claude
TURK_CLAUDE_MODEL=claude-haiku-4-5      # Full claude-* name
# If ANTHROPIC_BASE_URL is empty, defaults to api.anthropic.com
```

**② Claude Backend — Ollama Claude Combo** (equivalent to `ollama launch claude --model <m>`):
```bash
TURK_BACKEND=claude
TURK_CLAUDE_MODEL=glm-5.1:cloud        # Model pulled in Ollama
ANTHROPIC_BASE_URL=http://localhost:11434   # Ollama Anthropic-compatible endpoint
ANTHROPIC_AUTH_TOKEN=ollama          # Any value (falls back to subscription if empty)
```
After switching, run `turkctl restart` (or automatic restart on `.env` change).
The backend type (pi/claude) is displayed as a `<sub>` next to the title.

## /stop — Stop Server

```bash
turkctl stop
```

## /restart — Restart Server

```bash
turkctl restart
```

## /doctor — Diagnostics

```bash
cd ~/ai-turk

# General status (shows backend type)
turkctl status

# Backend process
turkctl pi

# WebSocket connection test
turkctl ws

# Session info
turkctl session

# Environment check
node --version
pi --version 2>/dev/null || echo "❌ pi not installed"
claude --version 2>/dev/null || echo "ℹ️ claude not installed (only needed for TURK_BACKEND=claude)"
ollama --version 2>/dev/null || echo "ℹ️ ollama not installed (needed for claude backend)"
[ -d node_modules ] && echo "✅ node_modules exists" || echo "❌ npm install required"
[ -f .env ] && echo "✅ .env exists" || echo "❌ .env missing"
# Check current backend
grep -E "^TURK_BACKEND" .env 2>/dev/null || echo "TURK_BACKEND=pi (default)"
npx tsc -b --noEmit 2>&1 | tail -3
```

## /logs — Real-time Logs

```bash
turkctl logs
```

## Coding Rules

- Use Korean comments (Note: kept as per original request, but if "unify to English" implies comments too, this might need change. However, usually "instructions" refers to MD files).
- Frontend: `src/App.tsx` (single component), `src/tailwind.css` (Tailwind integration — merged App.css)
- Backend Abstraction: `backend.ts` (PiBackend / ClaudeBackend + translation logic)
- Server: `server.ts` (Node.js built-in http + ws without Express, uses `createBackend()`)
- Dev Integration: `turkPlugin` in `vite.config.ts` (uses same `createBackend()` — no duplication)
- WebSocket Protocol: Broadcasts backend events in pi format, forwards client commands to backend stdin.
- **No restart needed after code changes** — automatically reflected via HMR.
- `turkctl restart` is only required for `vite.config.ts` or `.env` changes.

## turkctl Commands

```
turkctl start     # Start dev server (npm run dev, background, HMR)
turkctl stop      # Stop server and pi process
turkctl restart   # Restart server
turkctl status    # Execution status + health check
turkctl logs      # Real-time logs (tail -f)
turkctl session    # Query current session info
turkctl ws        # WebSocket connection test
turkctl pi        # pi RPC process status
turkctl build     # Production build → dist/
```

> **Principle**: Always use `turkctl` for operation control. Do not use `npm run dev` or `pkill` directly.

## Troubleshooting

| Symptom | Cause | Solution |
|---|---|---|
| `🔴 Disconnected` | Server not running | `turkctl start` |
| `🟡 pi Starting` | Waiting for backend process | Wait a few seconds, or run `turkctl pi` |
| `[Parsing Failed]` | Model outputs non-JSON text | Auto-recovers via self-correction (max 2 attempts) |
| `EADDRINUSE` | Port conflict | `turkctl restart` |
| Build Failure | TypeScript error | `npx tsc -b --noEmit` |
| CSS not reflected | HMR cache corruption | `turkctl restart` |
| Claude backend no response | Ollama not running/model not pulled | `ollama serve` + `ollama pull glm-5.1:cloud` |
| Claude `Not logged in` | `ANTHROPIC_AUTH_TOKEN` missing | Set `ANTHROPIC_AUTH_TOKEN=ollama` in `.env` |
