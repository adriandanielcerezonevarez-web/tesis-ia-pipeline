#!/usr/bin/env python3
"""
ai_code_analyzer.py
====================
Módulo principal del modelo de IA para análisis de calidad de código.
Integrado en pipelines CI/CD con GitHub Actions.

Tesis: Diseño de un modelo de uso de IA en pipelines CI/CD open source
Autor: Adrian Daniel Cerezo Nevarez
"""

import os
import sys
import json
import argparse
import textwrap
import subprocess
from pathlib import Path
from datetime import datetime

try:
    from openai import OpenAI
except ImportError:
    print("ERROR: Librería 'openai' no instalada. Ejecuta: pip install openai")
    sys.exit(1)

# Proveedor de IA: Cerebras (endpoint compatible con OpenAI)
CEREBRAS_BASE_URL = "https://api.cerebras.ai/v1"

# ─────────────────────────────────────────────────────────────
#  CONFIGURACIÓN DEL MODELO DE IA
# ─────────────────────────────────────────────────────────────

MODELO_IA = "gpt-oss-120b"               # Modelo open source (GPT-OSS 120B) vía Cerebras
TEMPERATURA = 0                           # Temperatura 0 = máxima consistencia (igual que el validador)
MAX_TOKENS = 8000                         # Amplio: gpt-oss "razona" antes de responder

# Criterios de análisis que evalúa la IA
DIMENSIONES_ANALISIS = [
    "Código Limpio (Clean Code)",
    "Modularidad y Responsabilidad Única",
    "Legibilidad y Nomenclatura",
    "Manejo de Errores",
    "Complejidad y Mantenibilidad",
    "Seguridad Básica",
    "Documentación y Comentarios",
]

# ─────────────────────────────────────────────────────────────
#  PROMPT DEL SISTEMA (Instrucciones para el modelo de IA)
# ─────────────────────────────────────────────────────────────

SYSTEM_PROMPT = """
Eres un revisor experto de calidad de software. Analizas código con RIGOR y CONSISTENCIA.

CONTEXTO IMPORTANTE (respétalo siempre):
El código que recibes es parte de un proyecto real con varios archivos (HTML, CSS, JavaScript,
configuración) que NO ves completos. Por lo tanto:
- NO inventes ni asumas la existencia de clases, módulos, variables o funciones que no aparecen
  literalmente en el código mostrado. No alucines una arquitectura que no está.
- NO penalices ni recomiendes separar el código en archivos nuevos ni mover estilos/scripts a otros
  archivos: el proyecto ya tiene sus archivos y eso rompería el diseño y las referencias existentes.
- Evalúa el archivo TAL COMO ESTÁ, como una pieza que funciona junto a los demás archivos del proyecto.

PUNTUACIÓN (rúbrica fija para que sea consistente):
- 9-10 excelente | 7-8 bueno | 5-6 aceptable | 3-4 deficiente | 1-2 crítico.
- "puntuacion_calidad" = promedio de las 7 dimensiones, redondeado a 1 decimal.

Analiza el código proporcionado evaluando las siguientes dimensiones:

1. CÓDIGO LIMPIO: ¿Sigue principios de Clean Code? (funciones pequeñas, nombres descriptivos, sin código muerto)
2. MODULARIDAD: ¿Respeta el Principio de Responsabilidad Única (SRP)?
3. LEGIBILIDAD: ¿Es fácil de leer y entender sin documentación adicional?
4. MANEJO DE ERRORES: ¿Maneja adecuadamente los errores y casos extremos?
5. MANTENIBILIDAD: ¿Qué tan fácil será modificar este código en el futuro?
6. SEGURIDAD BÁSICA: ¿Hay vulnerabilidades evidentes? (credenciales hardcodeadas, inyección, etc.)
7. DOCUMENTACIÓN: ¿Tiene comentarios relevantes donde se necesitan?

FORMATO DE RESPUESTA OBLIGATORIO (JSON puro, sin markdown):
{
  "resumen_general": "descripción breve del estado general del código",
  "puntuacion_calidad": <número del 1 al 10>,
  "nivel_riesgo": "BAJO|MEDIO|ALTO|CRÍTICO",
  "dimensiones": [
    {
      "nombre": "nombre de la dimensión",
      "puntuacion": <1-10>,
      "estado": "BIEN|MEJORABLE|PROBLEMA|CRÍTICO",
      "hallazgos": ["hallazgo 1", "hallazgo 2"],
      "recomendaciones": ["recomendación 1", "recomendación 2"]
    }
  ],
  "problemas_criticos": ["lista de problemas que bloquean el merge"],
  "recomendaciones_prioritarias": ["top 3 recomendaciones más importantes"],
  "apto_para_merge": true|false
}

Sé específico y constructivo. Señala líneas o patrones concretos cuando sea posible.
Responde ÚNICAMENTE con el JSON, sin texto adicional.
""".strip()


