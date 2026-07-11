#!/usr/bin/env python3
"""
ai_fix_iterativo.py
===================
Orquestador de corrección iterativa con IA para pipelines CI/CD.

Repite el ciclo (analizar -> corregir) sobre cada archivo hasta que la
puntuación de calidad alcance un umbral mínimo (por defecto 8/10) o hasta
agotar el número máximo de iteraciones. Guarda el historial de puntuaciones
para mostrar la progresión (por ejemplo: 2 -> 6 -> 8).

Comando en el Pull Request: /fix-ia

Tesis: Diseño de un modelo de uso de IA en pipelines CI/CD open source
Autor: Adrian Daniel Cerezo Nevarez
"""

import os
import sys
import json
import argparse
from pathlib import Path

# Permitir importar los módulos hermanos sin importar el directorio de trabajo
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    from openai import OpenAI
except ImportError:
    print("ERROR: Librería 'openai' no instalada. Ejecuta: pip install openai")
    sys.exit(1)

from ai_code_analyzer import analizar_con_ia, leer_archivo
from ai_code_fixer import corregir_con_ia

CEREBRAS_BASE_URL = "https://api.cerebras.ai/v1"


def construir_recomendaciones(analisis: dict) -> str:
    """Arma un texto con las recomendaciones del análisis para guiar la corrección."""
    partes = []
    for p in analisis.get("problemas_criticos", []):
        partes.append(f"- [CRÍTICO] {p}")
    for r in analisis.get("recomendaciones_prioritarias", []):
        partes.append(f"- {r}")
    for dim in analisis.get("dimensiones", []):
        for r in dim.get("recomendaciones", []):
            partes.append(f"- ({dim.get('nombre', '?')}) {r}")
    return "\n".join(partes)


def main():
    parser = argparse.ArgumentParser(
        description="Corrector iterativo de código con IA (hasta alcanzar un umbral de calidad)"
    )
    parser.add_argument("archivos", nargs="+", help="Archivos de código a corregir")
    parser.add_argument("--umbral", "-u", type=float, default=7.0,
                        help="Puntuación mínima objetivo (default: 7.0)")
    parser.add_argument("--max-iter", "-m", type=int, default=4,
                        help="Máximo de correcciones por archivo (default: 4)")
    args = parser.parse_args()

    api_key = os.environ.get("CEREBRAS_API_KEY")
    if not api_key:
        print("ERROR: Variable de entorno CEREBRAS_API_KEY no configurada.")
        sys.exit(1)

    cliente = OpenAI(api_key=api_key, base_url=CEREBRAS_BASE_URL)
    historial = {}

    print(f"\n{'='*60}")
    print(f"  CORRECCIÓN ITERATIVA CON IA — objetivo: {args.umbral}/10")
    print(f"{'='*60}\n")

    for ruta in args.archivos:
        contenido, extension = leer_archivo(ruta)
        if not contenido:
            print(f"[SKIP] {ruta}: vacío o ilegible.\n")
            continue

        nombre = Path(ruta).name
        scores = []
        print(f"📄 {ruta}")

        for iteracion in range(args.max_iter + 1):
            codigo_actual = Path(ruta).read_text(encoding="utf-8", errors="replace")
            analisis = analizar_con_ia(cliente, codigo_actual, nombre, extension)

            if "error" in analisis:
                print(f"   [WARN] Error de análisis: {analisis['error']}")
                break

            score = analisis.get("puntuacion_calidad", 0)
            scores.append(score)
            print(f"   Iteración {iteracion}: puntuación {score}/10")

            if score >= args.umbral:
                print(f"   ✅ Alcanzó el objetivo ({score} ≥ {args.umbral}) "
                      f"tras {iteracion} corrección(es).\n")
                break

            if iteracion == args.max_iter:
                print(f"   ⚠️ No alcanzó {args.umbral} tras {args.max_iter} correcciones "
                      f"(mejor puntuación: {score}).\n")
                break

            # Corregir aplicando las recomendaciones del análisis actual
            recomendaciones = construir_recomendaciones(analisis)
            corregido = corregir_con_ia(cliente, codigo_actual, nombre, extension, recomendaciones)

            if not corregido or corregido.strip() == codigo_actual.strip():
                print(f"   = La IA no aplicó más cambios; se detiene.\n")
                break

            Path(ruta).write_text(corregido, encoding="utf-8")

        historial[ruta] = scores

    # Guardar historial para el reporte del pipeline
    Path("historial-correccion.json").write_text(
        json.dumps(historial, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    print(f"{'='*60}")
    print("  Resumen de progresión:")
    for archivo, scores in historial.items():
        progresion = " → ".join(str(s) for s in scores) if scores else "sin datos"
        print(f"   {archivo}: {progresion}")
    print(f"{'='*60}\n")


if __name__ == "__main__":
    main()
