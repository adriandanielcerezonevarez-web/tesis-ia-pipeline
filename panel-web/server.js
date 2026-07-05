// ============================================================
//  App de Validación y Corrección de Código con IA — Backend
// ============================================================
//  App autónoma (no depende de GitHub). El usuario sube código,
//  la IA lo analiza, lo corrige y decide si es apto para desplegar.
//
//  Tesis: Diseño de un modelo de uso de IA en pipelines CI/CD
//  Autor: Adrian Daniel Cerezo Nevarez
// ============================================================

import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const MODELO = "llama-3.3-70b-versatile";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const UMBRAL = 8;        // nota mínima para desplegar
const MAX_ITER = 4;      // correcciones máximas por archivo

// ─────────────────────────────────────────────────────────────
//  Prompts (mismos criterios que el analizador de la tesis)
// ─────────────────────────────────────────────────────────────

const PROMPT_ANALISIS = `
Eres un experto en calidad de software. Analiza el código y responde SOLO con JSON puro (sin markdown):
{
  "resumen_general": "texto breve",
  "puntuacion_calidad": <número 1 a 10>,
  "nivel_riesgo": "BAJO|MEDIO|ALTO|CRÍTICO",
  "dimensiones": [
    {"nombre": "Código Limpio", "puntuacion": <1-10>, "estado": "BIEN|MEJORABLE|PROBLEMA|CRÍTICO", "hallazgos": ["..."], "recomendaciones": ["..."]}
  ],
  "problemas_criticos": ["..."],
  "recomendaciones_prioritarias": ["..."],
  "apto_para_despliegue": true|false
}
Evalúa 7 dimensiones: Código Limpio, Modularidad, Legibilidad, Manejo de Errores, Mantenibilidad, Seguridad Básica, Documentación.
Responde ÚNICAMENTE el JSON.`.trim();

const PROMPT_CORRECCION = `
Eres un ingeniero experto en refactorización. Reescribe el código aplicando las recomendaciones y las buenas prácticas
(código limpio, modularidad, legibilidad, manejo de errores, mantenibilidad, seguridad, documentación).
REGLAS: no cambies la funcionalidad; conserva el lenguaje; no agregues dependencias nuevas.
Devuelve ÚNICAMENTE el código corregido completo, sin explicaciones y SIN delimitadores markdown.`.trim();

// ─────────────────────────────────────────────────────────────
//  Llamada a Groq
// ─────────────────────────────────────────────────────────────

async function groq(system, user, maxTokens) {
  if (!GROQ_API_KEY) throw new Error("Falta GROQ_API_KEY en el servidor.");
  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODELO,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.15,
      max_tokens: maxTokens || 4096,
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Groq ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.choices[0].message.content.trim();
}

function limpiarJson(txt) {
  if (txt.startsWith("```")) {
    const lineas = txt.split("\n");
    if (lineas[0].startsWith("```")) lineas.shift();
    if (lineas.length && lineas[lineas.length - 1].trim() === "```") lineas.pop();
    txt = lineas.join("\n");
  }
  return txt;
}

function limpiarCodigo(txt) {
  if (txt.startsWith("```")) {
    const lineas = txt.split("\n");
    if (lineas[0].startsWith("```")) lineas.shift();
    if (lineas.length && lineas[lineas.length - 1].trim() === "```") lineas.pop();
    txt = lineas.join("\n");
  }
  return txt.trim() + "\n";
}

function recomendacionesTexto(analisis) {
  const partes = [];
  for (const p of analisis.problemas_criticos || []) partes.push(`- [CRÍTICO] ${p}`);
  for (const r of analisis.recomendaciones_prioritarias || []) partes.push(`- ${r}`);
  for (const d of analisis.dimensiones || [])
    for (const r of d.recomendaciones || []) partes.push(`- (${d.nombre}) ${r}`);
  return partes.join("\n");
}

async function analizar(codigo, nombre) {
  const ext = (nombre || "").split(".").pop();
  const user = `Analiza este archivo.\nArchivo: ${nombre || "codigo"}\nLenguaje: ${ext}\n\n\`\`\`\n${codigo.slice(0, 12000)}\n\`\`\``;
  const raw = await groq(PROMPT_ANALISIS, user, 4096);
  return JSON.parse(limpiarJson(raw));
}

async function corregir(codigo, nombre, recomendaciones) {
  const ext = (nombre || "").split(".").pop();
  const user = `Corrige este archivo.\nArchivo: ${nombre || "codigo"}\nLenguaje: ${ext}\n\nRecomendaciones:\n${recomendaciones || "Mejora la calidad general."}\n\nCódigo actual:\n\`\`\`\n${codigo}\n\`\`\``;
  const raw = await groq(PROMPT_CORRECCION, user, 8192);
  return limpiarCodigo(raw);
}

// ─────────────────────────────────────────────────────────────
//  Endpoints
// ─────────────────────────────────────────────────────────────

app.get("/api/health", (req, res) => {
  res.json({ ok: true, modelo: MODELO, configurado: Boolean(GROQ_API_KEY) });
});

// Analiza el código y devuelve el reporte con la puntuación
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

// Corrige el código iterativamente hasta alcanzar el umbral (8) o el máximo de intentos
app.post("/api/corregir", async (req, res) => {
  try {
    let { codigo, nombre } = req.body;
    if (!codigo || !codigo.trim()) throw new Error("No se recibió código.");

    const progresion = [];
    let analisis = null;

    for (let i = 0; i <= MAX_ITER; i++) {
      analisis = await analizar(codigo, nombre);
      progresion.push(analisis.puntuacion_calidad);
      if (analisis.puntuacion_calidad >= UMBRAL) break;
      if (i === MAX_ITER) break;
      const recs = recomendacionesTexto(analisis);
      const nuevo = await corregir(codigo, nombre, recs);
      if (!nuevo || nuevo.trim() === codigo.trim()) break;
      codigo = nuevo;
    }

    res.json({
      ok: true,
      codigo_corregido: codigo,
      progresion,
      analisis,
      apto: analisis.puntuacion_calidad >= UMBRAL,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// "Despliegue": la app pide permiso para integrarse al sistema del usuario.
// (En la tesis se usa el HelpDesk; aquí se registra la intención de integración.)
app.post("/api/desplegar", async (req, res) => {
  try {
    const { destino } = req.body || {};
    res.json({
      ok: true,
      mensaje: `Integración autorizada. Código apto desplegado en el entorno "${destino || "producción"}".`,
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