# ─────────────────────────────────────────────────────────────
#  FUNCIONES PRINCIPALES
# ─────────────────────────────────────────────────────────────

def leer_archivo(ruta: str) -> tuple[str, str]:
    """Lee un archivo de código y retorna su contenido y extensión."""
    path = Path(ruta)
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            contenido = f.read()
        return contenido, path.suffix.lstrip(".")
    except FileNotFoundError:
        print(f"  [WARN] Archivo no encontrado: {ruta}")
        return "", ""
    except Exception as e:
        print(f"  [WARN] Error leyendo {ruta}: {e}")
        return "", ""


def obtener_cambios(ruta: str) -> str:
    """
    Obtiene solo las líneas NUEVAS o MODIFICADAS del archivo respecto a la rama
    base del Pull Request (por ejemplo main). Devuelve únicamente esas líneas.

    Si no hay contexto de Pull Request o git falla, retorna cadena vacía y el
    análisis se realiza sobre el archivo completo (comportamiento anterior).
    """
    base = os.environ.get("GITHUB_BASE_REF", "").strip() or "main"
    try:
        subprocess.run(["git", "fetch", "--depth=1", "origin", base],
                       capture_output=True, timeout=40)
        referencia = f"origin/{base}"
        salida = subprocess.run(
            ["git", "diff", "--unified=0", referencia, "--", ruta],
            capture_output=True, text=True, timeout=40,
        )
        # Quedarse solo con las líneas agregadas (empiezan con '+' pero no con '+++')
        agregadas = [linea[1:] for linea in salida.stdout.splitlines()
                     if linea.startswith("+") and not linea.startswith("+++")]
        return "\n".join(agregadas).strip()
    except Exception:
        return ""


