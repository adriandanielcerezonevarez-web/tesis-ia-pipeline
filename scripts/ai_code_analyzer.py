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
import re
import time
import sys
import json
import argparse
import textwrap
import subprocess
import tempfile
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

MODELO_IA = "zai-glm-4.7"                # Modelo por defecto (GLM 4.7, open source, vía Cerebras)
# El modelo efectivo puede ajustarse por entorno (variable LLM_MODEL) sin tocar el código.
MODELO_API = (os.environ.get("LLM_MODEL") or "").strip() or MODELO_IA
ES_GLM = "glm" in MODELO_API.lower()
# GLM requiere desactivar el razonamiento cuando se usa temperatura determinista.
ESFUERZO = "none" if ES_GLM else "low"

TEMPERATURA = 0                           # Temperatura 0 = máxima consistencia
# GLM 4.7 en Cerebras: contexto 131k, salida hasta 40k tokens. 9000 basta para el JSON del reporte.
MAX_TOKENS = 9000

# Descripción que el desarrollador escribió en el Pull Request (qué hizo / qué quiere).
# La inyecta el workflow como variable de entorno PR_DESCRIPTION. Ayuda a la IA a enfocar el análisis.
DESCRIPCION_PR = (os.environ.get("PR_DESCRIPTION") or "").strip()


def completar_con_reintentos(cliente, intentos=4, espera=12, **kwargs):
    """
    Llama a la API con reintentos automáticos ante saturación (error 429).
    Espera creciente: 12s, 24s, 48s. Si persiste, propaga el error.
    """
    for i in range(intentos):
        try:
            return cliente.chat.completions.create(**kwargs)
        except Exception as e:
            if ("429" in str(e) or "too_many_requests" in str(e)) and i < intentos - 1:
                print(f"  [AVISO] API saturada (429). Reintento {i + 1}/{intentos - 1} en {espera}s...")
                time.sleep(espera)
                espera *= 2
            else:
                raise


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
    evento = os.environ.get("GITHUB_EVENT_NAME", "").strip()
    base = os.environ.get("GITHUB_BASE_REF", "").strip()
    try:
        if evento == "push":
            # Push (p. ej. merge a main): el cambio es el último commit. HEAD~1 ya está
            # disponible localmente (el checkout usa fetch-depth: 0). NO hacemos
            # 'git fetch --depth=1' porque eso vuelve el repo shallow y rompe HEAD~1.
            ref_base, ref_head = "HEAD~1", "HEAD"
        else:
            # pull_request -> rama base del PR; issue_comment (/fix-ia) u otro -> main.
            destino = base or "main"
            subprocess.run(["git", "fetch", "origin", destino],
                           capture_output=True, timeout=60)
            ref_base, ref_head = f"origin/{destino}", "HEAD"
        salida = subprocess.run(
            ["git", "diff", "--unified=0", ref_base, ref_head, "--", ruta],
            capture_output=True, text=True, timeout=40,
        )
        # Quedarse solo con las líneas agregadas (empiezan con '+' pero no con '+++')
        agregadas = [linea[1:] for linea in salida.stdout.splitlines()
                     if linea.startswith("+") and not linea.startswith("+++")]
        return "\n".join(agregadas).strip()
    except Exception:
        return ""


def verificar_sintaxis(codigo: str, extension: str):
    """
    Verificación objetiva de sintaxis (independiente del criterio del LLM).
    Python -> compile(); JavaScript -> node --check.
    Retorna None si la sintaxis es válida, o un mensaje de error si NO lo es.
    Otros lenguajes: retorna None (no se verifica).
    """
    ext = (extension or "").lower()
    if ext == "py":
        try:
            compile(codigo, "<archivo>", "exec")
            return None
        except SyntaxError as e:
            return f"línea {e.lineno}: {e.msg}"
    if ext in ("js", "mjs"):
        tmp = None
        try:
            with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as f:
                f.write(codigo)
                tmp = f.name
            res = subprocess.run(["node", "--check", tmp], capture_output=True, text=True, timeout=30)
            if res.returncode != 0:
                # Primera línea útil del error de node
                msg = (res.stderr or "").strip().split("\n")
                detalle = next((l.strip() for l in msg if "SyntaxError" in l or "Error" in l), msg[-1] if msg else "error de sintaxis")
                return detalle[:200]
            return None
        except FileNotFoundError:
            return None  # node no disponible: se omite la verificación
        except Exception:
            return None
        finally:
            if tmp:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
    return None


# Patrones peligrosos que, si se INTRODUCEN en las líneas cambiadas, bloquean el merge.
PATRONES_PELIGROSOS = [
    (r"""(?i)\b(password|passwd|pwd|secret|api[_-]?key|apikey|token|authorization)\b\s*[:=]\s*['"][^'"]{3,}['"]""",
     "credencial/secreto hardcodeado"),
    (r"\beval\s*\(", "uso de eval()"),
    (r"\.innerHTML\s*=\s*[^;]*\+", "innerHTML con concatenación (riesgo XSS)"),
    (r"\bdocument\.write\s*\(", "uso de document.write"),
    (r"""(?i)\b(SELECT|INSERT|UPDATE|DELETE)\b[^;]*['"]\s*\+""",
     "consulta SQL con concatenación (riesgo de inyección)"),
    (r"except\s*:\s*pass", "except desnudo que oculta errores"),
]


