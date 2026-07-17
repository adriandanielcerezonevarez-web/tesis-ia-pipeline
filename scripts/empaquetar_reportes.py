#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
empaquetar_reportes.py
Toma los reportes de IA descargados de los artefactos de GitHub y arma
UN SOLO ZIP. Al descomprimir queda una carpeta del periodo y, dentro,
UNA CARPETA POR REPORTE (nombrada con dia y hora) que contiene la IMAGEN
(.png) + el markdown (.md). Si el reporte fue corregido por la IA se guarda
ademas su version "-corregido".

Uso:
  python empaquetar_reportes.py --staging DIR --manifest FILE --out ZIP --periodo semanal

El manifest tiene una linea por artefacto:  <id>|<created_at>|<nombre_artefacto>
Tesis: Diseno de un modelo de uso de IA en pipelines CI/CD - Arce/Cerezo.
"""
import argparse
import json
import os
import re
import shutil
from datetime import datetime, timedelta
from pathlib import Path

import render_reporte


def a_hora_local(created_at):
    """Convierte el created_at ISO (UTC) a hora de Ecuador (UTC-5)."""
    try:
        dt = datetime.strptime(created_at.replace("Z", ""), "%Y-%m-%dT%H:%M:%S")
        dt = dt - timedelta(hours=5)
        return dt.strftime("%Y-%m-%d_%H-%M")
    except Exception:
        return datetime.now().strftime("%Y-%m-%d_%H-%M")


def nombre_archivo(datos):
    """Nombre del primer archivo analizado, saneado para usar como nombre."""
    try:
        arch = datos[0].get("archivo", "codigo") if isinstance(datos, list) else "codigo"
    except Exception:
        arch = "codigo"
    base = os.path.basename(str(arch)) or "codigo"
    return re.sub(r"[^A-Za-z0-9._-]", "_", base)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--staging", required=True)
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--periodo", default="semanal")
    args = ap.parse_args()

    # Carpeta raiz del periodo (asi al descomprimir queda "reportes-ia-<periodo>/")
    raiz = Path("out_reportes") / f"reportes-ia-{args.periodo}"
    if Path("out_reportes").exists():
        shutil.rmtree("out_reportes")
    raiz.mkdir(parents=True)

    total = 0
    if os.path.exists(args.manifest):
        for linea in Path(args.manifest).read_text(encoding="utf-8").splitlines():
            linea = linea.strip()
            if not linea:
                continue
            partes = linea.split("|")
            art_id = partes[0]
            created = partes[1] if len(partes) > 1 else ""
            nombre_art = partes[2] if len(partes) > 2 else "reporte-analisis-ia"

            carpeta = Path(args.staging) / art_id
            json_p = carpeta / "reporte-ia.json"
            md_p = carpeta / "reporte-ia.md"
            if not json_p.exists():
                continue

            datos = json.loads(json_p.read_text(encoding="utf-8"))
            ts = a_hora_local(created)
            arch = nombre_archivo(datos)
            corregido = nombre_art.endswith("corregido")
            base = f"{ts}_{arch}" + ("-corregido" if corregido else "")

            # Cada reporte en su PROPIA carpeta: imagen (.png) + markdown (.md)
            carpeta_rep = raiz / base
            carpeta_rep.mkdir(parents=True, exist_ok=True)
            try:
                etiqueta = f"{arch} - {ts.replace('_', ' ')}"
                if corregido:
                    etiqueta += "  (corregido por IA)"
                render_reporte.render(str(json_p), str(carpeta_rep / f"{base}.png"), etiqueta)
            except Exception as e:
                print(f"  Aviso: no se pudo renderizar {base}: {e}")
            if md_p.exists():
                shutil.copy(md_p, carpeta_rep / f"{base}.md")
            total += 1

    if total == 0:
        (raiz / "SIN-REPORTES.txt").write_text(
            "No se generaron reportes de IA en el periodo seleccionado.\n", encoding="utf-8")

    out = args.out[:-4] if args.out.endswith(".zip") else args.out
    shutil.make_archive(out, "zip", "out_reportes")
    print(f"Empaquetados {total} reporte(s) en {out}.zip")


if __name__ == "__main__":
    main()
