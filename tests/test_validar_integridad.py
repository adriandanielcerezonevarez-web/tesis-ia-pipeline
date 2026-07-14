"""
Pruebas del validador de integridad (ai_fix_iterativo.py).

Es la salvaguarda clave de la tesis: antes de aplicar una corrección de la IA,
verifica que no rompa el proyecto. Rechaza correcciones que (1) salen muy
recortadas, (2) introducen archivos locales inexistentes, o (3) rompen la
sintaxis. Estas pruebas comprueban cada regla.
"""

from ai_fix_iterativo import validar_integridad, _referencias_externas


def test_rechaza_resultado_muy_recortado():
    original = "x = 1\n" * 40          # ~240 caracteres
    corregido = "x = 1\n"              # muchísimo más corto
    ok, motivo = validar_integridad(original, corregido, "a.py")
    assert ok is False
    assert "recortado" in motivo


def test_rechaza_referencia_a_archivo_inexistente():
    # Este es exactamente el caso que rompía el HelpDesk: separar JS/CSS
    # a archivos que no existen.
    original = "<div>contenido de la pagina con bastante texto aqui dentro</div>"
    corregido = original + '<script src="nuevo_inexistente.js"></script>'
    ok, motivo = validar_integridad(original, corregido, "index.html")
    assert ok is False
    assert "nuevo_inexistente.js" in motivo


def test_rechaza_sintaxis_python_invalida():
    original = "def foo():\n    return 1\n"
    corregido = "def foo(:\n    return 1\n"   # paréntesis roto
    ok, motivo = validar_integridad(original, corregido, "a.py")
    assert ok is False
    assert "sintaxis" in motivo.lower()


def test_acepta_correccion_valida():
    original = "clave = 'valor viejo con relleno suficiente'\n"
    corregido = "clave = 'valor nuevo con relleno suficiente'\n"
    ok, motivo = validar_integridad(original, corregido, "a.py")
    assert ok is True
    assert motivo == "ok"


def test_referencias_externas_ignora_cdn_y_conserva_locales():
    texto = (
        '<script src="https://cdn.ejemplo.com/lib.js"></script>'
        '<script src="app_local.js"></script>'
        '<link href="//otra-cdn.com/e.css">'
    )
    refs = _referencias_externas(texto)
    assert "app_local.js" in refs
    assert "https://cdn.ejemplo.com/lib.js" not in refs
    assert "//otra-cdn.com/e.css" not in refs