def _peligros_en_diff(cambios: str):
    """Devuelve la lista de patrones peligrosos NUEVOS detectados en las líneas cambiadas."""
    encontrados = []
    for linea in (cambios or "").split("\n"):
        l = linea.strip()
        if not l:
            continue
        for patron, desc in PATRONES_PELIGROSOS:
            if re.search(patron, l):
                encontrados.append(f"{desc}: {l[:100]}")
                break
    return encontrados


def analizar_con_ia(cliente, codigo: str, nombre_archivo: str, extension: str, cambios: str = "") -> dict:
    """
    Envía el código al modelo de IA y retorna el análisis estructurado.

    Retorna:
        dict con el análisis completo o dict de error
    """
    # Código completo (sin truncar) para la verificación objetiva de sintaxis.
    codigo_original = codigo
    # Truncar código muy largo solo para el prompt (respetar límites del contexto).
    max_chars = 100000
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

    bloque_descripcion = ""
    if DESCRIPCION_PR:
        bloque_descripcion = f"""

DESCRIPCIÓN DEL DESARROLLADOR (qué hizo o qué quiere lograr con este cambio; tómala en cuenta al evaluar):
{DESCRIPCION_PR}
"""

    mensaje_usuario = f"""
Analiza el siguiente archivo de código:

**Archivo:** {nombre_archivo}
**Lenguaje:** {extension.upper() if extension else "desconocido"}

```{extension}
{codigo}
```
{bloque_enfoque}{bloque_descripcion}
Proporciona el análisis completo en el formato JSON especificado.
""".strip()

    try:
        respuesta = completar_con_reintentos(cliente,
            model=MODELO_API,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": mensaje_usuario},
            ],
            temperature=TEMPERATURA,
            max_tokens=MAX_TOKENS,
            reasoning_effort=ESFUERZO,
        )

        contenido_respuesta = (respuesta.choices[0].message.content or "").strip()

        # Limpiar delimitadores markdown y extraer el objeto JSON
        # (algunos modelos agregan texto alrededor del JSON).
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

        # VERIFICACIÓN OBJETIVA DE SINTAXIS: si el archivo no compila/parsea, es un
        # error crítico independiente del criterio del LLM. Se fuerza puntuación baja
        # y se bloquea, para que /fix-ia lo corrija (atrapa typos como 'cons'->'const').
        err_sintaxis = verificar_sintaxis(codigo_original, extension)
        if err_sintaxis:
            analisis["puntuacion_calidad"] = min(float(analisis.get("puntuacion_calidad", 2) or 2), 2.0)
            analisis["nivel_riesgo"] = "CRÍTICO"
            analisis["apto_para_merge"] = False
            problemas = analisis.get("problemas_criticos", []) or []
            problemas.insert(0, f"Error de sintaxis ({extension}): {err_sintaxis}")
            analisis["problemas_criticos"] = problemas
            recs = analisis.get("recomendaciones_prioritarias", []) or []
            recs.insert(0, "Corregir el error de sintaxis en las líneas modificadas antes de desplegar.")
            analisis["recomendaciones_prioritarias"] = recs

        # GATE CENTRADO EN EL DIFF: en el pipeline (PR/push/comentario) SIEMPRE se analiza
        # un archivo que cambió. Si el cambio no rompe la sintaxis y no introduce un patrón
        # peligroso NUEVO, se APRUEBA aunque el resto del archivo heredado puntúe bajo. Se
        # activa aunque 'cambios' esté vacío (p. ej. cuando el cambio fue SOLO borrar código:
        # el diff no tiene líneas '+' y antes eso caía a evaluar todo el archivo y bloqueaba).
        en_pipeline = bool(os.environ.get("GITHUB_EVENT_NAME", "").strip())
        if (cambios or en_pipeline) and not err_sintaxis:
            peligros = _peligros_en_diff(cambios)
            if peligros:
                analisis["puntuacion_calidad"] = 3.0
                analisis["nivel_riesgo"] = "ALTO"
                analisis["apto_para_merge"] = False
                problemas = analisis.get("problemas_criticos", []) or []
                for p in reversed(peligros):
                    problemas.insert(0, f"Patrón peligroso introducido en el cambio: {p}")
                analisis["problemas_criticos"] = problemas
                recs = analisis.get("recomendaciones_prioritarias", []) or []
                recs.insert(0, "Quitar el patrón peligroso introducido en las líneas modificadas.")
                analisis["recomendaciones_prioritarias"] = recs
            else:
                # Cambio limpio: aprobar sin re-evaluar el resto del archivo heredado.
                try:
                    llm_score = float(analisis.get("puntuacion_calidad", 0) or 0)
                except (TypeError, ValueError):
                    llm_score = 0.0
                observaciones = analisis.get("problemas_criticos", []) or []
                analisis["evaluacion"] = "diff"
                analisis["puntuacion_calidad"] = round(max(llm_score, 7.0), 1)
                analisis["nivel_riesgo"] = "BAJO"
                analisis["apto_para_merge"] = True
                if observaciones:
                    analisis["observaciones_archivo"] = observaciones  # informativas, no bloquean
                analisis["problemas_criticos"] = []
                analisis["resumen_general"] = (
                    "Cambio evaluado sobre las líneas modificadas: APTO. El resto del "
                    "archivo no se re-evalúa para el bloqueo (ver observaciones del archivo)."
                )

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
    """
    ahora = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    lineas = [
        "# Reporte de Análisis de Calidad de Código — Pipeline CI/CD",
        f"*Generado automáticamente el {ahora} por el modelo de IA integrado en el pipeline CI/CD*",
        f"*Modelo utilizado: `{MODELO_API}` (open source vía Cerebras)*",
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
    print(f"  Modelo: {MODELO_API}")
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
