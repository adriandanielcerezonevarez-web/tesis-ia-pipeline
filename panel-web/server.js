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
//  Prompts con rúbrica fija (para puntuaciones consistentes)
// ─────────────────────────────────────────────────────────────

const PROMPT_ANALISIS = `
Eres un revisor experto de calidad de software. Analiza el código con RIGOR y CONSISTENCIA.

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
Eres un ingeniero experto. Mejora la calidad del código de forma CONSERVADORA, sin romper nada.

REGLAS OBLIGATORIAS (respétalas todas):
1. Devuelve el archivo COMPLETO, sin recortar ni omitir nada. Prohibido usar "..." o resúmenes.
2. NO reestructures el archivo. NO separes el CSS ni el JavaScript a archivos externos:
   si están embebidos (dentro de <style> o <script>), DÉJALOS embebidos exactamente igual.
3. NO cambies, agregues ni quites etiquetas <link>, <script src>, ni ninguna referencia a archivos
   o recursos externos. Mantén las MISMAS rutas y los mismos recursos que ya tenía.
4. NO agregues Content-Security-Policy ni meta etiquetas nuevas. NO inventes valores integrity/SRI.
5. CONSERVA todos los estilos y la estructura visual EXACTAMENTE: el archivo debe verse y funcionar
   IDÉNTICO al original. Debe funcionar POR SÍ SOLO, sin depender de archivos nuevos que no existían.
6. Solo puedes: quitar credenciales/secretos embebidos, corregir vulnerabilidades de lógica (ej.
   inyección), mejorar nombres de variables internas y agregar comentarios. NADA más.

Devuelve ÚNICAMENTE el código corregido completo, sin explicaciones y SIN delimitadores markdown.`.trim();

// ─────────────────────────────────────────────────────────────
//  Llamada a Groq
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
  // Se recorta el código para respetar el límite de tokens del plan gratis de Groq.
  const user = `Analiza este archivo.\nArchivo: ${nombre || "codigo"}\nLenguaje: ${ext}\n\n\`\`\`\n${codigo.slice(0, 7000)}\n\`\`\``;
  const raw = await groq(PROMPT_ANALISIS, user, 8000, 0, { reasoning_effort: "low" });
  return normalizarAnalisis(extraerJson(raw));
}

async function corregir(codigo, nombre, recomendaciones) {
  const ext = (nombre || "").split(".").pop();
  const maxT = Math.min(24000, Math.max(4000, Math.ceil(codigo.length / 2) + 3000));
  const user = `Corrige este archivo.\nArchivo: ${nombre || "codigo"}\nLenguaje: ${ext}\n\nRecomendaciones:\n${recomendaciones || "Mejora la calidad general."}\n\nCódigo actual:\n\`\`\`\n${codigo}\n\`\`\``;
  const raw = await groq(PROMPT_CORRECCION, user, maxT, 0.1, { reasoning_effort: "low" });
  return quitarCerca(raw).trim() + "\n";
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
      // Freno de seguridad: si el resultado salió muy recortado, está roto -> no aplicar.
      if (nuevo.length < codigo.length * 0.6) break;
      codigo = nuevo;
    }

    // Explicar qué cambió (solo si hubo cambios reales)
    let cambios = [];
    if (codigo.trim() !== original.trim()) {
      cambios = await resumirCambios(original, codigo, nombre);
    }

    res.json({
      ok: true,
      codigo_corregido: codigo,
      progresion,
      analisis,
      apto: analisis.puntuacion_calidad >= UMBRAL,
      cambios,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Despliegue REAL al HelpDesk: escribe el archivo en la carpeta que sirve el HelpDesk.
app.post("/api/desplegar", async (req, res) => {
  try {
    const { nombre, codigo } = req.body;
    if (!codigo || !codigo.trim()) throw new Error("No hay código para desplegar.");
    // Nombre seguro (sin rutas relativas) para evitar escribir fuera de la carpeta
    const archivo = path.basename(nombre || "index.html");
    if (!fs.existsSync(HELPDESK_DIR)) throw new Error("La carpeta del HelpDesk no está montada en el servidor.");
    fs.writeFileSync(path.join(HELPDESK_DIR, archivo), codigo, "utf-8");
    res.json({
      ok: true,
      mensaje: `Desplegado en el HelpDesk: se actualizó "${archivo}". Míralo en ${HELPDESK_URL}`,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`App de validación IA escuchando en el puerto ${PORT}`);
});
