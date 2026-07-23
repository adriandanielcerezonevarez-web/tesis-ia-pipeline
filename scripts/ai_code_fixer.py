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
import re
import json
import argparse
import subprocess
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
MODELO_API = (os.environ.get("LLM_MODEL") or "").strip() or MODELO_IA
ESFUERZO = "none" if "glm" in MODELO_API.lower() else "low"

# ─── Límite de contexto (GLM en Cerebras acepta máx. 8192 tokens por petición) ───
MAX_CHARS_CODIGO = 12000 if "glm" in MODELO_API.lower() else 10**9


def recortar_codigo(codigo: str, cambios: str, max_chars: int = None):
    """
    Si el archivo supera el límite de contexto del modelo, retorna solo un
    fragmento centrado en las líneas cambiadas del PR (ventanas de ±40 líneas).
    Los parches @@BUSCAR@@ se aplican después sobre el archivo COMPLETO, por lo
    que recortar el prompt no afecta la aplicación de las correcciones.
    """
    max_chars = max_chars or MAX_CHARS_CODIGO
    if len(codigo) <= max_chars:
        return codigo, False
    lineas = codigo.split("\n")
    objetivo = {c.strip() for c in (cambios or "").split("\n") if c.strip()}
    indices = [i for i, l in enumerate(lineas) if l.strip() and l.strip() in objetivo]
    if not indices:
        return codigo[:max_chars], True
    ventanas = []
    for i in indices:
        a, b = max(0, i - 40), min(len(lineas), i + 41)
        if ventanas and a <= ventanas[-1][1]:
            ventanas[-1][1] = max(ventanas[-1][1], b)
        else:
            ventanas.append([a, b])
    partes = ["\n".join(lineas[a:b]) for a, b in ventanas]
    frag = "\n\n... (resto del archivo omitido por límite de contexto) ...\n\n".join(partes)
    return frag[:max_chars], True

TEMPERATURA = 0.1                         # Muy baja: correcciones conservadoras y consistentes
MAX_TOKENS = 15000
if "glm" in (os.environ.get("LLM_MODEL") or "").lower():
    MAX_TOKENS = 3000                     # GLM: los parches son cortos; cabe en el limite de 8192                        # Amplio: gpt-oss razona y devuelve el archivo completo

