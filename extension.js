// Mapa de agentes: lee (solo lectura) las definiciones de agentes y los transcripts de
// todas las sesiones de Claude Code. Sin servidor, sin red.
const vscode = require('vscode')
const fs = require('fs')
const os = require('os')
const path = require('path')

const PROYECTOS = path.join(os.homedir(), '.claude', 'projects')
const ACTIVO_MS = 60000
const VENTANA_MS = 30 * 24 * 3600 * 1000
const MAX_SESIONES = 60
const MAX_EVENTOS = 200

const TAREAS = path.join(os.homedir(), '.claude', 'state', 'tareas_hoy.json')
const PRECIOS_FILE = path.join(__dirname, 'precios.json')
let precios = { modelos: {}, por_defecto: { in: 2, out: 10, cr: 0.2, cw: 2.5 } }
function cargarPrecios() {
  try {
    precios = JSON.parse(fs.readFileSync(PRECIOS_FILE, 'utf8'))
  } catch {
    // se queda con los precios por defecto
  }
}
function costoMsg(model, u) {
  if (!model || model.startsWith('<')) return 0
  const p = (precios.modelos && precios.modelos[model]) || precios.por_defecto
  return ((u.input_tokens || 0) * p.in + (u.output_tokens || 0) * p.out + (u.cache_read_input_tokens || 0) * p.cr + (u.cache_creation_input_tokens || 0) * p.cw) / 1e6
}

