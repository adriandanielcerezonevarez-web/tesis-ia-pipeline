#!/usr/bin/env python3
"""
ai_code_fixer.py
================
Módulo de corrección automática de código con IA para pipelines CI/CD.
Toma el código y las recomendaciones del análisis previo (ai_code_analyzer.py)
y usa el modelo de lenguaje para reescribir el código aplicando las mejoras.

Comando en el Pull Request: /fix-ia

Tesis: Diseño de un modelo de uso de IA en pipelines CI/CD open source
Autor: Adrian Daniel Cerezo Nevarez
"""

import os
import sys
import json
import argparse
from pathlib import Path

try:
    from openai import OpenAI
except ImportError:
    print("ERROR: Librería 'openai' no instalada. Ejecuta: pip install openai")
    sys.exit(1)

# Proveedor de IA: Cerebras (endpoint compatible con OpenAI)
CEREBRAS_BASE_URL = "https://api.cerebras.ai/v1"

# ─────────────────────────────────────────────────────────────
#  CONFIGURACIÓN DEL MODELO DE IA (igual que el analizador)
# ─────────────────────────────────────────────────────────────

MODELO_IA = "gpt-oss-120b"               # Modelo open source (GPT-OSS 120B) vía Cerebras
TEMPERATURA = 0.1                         # Muy baja: correcciones conservadoras y consistentes
MAX_TOKENS = 12000                        # Amplio: gpt-oss razona y devuelve el archivo completo

SYSTEM_PROMPT = """
Eres un ingeniero de software experto en refactorización y calidad de código. Recibes un
archivo de código fuente y una lista de recomendaciones de mejora detectadas por un análisis
previo de calidad. Tu tarea es reescribir el código aplicando esas mejoras y las buenas
prácticas de las 7 dimensiones de calidad: código limpio, modularidad, legibilidad, manejo
de errores, mantenibilidad, seguridad básica y documentación.

CONTEXTO: el archivo es parte de un proyecto real con OTROS archivos (HTML, CSS, JS, configuración)
que no ves. Corrige de forma CONSERVADORA, sin romper el proyecto.

REGLAS ESTRICTAS:
- NO cambies la funcionalidad ni el comportamiento del programa.
- NO reestructures el archivo. NO separes el CSS ni el JavaScript a archivos externos: si están
  embebidos, DÉJALOS embebidos. NO cambies ni agregues referencias (<link>, <script src>) a otros archivos.
- NO inventes clases, módulos o "servicios" que no existen. NO conviertas funciones sueltas en clases nuevas.
- Si es HTML/CSS/front-end, CONSERVA los estilos y el diseño EXACTAMENTE: debe verse idéntico.
- Conserva el lenguaje original, la interfaz pública y NO agregues dependencias nuevas.
- Solo mejora: seguridad (quita credenciales, corrige inyecciones), validación, manejo de errores,
  nombres internos y comentarios. Nada de rearquitectura.
- Devuelve ÚNICAMENTE el código corregido COMPLETO del archivo, listo para guardar.
- NO incluyas explicaciones, ni texto adicional, ni delimitadores markdown (no uses ```).
""".strip()


def leer_archivo(ruta: str) -> tuple[str, str]:
    """Lee un archivo de código y retorna (contenido, extensión)."""
    path = Path(ruta)
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return f.read(), path.suffix.lstrip(".")
    except Exception as e:
        print(f"  [WARN] No se pudo leer {ruta}: {e}")
        return "", ""


def cargar_recomendaciones(ruta_reporte: str) -> dict:
    """
    Carga el reporte JSON del analizador y arma un diccionario
    {nombre_archivo: texto_de_recomendaciones}.
    """
    recomendaciones_por_archivo = {}
    if not ruta_reporte or not Path(ruta_reporte).exists():
        return recomendaciones_por_archivo

    try:
        datos = json.loads(Path(ruta_reporte).read_text(encoding="utf-8"))
    except Exception as e:
        print(f"  [WARN] No se pudo leer el reporte {ruta_reporte}: {e}")
        return recomendaciones_por_archivo

    for entrada in datos:
        archivo = entrada.get("archivo", "")
        analisis = entrada.get("analisis", {})
        if "error" in analisis:
            continue

        partes = []
        for p in analisis.get("problemas_criticos", []):
            partes.append(f"- [CRÍTICO] {p}")
        for r in analisis.get("recomendaciones_prioritarias", []):
            partes.append(f"- {r}")
        for dim in analisis.get("dimensiones", []):
            for r in dim.get("recomendaciones", []):
                partes.append(f"- ({dim.get('nombre', '?')}) {r}")

        if partes:
            recomendaciones_por_archivo[archivo] = "\n".join(partes)

    return recomendaciones_por_archivo


