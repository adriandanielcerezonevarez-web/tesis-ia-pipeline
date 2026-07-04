// ============================================================
//  Panel de Control del Pipeline CI/CD con IA — Backend
// ============================================================
//  Tesis: Diseño de un modelo de uso de IA en pipelines CI/CD
//  Autor: Adrian Daniel Cerezo Nevarez
//
//  API en Node/Express que consulta la API de GitHub para mostrar
//  los Pull Requests, sus puntuaciones de calidad, el diff del código
//  y ejecutar acciones (/fix-ia y desplegar).
// ============================================================

import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const REPO = process.env.GITHUB_REPO || "adriandanielcerezonevarez-web/tesis-ia-pipeline";
const TOKEN = process.env.GITHUB_TOKEN || "";
const API = "https://api.github.com";

// ─────────────────────────────────────────────────────────────
//  Utilidades de acceso a la API de GitHub
// ─────────────────────────────────────────────────────────────

async function gh(pathname, options = {}) {
  const headers = {
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "panel-pipeline-ia",
    ...(options.headers || {}),
  };
  if (TOKEN) headers["Authorization"] = `Bearer ${TOKEN}`;

  const res = await fetch(`${API}${pathname}`, { ...options, headers });
  if (!res.ok) {
    const texto = await res.text();
    throw new Error(`GitHub API ${res.status}: ${texto.slice(0, 200)}`);
  }
  // Los endpoints que devuelven diff usan texto plano
  const tipo = res.headers.get("content-type") || "";
  return tipo.includes("application/json") ? res.json() : res.text();
}

// Extrae la puntuación de calidad (0-10) de un texto de reporte markdown.
function extraerPuntuacion(texto) {
  if (!texto) return null;
  const m = texto.match(/Puntuaci[oó]n[^\d]{0,40}?(\d+(?:\.\d+)?)\s*\/\s*10/i);
  return m ? parseFloat(m[1]) : null;
}

// Extrae el nivel de riesgo (BAJO/MEDIO/ALTO/CRÍTICO) de un reporte.
function extraerRiesgo(texto) {
  if (!texto) return null;
  const m = texto.match(/\b(CR[IÍ]TICO|ALTO|MEDIO|BAJO)\b/i);
  return m ? m[1].toUpperCase() : null;
}

// Extrae una progresión de puntuaciones tipo "2 → 6 → 8" de un comentario.
function extraerProgresion(texto) {
  if (!texto) return null;
  const m = texto.match(/(\d+(?:\.\d+)?(?:\s*→\s*\d+(?:\.\d+)?)+)\s*\/?\s*10/);
  if (!m) return null;
  return m[1].split("→").map((s) => parseFloat(s.trim()));
}

// Devuelve los comentarios de un PR (que son "issue comments").
async function comentariosDe(numero) {
  return gh(`/repos/${REPO}/issues/${numero}/comments?per_page=100`);
}

// Busca el reporte de análisis más reciente publicado por el bot en un PR.
function ultimoReporte(comentarios) {
  const reportes = comentarios.filter(
    (c) => c.user && c.user.type === "Bot" &&
    /Reporte de An[aá]lisis|Correcci[oó]n autom[aá]tica/i.test(c.body || "")
  );
  return reportes.length ? reportes[reportes.length - 1] : null;
}

// ─────────────────────────────────────────────────────────────
//  Endpoints de la API del panel
// ─────────────────────────────────────────────────────────────

// Estado / salud
app.get("/api/health", (req, res) => {
  res.json({ ok: true, repo: REPO, autenticado: Boolean(TOKEN) });
});