SYSTEM_PROMPT = """
Eres un ingeniero experto en calidad de código. Recibes un archivo y recomendaciones de mejora.
NO reescribas el archivo completo. Devuelve SOLO cambios puntuales (quirúrgicos) en bloques con
este formato EXACTO:

@@BUSCAR@@
<fragmento EXACTO del código original, copiado carácter por carácter, con varias líneas de
contexto para que sea único e inconfundible dentro del archivo>
@@REEMPLAZAR@@
<ese mismo fragmento, pero corregido>
@@FIN@@

REGLAS OBLIGATORIAS:
- El texto entre @@BUSCAR@@ y @@REEMPLAZAR@@ debe existir EXACTAMENTE en el código (misma
  indentación, mismas comillas, mismos espacios). Cópialo literal; si no coincide, se descarta.
- Haz cambios MÍNIMOS enfocados en: ERRORES DE SINTAXIS, líneas basura o identificadores sin sentido,
  código muerto, seguridad (credenciales, inyección), validación de datos y manejo de errores.
- APLICA SIEMPRE las recomendaciones que recibes en el mensaje. Si una recomendación pide eliminar una
  línea (por ejemplo una línea basura que rompe la sintaxis), elimínala.
- Para ELIMINAR una línea, cópiala en @@BUSCAR@@ junto con 1 o 2 líneas de contexto y OMÍTELA en
  @@REEMPLAZAR@@ (deja únicamente el contexto).
- NO toques el diseño, estilos, HTML de presentación ni la estructura salvo que sea imprescindible.
- NO inventes clases, NO separes el código a otros archivos, NO cambies referencias (<link>, <script src>).
- Máximo 6 bloques, los más importantes. Solo devuelve vacío si el código ya está perfecto.
- No escribas nada fuera de los bloques.
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


def _reemplazo_tolerante(texto, buscar, reemplazar):
    """
    Reemplaza un bloque comparando línea por línea SIN tener en cuenta la
    indentación (espacios al inicio/fin). Sirve cuando el modelo copia el
    fragmento con espacios ligeramente distintos y el match exacto falla.
    """
    lineas = texto.split("\n")
    objetivo = [l.strip() for l in buscar.split("\n")]
    n = len(objetivo)
    if n == 0:
        return texto, False
    for i in range(len(lineas) - n + 1):
        if [l.strip() for l in lineas[i:i + n]] == objetivo:
            reemplazo_lineas = reemplazar.split("\n") if reemplazar != "" else [""]
            lineas[i:i + n] = reemplazo_lineas
            return "\n".join(lineas), True
    return texto, False


def aplicar_parches(codigo, respuesta):
    """
    Aplica los bloques @@BUSCAR@@/@@REEMPLAZAR@@. Primero intenta una coincidencia
    EXACTA; si falla, usa una coincidencia tolerante a la indentación. Permite
    también eliminar líneas (reemplazo vacío). El resto del archivo queda intacto.
    """
    patron = re.compile(r"@@BUSCAR@@\r?\n(.*?)\r?\n@@REEMPLAZAR@@\r?\n?(.*?)@@FIN@@", re.DOTALL)
    nuevo = codigo
    aplicados = 0
    for buscar, reemplazar in patron.findall(respuesta):
        reemplazar = reemplazar.rstrip("\n")
        if not buscar.strip():
            continue
        if buscar in nuevo:
            nuevo = nuevo.replace(buscar, reemplazar, 1)
            aplicados += 1
        else:
            nuevo, ok = _reemplazo_tolerante(nuevo, buscar, reemplazar)
            if ok:
                aplicados += 1
    total = respuesta.count("@@BUSCAR@@")
    print(f"  Parches: el modelo devolvió {total}, se aplicaron {aplicados}.")
    return nuevo


def obtener_cambios(ruta: str) -> str:
    """
    Obtiene solo las líneas nuevas o modificadas del archivo respecto a la rama
    base del Pull Request. Si no hay contexto de PR o git falla, retorna cadena
    vacía y la corrección se hace considerando todo el archivo (como antes).
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
        agregadas = [linea[1:] for linea in salida.stdout.splitlines()
                     if linea.startswith("+") and not linea.startswith("+++")]
        return "\n".join(agregadas).strip()
    except Exception:
        return ""


def corregir_con_ia(cliente, codigo: str, nombre_archivo: str,
                    extension: str, recomendaciones: str, cambios: str = "") -> str:
    """
    Envía el código y las recomendaciones al modelo y retorna el código corregido.
    Si algo falla, retorna cadena vacía (no se modifica el archivo).
    """
    bloque_recs = recomendaciones if recomendaciones else (
        "No hay recomendaciones específicas. Mejora la calidad general del código "
        "según las 7 dimensiones."
    )

    codigo_prompt, recortado = recortar_codigo(codigo, cambios)
    if recortado:
        print(f"  Prompt recortado a {len(codigo_prompt)} caracteres (limite de contexto del modelo).")

    bloque_enfoque = ""
    if cambios:
        bloque_enfoque = f"""
**Corrige SOLO estas líneas nuevas o modificadas del Pull Request** (el resto del archivo es contexto y NO debe tocarse):
```
{cambios}
```
"""

    mensaje_usuario = f"""
Corrige y mejora el siguiente archivo de código.

**Archivo:** {nombre_archivo}
**Lenguaje:** {extension.upper() if extension else "desconocido"}

**Recomendaciones a aplicar:**
{bloque_recs}
{bloque_enfoque}
**Código actual:**
```{extension}
{codigo_prompt}
```

Devuelve únicamente los cambios en el formato de parches @@BUSCAR@@/@@REEMPLAZAR@@/@@FIN@@ indicado.
""".strip()

    try:
        respuesta = cliente.chat.completions.create(
            model=MODELO_API,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": mensaje_usuario},
            ],
            temperature=TEMPERATURA,
            max_tokens=MAX_TOKENS,
            reasoning_effort=ESFUERZO,
        )
        contenido = respuesta.choices[0].message.content.strip()
        # Aplicar solo los cambios puntuales (parches) que coincidan exactamente con el código.
        return aplicar_parches(codigo, contenido)

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

        cambios = obtener_cambios(ruta)
        codigo_corregido = corregir_con_ia(
            cliente, contenido, Path(ruta).name, extension, recs, cambios
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
