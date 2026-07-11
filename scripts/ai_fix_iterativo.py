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
import re
import json
import argparse
import subprocess
import tempfile
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


def _referencias_externas(texto):
    """Extrae referencias a archivos/recursos locales (script src, link href, import)."""
    refs = set()
    refs.update(re.findall(r'<script[^>]+src=["\']([^"\']+)["\']', texto, re.I))
    refs.update(re.findall(r'<link[^>]+href=["\']([^"\']+)["\']', texto, re.I))
    refs.update(re.findall(r'(?:import|from)\s+["\']([^"\']+)["\']', texto))
    # Ignorar recursos remotos (CDN) y data URIs
    return {r for r in refs if not r.startswith(("http", "//", "data:"))}


def validar_integridad(original, corregido, ruta):
    """
    Verifica que la corrección de la IA no rompa el proyecto ANTES de aplicarla.
    Devuelve (True, "ok") si es segura, o (False, motivo) si debe descartarse.
    """
    # 1. No debe salir muy recortado (señal de truncamiento o rotura).
    if len(corregido) < len(original) * 0.6:
        return False, "el resultado salió demasiado recortado"

    # 2. No debe introducir referencias a archivos locales que no existían.
    #    (Esto es lo que rompía el HelpDesk: separar CSS/JS a archivos inexistentes.)
    nuevas = _referencias_externas(corregido) - _referencias_externas(original)
    if nuevas:
        return False, f"introduce archivos que no existen: {', '.join(sorted(nuevas))}"

    # 3. La sintaxis debe seguir siendo válida según el lenguaje.
    ext = ruta.rsplit(".", 1)[-1].lower() if "." in ruta else ""
    if ext == "py":
        try:
            compile(corregido, ruta, "exec")
        except SyntaxError as e:
            return False, f"error de sintaxis Python: {e}"
    elif ext in ("js", "mjs"):
        try:
            with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as f:
                f.write(corregido)
                tmp = f.name
            resultado = subprocess.run(["node", "--check", tmp], capture_output=True)
            os.unlink(tmp)
            if resultado.returncode != 0:
                return False, "error de sintaxis JavaScript"
        except FileNotFoundError:
            pass  # node no disponible: se omite esta comprobación

    return True, "ok"


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

            # VALIDADOR DE INTEGRIDAD: no aplicar la corrección si rompería el proyecto.
            valido, motivo = validar_integridad(codigo_actual, corregido, ruta)
            if not valido:
                print(f"   🛡️ Corrección DESCARTADA por seguridad: {motivo}.")
                print(f"      Se conserva la versión anterior para no romper el proyecto.\n")
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
