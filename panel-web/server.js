// ============================================================
//  App de Validación y Corrección de Código con IA — Backend
// ============================================================
//  App autónoma (no depende de GitHub). El usuario sube código,
//  la IA lo analiza, lo corrige y, si es apto (>= 8), lo despliega
//  automáticamente al HelpDesk (integración con el sistema).
//
//  Tesis: Diseño de un modelo de uso de IA en pipelines CI/CD
//  Autor: Adrian Daniel Cerezo Nevarez
// ============================================================

import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ─────────────────────────────────────────────────────────────
//  CORS: solo se aceptan peticiones desde orígenes autorizados.
//  Los orígenes se definen por variable de entorno (CORS_ORIGINS).
// ─────────────────────────────────────────────────────────────
const CORS_ORIGINS = (process.env.CORS_ORIGINS ||
  "https://cerezoarce.duckdns.org,https://helpdesk-arce.duckdns.org,http://localhost:3000")
  .split(",").map((o) => o.trim()).filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && CORS_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const PORT = process.env.PORT || 3000;
// Proveedor de IA (Cerebras por defecto; configurable por variables de entorno).
const LLM_KEY = process.env.CEREBRAS_API_KEY || process.env.GROQ_API_KEY || "";
const MODELO = process.env.LLM_MODEL || "gpt-oss-120b";
const LLM_URL = process.env.LLM_URL || "https://api.cerebras.ai/v1/chat/completions";
const UMBRAL = 7;                                    // nota mínima para desplegar
const MAX_ITER = 4;                                  // correcciones máximas
const HELPDESK_DIR = process.env.HELPDESK_DIR || "/helpdesk";  // carpeta del HelpDesk (volumen)
const HELPDESK_URL = "https://helpdesk-arce.duckdns.org";

// ─────────────────────────────────────────────────────────────
//  Histórico de reportes: cada análisis se guarda con día y hora
//  para poder descargar los reportes por periodo (diario/semanal/mensual)
//  y para ofrecer una vista del reporte desde el CSV.
// ─────────────────────────────────────────────────────────────
const REPORTES_DIR = process.env.REPORTES_DIR || path.join(HELPDESK_DIR, "reportes-ia");
try { fs.mkdirSync(REPORTES_DIR, { recursive: true }); } catch (e) { /* ignorar */ }

