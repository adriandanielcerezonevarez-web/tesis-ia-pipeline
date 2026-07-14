"""
Pruebas de la lógica de decisión del pipeline (ai_code_analyzer.py) y del
armado de recomendaciones (ai_fix_iterativo.py).

determinar_resultado_pipeline() es el "quality gate": decide si el pipeline
pasa (código 0) o falla (código 1) según las puntuaciones y la aptitud.
"""

from ai_code_analyzer import determinar_resultado_pipeline
from ai_fix_iterativo import construir_recomendaciones


def _resultado(analisis):
    return [{"archivo": "x.py", "analisis": analisis}]


def test_bloquea_si_un_archivo_no_es_apto():
    codigo, mensaje = determinar_resultado_pipeline(
        _resultado({"apto_para_merge": False, "puntuacion_calidad": 4})
    )
    assert codigo == 1
    assert "correcciones" in mensaje


def test_pasa_si_apto_y_buena_puntuacion():
    codigo, mensaje = determinar_resultado_pipeline(
        _resultado({"apto_para_merge": True, "puntuacion_calidad": 8.5})
    )
    assert codigo == 0
    assert "exitosamente" in mensaje


def test_falla_si_promedio_bajo_el_umbral():
    # Apto pero puntuación por debajo del umbral de bloqueo (5.0 por defecto)
    codigo, _ = determinar_resultado_pipeline(
        _resultado({"apto_para_merge": True, "puntuacion_calidad": 3})
    )
    assert codigo == 1


def test_falla_si_no_hay_analisis_validos():
    codigo, mensaje = determinar_resultado_pipeline(
        _resultado({"error": "La IA no retornó JSON válido"})
    )
    assert codigo == 1
    assert "No se pudieron analizar" in mensaje


def test_construir_recomendaciones_incluye_todas_las_fuentes():
    analisis = {
        "problemas_criticos": ["credencial expuesta"],
        "recomendaciones_prioritarias": ["validar entradas"],
        "dimensiones": [
            {"nombre": "Seguridad", "recomendaciones": ["cifrar datos"]}
        ],
    }
    texto = construir_recomendaciones(analisis)
    assert "[CRÍTICO] credencial expuesta" in texto
    assert "validar entradas" in texto
    assert "(Seguridad) cifrar datos" in texto