const SESIONES_PROY = path.join(os.homedir(), '.claude', 'state', 'sesion_proyecto.json')
// Sin proyectos de fábrica: cada persona crea los suyos desde el panel (selector «Proyecto» → «+ Nuevo proyecto»).
// Se guardan en ~/.claude/state/proyectos_lista.json como [{ nombre, palabras: [] }]. «palabras» es opcional.
const PROYECTOS_LISTA = path.join(os.homedir(), '.claude', 'state', 'proyectos_lista.json')
const PROYECTOS_DEF = []
function leerListaProyectos() {
  try {
    const l = JSON.parse(fs.readFileSync(PROYECTOS_LISTA, 'utf8'))
    return Array.isArray(l) ? l.map(x => (typeof x === 'string' ? { nombre: x, palabras: [] } : x)).filter(x => x && x.nombre) : []
  } catch {
    return []
  }
}
function agregarProyecto(nombre) {
  const l = leerListaProyectos()
  if (!l.some(x => x.nombre === nombre)) l.push({ nombre, palabras: [] })
  fs.mkdirSync(path.dirname(PROYECTOS_LISTA), { recursive: true })
  fs.writeFileSync(PROYECTOS_LISTA, JSON.stringify(l, null, 2), 'utf8')
}
// Las subcarpetas se guardan como «Padre/Hija». Renombrar, mover o borrar una carpeta arrastra las de adentro.
function rutaCarpeta(t) {
  return String(t || '').split('/').map(x => x.trim()).filter(Boolean).join('/').slice(0, 120)
}
const CARPETAS_SES = path.join(os.homedir(), '.claude', 'state', 'carpetas_sesiones.json')
// Carpetas de sesiones armadas a mano: { idSesion: 'Nombre de carpeta' }. No dependen de Obsidian.
const CARPETAS_LISTA = path.join(os.homedir(), '.claude', 'state', 'carpetas_lista.json')
// Carpetas creadas aunque aún no tengan chats: ["Nombre", ...]
function leerListaCarpetas() {
  try {
    const l = JSON.parse(fs.readFileSync(CARPETAS_LISTA, 'utf8'))
    return Array.isArray(l) ? l.map(String) : []
  } catch {
    return []
  }
}
function todasCarpetas(cm) {
  return [...new Set([...leerListaCarpetas(), ...Object.values(cm)])].sort((a, b) => a.localeCompare(b))
}
function leerCarpetas() {
  try {
    return JSON.parse(fs.readFileSync(CARPETAS_SES, 'utf8'))
  } catch {
    return {}
  }
}
function leerOverrides() {
  try {
    return JSON.parse(fs.readFileSync(SESIONES_PROY, 'utf8'))
  } catch {
    return {}
  }
}
function listaProyectos() {
  const c = vscode.workspace.getConfiguration('agentMap').get('proyectos')
  const todos = [...(Array.isArray(c) ? c : []), ...leerListaProyectos()]
  const vistos = new Set()
  return todos.filter(r => r && r.nombre && !vistos.has(r.nombre) && vistos.add(r.nombre))
}
// Bóveda detectada → proyecto. `agentMap.bovedas` permite nombrarla: { "petroff": "Mi proyecto" }.
const soloAlfa = t => String(t).toLowerCase().replace(/[^a-z0-9]/g, '')
function nombreProyectoBoveda(clave) {
  const m = vscode.workspace.getConfiguration('agentMap').get('bovedas') || {}
  const k = Object.keys(m).find(x => soloAlfa(x) === soloAlfa(clave))
  if (k) return m[k]
  const a = soloAlfa(clave)
  const existentes = [...listaProyectos().map(r => r.nombre), ...Object.values(leerOverrides())]
  const par = a.length >= 4 && existentes.find(p => { const b = soloAlfa(p); return b.length >= 4 && (b.includes(a) || a.includes(b)) })
  return par || 'Obsidian · ' + clave
}
// Bóveda que toca una llamada de herramienta: servidor MCP «obsidian-X», carpeta con «.obsidian», o ruta con una carpeta «obsidian…».
// Solo mira rutas (no cualquier texto con la palabra) y descarta la carpeta de la propia aplicación.
function bovedaDe(nm, ref) {
  const mcp = /^mcp__obsidian-([a-z0-9_-]+?)__/.exec(nm)
  if (mcp) return mcp[1]
  const r = String(ref).replace(/\\/g, '/')
  if (/appdata|programs\/obsidian|\.exe/.test(r)) return ''
  const ok = t => /^[a-z0-9_ -]{2,40}$/.test(t) && !t.includes(' -')
  const limpia = t => { const q = t.replace(/^obsidian[ _-]+/, '').trim(); return !q || q === 'vault' ? t : q }
  for (const p of r.match(/[a-z]:\/[^"'|;<>\r\n]*/g) || []) {
    const seg = p.split('/').map(x => x.trim())
    for (let i = 0; i < seg.length; i++) {
      const g = seg[i]
      if (g === '.obsidian' && i > 0 && ok(seg[i - 1])) return limpia(seg[i - 1])
      if (g === 'obsidian' && seg[i + 1] && ok(seg[i + 1])) return limpia(seg[i + 1])
      if (g !== 'obsidian' && g.startsWith('obsidian') && ok(g)) return limpia(g)
    }
  }
  return ''
}
function aplicarProyectos(sesiones) {
  const reglas = listaProyectos()
  const ov = leerOverrides()
  for (const s of sesiones) {
    if (ov[s.id]) {
      s.proyecto = ov[s.id]
      s.proyectoManual = true
      continue
    }
    s.porObsidian = false
    const bov = {}
    for (const x of [s.stats, ...s.subs.map(k => k.stats)]) for (const [k, n] of Object.entries((x && x.vaults) || {})) { const pn = nombreProyectoBoveda(k); bov[pn] = (bov[pn] || 0) + n }
    const orden = Object.entries(bov).sort((p, q) => q[1] - p[1])
    if (orden.length && orden[0][1] >= 2 && (orden.length === 1 || orden[0][1] >= 2 * orden[1][1])) {
      s.proyecto = orden[0][0]
      s.proyectoManual = false
      s.porObsidian = true
      continue
    }
    const texto = [s.titulo, s.primero, ...s.subs.map(k => k.desc + ' ' + k.tipo)].join(' ').toLowerCase()
    let mejor = 'Sin clasificar'
    let max = 0
    for (const r of reglas) {
      let n = 0
      for (const w of r.palabras || []) if (texto.includes(w.toLowerCase())) n += 1
      if (n > max) {
        max = n
        mejor = r.nombre
      }
    }
    s.proyecto = mejor
    s.proyectoManual = false
  }
}

// Tareas del Obsidian de Petroff: notas T## de 42_Plan_de_Tareas con tipo "tarea". Solo lectura.
const BOVEDA_PETROFF = path.join(os.homedir(), 'My Drive', 'Obsidian PetroffAmshen')
let cacheObs = { at: 0, lista: [] }
function leerTareasObsidian() {
  const ahora = Date.now()
  if (ahora - cacheObs.at < 30000) return cacheObs.lista
  const raiz = vscode.workspace.getConfiguration('agentMap').get('bovedaPetroff') || BOVEDA_PETROFF
  const dir = path.join(raiz, '42_Plan_de_Tareas')
  const lista = []
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!/^T\d+/.test(f) || !f.endsWith('.md')) continue
      const ruta = path.join(dir, f)
      let txt = ''
      let fd
      try {
        fd = fs.openSync(ruta, 'r')
        const b = Buffer.alloc(1500)
        txt = b.toString('utf8', 0, fs.readSync(fd, b, 0, 1500, 0))
      } finally {
        if (fd !== undefined) fs.closeSync(fd)
      }
      const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(txt)
      if (!m) continue
      const g = k => {
        const r = new RegExp('^' + k + ':\\s*"?(.*?)"?\\s*$', 'm').exec(m[1])
        return r ? r[1] : ''
      }
      if (g('tipo') !== 'tarea') continue
      const pr = g('prioridad')
      const est = g('estado')
      lista.push({ id: 'obs:' + g('codigo'), titulo: g('titulo'), proyecto: 'Petroff Amshen', prioridad: pr === 'P0' ? 'alta' : pr === 'P1' ? 'media' : 'baja', nivel: pr, responsable: g('dueno'), fuente: '', estado: est.slice(0, 80), area: g('proyecto'), que: ((/\*\*Qu[eé] es:\*\*\s*(.+)/.exec(txt) || [])[1] || '').replace(/[*`]/g, '').slice(0, 220), esfuerzo: g('esfuerzo'), hecho: /^hecho/i.test(est), ruta, soloLectura: true, codigo: g('codigo'), archivo: f.replace(/\.md$/, ''), bloquea: g('bloquea_a'), dependeDe: g('depende_de').match(/T\d+/g) || [], minutos: minutosDe(g('esfuerzo')) })
    }
    const porCodigo = new Map(lista.map(x => [x.codigo, x]))
    for (const x of lista) x.bloqueadaPor = x.dependeDe.filter(c => porCodigo.has(c) && !porCodigo.get(c).hecho)
  } catch {
    // bóveda no disponible: se muestran solo las tareas manuales
  }
  cacheObs = { at: ahora, lista }
  return lista
}
function tareasTodas() {
  const t = leerTareas()
  return { ...t, tareas: aplicarVinculos([...t.tareas, ...leerTareasObsidian()]) }
}

// Vínculos tarea → ventana de contexto (sesión) y carpeta. Archivo propio del panel:
// las notas de Obsidian no se tocan. sesion '-' = «sin ventana» (apaga la sugerencia automática).
const VINCULOS = path.join(os.homedir(), '.claude', 'state', 'tareas_vinculos.json')
function leerVinculos() {
  try {
    return JSON.parse(fs.readFileSync(VINCULOS, 'utf8')) || {}
  } catch {
    return {}
  }
}
function guardarVinculo(id, campo, valor) {
  const v = leerVinculos()
  const x = v[id] || {}
  if (valor) x[campo] = String(valor).slice(0, 80)
  else delete x[campo]
  if (Object.keys(x).length) v[id] = x
  else delete v[id]
  fs.mkdirSync(path.dirname(VINCULOS), { recursive: true })
  fs.writeFileSync(VINCULOS, JSON.stringify(v, null, 2), 'utf8')
}
const plano = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
const VACIAS = new Set('para como esta este estos estas sobre desde hasta entre donde cuando todas todos tarea tareas hacer revisar nueva nuevo sesion antes despues'.split(' '))
// Palabras que mandan una tarea a una carpeta (nombre de carpeta en minúsculas y sin tildes).
const PISTAS_CARPETA = {
  'ads y tracking': ['ads', ' meta', 'google', 'pixel', 'tracking', 'utm', ' cpc', 'quality score', 'campana', 'vxt', 'llamada', 'grabacion', 'hardnc', 'harddnc', 'conversion', 'capi', ' dns', 'dominio'],
  'hubspot y landings': ['hubspot', 'landing', 'formulario', 'pagina', 'sitio', 'theme', 'propiedad', 'oferta', 'pdf', 'carta', 'm1 v2', 'plantilla', ' form', ' lead', 'draft', 'produccion', 'publicar', 'lista', 'segmentacion', 'pipeline', 'etapa', 'no firmo', ' w1', ' w2', 'svg', 'hs cms', 'contenido', 'instancia', 'parche'],
  coordinacion: ['decidir', 'decision', 'firmar', 'discutir', 'aclarar', 'mandar', 'aprobacion', 'jira', 'kan-', 'cliente', 'revisa', 'dictado', 'agencia'],
  evals: ['eval', 'agente', 'errores', 'linea base', 'aprendizaje'],
  conexiones: ['conexion', 'mcp', 'composio', 'boveda', 'obsidian', 'token', 'clave', 'acceso', 'openrouter', 'repo', 'pa-systems', 'copia de seguridad'],
}
const palabras = s => plano(s).split(/[^a-z0-9]+/).filter(w => w.length >= 4 && !VACIAS.has(w))
function aplicarVinculos(tareas) {
  const v = leerVinculos()
  const ses = estado.sesiones || []
  const porId = new Map(ses.map(s => [s.id, s]))
  const carpetas = [...new Set(ses.map(s => s.depto).filter(Boolean).concat(estado.carpetas || []))]
  const perfiles = perfilesVentanas(ses)
  return tareas.map(t0 => {
    const t = { ...t0, sesion: '', carpeta: '', vinculo: '', vinculoAuto: false, carpetaAuto: false }
    const m = v[t.id] || {}
    if (m.sesion && m.sesion !== '-' && porId.has(m.sesion)) {
      t.sesion = m.sesion
      t.vinculo = 'manual'
    } else if (!m.sesion && !t.hecho) {
      // Identificación: códigos de la tarea mencionados en la ventana (o sus subagentes) y palabras
      // del título / «Qué es» / área en el título, primeros mensajes y encargos de la ventana.
      const cod = String(t.codigo || (/\b(KAN-\d+|T\d{2,})\b/i.exec(t.titulo + ' ' + (t.fuente || '')) || [])[1] || '').toUpperCase()
      const pt = new Set(palabras(t.titulo + ' ' + (t.que || '') + ' ' + (t.area || '') + ' ' + (t.fuente || '')))
      const cpal = carpetaPorPalabras(t, carpetas)
      let mejor = null
      for (const s of ses) {
        if (t.proyecto && s.proyecto && t.proyecto !== s.proyecto && ['Petroff Amshen', 'MasterStock USA'].includes(t.proyecto)) continue
        const pf = perfiles.get(s.id)
        let pts = 0
        const nc = cod ? pf.cods.get(cod) || 0 : 0
        if (nc) pts += Math.min(6, 2 + nc) * (pf.distintos > 25 ? 0.15 : pf.distintos > 12 ? 0.35 : 1)
        // Palabras raras valen más (idf) y las ventanas con vocabulario enorme (coordinadoras) valen menos.
        let pw = 0
        for (const w of pt) if (pf.pal.has(w)) pw += pf.pal.get(w) * Math.log((perfiles.size + 1) / (perfiles.df.get(w) || 1))
        pts += Math.min(8, pw / Math.max(1, Math.sqrt(pf.pal.size / 250)))
        if (cpal && s.depto === cpal) pts += 1.5
        if (pts >= 5 && (!mejor || pts > mejor[1] || (pts === mejor[1] && s.mtime > mejor[0].mtime))) mejor = [s, pts]
      }
      if (mejor) {
        t.sesion = mejor[0].id
        t.vinculo = mejor[1] >= 8 ? 'identificada' : 'probable'
        t.vinculoPts = Math.round(mejor[1] * 10) / 10
        t.vinculoAuto = true
      }
    }
    if (m.carpeta) t.carpeta = m.carpeta
    else if (t.sesion && porId.get(t.sesion).depto) {
      t.carpeta = porId.get(t.sesion).depto
      t.carpetaAuto = true
    } else {
      t.carpeta = carpetaPorPalabras(t, carpetas)
      t.carpetaAuto = !!t.carpeta
    }
    // Sin ventana identificada: la ventana más reciente de su carpeta, para poder abrirla y hacerla ahí.
    if (!t.sesion && !t.hecho && m.sesion !== '-' && t.carpeta) {
      const deC = ses.filter(s => s.depto === t.carpeta && (!t.proyecto || !['Petroff Amshen', 'MasterStock USA'].includes(t.proyecto) || s.proyecto === t.proyecto))
      if (deC.length) {
        t.sesion = deC.reduce((x, y) => (y.mtime > x.mtime ? y : x)).id
        t.vinculo = 'carpeta'
        t.vinculoAuto = true
      }
    }
    return t
  })
}

// Botón «Realizar»: abre la ventana de la tarea con un prompt listo (copiado también al portapapeles; no se envía solo).
function promptTarea(t) {
  const pet = t.proyecto === 'Petroff Amshen'
  return [
    'Vamos a realizar esta tarea' + (t.codigo ? ' del plan (' + t.codigo + ')' : '') + ': «' + t.titulo + '».',
    [t.nivel || t.prioridad ? 'Prioridad ' + (t.nivel || t.prioridad) : '', t.responsable ? 'responsable ' + t.responsable : '', t.esfuerzo ? 'esfuerzo ' + t.esfuerzo : '', t.bloqueadaPor && t.bloqueadaPor.length ? 'espera ' + t.bloqueadaPor.join(', ') : ''].filter(Boolean).join(' · ') + '.',
    t.que ? 'Qué es: ' + t.que : '',
    t.ruta ? 'Nota de la tarea: ' + t.ruta : t.fuente ? 'Fuente: ' + t.fuente : '',
    'Primero ' + (t.ruta ? 'lee la nota y ' : '') + 'dime en 3 líneas cómo la harías. Espera mi aprobación antes de cambiar nada' + (pet ? ' en HubSpot, en las cuentas de anuncios o en la bóveda (aprueba José; lo legal, Marianne)' : '') + '.',
    'Al terminar, di qué quedó hecho y qué falta, y cierra con «Qué sigue» y «Asignar a / Carpeta o proyecto».',
  ].filter(Boolean).join('\n')
}
function realizarTarea(id) {
  const t = tareasTodas().tareas.find(x => x.id === id)
  if (!t) return
  const prompt = promptTarea(t)
  if (t.sesion) return abrirConPrompt(t.sesion, prompt, 'de tarea')
  vscode.env.clipboard.writeText(prompt)
  if (t.carpeta) nuevaSesionEnCarpeta(t.carpeta, ['Petroff Amshen', 'MasterStock USA'].includes(t.proyecto) ? t.proyecto : '')
  else vscode.commands.executeCommand('claude-vscode.editor.open')
  vscode.window.showInformationMessage('Abrí una sesión nueva. El prompt de la tarea está en el portapapeles: pégalo (Ctrl+V).')
}

// Carpeta por palabras: las del nombre de la carpeta valen 2, las de PISTAS_CARPETA 1.
function carpetaPorPalabras(t, carpetas) {
  const txt = ' ' + plano(t.titulo + ' ' + (t.que || '') + ' ' + (t.area || '') + ' ' + (t.fuente || '')) + ' '
  let mejor = null
  for (const c of carpetas) {
    let pts = palabras(c).filter(w => txt.includes(w)).length * 2
    for (const w of PISTAS_CARPETA[plano(c)] || []) if (txt.includes(w)) pts += 1
    if (pts && (!mejor || pts > mejor[1])) mejor = [c, pts]
  }
  return mejor ? mejor[0] : ''
}

// Perfil de cada ventana: palabras (título ×3, encargos de subagentes ×1, mensajes del usuario ×1) y códigos mencionados.
function perfilesVentanas(ses) {
  const out = new Map()
  for (const s of ses) {
    const pal = new Map()
    const sumar = (txt, peso) => {
      for (const w of new Set(palabras(txt))) pal.set(w, Math.max(pal.get(w) || 0, peso))
    }
    const cods = new Map()
    const base = path.join(PROYECTOS, s.carpeta || '', s.id)
    const files = [base + '.jsonl'].concat((s.subs || []).map(k => path.join(base, 'subagents', 'agent-' + k.id + '.jsonl')))
    let temas = ''
    for (const f of files) {
      const a = archivos.get(f)
      if (!a) continue
      temas += ' ' + (a.temas || '')
      if (a.cods) for (const [c, n] of a.cods) cods.set(c, (cods.get(c) || 0) + n)
    }
    sumar(temas, 1)
    sumar((s.subs || []).map(k => k.desc).join(' '), 1)
    sumar((s.titulo || '') + ' ' + (s.depto || ''), 3)
    out.set(s.id, { pal, cods, distintos: cods.size })
  }
  out.df = new Map()
  for (const pf of out.values()) for (const w of pf.pal.keys()) out.df.set(w, (out.df.get(w) || 0) + 1)
  return out
}

let filtroActual = 'todos'
const avisados = new Map()
let primerEscaneo = true
function avisar(top, ahora) {
  if (presupuesto <= 0) return // aún poniéndose al día con las sesiones grandes
  const hacerlo = vscode.workspace.getConfiguration('agentMap').get('avisos') !== false
  for (const s of top) {
    if (filtroActual !== 'todos' && s.proyecto !== filtroActual) continue
    const nombreS = (s.titulo || s.primero || s.id.slice(0, 8)).slice(0, 50)
    const lim = limiteCtx()
    const cx = (s.stats && s.stats.ctx) || 0
    for (const [nivel, umbral] of [['ctx75', lim * 0.75], ['ctx100', lim]]) {
      const kc = nivel + ':' + s.id
      if (cx >= umbral && !avisados.has(kc)) {
        avisados.set(kc, ahora)
        if (!primerEscaneo && hacerlo) {
          vscode.window.showWarningMessage('«' + nombreS + '»: contexto en ' + tk(cx) + ' de ' + tk(lim) + (nivel === 'ctx100' ? '. Termina la tarea, deja el estado en Obsidian y abre una sesión nueva.' : '.'))
        }
      }
    }
    for (const k of s.subs) {
      if (!k.colgado) continue
      const clave = 'colg:' + k.id
      if (avisados.has(clave)) continue
      avisados.set(clave, ahora)
      if (!primerEscaneo && hacerlo) {
        vscode.window.showWarningMessage('Agente atascado: ' + k.tipo + ' · ' + k.desc.slice(0, 70) + ' · ' + k.estadoTxt + ' (sin actividad hace ' + Math.round((ahora - k.mtime) / 60000) + ' min; última acción: ' + ((k.stats.fin && k.stats.fin.tool) || '?').replace(/^mcp__/, '') + ')')
      }
    }
    const claveE = 'err:' + s.id
    const prev = avisados.get(claveE) || { n: 0, at: 0 }
    const n = s.total ? s.total.sinconf : 0
    if (n > prev.n && ahora - prev.at > 600000) {
      avisados.set(claveE, { n, at: ahora })
      if (!primerEscaneo && hacerlo) vscode.window.showWarningMessage('«' + nombreS + '»: ' + n + ' errores sin confirmar como resueltos')
    } else if (!avisados.has(claveE) || n < prev.n) {
      avisados.set(claveE, { n, at: prev.at })
    }
  }
  primerEscaneo = false
}

// ---- 4: historial por día ----
const HISTORIAL = path.join(os.homedir(), '.claude', 'state', 'historial_agentes.json')
let historial = {}
let historialSucio = false
let historialGuardado = 0
function cargarHistorial() {
  try {
    historial = JSON.parse(fs.readFileSync(HISTORIAL, 'utf8'))
  } catch {
    historial = {}
  }
}
const dia = t => {
  const d = new Date(t)
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}
function actualizarHistorial(top, ahora) {
  for (const s of top) {
    {
      const d0 = dia(s.mtime)
      const reg0 = { ses: 1, tipo: 'sesión', proy: s.proyecto, desc: (s.titulo || s.primero || '').slice(0, 80), e: s.stats.errores, sc: s.stats.sinconf, h: s.stats.tools, t: s.stats.tin + s.stats.tout, c: 0, ok: 0, pt: ptCompacto(s.stats.porTool) }
      const dd0 = (historial[d0] = historial[d0] || {})
      if (JSON.stringify(dd0['s:' + s.id]) !== JSON.stringify(reg0)) {
        dd0['s:' + s.id] = reg0
        historialSucio = true
      }
    }
    for (const k of s.subs) {
      const d = dia(k.inicio || k.mtime)
      const reg = { tipo: k.tipo, proy: s.proyecto, desc: k.desc.slice(0, 80), e: k.stats.errores, sc: k.stats.sinconf, h: k.stats.tools, t: k.stats.tin + k.stats.tout, c: k.colgado ? 1 : 0, ok: k.cierre ? 1 : 0, pt: ptCompacto(k.stats.porTool) }
      const dd = (historial[d] = historial[d] || {})
      if (JSON.stringify(dd[k.id]) !== JSON.stringify(reg)) {
        dd[k.id] = reg
        historialSucio = true
      }
    }
  }
  const dias = Object.keys(historial).sort()
  while (dias.length > 30) {
    delete historial[dias.shift()]
    historialSucio = true
  }
  if (historialSucio && ahora - historialGuardado > 30000) {
    try {
      fs.mkdirSync(path.dirname(HISTORIAL), { recursive: true })
      fs.writeFileSync(HISTORIAL, JSON.stringify(historial), 'utf8')
      historialSucio = false
      historialGuardado = ahora
    } catch {
      // se reintenta en la siguiente vuelta
    }
  }
  estado.historial = Object.keys(historial)
    .sort()
    .reverse()
    .slice(0, 14)
    .map(d => ({ dia: d, items: Object.values(historial[d]) }))
}

function hitosHoy(filtro) {
  const hoy = dia(Date.now())
  const hitos = new Map()
  const sesionesHoy = []
  for (const s of estado.sesiones) {
    if (filtro !== 'todos' && s.proyecto !== filtro) continue
    let aporta = false
    for (const k of s.subs) {
      if (!k.cierre || /fail|kill|error/i.test(k.cierre)) continue
      if (dia(k.inicio || k.mtime) !== hoy) continue
      const l = hitos.get(s.proyecto) || []
      l.push(k.desc.replace(/\s+/g, ' ').slice(0, 110))
      hitos.set(s.proyecto, l)
      aporta = true
    }
    if (aporta && (s.titulo || s.primero)) sesionesHoy.push((s.titulo || s.primero).slice(0, 80))
  }
  return { hitos, sesionesHoy }
}

function agruparTools(sesiones) {
  const m = new Map()
  for (const s of sesiones) {
    for (const st of [s.stats, ...s.subs.map(k => k.stats)]) {
      for (const [t, v] of Object.entries(st.porTool || {})) {
        const u = m.get(t) || { tool: t, e: 0, sc: 0, rec: 0, msg: '', pista: '' }
        u.e += v.e
        u.sc += v.sc
        u.rec += v.rec
        if (!u.msg && v.msg) {
          u.msg = v.msg
          u.pista = v.pista || ''
        }
        m.set(t, u)
      }
    }
  }
  return [...m.values()].filter(u => u.e > 0).sort((a, b) => b.sc - a.sc || b.e - a.e)
}

const nombreHerr = t => String(t).replace(/^mcp__/, '').replace(/__/g, ' · ')

function docErrores(filtro) {
  const hoy = dia(Date.now())
  const ses = estado.sesiones.filter(s => filtro === 'todos' || s.proyecto === filtro)
  const L = agruparTools(ses)
  const out = ['# Errores por herramienta · ' + hoy + (filtro === 'todos' ? '' : ' · ' + filtro), '', 'Generado por el panel Mapa de agentes con las sesiones de las últimas 24 h. «Sin confirmar» no significa sin arreglar: el agente pudo rodear el error.', '']
  out.push('| Herramienta | Errores | Recuperados | Sin confirmar | Pista | Ejemplo |', '|---|---|---|---|---|---|')
  for (const u of L) out.push('| ' + nombreHerr(u.tool) + ' | ' + u.e + ' | ' + u.rec + ' | ' + u.sc + ' | ' + u.pista + ' | ' + u.msg.replace(/\|/g, '/').slice(0, 110) + ' |')
  if (!L.length) out.push('| (sin errores) | | | | | |')
  const dias = new Map()
  for (const d of Object.keys(historial).sort().reverse().slice(0, 14)) {
    for (const r of Object.values(historial[d])) {
      if (filtro !== 'todos' && r.proy !== filtro) continue
      for (const [t, v] of Object.entries(r.pt || {})) {
        const u = dias.get(t) || { e: 0, sc: 0, d: new Set() }
        u.e += v[0]
        u.sc += v[1]
        u.d.add(d)
        dias.set(t, u)
      }
    }
  }
  out.push('', '## Tendencia (últimos 14 días)', '')
  if (dias.size) {
    out.push('| Herramienta | Errores | Sin confirmar | Días con fallas |', '|---|---|---|---|')
    for (const [t, u] of [...dias].sort((a, b) => b[1].sc - a[1].sc || b[1].e - a[1].e).slice(0, 15)) out.push('| ' + nombreHerr(t) + ' | ' + u.e + ' | ' + u.sc + ' | ' + u.d.size + ' |')
  } else out.push('- El historial por herramienta empieza a llenarse desde hoy.')
  out.push('', '## Qué mejorar primero', '')
  const top = L.filter(u => u.sc > 0).slice(0, 5)
  if (top.length) for (const u of top) out.push('- **' + nombreHerr(u.tool) + '** (' + u.sc + ' sin confirmar): ' + u.pista + '.')
  else out.push('- Nada urgente: los errores se recuperaron.')
  return out.join('\n')
}

function generarTraspaso(filtro) {
  const hoy = dia(Date.now())
  const lim = limiteCtx()
  const t = tareasTodas()
  const base = filtro === 'todos' ? t.tareas : t.tareas.filter(x => x.proyecto === filtro)
  const ref = x => (x.archivo ? '[[' + x.archivo + ']]' : x.titulo)
  const orden = { alta: 0, media: 1, baja: 2 }
  const rk = x => (x.prioridad in orden ? orden[x.prioridad] : 1)
  const bloq = x => !!(x.bloqueadaPor && x.bloqueadaPor.length)
  const abiertas = base.filter(x => !x.hecho)
  const libres = abiertas.filter(x => !bloq(x)).sort((a, b) => rk(a) - rk(b))
  const { hitos } = hitosHoy(filtro)
  const ses = estado.sesiones.filter(s => filtro === 'todos' || s.proyecto === filtro)
  const L = ['---', 'tipo: "traspaso"', 'carpeta: "55_Reporte_Diario"', 'creado: "' + hoy + '"', 'fuente: "Panel Mapa de agentes (VS Code)"', 'estado: "borrador"', 'tags: [traspaso, reporte-diario, petroff-amshen]', '---', '# Traspaso · ' + hoy + (filtro === 'todos' ? '' : ' · ' + filtro), '']
  L.push('> [!abstract] Para abrir la próxima sesión', '> Lee esta nota primero. Siguiente paso: ' + (libres[0] ? ref(libres[0]) : 'definir una tarea nueva') + '.', '')
  L.push('## Hecho', '')
  const hechas = base.filter(x => x.hecho)
  for (const x of hechas) L.push('- ' + ref(x))
  const todosHitos = [...hitos].flatMap(([proy, l]) => [...new Set(l)].map(x => x + ' (' + proy + ')'))
  for (const x of todosHitos.slice(0, 12)) L.push('- ' + x)
  if (todosHitos.length > 12) L.push('- … y ' + (todosHitos.length - 12) + ' hitos más de agentes')
  if (!hechas.length && !todosHitos.length) L.push('- (nada registrado todavía)')
  L.push('', '## Siguiente paso', '')
  if (libres.length) for (const x of libres.slice(0, 3)) L.push('- ' + ref(x) + (x.esfuerzo ? ' · ' + x.esfuerzo : '') + (x.bloquea && x.bloquea !== 'Nada' ? ' · desbloquea ' + x.bloquea : ''))
  else L.push('- (sin tareas libres)')
  L.push('', '## Pendiente por prioridad', '')
  for (const [k, nom] of [['alta', 'Urgente'], ['media', 'Importante']]) {
    const it = abiertas.filter(x => (x.prioridad in orden ? x.prioridad : 'media') === k)
    if (!it.length) continue
    L.push('**' + nom + '**')
    for (const x of it) L.push('- ' + ref(x) + (bloq(x) ? ' · 🔒 espera ' + x.bloqueadaPor.join(', ') : ''))
    L.push('')
  }
  L.push('## Sesiones', '')
  for (const s of ses.slice(0, 8)) {
    const cx = (s.stats && s.stats.ctx) || 0
    const nom = (s.titulo || s.primero || s.id.slice(0, 8)).slice(0, 80)
    L.push('- **' + nom + '**' + (cx ? ' · contexto ' + tk(cx) + ' de ' + tk(lim) : '') + (s.stats && s.stats.texto ? ' · dónde quedó: ' + s.stats.texto.slice(0, 220) : ''))
  }
  if (!ses.length) L.push('- (sin sesiones en las últimas 24 h)')
  const errs = agruparTools(ses).filter(u => u.sc > 0).slice(0, 5)
  L.push('', '## Errores sin confirmar', '')
  if (errs.length) for (const u of errs) L.push('- ' + nombreHerr(u.tool) + ': ' + u.sc + ' · ' + u.pista)
  else L.push('- Ninguno.')
  L.push('', '## Por confirmar con José', '', '- (completar a mano lo que se habló y no quedó en un archivo)', '')
  return L.join('\n')
}

function guardarLocal(md, nombre) {
  const dir = path.join(os.homedir(), '.claude', 'state', 'reportes')
  fs.mkdirSync(dir, { recursive: true })
  const f = path.join(dir, nombre)
  fs.writeFileSync(f, md, 'utf8')
  return f
}

function abrirArchivo(f) {
  vscode.workspace.openTextDocument(f).then(doc => vscode.window.showTextDocument(doc, { preview: true }))
}

function guardarTraspasoVault(md) {
  const raiz = vscode.workspace.getConfiguration('agentMap').get('bovedaPetroff') || BOVEDA_PETROFF
  const dir = path.join(raiz, '55_Reporte_Diario')
  if (!fs.existsSync(dir)) throw new Error('no encuentro la carpeta 55_Reporte_Diario')
  const hoy = dia(Date.now())
  let nombre = 'TR-' + hoy
  for (let i = 2; fs.existsSync(path.join(dir, nombre + '.md')); i += 1) nombre = 'TR-' + hoy + '-' + i
  const f = path.join(dir, nombre + '.md')
  fs.writeFileSync(f, md, { encoding: 'utf8', flag: 'wx' })
  const idx = path.join(dir, '00_INDEX_55_Reporte_Diario.md')
  if (fs.existsSync(idx)) {
    const cur = fs.readFileSync(idx, 'utf8')
    const enc = /^## Traspasos\s*$/m.test(cur) ? '' : '\n\n## Traspasos\n'
    fs.appendFileSync(idx, enc + '\n- [[' + nombre + ']] · traspaso del panel de agentes', 'utf8')
  }
  return f
}

function traspaso(filtro) {
  const md = generarTraspaso(filtro)
  const enVault = filtro === 'todos' || filtro === 'Petroff Amshen'
  vscode.workspace.openTextDocument({ content: md, language: 'markdown' }).then(doc => vscode.window.showTextDocument(doc, { preview: true }))
  vscode.env.clipboard.writeText(md)
  const op = enVault ? 'Guardar en el Obsidian de Petroff' : 'Guardar en carpeta local'
  vscode.window.showInformationMessage('Nota de traspaso lista (borrador abierto y copiado). ¿La guardo?', op, 'Solo copiar').then(r => {
    if (r !== op) return
    try {
      const f = enVault ? guardarTraspasoVault(md) : guardarLocal(md, 'traspaso_' + dia(Date.now()) + '.md')
      vscode.window.showInformationMessage('Traspaso guardado: ' + f)
    } catch (err) {
      vscode.window.showErrorMessage('No pude guardar el traspaso: ' + err.message)
    }
  })
}

function promptCorregir(sid) {
  const s = estado.sesiones.find(x => x.id === sid)
  if (!s) return ''
  const tools = agruparTools([s]).filter(u => u.sc > 0)
  const agentes = [...new Set((s.sinResolver || []).map(x => x.tipo).filter(Boolean))]
  const L = ['Hay errores sin confirmar como resueltos en esta sesión. Corrígelos y deja constancia.', '']
  for (const u of tools.slice(0, 8)) L.push('- ' + nombreHerr(u.tool) + ' (' + u.sc + ' sin confirmar): ' + u.msg + ' → pista: ' + u.pista)
  L.push('', 'Haz esto, en orden:')
  L.push('1. Para cada error comprueba si sigue ocurriendo y corrige la causa (no lo rodees).')
  L.push('2. Documenta qué falló y cómo se arregló en una nota corta (si es de Petroff, en 31_Guia_Claude de la bóveda de Petroff; si no, en ~/.claude/state/reportes).')
  L.push(agentes.length ? '3. Mejora la definición de estos agentes en ~/.claude/agents/ para que no repitan el error: ' + agentes.join(', ') + '.' : '3. Si el error viene de una regla, un hook o un permiso, ajústalo.')
  L.push('4. No hagas cambios destructivos sin preguntarme. Cierra con «Qué sigue» y «Asignar a / Carpeta o proyecto».')
  return L.join('\n')
}

// «Eliminar sesión»: no borra, mueve el .jsonl (y su carpeta de subagentes) a ~/.claude/state/papelera_sesiones/
// para poder restaurarlo. No toca sesiones con actividad en los últimos 2 minutos.
const PAPELERA = path.join(os.homedir(), '.claude', 'state', 'papelera_sesiones')
function eliminarSesion(sid) {
  const s = estado.sesiones.find(x => x.id === sid)
  if (!s || !s.carpeta) { vscode.window.showWarningMessage('No encontré esa sesión en disco.'); return false }
  const dir = path.join(PROYECTOS, s.carpeta), f = path.join(dir, sid + '.jsonl')
  let mt = 0
  try { mt = fs.statSync(f).mtimeMs } catch { vscode.window.showWarningMessage('No encontré el archivo de esa sesión.'); return false }
  if (Date.now() - mt < 120000) { vscode.window.showWarningMessage('Esa sesión tuvo actividad hace menos de 2 minutos: ciérrala o espera antes de eliminarla.'); return false }
  const dest = path.join(PAPELERA, s.carpeta)
  try {
    fs.mkdirSync(dest, { recursive: true })
    fs.renameSync(f, path.join(dest, sid + '.jsonl'))
    if (fs.existsSync(path.join(dir, sid))) fs.renameSync(path.join(dir, sid), path.join(dest, sid))
    fs.appendFileSync(path.join(PAPELERA, 'registro.log'), new Date().toISOString().slice(0, 19) + ' ' + sid + ' | ' + (s.titulo || '') + ' | de ' + dir + '\n')
  } catch (e) {
    vscode.window.showWarningMessage('No pude mover la sesión a la papelera: ' + e.message)
    return false
  }
  estado.sesiones = estado.sesiones.filter(x => x.id !== sid)
  vscode.window.showInformationMessage('Sesión «' + (s.titulo || sid.slice(0, 8)) + '» enviada a la papelera (se puede restaurar desde ~/.claude/state/papelera_sesiones).')
  return true
}

// «Nueva sesión en esta carpeta»: abre una sesión nueva y, cuando su .jsonl aparece (al enviar el primer
// mensaje), la asigna a la carpeta y al proyecto elegidos. La espera dura 30 min.
let sesionPendiente = null // { carpeta, proyecto, ts, conocidas:Set }
function idsEnDisco() {
  const ids = new Set()
  try {
    for (const d of fs.readdirSync(PROYECTOS)) {
      try { for (const f of fs.readdirSync(path.join(PROYECTOS, d))) if (f.endsWith('.jsonl')) ids.add(f.slice(0, -6)) } catch {}
    }
  } catch {}
  return ids
}
function nuevaSesionEnCarpeta(carpeta, proyecto) {
  const enCarpeta = estado.sesiones.filter(x => x.depto === carpeta && x.proyecto && x.proyecto !== 'Sin clasificar')
  const votos = {}
  for (const x of enCarpeta) votos[x.proyecto] = (votos[x.proyecto] || 0) + 1
  const proy = proyecto || Object.keys(votos).sort((a, b) => votos[b] - votos[a])[0] || ''
  sesionPendiente = { carpeta, proyecto: proy, ts: Date.now(), conocidas: idsEnDisco() }
  Promise.resolve(vscode.commands.executeCommand('claude-vscode.editor.open')).then(
    () => vscode.window.showInformationMessage('Sesión nueva abierta. Cuando envíes el primer mensaje quedará en «' + carpeta + '»' + (proy ? ' (' + proy + ')' : '') + '.'),
    () => vscode.window.showWarningMessage('No pude abrir una sesión nueva de Claude Code.'),
  )
}
function asignarSesionPendiente(top, cm) {
  const p = sesionPendiente
  if (!p) return
  if (Date.now() - p.ts > 30 * 60000) { sesionPendiente = null; return }
  const nueva = top.find(s => !p.conocidas.has(s.id) && !cm[s.id])
  if (!nueva) return
  cm[nueva.id] = p.carpeta
  try { fs.writeFileSync(CARPETAS_SES, JSON.stringify(cm, null, 2), 'utf8') } catch {}
  if (p.proyecto) {
    try {
      const f = path.join(os.homedir(), '.claude', 'state', 'sesion_proyecto.json')
      const ov = (() => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return {} } })()
      ov[nueva.id] = p.proyecto
      fs.writeFileSync(f, JSON.stringify(ov, null, 2), 'utf8')
      nueva.proyecto = p.proyecto
    } catch {}
  }
  sesionPendiente = null
}

// Abre una sesión con un prompt. Claude Code descarta el prompt si la sesión ya tiene pestaña abierta
// («Session is already open»). Por eso: se abre sin prompt (la trae al frente y queda como pestaña activa),
// se cierra esa pestaña y se vuelve a abrir con el prompt. La conversación sigue en disco.
const ABRIR_LOG = path.join(os.homedir(), '.claude', 'state', 'abrir_con_prompt.log')
const esperar = ms => new Promise(r => setTimeout(r, ms))
const tabClaude = t => !!(t && t.input && /claude/i.test(t.input.viewType || ''))
async function abrirConPrompt(sid, prompt, que) {
  vscode.env.clipboard.writeText(prompt)
  const s = estado.sesiones.find(x => x.id === sid)
  const trabajando = s && Date.now() - s.mtime < 30000
  const log = m => { try { fs.appendFileSync(ABRIR_LOG, new Date().toISOString().slice(0, 19) + ' ' + sid.slice(0, 8) + ' ' + m + '\n') } catch {} }
  const abiertaAntes = vscode.window.tabGroups.all.some(g => g.tabs.some(tabClaude))
  let cerrada = false
  try {
    if (abiertaAntes && !trabajando) {
      const antes = vscode.window.tabGroups.activeTabGroup.activeTab
      await vscode.commands.executeCommand('claude-vscode.editor.open', sid)
      await esperar(350)
      const t = vscode.window.tabGroups.activeTabGroup.activeTab
      log('activa tras abrir: ' + (t ? t.label + ' | ' + ((t.input && t.input.viewType) || '-') : 'ninguna'))
      const norm = x => String(x || '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().toLowerCase()
      const mismoTitulo = s && norm(s.titulo) && norm(t && t.label).startsWith(norm(s.titulo).slice(0, 20))
      if (tabClaude(t) && (t !== antes || mismoTitulo)) { cerrada = await vscode.window.tabGroups.close(t); await esperar(500) }
    }
    await vscode.commands.executeCommand('claude-vscode.editor.open', sid, prompt)
  } catch (e) {
    log('error ' + e)
    vscode.window.showWarningMessage('No pude abrir la sesión: el prompt ' + que + ' quedó copiado, pégalo con Ctrl+V.')
    return
  }
  log('trabajando=' + !!trabajando + ' abiertaAntes=' + abiertaAntes + ' cerrada=' + cerrada)
  if (trabajando) vscode.window.showWarningMessage('La sesión está trabajando, no la interrumpí: el prompt ' + que + ' quedó copiado, pégalo con Ctrl+V cuando termine.')
  else vscode.window.showInformationMessage('Abrí la sesión con el prompt ' + que + ': revísalo y envíalo. (Si no aparece escrito, pégalo con Ctrl+V; está copiado.)')
}

function corregirErrores(sid) {
  const prompt = promptCorregir(sid)
  if (!prompt) return
  abrirConPrompt(sid, prompt, 'de corrección')
}

function promptTraspaso(sid) {
  const s = estado.sesiones.find(x => x.id === sid)
  if (!s) return ''
  const pet = s.proyecto === 'Petroff Amshen'
  const dest = pet
    ? 'una nota nueva en la carpeta 31_Guia_Claude de la bóveda de Petroff (' + (vscode.workspace.getConfiguration('agentMap').get('bovedaPetroff') || BOVEDA_PETROFF) + '), con frontmatter y enlace desde su índice'
    : 'un archivo en ' + path.join(os.homedir(), '.claude', 'state', 'traspasos') + ' (créalo si no existe)'
  return [
    'Esta sesión está llegando al límite de contexto. Antes de cerrarla, deja todo documentado para continuar en una sesión nueva.',
    '',
    'Haz esto, en orden, y no empieces trabajo nuevo:',
    '1. Escribe ' + dest + ' con: qué se hizo, qué falta con responsable, decisiones tomadas, rutas completas de archivos y notas, ids de HubSpot y de otros sistemas, y errores abiertos.',
    '2. Verifica que la nota quedó escrita (léela de vuelta, sin pegarla entera).',
    '3. Responde solo con: la ruta completa de la nota y un prompt de 3 líneas para abrir la sesión nueva (que lea esa nota y siga desde «Qué sigue»).',
    '4. Termina con «Ya puedes cerrar esta sesión», «Qué sigue» y «Asignar a / Carpeta o proyecto».',
  ].join('\n')
}
function traspasoSesion(sid) {
  const prompt = promptTraspaso(sid)
  if (!prompt) return
  abrirConPrompt(sid, prompt, 'de traspaso')
}

// Pool de ideas compartido (scripts/ideas.py): lo que una sesión descubre, otras del mismo proyecto lo consultan
const POOL_IDEAS = path.join(os.homedir(), '.claude', 'state', 'pool_ideas.jsonl')
function leerIdeas() {
  try {
    return fs.readFileSync(POOL_IDEAS, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } })
      .filter(Boolean).map(i => ({ id: i.id, fecha: i.fecha, sesion: i.sesion, proyecto: i.proyecto, carpeta: i.carpeta || '', titulo: i.titulo, detalle: i.detalle || '', para: i.para || [], tags: i.tags || [], evidencia: i.evidencia || '', usos: (i.usos || []).length }))
  } catch { return [] }
}
const BUZON = path.join(os.homedir(), '.claude', 'state', 'buzon_sesiones.jsonl')
function leerBuzon() {
  try {
    return fs.readFileSync(BUZON, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
      .map(m => ({ id: m.id, fecha: m.fecha, de: m.de_titulo || '', deCarpeta: m.de_carpeta || '', proyecto: m.proyecto, para: m.para, texto: m.texto, respuestas: (m.respuestas || []).map(r => ({ de: r.de_titulo || '', fecha: r.fecha, texto: r.texto })) }))
  } catch { return [] }
}
function promptIdeas(sid) {
  const s = estado.sesiones.find(x => x.id === sid)
  if (!s) return ''
  const py = path.join(os.homedir(), '.claude', 'scripts', 'ideas.py').replace(/\\/g, '/')
  const carpetas = (estado.carpetas || []).filter(c => c !== s.depto).join(', ')
  return [
    'Aporta tus descubrimientos al pool de ideas compartido, para que otras sesiones de ' + (s.proyecto || 'este proyecto') + ' los aprovechen.',
    '',
    '1. Revisa lo que hiciste en esta sesión y elige de 1 a 5 descubrimientos reutilizables: causa de un error y su arreglo, cómo funciona una API o herramienta, un dato verificado, una decisión de José. Nada que esté a medias o sin comprobar.',
    '2. Antes de cada uno, busca si ya existe: python "' + py + '" buscar "tema" --sesion ' + sid.slice(0, 8),
    '3. Guarda los nuevos: python "' + py + '" agregar --sesion ' + sid.slice(0, 8) + ' --titulo "una línea" --detalle "qué, por qué y cómo usarlo (máx. 600 caracteres)" --para "carpetas a las que les sirve" --evidencia "ruta o nota"',
    '   Carpetas posibles para --para: ' + (carpetas || 'las del Mapa de agentes') + '. Déjalo vacío si sirve a todas.',
    '4. Responde solo con la lista de ideas guardadas (id y título), «Qué sigue» y «Asignar a / Carpeta o proyecto».',
  ].join('\n')
}
function promptTraer(sid) {
  const s = estado.sesiones.find(x => x.id === sid)
  if (!s) return ''
  const py = path.join(os.homedir(), '.claude', 'scripts', 'ideas.py').replace(/\\/g, '/')
  const id8 = sid.slice(0, 8)
  return [
    'Trae ideas de las otras sesiones de ' + (s.proyecto || 'este proyecto') + ' que ayuden a esta sesión. Solo lectura: no toques las otras sesiones.',
    '',
    '1. En una línea, di el objetivo de esta sesión y elige de 2 a 5 palabras clave del tema (por ejemplo: Mario preguntas pendientes).',
    '2. Corre las dos búsquedas: python "' + py + '" buscar "palabras" --sesion ' + id8 + '   y   python "' + py + '" otras --sesion ' + id8 + ' --tema "palabras"',
    '3. Entrega solo lo que suma y esta sesión aún no tiene: una viñeta por punto con la sesión de origen (título e id corto). Descarta lo ya cubierto aquí y lo que esté resuelto.',
    '4. Si algo es un descubrimiento reutilizable y comprobado, guárdalo con «agregar»; si una idea del pool te sirvió, márcala con «usar».',
    '5. Si te falta algo que solo sabe otra sesión o carpeta, pregúntale: python "' + py + '" preguntar --sesion ' + id8 + ' --para "carpeta | id de sesión | todas" --texto "pregunta concreta". La respuesta llegará sola a esta sesión.',
    '6. Cierra con «Qué sigue» y «Asignar a / Carpeta o proyecto».',
  ].join('\n')
}
function traerIdeas(sid) {
  const prompt = promptTraer(sid)
  if (!prompt) return
  abrirConPrompt(sid, prompt, 'para traer ideas')
}
function aportarIdeas(sid) {
  const prompt = promptIdeas(sid)
  if (!prompt) return
  abrirConPrompt(sid, prompt, 'para aportar ideas')
}

function sesionesQuemadas() {
  const lim = limiteCtx()
  const ahora = Date.now()
  return estado.sesiones.filter(s => ((s.stats && s.stats.ctx) || 0) >= lim && ahora - s.mtime >= 60000 && !(s.subs || []).some(b => ahora - b.mtime < 60000))
}

function notaQuemados(lista, petroff) {
  const hoy = dia(Date.now())
  const lim = limiteCtx()
  const L = ['---', 'tipo: "traspaso"', 'carpeta: "55_Reporte_Diario"', 'creado: "' + hoy + '"', 'fuente: "Panel Mapa de agentes (VS Code), botón de contextos quemados"', 'estado: "borrador"', 'tags: [traspaso, contexto-quemado' + (petroff ? ', petroff-amshen' : '') + ']', '---', '# Traspaso de contextos quemados · ' + hoy, '']
  L.push('> [!abstract] Para abrir las sesiones nuevas', '> Cada sesión de abajo pasó el límite de ' + tk(lim) + ' de contexto y se cerró. Abre una sesión nueva por tema, pídele que lea esta nota y siga desde «Dónde quedó». El historial completo sigue en disco (`~/.claude/projects`).', '')
  if (petroff) {
    const t = tareasTodas()
    const libres = t.tareas.filter(x => !x.hecho && x.proyecto === 'Petroff Amshen' && !(x.bloqueadaPor && x.bloqueadaPor.length))
    if (libres.length) {
      L.push('## Siguiente paso (tareas libres)', '')
      for (const x of libres.slice(0, 3)) L.push('- ' + (x.archivo ? '[[' + x.archivo + ']]' : x.titulo))
      L.push('')
    }
  }
  L.push('## Sesiones cerradas', '')
  for (const s of lista) {
    const cx = (s.stats && s.stats.ctx) || 0
    const nom = (s.titulo || s.primero || s.id.slice(0, 8)).slice(0, 90)
    L.push('### ' + nom, '')
    L.push('- Proyecto: ' + s.proyecto + (s.depto ? ' · carpeta ' + s.depto : ''))
    L.push('- Contexto al cerrar: ' + tk(cx) + ' de ' + tk(lim))
    L.push('- Id de la sesión: `' + s.id + '`')
    L.push('- Dónde quedó: ' + ((s.stats && s.stats.texto) ? s.stats.texto.slice(0, 600).replace(/\s+/g, ' ') : '(sin texto registrado)'))
    const u = s.stats && s.stats.ultima
    if (u) L.push('- Última acción: ' + u.tool + (u.det ? ' · ' + u.det : ''))
    const errs = agruparTools([s]).filter(x => x.sc > 0).slice(0, 5)
    if (errs.length) {
      L.push('- Errores sin confirmar:')
      for (const x of errs) L.push('  - ' + nombreHerr(x.tool) + ': ' + x.sc + ' · ' + x.pista)
    }
    L.push('')
  }
  L.push('## Por confirmar con José', '', '- (lo hablado que no quedó en un archivo; esta nota sale solo de lo que ve el panel)', '')
  return L.join('\n')
}

function cerrarPestanasChat(lista) {
  try {
    const tg = vscode.window.tabGroups
    if (!tg) return 0
    const titulos = lista.map(s => (s.titulo || '').trim()).filter(Boolean)
    const cerrar = []
    for (const g of tg.all) {
      for (const tab of g.tabs) {
        const vt = String((tab.input && tab.input.viewType) || '')
        if (!/claude/i.test(vt)) continue
        const lab = String(tab.label || '').trim()
        if (titulos.some(t => lab === t || lab.startsWith(t.slice(0, 20)) || t.startsWith(lab.slice(0, 20)))) cerrar.push(tab)
      }
    }
    if (cerrar.length) tg.close(cerrar)
    return cerrar.length
  } catch (err) {
    return 0
  }
}

function traspasoQuemados() {
  const lista = sesionesQuemadas()
  if (!lista.length) {
    vscode.window.showInformationMessage('No hay contextos quemados (ninguna sesión en reposo pasó el límite).')
    return
  }
  vscode.window.showWarningMessage(
    'Dejar traspaso de ' + lista.length + ' sesión(es) con el contexto quemado: se guarda una nota y se cierran sus pestañas (el historial queda en disco). ¿Seguir?',
    { modal: true },
    'Guardar y cerrar',
  ).then(r => {
    if (r !== 'Guardar y cerrar') return
    const pet = lista.filter(s => s.proyecto === 'Petroff Amshen')
    const otras = lista.filter(s => s.proyecto !== 'Petroff Amshen')
    const guardados = []
    const fallos = []
    const intentar = (grupo, esPet) => {
      if (!grupo.length) return
      const md = notaQuemados(grupo, esPet)
      try {
        const f = esPet ? guardarTraspasoVault(md) : guardarLocal(md, 'traspaso_quemados_' + dia(Date.now()) + '_' + Date.now() + '.md')
        guardados.push(f)
        grupo.forEach(s => { s._guardada = true })
      } catch (err) {
        fallos.push(err.message)
      }
    }
    intentar(pet, true)
    intentar(otras, false)
    const ok = lista.filter(s => s._guardada)
    const cerradas = cerrarPestanasChat(ok)
    if (guardados.length) {
      abrirArchivo(guardados[0])
      vscode.window.showInformationMessage('Traspaso guardado (' + ok.length + ' sesión(es)): ' + guardados.join(' · ') + '. Pestañas cerradas: ' + cerradas + (cerradas < ok.length ? ' (las demás ciérralas a mano)' : '') + '.')
    }
    if (fallos.length) vscode.window.showErrorMessage('No pude guardar parte del traspaso, esas sesiones NO se cerraron: ' + fallos.join(' | '))
  })
}

const PARADAS = new Set('para con del las los una uno unos unas sobre entre desde esta este esto como que por sus todo toda todos todas hacer hoja cambio sesion agente agentes probar evaluar revisar claude estado proyecto proyectos tareas notas nota obsidian archivos informe resumen'.split(' '))
const GENERICOS = new Set(['general-purpose', 'claude', 'Explore', 'Plan', 'agente'])
const COLORES = { 'Petroff Amshen': '#22d3ee', 'MasterStock USA': '#fb7185', 'Ofrecer servicios': '#c084fc', 'Sin clasificar': '#8b95a5' }
function colorProyecto(nombre) {
  if (COLORES[nombre]) return COLORES[nombre]
  let h = 0
  for (const c of String(nombre)) h = (h * 31 + c.charCodeAt(0)) >>> 0
  const hue = h % 360
  const f = n => {
    const k = (n + hue / 30) % 12
    const v = 0.62 - 0.65 * Math.min(0.62, 1 - 0.62) * Math.max(-1, Math.min(k - 3, 9 - k, 1))
    return Math.round(v * 255).toString(16).padStart(2, '0')
  }
  return '#' + f(0) + f(8) + f(4)
}
// Lo lee el mod «proyecto-chat» para pintar cada ventana de chat con el color de su proyecto.
let estadoSesionesPrevio = ''
function escribirEstadoSesiones(top, ahora) {
  const out = {}
  for (const s of top) {
    out[s.id] = { proyecto: s.proyecto, color: colorProyecto(s.proyecto), ctx: (s.stats && s.stats.ctx) || 0, limite: limiteCtx(), sinconf: s.total.sinconf, errores: s.total.errores, activos: s.subs.filter(b => ahora - b.mtime < ACTIVO_MS).length, subs: s.subs.length, ts: ahora }
  }
  const txt = JSON.stringify(out)
  const clave = JSON.stringify(Object.values(out).map(x => [x.proyecto, x.ctx, x.sinconf, x.activos]))
  if (clave === estadoSesionesPrevio) return
  estadoSesionesPrevio = clave
  try {
    fs.mkdirSync(path.dirname(HISTORIAL), { recursive: true })
    fs.writeFileSync(path.join(path.dirname(HISTORIAL), 'sesiones_estado.json'), txt, 'utf8')
  } catch (e) {}
}

const EMOJI_PROYECTO = { 'Petroff Amshen': '🔵', 'MasterStock USA': '🔴', 'Ofrecer servicios': '🟣' }
const TITULOS_ORIG = path.join(os.homedir(), '.claude', 'state', 'titulos_originales.json')
let emojisUltimo = 0
const emojisHechos = new Map()
// Pone el emoji del proyecto delante del título de la sesión (como /rename): una línea custom-title al final del .jsonl.
// Solo en sesiones quietas más de 3 min, para no escribir en un archivo que Claude Code tiene en uso.
function aplicarEmojis(top, ahora) {
  if (ahora - emojisUltimo < 60000) return
  emojisUltimo = ahora
  if (vscode.workspace.getConfiguration('agentMap').get('emojiTitulos') === false) return
  let orig = null
  for (const s of top) {
    const emoji = EMOJI_PROYECTO[s.proyecto]
    if (!emoji || !s.titulo || ahora - s.mtime < 180000 || s.subs.some(b => ahora - b.mtime < 180000)) continue
    let base = s.titulo
    for (const e of Object.values(EMOJI_PROYECTO)) if (base.startsWith(e + ' ')) base = base.slice(e.length + 1)
    const deseado = emoji + ' ' + base
    if (deseado === s.titulo || emojisHechos.get(s.id) === deseado) continue
    try {
      const f = path.join(PROYECTOS, s.carpeta, s.id + '.jsonl')
      if (orig === null) {
        try { orig = JSON.parse(fs.readFileSync(TITULOS_ORIG, 'utf8')) } catch (e) { orig = {} }
      }
      if (!(s.id in orig)) orig[s.id] = s.titulo
      fs.appendFileSync(f, '\n' + JSON.stringify({ type: 'custom-title', customTitle: deseado, sessionId: s.id }) + '\n', 'utf8')
      emojisHechos.set(s.id, deseado)
    } catch (e) {}
  }
  if (orig !== null) {
    try { fs.writeFileSync(TITULOS_ORIG, JSON.stringify(orig, null, 1), 'utf8') } catch (e) {}
  }
}

// Sugerencias descartadas a mano: archivo propio de la extensión (no toca los demás archivos de estado).
const SUG_DESCARTES = path.join(os.homedir(), '.claude', 'state', 'agent_map_sugerencias_descartadas.json')
let sugOcultas = 0
function leerDescartes() {
  try {
    const j = JSON.parse(fs.readFileSync(SUG_DESCARTES, 'utf8'))
    return new Set(Array.isArray(j.claves) ? j.claves.map(String) : [])
  } catch {
    return new Set()
  }
}
function guardarDescartes(set) {
  fs.mkdirSync(path.dirname(SUG_DESCARTES), { recursive: true })
  fs.writeFileSync(SUG_DESCARTES, JSON.stringify({ claves: [...set].slice(-300) }, null, 1), 'utf8')
}
const sinTildes = t => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
// Borrador de la definición de un agente nuevo (solo texto para el portapapeles; no crea el archivo).
function borradorAgente(sug) {
  const b = sug.borrador || {}
  return ['---', 'name: ' + b.nombre, 'description: ' + b.descripcion, 'tools: ' + b.herramientas, 'model: ' + (b.modelo || 'sonnet'), '---', '', 'Eres el agente «' + b.nombre + '». Objetivo: ' + b.objetivo + '.', 'Reglas: de solo lectura salvo que se te pida lo contrario, marca «por confirmar» lo que no pudiste comprobar y devuelve un resumen corto con evidencia.', '(Borrador generado por el Mapa de agentes: revisar y completar antes de guardarlo en ~/.claude/agents/.)'].join('\n')
}

// ---- Curvas de aprendizaje (18-oct): por agente de Petroff; de MEMORY.md solo metadatos (nunca el contenido) ----
const MEM_DIR = path.join(os.homedir(), '.claude', 'agent-memory')
const memCache = new Map()
function metaMemoria(ruta) {
  try {
    const st = fs.statSync(ruta)
    if (!st.isFile()) return null
    const c = memCache.get(ruta)
    if (c && c.m === st.mtimeMs && c.b === st.size) return c.v
    let lineas = null
    if (st.size <= 1048576) {
      const b = fs.readFileSync(ruta)
      let n = 0
      for (let i = 0; i < b.length; i++) if (b[i] === 10) n++
      if (b.length && b[b.length - 1] !== 10) n++
      lineas = n
    }
    const v = { lineas, bytes: st.size, kb: Math.round(st.size / 102.4) / 10, mtime: st.mtimeMs }
    memCache.set(ruta, { m: st.mtimeMs, b: st.size, v })
    return v
  } catch {
    return null
  }
}
function calcularAprendizaje() {
  const ahora = Date.now()
  const dias = []
  for (let i = 0; i < 14; i++) dias.push(dia(ahora - i * 86400000)) // 0 = hoy ... 13; 0-6 ventana actual, 7-13 previa
  const agentes = (estado.org || []).filter(n => n.proy === 'Petroff Amshen')
  const por = new Map()
  dias.forEach((d, i) => {
    for (const r of Object.values(historial[d] || {})) {
      if (!r || r.ses) continue
      const k = String(r.tipo || '').toLowerCase()
      let a = por.get(k)
      if (!a) por.set(k, (a = Array.from({ length: 14 }, () => ({ n: 0, e: 0, sc: 0, h: 0, t: 0 }))))
      const b = a[i]
      b.n += 1
      b.e += Number(r.e) || 0
      b.sc += Number(r.sc) || 0
      b.h += Number(r.h) || 0
      b.t += Number(r.t) || 0
    }
  })
  const suma = (a, d0, d1) => a.slice(d0, d1).reduce((s, b) => ({ n: s.n + b.n, e: s.e + b.e, sc: s.sc + b.sc, h: s.h + b.h, t: s.t + b.t }), { n: 0, e: 0, sc: 0, h: 0, t: 0 })
  const tasa = s => (s.h > 0 ? (s.e / s.h) * 100 : null)
  const tend = (a, p) => {
    if (a == null || p == null) return { pct: null, dir: null }
    if (p === 0) return a === 0 ? { pct: 0, dir: 'igual' } : { pct: null, dir: 'nuevo' }
    const pct = ((a - p) / p) * 100
    return { pct: Math.round(pct), dir: pct <= -5 ? 'baja' : pct >= 5 ? 'sube' : 'igual' }
  }
  const out = []
  for (const n of agentes) {
    const arr = por.get(String(n.name).toLowerCase()) || Array.from({ length: 14 }, () => ({ n: 0, e: 0, sc: 0, h: 0, t: 0 }))
    const act = suma(arr, 0, 7)
    const prev = suma(arr, 7, 14)
    const tot = suma(arr, 0, 14)
    const suf = tot.n >= 5
    const tA = act.n ? act.t / act.n : null
    const tP = prev.n ? prev.t / prev.n : null
    const mem = metaMemoria(path.join(MEM_DIR, n.name, 'MEMORY.md'))
    const muyUsado = tot.n >= 5
    const alertas = []
    let memo = { existe: false }
    if (mem) {
      const diasSin = Math.floor((ahora - mem.mtime) / 86400000)
      memo = { existe: true, lineas: mem.lineas, kb: mem.kb, mtime: mem.mtime, dias: Math.max(0, diasSin) }
      if ((mem.lineas != null && mem.lineas > 200) || mem.bytes > 25 * 1024) alertas.push({ nivel: 'rojo', texto: 'Curar ya: pasa el límite de 200 líneas / 25 KB que carga el agente; lo que sobra no se lee.' })
      else if ((mem.lineas != null && mem.lineas > 150) || mem.bytes > 20 * 1024) alertas.push({ nivel: 'ambar', texto: 'Curar: se acerca al límite de 200 líneas / 25 KB que carga el agente.' })
      if (muyUsado && diasSin > 14) alertas.push({ nivel: 'ambar', texto: 'Muy usado (' + tot.n + ' lanzamientos en 14 días) y su memoria lleva ' + diasSin + ' días sin actualizarse: no está aprendiendo.' })
    }
    out.push({
      name: n.name,
      model: n.model || '',
      lanz: tot.n,
      lanzAct: act.n,
      lanzPrev: prev.n,
      suficiente: suf,
      e100: { act: tasa(act), prev: tasa(prev), ...tend(tasa(act), tasa(prev)) },
      tok: { prom: tot.n ? tot.t / tot.n : null, act: tA, prev: tP, ...tend(tA, tP) },
      rec: { e: tot.e, sc: tot.sc, pct: tot.e > 0 ? Math.round(((tot.e - tot.sc) / tot.e) * 100) : null },
      spark: { tasa: arr.map(b => (b.h > 0 ? Math.round((b.e / b.h) * 1000) / 10 : null)).reverse(), lanz: arr.map(b => b.n).reverse() },
      mem: memo,
      alertas,
    })
  }
  out.sort((a, b) => b.lanz - a.lanz || a.name.localeCompare(b.name))
  return { agentes: out, comun: metaMemoria(path.join(MEM_DIR, '_comun', 'LECCIONES.md')), ts: ahora }
}

function calcularSugerencias() {
  const out = []
  const regs = []
  const org = estado.org || []
  for (const d of Object.keys(historial).sort().reverse().slice(0, 14)) for (const r of Object.values(historial[d])) if (!r.ses) regs.push({ ...r, dia: d })
  const tokensDe = r =>
    new Set(
      sinTildes(r.desc)
        .split(/[^a-z0-9]+/)
        .filter(w => w.length >= 5 && !PARADAS.has(w)),
    )
  const df = new Map()
  const gen = regs.filter(x => GENERICOS.has(x.tipo)).map(r => ({ r, toks: tokensDe(r) }))
  for (const { r, toks } of gen) {
    for (const w of toks) {
      const e = df.get(w) || { n: 0, dias: new Set(), ej: [], proy: {} }
      e.n += 1
      e.dias.add(r.dia)
      if (e.ej.length < 2 && r.desc && !e.ej.includes(r.desc)) e.ej.push(String(r.desc).slice(0, 70))
      e.proy[r.proy || 'Sin clasificar'] = (e.proy[r.proy || 'Sin clasificar'] || 0) + 1
      df.set(w, e)
    }
  }
  // Una palabra cuenta solo si se repite en 3 o más lanzamientos de al menos 2 días distintos (una sola investigación larga no es un rol).
  for (const [w, e] of [...df].filter(([, e]) => e.n >= 3 && e.dias.size >= 2).sort((a, b) => b[1].n - a[1].n).slice(0, 6)) {
    const proy = Object.entries(e.proy).sort((a, b) => b[1] - a[1])[0][0]
    const cubre = org.find(n => sinTildes(n.name).includes(w) || sinTildes(n.desc).includes(w))
    if (cubre) {
      const desde = dia(cubre.creado || 0)
      const post = gen.filter(x => x.toks.has(w) && x.r.dia >= desde).length
      if (post >= 2) out.push({ tipo: 'usar', clave: 'usar:' + w, proy, titulo: 'Usar «' + cubre.name + '» en vez de agentes genéricos', detalle: post + ' lanzamientos genéricos de «' + w + '» desde que existe ese agente (' + desde + ').', ejemplos: e.ej })
      continue
    }
    const nombre = (proy === 'Petroff Amshen' ? 'petroff-' : '') + w
    out.push({
      tipo: 'crear',
      clave: 'crear:' + w,
      proy,
      titulo: 'Agente para «' + w + '»',
      detalle: e.n + ' lanzamientos con agentes genéricos en ' + e.dias.size + ' días de los últimos 14. Un agente dedicado evita repetir instrucciones y ahorra contexto.',
      ejemplos: e.ej,
      borrador: {
        nombre,
        descripcion: 'Agente para trabajos de «' + w + '». Usarlo cuando se pida, por ejemplo: ' + e.ej.join('; ') + '.',
        herramientas: 'Read, Grep, Glob, Bash, Write' + (proy === 'Petroff Amshen' ? ', mcp__obsidian-petroff__vault_read, mcp__obsidian-petroff__vault_list, mcp__obsidian-petroff__vault_search' : ''),
        modelo: 'sonnet',
        objetivo: 'resolver los encargos sobre «' + w + '» que hoy se mandan a agentes genéricos',
      },
    })
  }
  const por = new Map()
  for (const r of regs) {
    const u = por.get(r.tipo) || { n: 0, sc: 0, h: 0, c: 0, proy: {} }
    u.n += 1
    u.sc += r.sc || 0
    u.h += r.h || 0
    u.c += r.c || 0
    u.proy[r.proy || 'Sin clasificar'] = (u.proy[r.proy || 'Sin clasificar'] || 0) + 1
    por.set(r.tipo, u)
  }
  for (const [t, u] of por) {
    if (u.n >= 2 && (u.c > 0 || (u.h && u.sc / u.h > 0.03))) out.push({ tipo: 'mejorar', clave: 'mejorar:' + t, proy: Object.entries(u.proy).sort((a, b) => b[1] - a[1])[0][0], titulo: 'Mejorar «' + t + '»', detalle: u.sc + ' errores sin confirmar en ' + u.h + ' acciones' + (u.c ? ' y ' + u.c + ' veces atascado' : '') + ' (' + u.n + ' lanzamientos).' })
  }
  // Agentes definidos sin uso: uno por proyecto (los de MasterStock no aparecen en la vista de Petroff).
  const usados = new Set([...por.keys()].map(x => String(x).toLowerCase()))
  const grupos = new Map()
  for (const n of org) {
    if (usados.has(String(n.name).toLowerCase())) continue
    const k = n.proy || ''
    grupos.set(k, [...(grupos.get(k) || []), n.name])
  }
  for (const [k, sinUso] of grupos) {
    out.push({ tipo: 'revisar', clave: 'revisar:' + k, proy: k, titulo: sinUso.length + (sinUso.length === 1 ? ' agente definido sin uso' : ' agentes definidos sin uso') + ' en 14 días' + (k ? ' · ' + k : ' · comunes'), detalle: sinUso.slice(0, 6).join(', ') + (sinUso.length > 6 ? ' y ' + (sinUso.length - 6) + ' más' : '') + '. Revisa si siguen sirviendo o si hay que activarlos.' })
  }
  const lim = limiteCtx()
  for (const s of estado.sesiones) {
    const c = (s.stats && s.stats.ctx) || 0
    if (c >= lim * 0.75 && s.subs.length === 0) out.push({ tipo: 'delegar', clave: 'delegar:' + s.id, proy: s.proyecto, titulo: 'Delegar en «' + (s.titulo || s.primero || s.id.slice(0, 8)).slice(0, 40) + '»', detalle: 'Llegó a ' + tk(c) + ' de contexto sin lanzar ningún subagente. Las tareas largas de lectura o búsqueda conviene mandarlas a subagentes.' })
  }
  const desc = leerDescartes()
  sugOcultas = out.filter(x => desc.has(x.clave)).length
  return out.filter(x => !desc.has(x.clave))
}

// ---- 7: reporte del día (solo tareas hechas e hitos) ----
function generarReporte(filtro) {
  const hoy = dia(Date.now())
  const t = tareasTodas()
  const quedan = filtro === 'todos' ? t.tareas : t.tareas.filter(x => x.proyecto === filtro)
  const hechas = quedan.filter(x => x.hecho)
  const { hitos, sesionesHoy } = hitosHoy(filtro)
  const L = ['# Resumen del día · ' + hoy + (filtro === 'todos' ? '' : ' · ' + filtro), '']
  L.push('## Tareas hechas', '')
  if (hechas.length) for (const x of hechas) L.push('- ' + x.titulo + (x.proyecto ? ' (' + x.proyecto + ')' : ''))
  else L.push('- (ninguna marcada todavía)')
  L.push('', '## Hitos', '')
  if (hitos.size) {
    for (const [proy, l] of hitos) {
      L.push('**' + proy + '**')
      for (const x of [...new Set(l)]) L.push('- ' + x)
      L.push('')
    }
  } else L.push('- (sin hitos registrados hoy)')
  if (sesionesHoy.length) L.push('## Sesiones de trabajo', '', ...[...new Set(sesionesHoy)].map(x => '- ' + x), '')
  return L.join('\n')
}

const estado = { carpetas: [], sesiones: [], eventos: [], org: [], proyectos: [], tareas: { fecha: '', tareas: [] }, ts: 0 }

function leerTareas() {
  try {
    return JSON.parse(fs.readFileSync(TAREAS, 'utf8'))
  } catch {
    return { fecha: '', tareas: [] }
  }
}

function guardarTareas(t) {
  fs.mkdirSync(path.dirname(TAREAS), { recursive: true })
  fs.writeFileSync(TAREAS, JSON.stringify(t, null, 2), 'utf8')
}
const vistos = new Map()
const metas = new Map()
let sembrado = false

function expandir(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p
}

function frontmatter(txt) {
  const out = {}
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(txt)
  if (!m) return out
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^(name|description|model|tools):\s*(.*)$/.exec(line)
    if (kv) out[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '')
  }
  return out
}

function leerOrg() {
  const carpetas = vscode.workspace.getConfiguration('agentMap').get('agentFolders') || []
  const nodos = []
  for (const c of carpetas) {
    let files = []
    try {
      files = fs.readdirSync(expandir(c.path)).filter(f => f.endsWith('.md')).sort()
    } catch {
      continue
    }
    for (const f of files) {
      try {
        const txt = fs.readFileSync(path.join(expandir(c.path), f), 'utf8').slice(0, 4000)
        const fm = frontmatter(txt)
        const desc = fm.description || ''
        const sp = /Spawned by ([A-Za-z0-9_-]+)/i.exec(desc)
        const nombreA = fm.name || f.replace(/\.md$/, '')
        const pistaP = (fm.tools || '') + ' ' + desc + ' ' + nombreA
        // Proyecto del agente: por herramientas/descripción (la carpeta ~/.claude/agents mezcla agentes de Petroff y de MasterStock).
        const proyA = /^masterstock/i.test(c.grupo) || /obsidian-sandbox|masterstock|liquidat|pallet|nemesis/i.test(pistaP) ? 'MasterStock USA' : /obsidian-petroff|petroff/i.test(pistaP) ? 'Petroff Amshen' : ''
        let creadoA = 0
        try { creadoA = fs.statSync(path.join(expandir(c.path), f)).birthtimeMs } catch {}
        nodos.push({
          name: nombreA,
          grupo: c.grupo,
          proy: proyA,
          creado: creadoA,
          parent: sp ? sp[1].toLowerCase() : null,
          model: fm.model || '',
          desc: desc.slice(0, 200),
        })
      } catch {
        // archivo ilegible: se omite
      }
    }
  }
  return nodos
}

function log(at, tipo, texto) {
  estado.eventos.unshift({ at, tipo, texto })
  estado.eventos.length = Math.min(estado.eventos.length, MAX_EVENTOS)
}

const archivos = new Map()
const NL = String.fromCharCode(10)
let presupuesto = 0

const txt = c =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map(x => (x && x.text) || '').join(' ') : ''

// No son fallos: el usuario rechazó la llamada, una guardia o hook la bloqueó a propósito, o la sesión se cortó.
const NO_ES_ERROR = [/doesn't want to proceed/i, /tool use was rejected/i, /^<tool_use_error>blocked:/i, /^blocked:/i, /pretooluse:\w+ hook error/i, /guardia de contexto/i, /tool call interrupted/i, /was denied by the claude code auto mode classifier/i]
// Errores ya documentados (causa y regla para que no se repitan): ~/.claude/state/errores_documentados.json
// [{ "tool": "prefijo de herramienta", "patron": "texto en minúsculas", "nota": "GC40 §n" }]
const ERR_DOC = path.join(os.homedir(), '.claude', 'state', 'errores_documentados.json')
let errDoc = { mtime: -1, lista: [] }
function erroresDocumentados() {
  try {
    const m = fs.statSync(ERR_DOC).mtimeMs
    if (m !== errDoc.mtime) {
      const l = JSON.parse(fs.readFileSync(ERR_DOC, 'utf8'))
      errDoc = { mtime: m, lista: Array.isArray(l) ? l : [] }
      archivos.clear()
    }
  } catch {
    errDoc = { mtime: -1, lista: [] }
  }
  return errDoc.lista
}
function documentado(tool, msg) {
  const t = String(tool)
  const m = String(msg).toLowerCase()
  return errDoc.lista.some(d => (!d.tool || t.startsWith(d.tool) || t.endsWith('__' + d.tool)) && d.patron && m.includes(String(d.patron).toLowerCase()))
}

// Empareja cada error con lo que pasó después: si la misma herramienta funcionó en las
// siguientes 5 respuestas se cuenta como recuperado; si no, queda "sin confirmar".
function resolver(a, b) {
  const nombre = a.usos.get(b.tool_use_id) || '?'
  a.usos.delete(b.tool_use_id)
  const ruta = (a.rutas && a.rutas.get(b.tool_use_id)) || ''
  if (a.rutas) a.rutas.delete(b.tool_use_id)
  const msgErr = b.is_error ? limpiarMsg(txt(b.content)).slice(0, 160) : ''
  if (b.is_error && NO_ES_ERROR.some(r => r.test(msgErr.trim()))) return
  if (b.is_error && documentado(nombre, msgErr)) {
    a.errores += 1
    a.recup += 1
    a.docum = (a.docum || 0) + 1
    const q = ptool(a, nombre)
    q.e += 1
    q.rec += 1
    return
  }
  const err = !!b.is_error
  const resto = []
  for (const p of a.pend) {
    // Error esperado: leer/buscar un archivo que no existía y luego crearlo o editarlo con éxito (misma ruta) = resuelto.
    if (!err && ((p.tool === nombre) || (p.ruta && ruta === p.ruta && /^(Write|Edit|MultiEdit|NotebookEdit)$/.test(nombre)))) {
      a.recup += 1
      ptool(a, p.tool).rec += 1
      continue
    }
    p.left -= 1
    if (p.left <= 0) {
      a.sinconf += 1
      {
        const q = ptool(a, p.tool)
        q.sc += 1
        if (!q.msg) q.msg = p.msg
      }
      if (a.lista.length < 30) a.lista.push({ tool: p.tool, msg: p.msg })
      continue
    }
    resto.push(p)
  }
  a.pend = resto
  if (err) {
    a.errores += 1
    {
      const q = ptool(a, nombre)
      q.e += 1
      q.msg = limpiarMsg(txt(b.content)).slice(0, 160)
    }
    a.pend.push({ tool: nombre, left: 5, msg: limpiarMsg(txt(b.content)).slice(0, 160), ruta: /does not exist|no such file|ENOENT|not found|no existe/i.test(msgErr) ? ruta : '' })
  }
}

// Quita el ruido de compresión (líneas [sqz] y marcas §ref) y colapsa espacios.
const limpiarMsg = m =>
  m
    .split('\n')
    .filter(l => !l.includes('[sqz]'))
    .join(' ')
    .replace(/§ref:[0-9a-f]+§/g, '')
    .replace(/\s+/g, ' ')
    .trim()
const nombreModelo = id => {
  const m = /claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?/.exec(id || '')
  return m ? m[1][0].toUpperCase() + m[1].slice(1) + ' ' + m[2] + (m[3] && m[3].length < 3 ? '.' + m[3] : '') : ''
}
const ptool = (a, t) => (a.porTool[t] = a.porTool[t] || { e: 0, sc: 0, rec: 0, msg: '' })
const PISTAS = [
  [/multiple .* accounts|specify which/i, 'Hay varias cuentas conectadas: indicar cuál usar'],
  [/InputValidationError|required parameter|missing required/i, 'Falta un parámetro obligatorio: revisar la llamada'],
  [/no response or progress|server .* not connected|disconnected/i, 'El servidor MCP dejó de responder: reconectarlo'],
  [/does not exist|no longer exists/i, 'La ruta o el recurso no existe: verificarlo antes de usarlo'],
  [/file has not been read|must read|modified since/i, 'Leer el archivo antes de editarlo'],
  [/\b400\b|bad request/i, 'Revisar los parámetros de la llamada (error 400)'],
  [/401|403|permission|denied|unauthori[sz]ed|forbidden|scope|permiso/i, 'Falta permiso o autenticación: revisar el acceso de la conexión'],
  [/not found|ENOENT|no such file|no existe|404/i, 'La ruta o el recurso no existe: verificarlo antes de usarlo'],
  [/timeout|timed out|ETIMEDOUT/i, 'Tiempo agotado: reintentar o dividir la consulta'],
  [/429|rate limit|quota/i, 'Límite de uso: espaciar las llamadas'],
  [/blocked|guard|hook|rechaz/i, 'Lo bloqueó una regla o guardia: usar la ruta permitida'],
  [/syntax|unexpected|EOF|parse/i, 'Error de sintaxis en el comando: escribir el script en un archivo'],
]
const pista = msg => {
  for (const [re, t] of PISTAS) if (re.test(msg || '')) return t
  return 'Revisar el mensaje y cómo se usa la herramienta'
}
const porToolConPista = pt => Object.fromEntries(Object.entries(pt).map(([t, v]) => [t, { ...v, pista: pista(v.msg) }]))
const ptCompacto = pt => Object.fromEntries(Object.entries(pt || {}).filter(([, v]) => v.e > 0).map(([t, v]) => [t, [v.e, v.sc]]))
const limiteCtx = () => Number(vscode.workspace.getConfiguration('agentMap').get('limiteContexto')) || 400000
const minutosDe = txt0 => {
  const m = /([\d.,]+)\s*(min|h)/i.exec(txt0 || '')
  if (!m) return 0
  const n = parseFloat(m[1].replace(',', '.')) || 0
  return Math.round(/h/i.test(m[2]) ? n * 60 : n)
}

function detalle(i) {
  if (!i || typeof i !== 'object') return ''
  const v = i.file_path || i.command || i.pattern || i.query || i.url || i.description || i.path || i.prompt || ''
  return String(v).replace(/\s+/g, ' ').slice(0, 90)
}

// Suma tokens, herramientas y errores leyendo solo los bytes nuevos de un transcript.
function diaLocal(dt) {
  return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0')
}

// Sesión dueña de un archivo: <sid>.jsonl o <sid>/subagents/agent-x.jsonl
function sidDeArchivo(file) {
  const dir = path.dirname(file)
  return path.basename(dir) === 'subagents' ? path.basename(path.dirname(dir)) : path.basename(file, '.jsonl')
}

// Mapa de calor de la pestaña Uso: tokens por proyecto, día y hora de los últimos 7 días.
// t = entrada nueva + salida; r = lectura de caché. Sin costos (regla de José).
function calcularUsoMapa(top) {
  const proySes = new Map(top.map(s => [s.id, s.proyecto || '']))
  const hoy = new Date()
  hoy.setHours(0, 0, 0, 0)
  const dias = []
  for (let i = 6; i >= 0; i--) dias.push(diaLocal(new Date(hoy.getTime() - i * 86400000 + 3600000)))
  const vistosUso = new Set()
  const acc = new Map()
  for (const [file, a] of archivos) {
    if (!a.horas) continue
    const p = proySes.get(sidDeArchivo(file))
    if (p === undefined) continue
    for (const [id, x] of a.horas) {
      if (x[0] < dias[0]) {
        a.horas.delete(id)
        continue
      }
      if (vistosUso.has(id)) continue
      vistosUso.add(id)
      const k = p + '|' + x[0] + '|' + x[1]
      const c = acc.get(k) || { p, d: x[0], h: x[1], t: 0, r: 0 }
      c.t += x[2]
      c.r += x[3]
      acc.set(k, c)
    }
  }
  estado.usoMapa = { dias, celdas: [...acc.values()] }
}

function stats(file, size) {
  let a = archivos.get(file)
  if (!a || size < a.offset) {
    a = { offset: 0, carry: '', msgs: new Map(), cierres: new Map(), ultima: null, texto: '', ctx: 0, porTool: {}, modelo: '', archivos: [], deptos: {}, vaultP: 0, vaultM: 0, vaults: {}, costo: 0, titulo: '', primero: '', tin: 0, tout: 0, cache: 0, tools: 0, errores: 0, usos: new Map(), pend: [], recup: 0, sinconf: 0, lista: [] }
    archivos.set(file, a)
  }
  if (size > a.offset && presupuesto > 0) {
    let fd
    try {
      fd = fs.openSync(file, 'r')
      while (a.offset < size && presupuesto > 0) {
        const len = Math.min(4 * 1024 * 1024, size - a.offset)
        const buf = Buffer.alloc(len)
        const got = fs.readSync(fd, buf, 0, len, a.offset)
        if (!got) break
        a.offset += got
        presupuesto -= got
        const lineas = (a.carry + buf.toString('utf8', 0, got)).split(NL)
        a.carry = lineas.pop()
        for (const l of lineas) {
          if (l.length > 2000000) continue
          if (l.includes('<task-id>') && l.includes('<status>')) {
            const re = /<task-id>([^<]+)<[/]task-id>[^]*?<status>([^<]+)<[/]status>/g
            let mm
            while ((mm = re.exec(l))) a.cierres.set(mm[1], mm[2])
          }
          if (l.includes('"type":"custom-title"') && l.length < 4000) {
            try {
              const c0 = JSON.parse(l)
              if (c0.customTitle) a.titulo2 = String(c0.customTitle)
            } catch {
              // línea de título dañada
            }
            continue
          }
          if (l.includes('"aiTitle"') && l.length < 4000) {
            try {
              const t0 = JSON.parse(l)
              if (t0.aiTitle) a.titulo = String(t0.aiTitle)
            } catch {
              // línea de título dañada
            }
            continue
          }
          if (!(l.includes('"type":"assistant"') || l.includes('"type":"user"'))) continue
          // Perfil de la ventana (pestaña Hoy): códigos de tarea mencionados y lo que se le pidió.
          {
            const rc = /\b(T\d{2}|KAN-\d{1,3})\b/g
            let mc
            while ((mc = rc.exec(l))) {
              const cods = a.cods || (a.cods = new Map())
              cods.set(mc[1], (cods.get(mc[1]) || 0) + 1)
            }
          }
          if ((a.temas || '').length < 3000 && l.includes('"type":"user"') && !l.includes('"tool_result"')) {
            try {
              const c1 = JSON.parse(l).message.content
              const t1 = typeof c1 === 'string' ? c1 : Array.isArray(c1) ? c1.map(x => (x && x.type === 'text' && x.text) || '').join(' ') : ''
              if (t1.trim() && !t1.trim().startsWith('<')) a.temas = (a.temas || '') + ' ' + t1.slice(0, 1200)
            } catch {
              // mensaje ilegible
            }
          }
          if (!a.primero && l.includes('"type":"user"') && !l.includes('"isSidechain":true')) {
            try {
              const u0 = JSON.parse(l)
              const c0 = u0.message && u0.message.content
              const tx = typeof c0 === 'string' ? c0 : Array.isArray(c0) ? c0.map(x => (x && x.text) || '').join(' ') : ''
              if (tx.trim() && !tx.trim().startsWith('<')) a.primero = tx.trim().replace(/[ ]+/g, ' ').slice(0, 140)
            } catch {
              // primer mensaje ilegible
            }
          }
          if (!(l.includes('"usage"') || l.includes('"tool_use"') || l.includes('"tool_result"'))) continue
          let j
          try {
            j = JSON.parse(l)
          } catch {
            continue
          }
          const m = j.message
          if (!m) continue
          // Los registros 'api-request-blob' repiten mensajes viejos (con sus tool_result): no son eventos nuevos y duplicaban errores.
          if (j.type !== 'assistant' && j.type !== 'user') continue
          if (j.type === 'assistant' && m.usage) {
            const id = m.id || j.uuid
            const u = m.usage
            const nuevo = [(u.input_tokens || 0) + (u.cache_creation_input_tokens || 0), u.output_tokens || 0, u.cache_read_input_tokens || 0, costoMsg(m.model, u)]
            const viejo = a.msgs.get(id)
            if (viejo) {
              a.tin -= viejo[0]
              a.tout -= viejo[1]
              a.cache -= viejo[2]
              a.costo -= viejo[3]
            }
            a.msgs.set(id, nuevo)
            a.tin += nuevo[0]
            a.tout += nuevo[1]
            a.cache += nuevo[2]
            a.costo += nuevo[3]
            // Pestaña Uso: día y hora local de cada mensaje (sin duplicar por id).
            const dt = new Date(j.timestamp)
            if (!isNaN(dt)) (a.horas || (a.horas = new Map())).set(id, [diaLocal(dt), dt.getHours(), nuevo[0] + nuevo[1], nuevo[2]])
            const cx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)
            if (j.type === 'assistant' && cx > 0) a.ctx = cx
            if (m.model && !String(m.model).startsWith('<')) a.modelo = String(m.model)
          }
          if (Array.isArray(m.content)) {
            for (const b of m.content) {
              if (b.type === 'tool_use') {
                a.tools += 1
                a.usos.set(b.id, b.name)
                {
                  const rp = b.input && (b.input.file_path || b.input.notebook_path || b.input.path)
                  if (rp) (a.rutas = a.rutas || new Map()).set(b.id, String(rp).toLowerCase())
                }
                a.ultima = { tool: b.name, det: detalle(b.input), at: Date.parse(j.timestamp) || 0 }
                a.fin = { e: b.name === 'SubagentHandback' ? 'handback' : 'tool', tool: b.name, det: detalle(b.input), at: Date.parse(j.timestamp) || 0 }
                const nm = String(b.name || '')
                const ref = String((b.input && (b.input.file_path || b.input.path || b.input.command || b.input.pattern)) || '').toLowerCase()
                const vk = bovedaDe(nm, ref)
                if (vk) a.vaults[vk] = (a.vaults[vk] || 0) + 1
                const md = /(?:^|[\\/])(\d\d_[a-z0-9_]+)[\\/]/.exec(ref)
                if (md && vk) a.deptos[md[1]] = (a.deptos[md[1]] || 0) + 1
                const fp = b.input && (b.input.file_path || b.input.notebook_path)
                if (fp && /^(Read|Edit|Write|MultiEdit|NotebookEdit)$/.test(b.name)) a.archivos = [fp, ...a.archivos.filter(x => x !== fp)].slice(0, 6)
              } else if (b.type === 'text' && j.type === 'assistant' && b.text && b.text.trim()) {
                a.texto = b.text.trim().replace(/\s+/g, ' ').slice(0, 600)
                a.fin = { e: 'texto', tool: '', det: '', at: Date.parse(j.timestamp) || 0 }
              } else if (b.type === 'tool_result') {
                const nmR = a.usos.get(b.tool_use_id) || ''
                resolver(a, b)
                // Estado del final del archivo (ver LEEME §15 «Colgados»): handback = respuesta final entregada;
                // tool = herramienta sin resultado; resultado = el modelo aún no respondió.
                if (nmR === 'SubagentHandback') a.fin = { e: 'handback', tool: nmR, det: '', at: Date.parse(j.timestamp) || 0 }
                else if (a.usos.size === 0 || !a.fin || a.fin.e !== 'tool') a.fin = { e: 'resultado', tool: nmR, det: (a.fin && a.fin.det) || '', at: Date.parse(j.timestamp) || 0 }
              }
            }
          }
        }
      }
    } catch {
      // archivo en uso o movido: se reintenta en la siguiente vuelta
    } finally {
      if (fd !== undefined) fs.closeSync(fd)
    }
  }
  return { deptos: Object.assign({}, a.deptos), vaultP: a.vaultP, vaultM: a.vaultM, vaults: Object.assign({}, a.vaults), titulo2: a.titulo2 || '', modelo: nombreModelo(a.modelo), archivos: a.archivos.slice(), ctx: a.ctx, porTool: porToolConPista(a.porTool), ultima: a.ultima, texto: a.texto, cierres: Object.fromEntries(a.cierres), fin: a.fin || null, costo: a.costo, titulo: a.titulo, primero: a.primero, tin: a.tin, tout: a.tout, cache: a.cache, tools: a.tools, errores: a.errores, recup: a.recup, sinconf: a.sinconf, abiertos: a.pend.length, lista: a.lista.slice() }
}

// Estado concreto de un subagente (regla del 17-oct, LEEME §15 «Colgados»).
// cerrado = aviso <task-notification>; terminado = su último registro es la entrega final (SubagentHandback o texto sin
// herramienta) aunque no haya aviso; herramienta = espera una herramienta larga (<15 min); pensando = espera al modelo
// (<10 min); atascado = pasó ese plazo (hasta 2 h) = lo único que cuenta como colgado y lo único que avisa.
function estadoSub(k, ahora) {
  const fin = k.stats && k.stats.fin
  const edad = ahora - k.mtime
  const R = (e, txt, extra) => ({ estado: e, colgado: e === 'atascado', estadoTxt: txt, desde: (fin && fin.at) || k.mtime, ...extra })
  if (k.cierre) return R('cerrado', 'terminó (aviso de cierre)')
  if (edad < 60000) return R('trabajando', 'trabajando')
  if (fin && fin.e === 'handback') return R('terminado', 'terminó (entregó su resultado; el padre no mandó aviso)')
  if (!fin) return R('inactivo', 'aún sin leer el final de su archivo')
  if (fin.e === 'texto') return edad > 180000 ? R('terminado', 'terminó (última respuesta sin herramienta)') : R('trabajando', 'trabajando')
  if (edad >= 7200000) return R('inactivo', 'inactivo (más de 2 h)')
  if (fin.e === 'tool') return edad < 900000 ? R('herramienta', 'esperando la herramienta ' + fin.tool.replace(/^mcp__/, '')) : R('atascado', 'atascado: la herramienta ' + fin.tool.replace(/^mcp__/, '') + ' no responde')
  return edad < 600000 ? R('pensando', 'esperando al modelo') : R('atascado', 'atascado: el modelo no contestó')
}

const inicios = new Map()
function leerInicio(file) {
  if (inicios.has(file)) return inicios.get(file)
  let t = 0
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(65536)
    const got = fs.readSync(fd, buf, 0, 65536, 0)
    const m = /"timestamp":"([^"]+)"/.exec(buf.toString('utf8', 0, got))
    if (m) t = Date.parse(m[1]) || 0
  } catch {
    t = 0
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
  if (t) inicios.set(file, t)
  return t
}

const tk = n => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n))
const resumen = x => `${tk(x.tin + x.tout)} tokens · ${x.tools} herramientas · ${x.errores} errores`
const etiqueta = s => `${s.tipo} · ${s.desc.slice(0, 70)}`

function escanear() {
  const carpetasMano = leerCarpetas()
  erroresDocumentados()
  const ahora = Date.now()
  presupuesto = 24 * 1024 * 1024
  cargarPrecios()
  const sesiones = []
  let proyectos = []
  try {
    proyectos = fs.readdirSync(PROYECTOS, { withFileTypes: true }).filter(d => d.isDirectory())
  } catch {
    // sin carpeta de proyectos todavía
  }
  for (const p of proyectos) {
    let files = []
    try {
      files = fs.readdirSync(path.join(PROYECTOS, p.name)).filter(f => f.endsWith('.jsonl'))
    } catch {
      continue
    }
    for (const f of files) {
      try {
        const st = fs.statSync(path.join(PROYECTOS, p.name, f))
        if (ahora - st.mtimeMs > VENTANA_MS) continue
        sesiones.push({ id: f.replace(/\.jsonl$/, ''), carpeta: p.name, proyecto: p.name, mtime: st.mtimeMs, size: st.size, subs: [] })
      } catch {
        // la sesión cambió mientras la leía
      }
    }
  }
  sesiones.sort((a, b) => b.mtime - a.mtime)
  const top = sesiones.slice(0, MAX_SESIONES)
  for (const s of top) {
    s.stats = stats(path.join(PROYECTOS, s.proyecto, s.id + '.jsonl'), s.size)
    const dir = path.join(PROYECTOS, s.proyecto, s.id, 'subagents')
    let files = []
    try {
      files = fs.readdirSync(dir)
    } catch {
      s.total = { ...s.stats }
      s.titulo = s.stats.titulo2 || s.stats.titulo || ''
      s.primero = s.stats.primero || ''
      s.sinResolver = s.stats.lista.map(e => ({ ...e, agente: 'sesión principal' }))
      continue
    }
    for (const f of files) {
      const m = /^agent-(.+)\.jsonl$/.exec(f)
      if (!m) continue
      const id = m[1]
      let st
      try {
        st = fs.statSync(path.join(dir, f))
      } catch {
        continue
      }
      if (!metas.has(id)) {
        try {
          const j = JSON.parse(fs.readFileSync(path.join(dir, `agent-${id}.meta.json`), 'utf8'))
          metas.set(id, { desc: String(j.description || ''), tipo: String(j.agentType || '') })
        } catch {
          // meta aún no escrita: se reintenta
        }
      }
      const me = metas.get(id) || {}
      const sub = { id, desc: me.desc || '(sin descripción aún)', tipo: me.tipo || 'agente', size: st.size, mtime: st.mtimeMs, inicio: leerInicio(path.join(dir, f)), stats: stats(path.join(dir, f), st.size) }
      sub.cierre = (s.stats.cierres && s.stats.cierres[id]) || ''
      Object.assign(sub, estadoSub(sub, ahora))
      s.subs.push(sub)
    }
    s.subs.sort((a, b) => b.mtime - a.mtime)
    s.titulo = s.stats.titulo2 || s.stats.titulo || ''
    s.primero = s.stats.primero || ''
    s.total = { vaultP: 0, vaultM: 0, costo: 0, tin: 0, tout: 0, cache: 0, tools: 0, errores: 0, recup: 0, sinconf: 0, abiertos: 0 }
    for (const x of [s.stats, ...s.subs.map(k => k.stats)]) {
      for (const k of Object.keys(s.total)) s.total[k] += x[k]
    }
    s.depto = carpetasMano[s.id] || ''
    s.sinResolver = [
      ...s.stats.lista.map(e => ({ ...e, agente: 'sesión principal' })),
      ...s.subs.flatMap(k => k.stats.lista.map(e => ({ ...e, agente: k.desc, tipo: k.tipo }))),
    ]
  }
  // Línea de tiempo reconstruida desde las marcas de hora: no depende de haber estado mirando.
  const ev = []
  const uso = new Map()
  for (const s of top) {
    for (const k of s.subs) {
      const et = etiqueta(k)
      if (k.inicio) ev.push({ at: k.inicio, sid: s.id, tipo: 'nace', texto: et })
      if (ahora - k.mtime >= ACTIVO_MS) {
        const dur = k.inicio ? Math.max(0, Math.round((k.mtime - k.inicio) / 1000)) : 0
        ev.push({ at: k.mtime, sid: s.id, tipo: 'termina', texto: et + (k.inicio ? ' · duró ' + dur + 's' : '') + ' · ' + resumen(k.stats) })
      }
      const u = uso.get(k.tipo) || { tipo: k.tipo, n: 0, activos: 0, tin: 0, tout: 0, tools: 0, errores: 0, sinconf: 0, ultimo: 0 }
      u.n += 1
      if (ahora - k.mtime < ACTIVO_MS) u.activos += 1
      u.tin += k.stats.tin
      u.tout += k.stats.tout
      u.tools += k.stats.tools
      u.errores += k.stats.errores
      u.sinconf += k.stats.sinconf
      u.ultimo = Math.max(u.ultimo, k.mtime)
      uso.set(k.tipo, u)
    }
  }
  ev.sort((x, y) => y.at - x.at)
  estado.eventos = ev.slice(0, MAX_EVENTOS)
  estado.uso = [...uso.values()].sort((x, y) => y.n - x.n || y.tin + y.tout - (x.tin + x.tout))
  sembrado = true
  aplicarProyectos(top)
  estado.carpetas = todasCarpetas(carpetasMano)
  estado.ideas = leerIdeas()
  estado.buzon = leerBuzon()
  calcularUsoMapa(top)
  estado.proyectos = [...new Set([...listaProyectos().map(r => r.nombre), ...Object.values(leerOverrides()), ...top.map(s => s.proyecto).filter(p => p && p !== 'Sin clasificar')])].sort((p, q) => p.localeCompare(q)).concat('Sin clasificar')
  estado.sesiones = top
  asignarSesionPendiente(top, carpetasMano)
  for (const s of top) s.depto = carpetasMano[s.id] || ""
  estado.ts = ahora
  estado.limiteCtx = limiteCtx()
  avisar(top, ahora)
  actualizarHistorial(top, ahora)
  estado.aprendizaje = calcularAprendizaje()
  estado.sugerencias = calcularSugerencias()
  estado.sugOcultas = sugOcultas
  escribirEstadoSesiones(top, ahora)
  aplicarEmojis(top, ahora)
}

const leerHtml = () => fs.readFileSync(path.join(__dirname, 'view.html'), 'utf8')

let vistaActual

function refrescarVista() {
  if (vistaActual) {
    vistaActual.webview.html = leerHtml()
    if (vistaActual.visible) vistaActual.webview.postMessage(estado)
  }
}

class Proveedor {
  resolveWebviewView(view) {
    this.view = view
    vistaActual = view
    view.webview.options = { enableScripts: true }
    view.webview.html = leerHtml()
    view.webview.onDidReceiveMessage(msg => {
      try {
        const t = leerTareas()
        if (msg && msg.tipo === 'toggle') {
          const x = t.tareas.find(k => k.id === msg.id)
          if (x) x.hecho = !x.hecho
        } else if (msg && msg.tipo === 'proyecto' && typeof msg.id === 'string') {
          const ov = leerOverrides()
          if (msg.nombre) ov[msg.id] = String(msg.nombre).slice(0, 60)
          else delete ov[msg.id]
          fs.mkdirSync(path.dirname(SESIONES_PROY), { recursive: true })
          fs.writeFileSync(SESIONES_PROY, JSON.stringify(ov, null, 2), 'utf8')
          aplicarProyectos(estado.sesiones)
          this.enviar()
          return
        } else if (msg && msg.tipo === 'nuevoProyecto' && typeof msg.nombre === 'string' && msg.nombre.trim()) {
          const nom = msg.nombre.trim().slice(0, 60)
          agregarProyecto(nom)
          if (/^[0-9a-f-]{36}$/.test(String(msg.id || ''))) {
            const ov = leerOverrides()
            ov[msg.id] = nom
            fs.mkdirSync(path.dirname(SESIONES_PROY), { recursive: true })
            fs.writeFileSync(SESIONES_PROY, JSON.stringify(ov, null, 2), 'utf8')
          }
          aplicarProyectos(estado.sesiones)
          estado.proyectos = [...new Set([...estado.proyectos.filter(p => p !== 'Sin clasificar'), nom])].sort((p, q) => p.localeCompare(q)).concat('Sin clasificar')
          this.enviar()
          return
        } else if (msg && msg.tipo === 'moverCarpeta' && typeof msg.carpeta === 'string' && typeof msg.hacia === 'string' && msg.hacia.trim()) {
          // Pasa todos los chats de la carpeta (los del proyecto de origen) a otro proyecto; la carpeta los sigue.
          const hacia = msg.hacia.trim().slice(0, 60)
          const ov = leerOverrides()
          for (const x of estado.sesiones) if ((x.depto === msg.carpeta || String(x.depto || '').startsWith(msg.carpeta + '/')) && (!msg.desde || x.proyecto === msg.desde)) ov[x.id] = hacia
          if (!listaProyectos().some(r => r.nombre === hacia)) agregarProyecto(hacia)
          fs.mkdirSync(path.dirname(SESIONES_PROY), { recursive: true })
          fs.writeFileSync(SESIONES_PROY, JSON.stringify(ov, null, 2), 'utf8')
          aplicarProyectos(estado.sesiones)
          estado.proyectos = [...new Set([...estado.proyectos.filter(p => p !== 'Sin clasificar'), hacia])].sort((p, q) => p.localeCompare(q)).concat('Sin clasificar')
          this.enviar()
          return
        } else if (msg && msg.tipo === 'nuevaSesion' && typeof msg.carpeta === 'string' && msg.carpeta.trim()) {
          nuevaSesionEnCarpeta(rutaCarpeta(msg.carpeta), String(msg.proyecto || ''))
          return
        } else if (msg && msg.tipo === 'carpeta' && /^[0-9a-f-]{36}$/.test(String(msg.id))) {
          const cm = leerCarpetas()
          const nom = rutaCarpeta(msg.nombre)
          if (nom) cm[msg.id] = nom
          else delete cm[msg.id]
          fs.mkdirSync(path.dirname(CARPETAS_SES), { recursive: true })
          fs.writeFileSync(CARPETAS_SES, JSON.stringify(cm, null, 2), 'utf8')
          for (const x of estado.sesiones) if (x.id === msg.id) x.depto = nom
          estado.carpetas = todasCarpetas(cm)
          this.enviar()
          return
        } else if (msg && (msg.tipo === 'renombrarCarpeta' || msg.tipo === 'borrarCarpeta') && typeof msg.de === 'string') {
          const de = msg.de
          const a = msg.tipo === 'renombrarCarpeta' ? rutaCarpeta(msg.a) : ''
          if (msg.tipo === 'renombrarCarpeta' && (!a || a === de || a.startsWith(de + '/'))) return
          const dentro = x => x === de || x.startsWith(de + '/')
          const nuevo = x => a + x.slice(de.length)
          const cm = leerCarpetas()
          for (const k of Object.keys(cm)) {
            if (!dentro(cm[k])) continue
            if (a) cm[k] = nuevo(cm[k])
            else delete cm[k]
          }
          let l = leerListaCarpetas().map(x => (dentro(x) ? (a ? nuevo(x) : '') : x)).filter(Boolean)
          l = [...new Set(l)]
          if (a && !l.includes(a)) l.push(a)
          fs.mkdirSync(path.dirname(CARPETAS_SES), { recursive: true })
          fs.writeFileSync(CARPETAS_SES, JSON.stringify(cm, null, 2), 'utf8')
          fs.writeFileSync(CARPETAS_LISTA, JSON.stringify(l, null, 2), 'utf8')
          for (const x of estado.sesiones) x.depto = cm[x.id] || ''
          estado.carpetas = todasCarpetas(cm)
          this.enviar()
          return
        } else if (msg && msg.tipo === 'realizarTarea' && typeof msg.id === 'string') {
          realizarTarea(msg.id)
          return
        } else if (msg && msg.tipo === 'vincularTarea' && typeof msg.id === 'string' && ['sesion', 'carpeta'].includes(msg.campo)) {
          guardarVinculo(msg.id, msg.campo, typeof msg.valor === 'string' ? msg.valor : '')
          estado.tareas = tareasTodas()
          this.enviar()
          return
        } else if (msg && msg.tipo === 'nuevaCarpeta' && typeof msg.nombre === 'string' && msg.nombre.trim()) {
          const l = leerListaCarpetas()
          const nom = rutaCarpeta(msg.nombre)
          if (!nom) return
          if (!l.includes(nom)) l.push(nom)
          fs.mkdirSync(path.dirname(CARPETAS_LISTA), { recursive: true })
          fs.writeFileSync(CARPETAS_LISTA, JSON.stringify(l, null, 2), 'utf8')
          estado.carpetas = todasCarpetas(leerCarpetas())
          this.enviar()
          return
        } else if (msg && msg.tipo === 'traspasoQuemados') {
          traspasoQuemados()
          return
        } else if (msg && msg.tipo === 'traspasoSesion' && /^[0-9a-f-]{36}$/.test(String(msg.id))) {
          traspasoSesion(msg.id)
          return
        } else if (msg && msg.tipo === 'aportarIdeas' && /^[0-9a-f-]{36}$/.test(String(msg.id))) {
          aportarIdeas(msg.id)
          return
        } else if (msg && msg.tipo === 'traerIdeas' && /^[0-9a-f-]{36}$/.test(String(msg.id))) {
          traerIdeas(msg.id)
          return
        } else if (msg && msg.tipo === 'corregir' && typeof msg.id === 'string') {
          corregirErrores(msg.id)
          return
        } else if (msg && msg.tipo === 'docErrores') {
          abrirArchivo(guardarLocal(docErrores(typeof msg.filtro === 'string' ? msg.filtro : 'todos'), 'errores_herramientas_' + dia(Date.now()) + '.md'))
          return
        } else if (msg && msg.tipo === 'traspaso') {
          traspaso(typeof msg.filtro === 'string' ? msg.filtro : 'todos')
          return
        } else if (msg && msg.tipo === 'abrir' && typeof msg.id === 'string') {
          const x = leerTareasObsidian().find(k => k.id === msg.id)
          if (x) vscode.workspace.openTextDocument(x.ruta).then(d => vscode.window.showTextDocument(d, { preview: true }))
          return
        } else if (msg && msg.tipo === 'eliminarSesion' && /^[0-9a-f-]{36}$/.test(String(msg.id))) {
          if (eliminarSesion(msg.id)) this.enviar()
          return
        } else if (msg && msg.tipo === 'abrirChat' && /^[0-9a-f-]{36}$/.test(String(msg.id))) {
          // Abre (o enfoca) la ventana de chat de Claude Code de esa sesión.
          Promise.resolve(vscode.commands.executeCommand('claude-vscode.editor.open', msg.id)).then(
            () => undefined,
            () => vscode.window.showWarningMessage('No pude abrir ese chat. Búscalo en el historial de Claude Code por su título.'),
          )
          return
        } else if (msg && msg.tipo === 'descartarSugerencia' && typeof msg.clave === 'string') {
          const ds = leerDescartes()
          ds.add(msg.clave.slice(0, 120))
          guardarDescartes(ds)
          estado.sugerencias = calcularSugerencias()
          estado.sugOcultas = sugOcultas
          this.enviar()
          return
        } else if (msg && msg.tipo === 'restaurarSugerencias') {
          guardarDescartes(new Set())
          estado.sugerencias = calcularSugerencias()
          estado.sugOcultas = sugOcultas
          this.enviar()
          return
        } else if (msg && msg.tipo === 'copiarBorrador' && typeof msg.clave === 'string') {
          const sg = (estado.sugerencias || []).find(x => x.clave === msg.clave && x.borrador)
          if (sg) {
            vscode.env.clipboard.writeText(borradorAgente(sg))
            vscode.window.setStatusBarMessage('Borrador del agente «' + sg.borrador.nombre + '» copiado (no se creó ningún archivo)', 5000)
          }
          return
        } else if (msg && msg.tipo === 'filtro' && typeof msg.nombre === 'string') {
          filtroActual = msg.nombre
          return
        } else if (msg && msg.tipo === 'reporte') {
          const md = generarReporte(typeof msg.filtro === 'string' ? msg.filtro : 'todos')
          const dir = path.join(os.homedir(), '.claude', 'state', 'reportes')
          fs.mkdirSync(dir, { recursive: true })
          const f = path.join(dir, 'reporte_' + dia(Date.now()) + '.md')
          fs.writeFileSync(f, md, 'utf8')
          vscode.env.clipboard.writeText(md)
          vscode.workspace.openTextDocument(f).then(doc => vscode.window.showTextDocument(doc, { preview: true }))
          vscode.window.setStatusBarMessage('Reporte copiado al portapapeles y abierto', 4000)
          return
        } else if (msg && msg.tipo === 'add' && typeof msg.titulo === 'string' && msg.titulo.trim()) {
          t.tareas.push({ id: 't' + Date.now(), titulo: msg.titulo.trim().slice(0, 200), proyecto: filtroActual !== 'todos' && filtroActual !== 'Sin clasificar' ? filtroActual : 'General', prioridad: 'media', responsable: '', fuente: 'manual', hecho: false })
        } else {
          return
        }
        guardarTareas(t)
        estado.tareas = tareasTodas()
        this.enviar()
      } catch (err) {
        console.error('agent-map tareas:', err)
      }
    })
    this.enviar()
    view.onDidChangeVisibility(() => this.enviar())
    view.onDidDispose(() => {
      this.view = undefined
      vistaActual = undefined
    })
  }

  enviar() {
    if (this.view && this.view.visible) this.view.webview.postMessage(estado)
  }
}

function activate(context) {
  const prov = new Proveedor()
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('agentMap.view', prov))
  let n = 0
  const paso = () => {
    try {
      if (n === 0) cargarHistorial()
      if (n % 20 === 0) estado.org = leerOrg()
      escanear()
      estado.tareas = tareasTodas()
      prov.enviar()
    } catch (err) {
      console.error('agent-map:', err)
    }
    n += 1
  }
  context.subscriptions.push(
    vscode.commands.registerCommand('agentMap.refresh', () => {
      refrescarVista()
      vscode.window.setStatusBarMessage('Mapa de agentes: vista refrescada', 2000)
    }),
    vscode.commands.registerCommand('agentMap.reloadWindow', () => vscode.commands.executeCommand('workbench.action.reloadWindow')),
  )
  // Si cambia view.html, la vista se refresca sola (sin recargar la ventana).
  const htmlPath = path.join(__dirname, 'view.html')
  fs.watchFile(htmlPath, { interval: 1000 }, () => refrescarVista())
  context.subscriptions.push({ dispose: () => fs.unwatchFile(htmlPath) })
  paso()
  const t = setInterval(paso, 3000)
  context.subscriptions.push({ dispose: () => clearInterval(t) })
}

function deactivate() {}

module.exports = { activate, deactivate }