// Identificador legible con día y hora (hora de Ecuador, UTC-5).
function idFechaHora(d) {
  const local = new Date(d.getTime() - 5 * 60 * 60 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${local.getUTCFullYear()}-${p(local.getUTCMonth() + 1)}-${p(local.getUTCDate())}` +
         `_${p(local.getUTCHours())}-${p(local.getUTCMinutes())}-${p(local.getUTCSeconds())}`;
}

// Guarda cada análisis en el histórico. Devuelve el uid del reporte.
function guardarReporte(analisis, nombre, corregido = false) {
  try {
    const ahora = new Date();
    const idHora = idFechaHora(ahora);
    const uid = idHora + "-" + Math.random().toString(36).slice(2, 6) + (corregido ? "-corregido" : "");
    const registro = {
      uid, id_hora: idHora, corregido: Boolean(corregido),
      fecha: ahora.toISOString(), archivo: nombre || "codigo", analisis,
    };
    fs.appendFileSync(path.join(REPORTES_DIR, "historico.jsonl"), JSON.stringify(registro) + "\n", "utf-8");
    return uid;
  } catch (e) {
    console.error("No se pudo guardar el reporte:", e.message);
    return null;
  }
}

// Lee todos los registros del histórico.
function leerHistorico() {
  const ruta = path.join(REPORTES_DIR, "historico.jsonl");
  if (!fs.existsSync(ruta)) return [];
  return fs.readFileSync(ruta, "utf-8").trim().split("\n")
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

// Genera una vista HTML del reporte (se ve como el reporte de análisis).
function reporteHtml(reg) {
  const a = reg.analisis || {};
  const nivel = String(a.nivel_riesgo || "?").toUpperCase();
  const nivelColor = { BAJO: "#2ea043", MEDIO: "#d29922", ALTO: "#e5534b", "CRÍTICO": "#a5202a", "CRITICO": "#a5202a" }[nivel] || "#9aa7b4";
  const estadoColor = (e) => ({ BIEN: "#2ea043", MEJORABLE: "#d29922", PROBLEMA: "#e5534b", "CRÍTICO": "#a5202a", "CRITICO": "#a5202a" }[String(e || "").toUpperCase()] || "#9aa7b4");
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const recs = (a.recomendaciones_prioritarias || []).map((r) => `<li>${esc(r)}</li>`).join("");
  const dims = (a.dimensiones || []).map((d) =>
    `<tr><td>${esc(d.nombre)}</td><td style="text-align:center">${esc(d.puntuacion)}/10</td>` +
    `<td><span class="pill" style="background:${estadoColor(d.estado)}">${esc(String(d.estado || "").toUpperCase())}</span></td></tr>`).join("");
  const apto = a.apto_para_despliegue ? "Apto para despliegue" : "Requiere correcciones";
  const aptoColor = a.apto_para_despliegue ? "#2ea043" : "#e5534b";
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Reporte ${esc(reg.archivo)} - ${esc(reg.id_hora)}</title>
<style>
 body{background:#0f1419;color:#e6edf3;font-family:system-ui,Segoe UI,Roboto,sans-serif;margin:0;padding:24px}
 .wrap{max-width:820px;margin:0 auto}
 .card{background:#1a2029;border:1px solid #2d3742;border-radius:12px;padding:20px;margin-bottom:16px}
 .head{border:1px solid #f26b21}
 h1{font-size:20px;margin:0 0 6px} h2{font-size:15px;margin:0 0 12px}
 .sub{color:#9aa7b4;font-size:13px;margin:2px 0}
 table{width:100%;border-collapse:collapse;font-size:13px}
 td,th{padding:8px 10px;border-bottom:1px solid #2d3742;text-align:left}
 .pill{color:#fff;padding:2px 10px;border-radius:10px;font-size:11px;font-weight:700}
 .big{font-size:15px;font-weight:700;color:#f26b21}
 ul{margin:6px 0 0 18px;color:#c8d2dc;font-size:13px}
</style></head><body><div class="wrap">
 <div class="card head">
   <h1>Reporte de An&aacute;lisis de Calidad de C&oacute;digo</h1>
   <div class="sub">Pipeline CI/CD &middot; Modelo GPT-OSS 120B (open source)</div>
   <div class="sub">Archivo: <b>${esc(reg.archivo)}</b> &middot; Identificador: <b>${esc(reg.id_hora)}</b>${reg.corregido ? " &middot; <b>corregido por IA</b>" : ""}</div>
 </div>
 <div class="card">
   <h2>Resumen ejecutivo</h2>
   <div class="sub">${esc(a.resumen_general || "")}</div>
   <table>
     <tr><td>Puntuaci&oacute;n de calidad</td><td class="big">${esc(a.puntuacion_calidad)} / 10</td></tr>
     <tr><td>Nivel de riesgo</td><td><span class="pill" style="background:${nivelColor}">${esc(nivel)}</span></td></tr>
     <tr><td>Estado</td><td style="color:${aptoColor};font-weight:700">${apto}</td></tr>
   </table>
 </div>
 ${recs ? `<div class="card"><h2>Recomendaciones prioritarias</h2><ul>${recs}</ul></div>` : ""}
 ${dims ? `<div class="card"><h2>An&aacute;lisis por dimensi&oacute;n</h2><table>` +
   `<tr><th>Dimensi&oacute;n</th><th style="text-align:center">Puntuaci&oacute;n</th><th>Estado</th></tr>${dims}</table></div>` : ""}
 <div class="sub" style="text-align:center">Generado por ARCE-CEREZO VALIDADOR &middot; ${esc(reg.fecha)}</div>
</div></body></html>`;
}

// ─────────────────────────────────────────────────────────────
//  Prompts con rúbrica fija (para puntuaciones consistentes)
// ─────────────────────────────────────────────────────────────

const PROMPT_ANALISIS = `
Eres un revisor experto de calidad de software. Analiza el código con RIGOR y CONSISTENCIA.

CONTEXTO IMPORTANTE:
El código es parte de un proyecto real con varios archivos (HTML, CSS, JS, configuración) que NO ves completos.
- NO inventes ni asumas clases, módulos o variables que no aparecen literalmente en el código mostrado.
- NO penalices ni recomiendes separar el código en archivos nuevos ni mover estilos/scripts a otros archivos.
- Evalúa el archivo TAL COMO ESTÁ, como una pieza que funciona junto a los demás archivos del proyecto.

Puntúa cada una de las 7 dimensiones de 1 a 10 con esta rúbrica:
- 9-10: excelente, sin problemas.
- 7-8: bueno, solo mejoras menores.
- 5-6: aceptable, varios problemas.
- 3-4: deficiente, problemas serios.
- 1-2: crítico, muy malo.

Las 7 dimensiones son EXACTAMENTE:
Código Limpio, Modularidad, Legibilidad, Manejo de Errores, Mantenibilidad, Seguridad Básica, Documentación.

REGLAS DE PUNTUACIÓN (obligatorias):
- "puntuacion_calidad" = promedio aritmético de las 7 dimensiones, redondeado a 1 decimal.
- "nivel_riesgo" según la puntuacion_calidad: >=8 "BAJO", >=6 "MEDIO", >=4 "ALTO", <4 "CRÍTICO".
- "apto_para_despliegue" = true SOLO si puntuacion_calidad >= 8 y no hay fallos graves de seguridad.
- Penaliza con fuerza (dimensión <=3): credenciales o secretos escritos en el código,
  inyección SQL, ausencia total de manejo de errores.

Sé CONCISO para ahorrar espacio: máximo 2 hallazgos y 2 recomendaciones por dimensión,
y máximo 3 recomendaciones prioritarias en total.

Responde SOLO con JSON puro (sin markdown, sin texto extra):
{
  "resumen_general": "texto breve y objetivo",
  "puntuacion_calidad": <número con 1 decimal>,
  "nivel_riesgo": "BAJO|MEDIO|ALTO|CRÍTICO",
  "dimensiones": [
    {"nombre":"Código Limpio","puntuacion":<1-10>,"estado":"BIEN|MEJORABLE|PROBLEMA|CRÍTICO","hallazgos":["..."],"recomendaciones":["..."]}
  ],
  "problemas_criticos": ["..."],
  "recomendaciones_prioritarias": ["..."],
  "apto_para_despliegue": true|false
}`.trim();

const PROMPT_CORRECCION = `
Eres un ingeniero experto en calidad de código. Recibes un archivo y recomendaciones de mejora.
NO reescribas el archivo completo. Devuelve SOLO cambios puntuales (quirúrgicos) en bloques con
este formato EXACTO:

@@BUSCAR@@
<fragmento EXACTO del código original, copiado carácter por carácter, con varias líneas de
contexto para que sea único e inconfundible dentro del archivo>
@@REEMPLAZAR@@
<ese mismo fragmento, pero corregido>
@@FIN@@

REGLAS OBLIGATORIAS:
- El texto entre @@BUSCAR@@ y @@REEMPLAZAR@@ debe existir EXACTAMENTE en el código (misma
  indentación, mismas comillas, mismos espacios). Cópialo literal; si no coincide, se descarta.
- Haz cambios MÍNIMOS: seguridad (credenciales, inyección), validación de datos y manejo de errores.
- NO toques el diseño, los estilos, el HTML de presentación ni la estructura salvo que sea imprescindible.
- NO inventes clases, NO separes el código a otros archivos, NO cambies referencias (<link>, <script src>).
- Máximo 6 bloques, los más importantes. Si no hay cambios realmente seguros, no devuelvas ningún bloque.
- No escribas nada fuera de los bloques.`.trim();

// ─────────────────────────────────────────────────────────────
//  Llamada a la IA
// ─────────────────────────────────────────────────────────────

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

async function groq(system, user, maxTokens, temperatura, extra = {}, intentos = 0) {
  if (!LLM_KEY) throw new Error("Falta la API key del proveedor de IA (CEREBRAS_API_KEY).");
  const res = await fetch(LLM_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${LLM_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODELO,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: temperatura ?? 0,
      max_tokens: maxTokens || 4096,
      ...extra,
    }),
  });

  // Límite de tokens por minuto: esperar y reintentar en vez de fallar.
  if (res.status === 429 && intentos < 4) {
    const texto = await res.text();
    let espera = 18000;
    const m = texto.match(/try again in ([\d.]+)s/i);
    if (m) espera = Math.ceil(parseFloat(m[1]) * 1000) + 1500;
    await dormir(Math.min(espera, 65000));
    return groq(system, user, maxTokens, temperatura, extra, intentos + 1);
  }

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`IA ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  return (data.choices[0].message.content || "").trim();
}

// Extrae el objeto JSON aunque el modelo agregue texto o razonamiento alrededor.
function extraerJson(txt) {
  txt = quitarCerca(txt);
  const i = txt.indexOf("{");
  const j = txt.lastIndexOf("}");
  if (i >= 0 && j > i) txt = txt.slice(i, j + 1);
  return JSON.parse(txt);
}

function quitarCerca(txt) {
  if (txt.startsWith("```")) {
    const lineas = txt.split("\n");
    if (lineas[0].startsWith("```")) lineas.shift();
    if (lineas.length && lineas[lineas.length - 1].trim() === "```") lineas.pop();
    txt = lineas.join("\n");
  }
  return txt;
}