// Lista de Pull Requests con su puntuación
app.get("/api/pulls", async (req, res) => {
  try {
    const pulls = await gh(`/repos/${REPO}/pulls?state=all&per_page=30&sort=created&direction=desc`);
    const resultado = [];
    for (const pr of pulls) {
      let puntuacion = null;
      let riesgo = null;
      let progresion = null;
      try {
        const comentarios = await comentariosDe(pr.number);
        const rep = ultimoReporte(comentarios);
        if (rep) {
          puntuacion = extraerPuntuacion(rep.body);
          riesgo = extraerRiesgo(rep.body);
        }
        // Buscar progresión en comentarios de corrección
        for (const c of comentarios) {
          const p = extraerProgresion(c.body || "");
          if (p) progresion = p;
        }
      } catch (e) { /* sin comentarios */ }

      resultado.push({
        numero: pr.number,
        titulo: pr.title,
        estado: pr.state,
        merged: Boolean(pr.merged_at),
        rama: pr.head ? pr.head.ref : "",
        autor: pr.user ? pr.user.login : "",
        creado: pr.created_at,
        url: pr.html_url,
        puntuacion,
        riesgo,
        progresion,
      });
    }
    res.json(resultado);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Detalle de un PR: info + reporte markdown más reciente
app.get("/api/pulls/:num", async (req, res) => {
  try {
    const num = req.params.num;
    const pr = await gh(`/repos/${REPO}/pulls/${num}`);
    const comentarios = await comentariosDe(num);
    const rep = ultimoReporte(comentarios);
    res.json({
      numero: pr.number,
      titulo: pr.title,
      estado: pr.state,
      merged: Boolean(pr.merged_at),
      rama: pr.head ? pr.head.ref : "",
      base: pr.base ? pr.base.ref : "",
      autor: pr.user ? pr.user.login : "",
      creado: pr.created_at,
      url: pr.html_url,
      puntuacion: rep ? extraerPuntuacion(rep.body) : null,
      riesgo: rep ? extraerRiesgo(rep.body) : null,
      reporte: rep ? rep.body : null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Diff (archivos modificados con su parche) de un PR
app.get("/api/pulls/:num/diff", async (req, res) => {
  try {
    const num = req.params.num;
    const files = await gh(`/repos/${REPO}/pulls/${num}/files?per_page=100`);
    res.json(files.map((f) => ({
      archivo: f.filename,
      estado: f.status,
      adiciones: f.additions,
      eliminaciones: f.deletions,
      patch: f.patch || "",
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Acción: lanzar la corrección con IA (comenta /fix-ia en el PR)
app.post("/api/pulls/:num/fix-ia", async (req, res) => {
  try {
    if (!TOKEN) throw new Error("Falta GITHUB_TOKEN para ejecutar acciones.");
    const num = req.params.num;
    await gh(`/repos/${REPO}/issues/${num}/comments`, {
      method: "POST",
      body: JSON.stringify({ body: "/fix-ia" }),
    });
    res.json({ ok: true, mensaje: "Corrección con IA solicitada. El pipeline la procesará en ~1-2 min." });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Acción: desplegar (fusiona el PR a main, lo que dispara el despliegue automático)
app.post("/api/pulls/:num/deploy", async (req, res) => {
  try {
    if (!TOKEN) throw new Error("Falta GITHUB_TOKEN para ejecutar acciones.");
    const num = req.params.num;
    await gh(`/repos/${REPO}/pulls/${num}/merge`, {
      method: "PUT",
      body: JSON.stringify({ merge_method: "merge" }),
    });
    res.json({ ok: true, mensaje: "PR fusionado a main. El despliegue automático (Job 4) se está ejecutando." });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Métricas agregadas del pipeline
app.get("/api/metrics", async (req, res) => {
  try {
    const pulls = await gh(`/repos/${REPO}/pulls?state=all&per_page=50`);
    let totalPRs = pulls.length;
    let desplegados = 0;
    let correcciones = 0;
    let mejoras = [];
    const puntuaciones = [];

    for (const pr of pulls) {
      if (pr.merged_at) desplegados++;
      try {
        const comentarios = await comentariosDe(pr.number);
        const rep = ultimoReporte(comentarios);
        if (rep) {
          const p = extraerPuntuacion(rep.body);
          if (p != null) puntuaciones.push(p);
        }
        for (const c of comentarios) {
          if (/Correcci[oó]n autom[aá]tica/i.test(c.body || "")) correcciones++;
          const prog = extraerProgresion(c.body || "");
          if (prog && prog.length >= 2) mejoras.push(prog[prog.length - 1] - prog[0]);
        }
      } catch (e) { /* ignore */ }
    }

    const promedio = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
    res.json({
      total_prs: totalPRs,
      desplegados,
      correcciones_ia: correcciones,
      puntuacion_promedio: Number(promedio(puntuaciones).toFixed(1)),
      mejora_promedio: Number(promedio(mejoras).toFixed(1)),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Cualquier otra ruta sirve el frontend (SPA)
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Panel del pipeline IA escuchando en el puerto ${PORT} (repo: ${REPO})`);
});
