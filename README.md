# Mapa de agentes (extensión de VS Code)

Barra lateral que muestra y organiza todas tus sesiones de Claude Code: monitor en vivo de cada sesión y subagente, contexto usado, errores, costo y traspasos.

## Instalar
1. Requisitos: VS Code 1.85+ y Claude Code (las sesiones se leen de `~/.claude/projects`).
2. En PowerShell, dentro de esta carpeta: `powershell -ExecutionPolicy Bypass -File .\instalar.ps1`
3. En VS Code: `Developer: Reload Window`. Aparece el icono **Agentes** en la barra de actividad.

## Primeros pasos
- **Monitor** lista todas las sesiones abiertas en las últimas 24 h.
- **Proyecto** (selector de arriba) → **+ Nuevo proyecto…** para crear los tuyos. Cada sesión también tiene su propio selector Proyecto y Carpeta.
- Las sesiones que usan una bóveda de Obsidian (servidor MCP `obsidian-*` o una carpeta con `.obsidian`) se agrupan solas como «Obsidian · nombre-de-la-bóveda». Para ponerles nombre propio: ajuste `agentMap.bovedas`, p. ej. `{ "petroff": "Petroff Amshen" }`.
- Las carpetas se crean desde Monitor → «Nueva carpeta de sesiones…».

Tus proyectos, carpetas y asignaciones se guardan en `~/.claude/state/` (nada sale de tu equipo).