// Recalcula la puntuación como promedio de las dimensiones (garantiza coherencia)
function normalizarAnalisis(a) {
  const dims = a.dimensiones || [];
  if (dims.length) {
    const suma = dims.reduce((s, d) => s + (Number(d.puntuacion) || 0), 0);
    const prom = Math.round((suma / dims.length) * 10) / 10;
    a.puntuacion_calidad = prom;
    a.nivel_riesgo = prom >= 8 ? "BAJO" : prom >= 6 ? "MEDIO" : prom >= 4 ? "ALTO" : "CRÍTICO";
    a.apto_para_despliegue = prom >= UMBRAL;
  }
  return a;
}

// Referencias a archivos locales (script src, link href, import) — para validar integridad.
function refsExternas(texto) {
  const refs = new Set();
  for (const m of texto.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)) refs.add(m[1]);
  for (const m of texto.matchAll(/<link[^>]+href=["']([^"']+)["']/gi)) refs.add(m[1]);
  for (const m of texto.matchAll(/(?:import|from)\s+["']([^"']+)["']/g)) refs.add(m[1]);
  const res = new Set();
  for (const r of refs) if (!/^(https?:|\/\/|data:)/.test(r)) res.add(r);
  return res;
}

function recomendacionesTexto(a) {
  const partes = [];
  for (const p of a.problemas_criticos || []) partes.push(`- [CRÍTICO] ${p}`);
  for (const r of a.recomendaciones_prioritarias || []) partes.push(`- ${r}`);
  for (const d of a.dimensiones || [])
    for (const r of d.recomendaciones || []) partes.push(`- (${d.nombre}) ${r}`);
  return partes.join("\n");
}