def analizar_con_ia(cliente, codigo: str, nombre_archivo: str, extension: str, cambios: str = "") -> dict:
    """
    Envía el código al modelo de IA y retorna el análisis estructurado.

    Parámetros:
        cliente: Instancia del cliente de IA
        codigo: Contenido del archivo de código (contexto completo)
        nombre_archivo: Nombre del archivo para contexto
        extension: Extensión del lenguaje (py, js, java, html, css, etc.)
        cambios: Líneas nuevas/modificadas del PR. Si viene con contenido, el
                 análisis se enfoca SOLO en esas líneas y usa el resto como contexto.

    Retorna:
        dict con el análisis completo o dict de error
    """
    # Truncar código muy largo para respetar límites del contexto
    max_chars = 12000
    if len(codigo) > max_chars:
        codigo = codigo[:max_chars] + f"\n\n[... ARCHIVO TRUNCADO - {len(codigo) - max_chars} caracteres adicionales no mostrados ...]"

    bloque_enfoque = ""
    if cambios:
        bloque_enfoque = f"""

ENFOQUE OBLIGATORIO: Esto es un Pull Request. El archivo completo de arriba es SOLO contexto.
Tus hallazgos, problemas_criticos, recomendaciones y la puntuacion deben referirse UNICAMENTE a
las siguientes lineas NUEVAS o MODIFICADAS. No reportes nada del codigo que no aparezca aqui:

```
{cambios}
```
"""

    mensaje_usuario = f"""
Analiza el siguiente archivo de código:

**Archivo:** {nombre_archivo}
**Lenguaje:** {extension.upper() if extension else "desconocido"}

```{extension}
{codigo}
```
{bloque_enfoque}
Proporciona el análisis completo en el formato JSON especificado.
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

        contenido_respuesta = respuesta.choices[0].message.content.strip()

        # Limpiar delimitadores markdown y extraer el objeto JSON
        # (gpt-oss puede agregar texto de razonamiento alrededor del JSON).
        if contenido_respuesta.startswith("```"):
            lineas = contenido_respuesta.split("\n")
            contenido_respuesta = "\n".join(lineas[1:-1])
        ini = contenido_respuesta.find("{")
        fin = contenido_respuesta.rfind("}")
        if ini >= 0 and fin > ini:
            contenido_respuesta = contenido_respuesta[ini:fin + 1]

        analisis = json.loads(contenido_respuesta)
        # Recalcular la puntuación como promedio de las 7 dimensiones (coherencia con el validador).
        dims = analisis.get("dimensiones", [])
        if dims:
            try:
                prom = round(sum(float(d.get("puntuacion", 0)) for d in dims) / len(dims), 1)
                analisis["puntuacion_calidad"] = prom
                analisis["nivel_riesgo"] = (
                    "BAJO" if prom >= 8 else "MEDIO" if prom >= 6 else "ALTO" if prom >= 4 else "CRÍTICO"
                )
            except (TypeError, ValueError):
                pass
        # Aptitud por umbral numérico (>= 7), sin depender del criterio variable del modelo.
        try:
            analisis["apto_para_merge"] = float(analisis.get("puntuacion_calidad", 0)) >= 7
        except (TypeError, ValueError):
            pass
        return analisis

    except json.JSONDecodeError as e:
        return {
            "error": f"La IA no retornó JSON válido: {e}",
            "respuesta_raw": contenido_respuesta[:500],
        }
    except Exception as e:
        return {"error": f"Error en la llamada a la API: {e}"}


def generar_reporte_markdown(resultados: list[dict]) -> str:
    """
    Genera un reporte Markdown completo a partir de los análisis de todos los archivos.

    Parámetros:
        resultados: Lista de análisis por archivo

    Retorna:
        str con el reporte en formato Markdown
    """
    ahora = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    lineas = [
        "# Reporte de Análisis de Calidad de Código — Pipeline CI/CD",
        f"*Generado automáticamente el {ahora} por el modelo de IA integrado en el pipeline CI/CD*",
        f"*Modelo utilizado: `{MODELO_IA}` (open source vía Groq API)*",
        "",
        "---",
        "",
    ]

    archivos_analizados = [r for r in resultados if "error" not in r.get("analisis", {})]
    archivos_con_error = [r for r in resultados if "error" in r.get("analisis", {})]

    # Resumen ejecutivo
    if archivos_analizados:
        puntajes = [r["analisis"].get("puntuacion_calidad", 0) for r in archivos_analizados]
        puntaje_promedio = sum(puntajes) / len(puntajes)
        archivos_bloqueados = [r for r in archivos_analizados if not r["analisis"].get("apto_para_merge", True)]

        emoji_estado = "✅" if puntaje_promedio >= 7 else ("⚠️" if puntaje_promedio >= 5 else "❌")

        lineas += [
            "## Resumen Ejecutivo",
            "",
            f"| Métrica | Valor |",
            f"|---------|-------|",
            f"| Archivos analizados | {len(archivos_analizados)} |",
            f"| Puntuación promedio de calidad | {puntaje_promedio:.1f} / 10 {emoji_estado} |",
            f"| Archivos que bloquean merge | {len(archivos_bloqueados)} |",
            f"| Archivos con error de análisis | {len(archivos_con_error)} |",
            "",
        ]

        if archivos_bloqueados:
            lineas += [
                "### Archivos que requieren corrección antes del merge:",
                "",
            ]
            for r in archivos_bloqueados:
                nivel = r["analisis"].get("nivel_riesgo", "?")
                lineas.append(f"- `{r['archivo']}` — Riesgo: **{nivel}**")
            lineas.append("")

    lineas += ["---", ""]

    # Detalle por archivo
    for resultado in resultados:
        archivo = resultado["archivo"]
        analisis = resultado["analisis"]

        lineas += [f"## `{archivo}`", ""]

        if "error" in analisis:
            lineas += [
                f"⚠️ **Error durante el análisis:** {analisis['error']}",
                "",
            ]
            continue

        # Cabecera del archivo
        puntaje = analisis.get("puntuacion_calidad", "N/A")
        nivel_riesgo = analisis.get("nivel_riesgo", "N/A")
        apto = analisis.get("apto_para_merge", True)
        resumen = analisis.get("resumen_general", "Sin resumen disponible.")

        emoji_riesgo = {"BAJO": "🟢", "MEDIO": "🟡", "ALTO": "🟠", "CRÍTICO": "🔴"}.get(nivel_riesgo, "⚪")
        emoji_merge = "✅ Apto para merge" if apto else "❌ Requiere correcciones"

        lineas += [
            f"**Puntuación de calidad:** {puntaje}/10 &nbsp;|&nbsp; "
            f"**Nivel de riesgo:** {emoji_riesgo} {nivel_riesgo} &nbsp;|&nbsp; "
            f"**Estado:** {emoji_merge}",
            "",
            f"> {resumen}",
            "",
        ]

        # Problemas críticos
        problemas = analisis.get("problemas_criticos", [])
        if problemas:
            lineas += ["### Problemas Críticos", ""]
            for p in problemas:
                lineas.append(f"- {p}")
            lineas.append("")

        # Recomendaciones prioritarias
        recomendaciones = analisis.get("recomendaciones_prioritarias", [])
        if recomendaciones:
            lineas += ["### Recomendaciones Prioritarias", ""]
            for i, r in enumerate(recomendaciones, 1):
                lineas.append(f"{i}. {r}")
            lineas.append("")

        # Análisis por dimensión
        dimensiones = analisis.get("dimensiones", [])
        if dimensiones:
            lineas += ["### Análisis por Dimensión", ""]
            lineas += [
                "| Dimensión | Puntuación | Estado |",
                "|-----------|-----------|--------|",
            ]
            for dim in dimensiones:
                nombre = dim.get("nombre", "?")
                punt = dim.get("puntuacion", "?")
                estado = dim.get("estado", "?")
                emoji_dim = {"BIEN": "✅", "MEJORABLE": "🟡", "PROBLEMA": "🟠", "CRÍTICO": "🔴"}.get(estado, "⚪")
                lineas.append(f"| {nombre} | {punt}/10 | {emoji_dim} {estado} |")
            lineas.append("")

            # Detalle de cada dimensión
            for dim in dimensiones:
                nombre = dim.get("nombre", "?")
                hallazgos = dim.get("hallazgos", [])
                recs = dim.get("recomendaciones", [])

                if hallazgos or recs:
                    lineas += [f"<details>", f"<summary><b>{nombre}</b></summary>", ""]

                    if hallazgos:
                        lineas.append("**Hallazgos:**")
                        for h in hallazgos:
                            lineas.append(f"- {h}")

                    if recs:
                        lineas.append("")
                        lineas.append("**Recomendaciones:**")
                        for r in recs:
                            lineas.append(f"- {r}")

                    lineas += ["", "</details>", ""]

        lineas += ["---", ""]

    lineas += [
        "",
        "*Este reporte fue generado automáticamente por el sistema de análisis de IA integrado en el pipeline CI/CD.*",
        "*Para más información sobre el modelo, consulta la documentación del proyecto.*",
    ]

    return "\n".join(lineas)


def determinar_resultado_pipeline(resultados: list[dict], umbral_bloqueo: float = 5.0) -> tuple[int, str]:
    """
    Determina si el pipeline debe pasar o fallar basándose en los resultados.

    Retorna:
        tuple (código_de_salida, mensaje)
        código_de_salida: 0 = éxito, 1 = fallo
    """
    analisis_validos = [r["analisis"] for r in resultados if "error" not in r.get("analisis", {})]

    if not analisis_validos:
        return 1, "No se pudieron analizar archivos."

    # Verificar si algún archivo no es apto para merge
    archivos_bloqueados = [a for a in analisis_validos if not a.get("apto_para_merge", True)]

    if archivos_bloqueados:
        return 1, f"{len(archivos_bloqueados)} archivo(s) requieren correcciones antes del merge."

    # Verificar puntuación promedio
    puntajes = [a.get("puntuacion_calidad", 0) for a in analisis_validos]
    promedio = sum(puntajes) / len(puntajes)

    if promedio < umbral_bloqueo:
        return 1, f"Puntuación de calidad promedio ({promedio:.1f}) por debajo del umbral mínimo ({umbral_bloqueo})."

    return 0, f"Análisis completado exitosamente. Puntuación promedio: {promedio:.1f}/10."


# ─────────────────────────────────────────────────────────────
#  PUNTO DE ENTRADA
# ─────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Analizador de calidad de código con IA para pipelines CI/CD",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=textwrap.dedent("""
            Ejemplos de uso:
              python ai_code_analyzer.py archivo.py
              python ai_code_analyzer.py src/main.py src/utils.py src/models.py
              python ai_code_analyzer.py --umbral 6.0 --output reporte.md src/*.py
        """),
    )
    parser.add_argument("archivos", nargs="+", help="Archivos de código a analizar")
    parser.add_argument("--output", "-o", default="reporte-ia.md", help="Archivo de salida del reporte (default: reporte-ia.md)")
    parser.add_argument("--umbral", "-u", type=float, default=5.0, help="Puntuación mínima aceptable (1-10, default: 5.0)")
    parser.add_argument("--json", "-j", action="store_true", help="También guardar resultados en formato JSON")
    parser.add_argument("--verbose", "-v", action="store_true", help="Mostrar información detallada en consola")

    args = parser.parse_args()

    # Verificar API key
    api_key = os.environ.get("CEREBRAS_API_KEY")
    if not api_key:
        print("ERROR: Variable de entorno CEREBRAS_API_KEY no configurada.")
        print("Obtén tu clave en: https://cloud.cerebras.ai")
        sys.exit(1)

    cliente = OpenAI(api_key=api_key, base_url=CEREBRAS_BASE_URL)

    print(f"\n{'='*60}")
    print(f"  ANALIZADOR DE CÓDIGO CON IA — Pipeline CI/CD")
    print(f"  Modelo: {MODELO_IA}")
    print(f"{'='*60}\n")

    resultados = []

    for ruta_archivo in args.archivos:
        print(f"📂 Analizando: {ruta_archivo}")

        contenido, extension = leer_archivo(ruta_archivo)

        if not contenido:
            print(f"  [SKIP] Archivo vacío o no legible.\n")
            continue

        if args.verbose:
            print(f"  Tamaño: {len(contenido)} caracteres | Lenguaje: {extension.upper()}")

        print(f"  Enviando al modelo de IA...")
        cambios = obtener_cambios(ruta_archivo)
        if cambios:
            print(f"  Enfocando el reporte en {len(cambios.splitlines())} línea(s) cambiada(s) del PR.")
        analisis = analizar_con_ia(cliente, contenido, Path(ruta_archivo).name, extension, cambios)

        if "error" in analisis:
            print(f"  ❌ Error: {analisis['error']}\n")
        else:
            puntaje = analisis.get("puntuacion_calidad", "?")
            nivel = analisis.get("nivel_riesgo", "?")
            apto = "✅ Apto" if analisis.get("apto_para_merge", True) else "❌ Requiere correcciones"
            print(f"  ✅ Completado — Calidad: {puntaje}/10 | Riesgo: {nivel} | {apto}\n")

        resultados.append({"archivo": ruta_archivo, "analisis": analisis})

    if not resultados:
        print("No se encontraron archivos válidos para analizar.")
        sys.exit(1)

    # Generar reporte Markdown
    reporte_md = generar_reporte_markdown(resultados)
    output_path = Path(args.output)
    output_path.write_text(reporte_md, encoding="utf-8")
    print(f"📋 Reporte generado: {output_path}")

    # Guardar JSON si se solicitó
    if args.json:
        json_path = output_path.with_suffix(".json")
        json_path.write_text(json.dumps(resultados, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"📄 Reporte JSON: {json_path}")

    # Determinar resultado del pipeline
    codigo_salida, mensaje_resultado = determinar_resultado_pipeline(resultados, args.umbral)

    print(f"\n{'='*60}")
    if codigo_salida == 0:
        print(f"  ✅ PIPELINE: APROBADO — {mensaje_resultado}")
    else:
        print(f"  ❌ PIPELINE: BLOQUEADO — {mensaje_resultado}")
    print(f"{'='*60}\n")

    sys.exit(codigo_salida)


if __name__ == "__main__":
    main()