def corregir_con_ia(cliente, codigo: str, nombre_archivo: str,
                    extension: str, recomendaciones: str) -> str:
    """
    Envía el código y las recomendaciones al modelo y retorna el código corregido.
    Si algo falla, retorna cadena vacía (no se modifica el archivo).
    """
    bloque_recs = recomendaciones if recomendaciones else (
        "No hay recomendaciones específicas. Mejora la calidad general del código "
        "según las 7 dimensiones."
    )

    mensaje_usuario = f"""
Corrige y mejora el siguiente archivo de código.

**Archivo:** {nombre_archivo}
**Lenguaje:** {extension.upper() if extension else "desconocido"}

**Recomendaciones a aplicar:**
{bloque_recs}

**Código actual:**
```{extension}
{codigo}
```

Devuelve únicamente el código corregido completo, sin explicaciones ni markdown.
""".strip()

    try:
        respuesta = cliente.chat.completions.create(
            model=MODELO_IA,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": mensaje_usuario},
            ],
            temperature=TEMPERATURA,
            max_tokens=MAX_TOKENS,
            reasoning_effort="low",
        )
        contenido = respuesta.choices[0].message.content.strip()

        # Quitar delimitadores markdown si el modelo los agregó igualmente
        if contenido.startswith("```"):
            lineas = contenido.split("\n")
            if lineas[0].startswith("```"):
                lineas = lineas[1:]
            if lineas and lineas[-1].strip() == "```":
                lineas = lineas[:-1]
            contenido = "\n".join(lineas)

        return contenido.strip() + "\n"

    except Exception as e:
        print(f"  [ERROR] Falló la corrección de {nombre_archivo}: {e}")
        return ""


def main():
    parser = argparse.ArgumentParser(
        description="Corrector de código con IA para pipelines CI/CD (comando /fix-ia)"
    )
    parser.add_argument("archivos", nargs="+", help="Archivos de código a corregir")
    parser.add_argument("--reporte", "-r", default="reporte-ia.json",
                        help="Reporte JSON del análisis previo (default: reporte-ia.json)")
    args = parser.parse_args()

    api_key = os.environ.get("CEREBRAS_API_KEY")
    if not api_key:
        print("ERROR: Variable de entorno CEREBRAS_API_KEY no configurada.")
        sys.exit(1)

    cliente = OpenAI(api_key=api_key, base_url=CEREBRAS_BASE_URL)
    recomendaciones = cargar_recomendaciones(args.reporte)

    print(f"\n{'='*60}")
    print(f"  CORRECTOR DE CÓDIGO CON IA — Pipeline CI/CD")
    print(f"  Modelo: {MODELO_IA}")
    print(f"{'='*60}\n")

    archivos_corregidos = 0

    for ruta in args.archivos:
        print(f"🔧 Corrigiendo: {ruta}")
        contenido, extension = leer_archivo(ruta)
        if not contenido:
            print("  [SKIP] Archivo vacío o ilegible.\n")
            continue

        # Buscar recomendaciones por nombre de archivo (coincidencia por sufijo de ruta)
        recs = ""
        for archivo_rep, texto in recomendaciones.items():
            if ruta.endswith(archivo_rep) or archivo_rep.endswith(ruta) or Path(archivo_rep).name == Path(ruta).name:
                recs = texto
                break

        codigo_corregido = corregir_con_ia(
            cliente, contenido, Path(ruta).name, extension, recs
        )

        if not codigo_corregido:
            print("  [SKIP] La IA no devolvió una corrección válida.\n")
            continue

        if codigo_corregido.strip() == contenido.strip():
            print("  = Sin cambios (el código ya estaba correcto).\n")
            continue

        Path(ruta).write_text(codigo_corregido, encoding="utf-8")
        archivos_corregidos += 1
        print("  ✅ Corregido y guardado.\n")

    print(f"{'='*60}")
    print(f"  Corrección finalizada: {archivos_corregidos} archivo(s) modificado(s).")
    print(f"{'='*60}\n")


if __name__ == "__main__":
    main()