async function analizar(codigo, nombre) {
  const ext = (nombre || "").split(".").pop();
  // Se recorta el código para respetar el límite de tokens del plan gratis.
  const user = `Analiza este archivo.\nArchivo: ${nombre || "codigo"}\nLenguaje: ${ext}\n\n\`\`\`\n${codigo.slice(0, 7000)}\n\`\`\``;
  const raw = await groq(PROMPT_ANALISIS, user, 8000, 0, { reasoning_effort: "low" });
  return normalizarAnalisis(extraerJson(raw));
}

async function corregir(codigo, nombre, recomendaciones) {
  const ext = (nombre || "").split(".").pop();
  const maxT = Math.min(16000, Math.max(3000, Math.ceil(codigo.length / 4) + 3000));
  const user = `Archivo: ${nombre || "codigo"}\nLenguaje: ${ext}\n\nRecomendaciones a aplicar:\n${recomendaciones || "Mejora la calidad general."}\n\nCódigo actual:\n\`\`\`\n${codigo}\n\`\`\``;
  const raw = await groq(PROMPT_CORRECCION, user, maxT, 0.1, { reasoning_effort: "low" });
  return aplicarParches(codigo, raw);
}

// Aplica solo los bloques @@BUSCAR@@/@@REEMPLAZAR@@ que coinciden EXACTAMENTE con el código.
function aplicarParches(codigo, respuesta) {
  const re = /@@BUSCAR@@\r?\n([\s\S]*?)\r?\n@@REEMPLAZAR@@\r?\n([\s\S]*?)\r?\n@@FIN@@/g;
  let nuevo = codigo;
  let m;
  while ((m = re.exec(respuesta)) !== null) {
    const buscar = m[1];
    const reemplazar = m[2];
    if (buscar && nuevo.includes(buscar)) {
      nuevo = nuevo.replace(buscar, reemplazar);
    }
  }
  return nuevo;
}

