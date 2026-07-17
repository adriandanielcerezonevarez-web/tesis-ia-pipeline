#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
render_reporte.py
Convierte un reporte de analisis (reporte-ia.json) en una IMAGEN PNG
con el aspecto del reporte de calidad del pipeline CI/CD.

Uso:
    python render_reporte.py reporte-ia.json salida.png [--titulo "texto extra"]

No requiere navegador: usa solo matplotlib (fiable en GitHub Actions).
Tesis: Diseno de un modelo de uso de IA en pipelines CI/CD - Arce/Cerezo.
"""
import json
import sys
import argparse
import textwrap
from datetime import datetime

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, Rectangle

# Paleta (tonos del panel / reporte)
COL_FONDO = "#0f1419"
COL_TARJETA = "#1a2029"
COL_HEADER = "#151b24"
COL_TEXTO = "#e6edf3"
COL_SUB = "#9aa7b4"
COL_BORDE = "#2d3742"
COL_ACENTO = "#f26b21"
COL_BIEN = "#2ea043"
COL_MEJ = "#d29922"
COL_PROB = "#e5534b"
COL_CRIT = "#a5202a"

ESTADO_COLOR = {
    "BIEN": COL_BIEN, "MEJORABLE": COL_MEJ, "PROBLEMA": COL_PROB,
    "CRITICO": COL_CRIT, "CRÍTICO": COL_CRIT,
}
NIVEL_COLOR = {
    "BAJO": COL_BIEN, "MEDIO": COL_MEJ, "ALTO": COL_PROB,
    "CRITICO": COL_CRIT, "CRÍTICO": COL_CRIT,
}


def _wrap(txt, ancho):
    return "\n".join(textwrap.wrap(str(txt), ancho)) or str(txt)


def render(json_path, out_png, titulo_extra=""):
    with open(json_path, encoding="utf-8") as f:
        datos = json.load(f)
    if isinstance(datos, dict):
        datos = [datos] if "analisis" in datos else [{"archivo": "codigo", "analisis": datos}]

    validos = [r for r in datos if "error" not in r.get("analisis", {})]
    puntajes = [float(r["analisis"].get("puntuacion_calidad", 0)) for r in validos]
    promedio = round(sum(puntajes) / len(puntajes), 1) if puntajes else 0
    bloqueados = [r for r in validos if not r["analisis"].get("apto_para_merge", True)]
    con_error = [r for r in datos if "error" in r.get("analisis", {})]

    # Altura dinamica segun contenido
    alto = 3.2  # header + resumen
    for r in validos:
        a = r["analisis"]
        alto += 0.9
        alto += 0.28 * len(a.get("recomendaciones_prioritarias", [])[:4])
        alto += 0.30 * len(a.get("dimensiones", [])[:7])
        alto += 0.9
    alto = max(alto, 6)

    fig = plt.figure(figsize=(9.2, alto), dpi=150)
    fig.patch.set_facecolor(COL_FONDO)
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_xlim(0, 100)
    ax.set_ylim(0, alto * 10)
    ax.axis("off")
    Y = alto * 10

    def caja(x, y, w, h, color, borde=COL_BORDE, r=0.6):
        ax.add_patch(FancyBboxPatch((x, y - h), w, h,
                     boxstyle=f"round,pad=0.1,rounding_size={r}",
                     linewidth=1, edgecolor=borde, facecolor=color, zorder=1))

    # ── Header ──
    caja(3, Y - 1.5, 94, 9.5, COL_HEADER, COL_ACENTO)
    ax.text(6, Y - 4.2, "Reporte de Analisis de Calidad de Codigo",
            color=COL_TEXTO, fontsize=15, fontweight="bold", zorder=2)
    ax.text(6, Y - 7, "Pipeline CI/CD  -  Modelo GPT-OSS 120B (open source)",
            color=COL_ACENTO, fontsize=9.5, zorder=2)
    sub = f"Generado el {datetime.now().strftime('%Y-%m-%d %H:%M')}"
    if titulo_extra:
        sub += f"   |   {titulo_extra}"
    ax.text(6, Y - 9.4, sub, color=COL_SUB, fontsize=8.5, zorder=2)
    y = Y - 13

    # ── Resumen ejecutivo ──
    ax.text(4, y, "Resumen Ejecutivo", color=COL_TEXTO, fontsize=12, fontweight="bold")
    y -= 3
    metricas = [
        ("Archivos analizados", str(len(validos))),
        ("Puntuacion promedio", f"{promedio} / 10"),
        ("Archivos que bloquean merge", str(len(bloqueados))),
        ("Archivos con error", str(len(con_error))),
    ]
    caja(3, y + 1.5, 94, 2.2 * len(metricas) + 1, COL_TARJETA)
    for i, (k, v) in enumerate(metricas):
        yy = y - i * 2.2
        ax.text(6, yy, k, color=COL_SUB, fontsize=9.5, va="center")
        col = COL_ACENTO if "promedio" in k else COL_TEXTO
        ax.text(70, yy, v, color=col, fontsize=9.5, fontweight="bold", va="center")
    y -= 2.2 * len(metricas) + 3

    # ── Por archivo ──
    for r in validos:
        a = r["analisis"]
        archivo = r.get("archivo", "codigo")
        punt = a.get("puntuacion_calidad", "?")
        nivel = str(a.get("nivel_riesgo", "?")).upper()
        apto = a.get("apto_para_merge", True)
        ncol = NIVEL_COLOR.get(nivel, COL_SUB)

        ax.add_patch(Rectangle((3, y - 0.3), 1.2, 2.4, color=COL_ACENTO, zorder=2))
        ax.text(6, y + 1, archivo, color=COL_TEXTO, fontsize=11, fontweight="bold", va="center")
        y -= 2.4
        estado_txt = "Apto para merge" if apto else "Requiere correcciones"
        estado_col = COL_BIEN if apto else COL_PROB
        ax.text(6, y, f"Puntuacion: {punt}/10", color=COL_TEXTO, fontsize=9.5, va="center")
        ax.text(34, y, f"Riesgo: {nivel}", color=ncol, fontsize=9.5, fontweight="bold", va="center")
        ax.text(60, y, estado_txt, color=estado_col, fontsize=9.5, fontweight="bold", va="center")
        y -= 3

        recs = a.get("recomendaciones_prioritarias", [])[:4]
        if recs:
            ax.text(6, y, "Recomendaciones prioritarias", color=COL_TEXTO,
                    fontsize=9.5, fontweight="bold", va="center")
            y -= 2.4
            for rec in recs:
                linea = _wrap(rec, 95)
                nlin = linea.count("\n") + 1
                ax.text(8, y, "-", color=COL_ACENTO, fontsize=9, va="top")
                ax.text(10, y, linea, color=COL_SUB, fontsize=8.5, va="top")
                y -= 2.3 * nlin

        dims = a.get("dimensiones", [])[:7]
        if dims:
            y -= 1
            ax.text(6, y, "Analisis por dimension", color=COL_TEXTO,
                    fontsize=9.5, fontweight="bold", va="center")
            y -= 2.6
            for d in dims:
                nombre = d.get("nombre", "?")
                dp = d.get("puntuacion", "?")
                est = str(d.get("estado", "?")).upper()
                ecol = ESTADO_COLOR.get(est, COL_SUB)
                caja(6, y + 1, 88, 2.3, COL_TARJETA)
                ax.text(9, y, nombre, color=COL_TEXTO, fontsize=8.8, va="center")
                ax.text(66, y, f"{dp}/10", color=COL_TEXTO, fontsize=8.8, va="center")
                ax.add_patch(Rectangle((76, y - 0.7), 3, 1.4, color=ecol, zorder=3))
                ax.text(80, y, est, color=ecol, fontsize=8.5, fontweight="bold", va="center")
                y -= 2.7
        y -= 3

    ax.text(50, 2, "Reporte generado por el sistema de analisis de IA integrado en el pipeline CI/CD - Arce/Cerezo",
            color=COL_SUB, fontsize=7, ha="center", style="italic")

    fig.savefig(out_png, facecolor=COL_FONDO, bbox_inches="tight", pad_inches=0.15)
    plt.close(fig)
    return out_png


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("json_path")
    ap.add_argument("out_png")
    ap.add_argument("--titulo", default="")
    args = ap.parse_args()
    render(args.json_path, args.out_png, args.titulo)
    print(f"Imagen generada: {args.out_png}")
