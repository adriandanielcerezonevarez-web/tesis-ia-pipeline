#!/usr/bin/env python3
"""
ai_fix_iterativo.py
===================
Orquestador de corrección iterativa con IA para pipelines CI/CD.

Repite el ciclo (analizar -> corregir) sobre cada archivo hasta que la
puntuación de calidad del modelo alcance un umbral mínimo (por defecto 7/10)
o hasta agotar el número máximo de iteraciones. Guarda el historial de
puntuaciones para mostrar la progresión (por ejemplo: 2 -> 5 -> 7).

IMPORTANTE: la corrección NO se detiene apenas se quita el bloqueo (sintaxis o
patrón peligroso). Usa la puntuación REAL del modelo sobre las líneas cambiadas
('puntuacion_llm'), así primero corrige el error que bloquea y luego sigue
mejorando la CALIDAD del código hasta llegar al umbral o no poder mejorar más.

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

from ai_code_analyzer import analizar_con_ia, leer_archivo, obtener_cambios
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
        tmp = None
        try:
            with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as f:
                f.write(corregido)
                tmp = f.name
            resultado = subprocess.run(["node", "--check", tmp], capture_output=True)
            if resultado.returncode != 0:
                return False, "error de sintaxis JavaScript"
        except FileNotFoundError:
            pass  # node no disponible: se omite esta comprobación
        finally:
            if tmp:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass

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
    print(f"  CORRECCIÓN ITERATIVA CON IA — objetivo de calidad: {args.umbral}/10")
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
            # Se recalcula el diff EN CADA iteración: así, tras aplicar una corrección,
            # el análisis "ve" las líneas ya arregladas (en vez de quedarse con el diff viejo).
            cambios = obtener_cambios(ruta)
            if iteracion == 0 and cambios:
                print(f"   Enfocando en {len(cambios.splitlines())} línea(s) cambiada(s) del PR.")

            analisis = analizar_con_ia(cliente, codigo_actual, nombre, extension, cambios)
            if "error" in analisis:
                print(f"   [WARN] Error de análisis: {analisis['error']}")
                break

            # La puntuación mostrada es el promedio real de las 7 dimensiones.
            score = float(analisis.get("puntuacion_calidad", 0) or 0)
            scores.append(score)
            apto = bool(analisis.get("apto_para_merge"))
            print(f"   Iteración {iteracion}: calidad {score}/10 | apto: {apto}")

            # Se detiene cuando el cambio queda APTO: puntuación >= umbral Y sin bloqueos
            # objetivos (sintaxis / patrón peligroso). Así corrige el bloqueo Y mejora la calidad.
            if apto:
                print(f"   ✅ Apto (calidad {score} ≥ {args.umbral} y sin bloqueos objetivos) "
                      f"tras {iteracion} corrección(es).\n")
                break

            if iteracion == args.max_iter:
                print(f"   ⚠️ No quedó apto tras {args.max_iter} correcciones "
                      f"(mejor calidad: {score}).\n")
                break

            # Corregir aplicando las recomendaciones del análisis actual.
            # Si la corrección rompe la integridad, se reintenta UNA vez
            # informando al modelo el error exacto que produjo.
            recomendaciones = construir_recomendaciones(analisis)
            aviso = ""
            aplicado = False
            for intento in range(2):
                corregido = corregir_con_ia(cliente, codigo_actual, nombre, extension,
                                            recomendaciones + aviso, cambios)
                if not corregido or corregido.strip() == codigo_actual.strip():
                    break
                valido, motivo = validar_integridad(codigo_actual, corregido, ruta)
                if valido:
                    Path(ruta).write_text(corregido, encoding="utf-8")
                    aplicado = True
                    break
                print(f"   🛡️ Corrección descartada (intento {intento + 1}): {motivo}.")
                aviso = (
                    "\n- [MUY IMPORTANTE] Tu parche anterior fue RECHAZADO porque produjo: "
                    f"{motivo}. Devuelve un parche MÍNIMO que corrija solo la línea dañada "
                    "SIN agregar ni quitar llaves, paréntesis o bloques fuera de esa línea."
                )
            if not aplicado:
                print(f"   = No se pudo aplicar una corrección segura; se detiene.\n")
                break

        historial[ruta] = scores

    # Guardar historial para el reporte del pipeline
    Path("historial-correccion.json").write_text(
        json.dumps(historial, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    print(f"{'='*60}")
    print("  Resumen de progresión de calidad:")
    for archivo, scores in historial.items():
        progresion = " → ".join(str(s) for s in scores) if scores else "sin datos"
        print(f"   {archivo}: {progresion}")
    print(f"{'='*60}\n")


if __name__ == "__main__":
    main()