// Explica los cambios entre el código original y el corregido (qué, por qué, mejora).
async function resumirCambios(original, corregido, nombre) {
  const sys = "Eres un revisor de código que explica los cambios de forma clara, breve y objetiva. Responde SOLO con JSON.";
  const user = `Compara el código ORIGINAL con el CORREGIDO del archivo ${nombre} y lista los cambios más importantes que se hicieron.
Para cada cambio indica: qué se cambió, por qué se cambió, y cuál fue la mejora obtenida.
Responde SOLO este JSON (máximo 6 cambios, los más relevantes):
{ "cambios": [ { "que": "descripción breve del cambio", "porque": "motivo", "mejora": "beneficio" } ] }

ORIGINAL:
\`\`\`
${original.slice(0, 6000)}
\`\`\`

CORREGIDO:
\`\`\`
${corregido.slice(0, 6000)}
\`\`\``;
  try {
    const raw = await groq(sys, user, 3000, 0, { reasoning_effort: "low" });
    const obj = extraerJson(raw);
    return Array.isArray(obj.cambios) ? obj.cambios : [];
  } catch (e) {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
//  Endpoints
// ─────────────────────────────────────────────────────────────

app.get("/api/health", (req, res) => {
  res.json({ ok: true, modelo: MODELO, configurado: Boolean(LLM_KEY) });
});

app.post("/api/analizar", async (req, res) => {
  try {
    const { codigo, nombre } = req.body;
    if (!codigo || !codigo.trim()) throw new Error("No se recibió código.");
    const analisis = await analizar(codigo, nombre);
    guardarReporte(analisis, nombre);
    res.json({ ok: true, analisis });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/corregir", async (req, res) => {
  try {
    let { codigo, nombre } = req.body;
    if (!codigo || !codigo.trim()) throw new Error("No se recibió código.");
    const original = codigo;

    const progresion = [];
    let analisis = null;

    for (let i = 0; i <= MAX_ITER; i++) {
      analisis = await analizar(codigo, nombre);
      progresion.push(analisis.puntuacion_calidad);
      if (analisis.puntuacion_calidad >= UMBRAL) break;
      if (i === MAX_ITER) break;
      const nuevo = await corregir(codigo, nombre, recomendacionesTexto(analisis));
      if (!nuevo || nuevo.trim() === codigo.trim()) break;
      if (nuevo.length < codigo.length * 0.6) break;
      const antes = refsExternas(codigo);
      const introduce = [...refsExternas(nuevo)].filter((r) => !antes.has(r));
      if (introduce.length) break;
      codigo = nuevo;
    }

    const huboCorreccion = codigo.trim() !== original.trim();
    if (analisis) guardarReporte(analisis, nombre, huboCorreccion);

    let cambios = [];
    if (huboCorreccion) {
      cambios = await resumirCambios(original, codigo, nombre);
    }

    res.json({
      ok: true,
      codigo_corregido: codigo,
      progresion,
      analisis,
      cambios,
      apto: Boolean(analisis && analisis.puntuacion_calidad >= UMBRAL),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/desplegar", async (req, res) => {
  try {
    const { codigo, nombre } = req.body;
    if (!codigo || !codigo.trim()) throw new Error("No se recibió código para desplegar.");
    if (!nombre) throw new Error("Falta el nombre del archivo.");

    const base = path.basename(nombre);
    if (base !== nombre || base.includes("..")) throw new Error("Nombre de archivo no válido.");

    const destino = path.join(HELPDESK_DIR, base);
    fs.writeFileSync(destino, codigo, "utf-8");

    res.json({
      ok: true,
      mensaje: `Archivo ${base} desplegado en el HelpDesk (${HELPDESK_URL}).`,
      url: HELPDESK_URL,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/reportes/ver/:uid", (req, res) => {
  const reg = leerHistorico().find((r) => r.uid === req.params.uid);
  if (!reg) return res.status(404).send("Reporte no encontrado.");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(reporteHtml(reg));
});

app.get("/api/reportes/:periodo", (req, res) => {
  try {
    const rangos = { diario: 1, semanal: 7, mensual: 30 };
    const dias = rangos[req.params.periodo] || 7;
    const desde = Date.now() - dias * 24 * 60 * 60 * 1000;
    const registros = leerHistorico().filter((r) => r && new Date(r.fecha).getTime() >= desde);
    if (!registros.length) return res.status(404).send("Aun no hay reportes en este periodo.");
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const c = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
    const filas = [
      ["Fecha y hora", "Archivo", "Puntuacion", "Nivel de riesgo", "Apto", "Corregido por IA", "Reporte"].join(";"),
    ];
    for (const r of registros) {
      const a = r.analisis || {};
      const url = `${baseUrl}/api/reportes/ver/${r.uid}`;
      const enlace = `=HYPERLINK(${c(url)},${c("Ver reporte")})`;
      filas.push([
        c(r.id_hora || r.fecha), c(r.archivo), c(a.puntuacion_calidad ?? ""),
        c(a.nivel_riesgo ?? ""), c(a.apto_para_despliegue ? "Si" : "No"),
        c(r.corregido ? "Si" : "No"), enlace,
      ].join(";"));
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="reportes-ia-${req.params.periodo}.csv"`);
    res.send("\uFEFF" + filas.join("\r\n"));
  } catch (e) {
    res.status(500).send("Error: " + e.message);
  }
});

app.listen(PORT, () => {
  console.log(`ARCE-CEREZO VALIDADOR escuchando en el puerto ${PORT} (modelo: ${MODELO})`);
});
