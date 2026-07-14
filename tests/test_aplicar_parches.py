"""
Pruebas del aplicador de parches quirúrgicos (ai_code_fixer.py).

El corrector no reescribe el archivo completo: aplica solo bloques
@@BUSCAR@@/@@REEMPLAZAR@@ que coincidan con el código. Estas pruebas
verifican que aplique los cambios correctos y deje el resto intacto.
"""

from ai_code_fixer import aplicar_parches, _reemplazo_tolerante


def _parche(buscar, reemplazar):
    return f"@@BUSCAR@@\n{buscar}\n@@REEMPLAZAR@@\n{reemplazar}\n@@FIN@@"


def test_reemplazo_exacto():
    codigo = "def foo():\n    x = 1\n    return x\n"
    respuesta = _parche("    x = 1", "    x = 2")
    resultado = aplicar_parches(codigo, respuesta)
    assert "x = 2" in resultado
    assert "x = 1" not in resultado
    # El resto del archivo se conserva
    assert "def foo():" in resultado
    assert "return x" in resultado


def test_eliminar_linea_basura():
    codigo = "a = 1\nbasura###\nb = 2\n"
    respuesta = _parche("basura###", "")
    resultado = aplicar_parches(codigo, respuesta)
    assert "basura" not in resultado
    assert "a = 1" in resultado and "b = 2" in resultado


def test_coincidencia_tolerante_a_indentacion():
    # El código real no tiene indentación; el parche trae 2 espacios de más.
    # El match exacto falla (esos espacios no existen en el código), pero la
    # coincidencia tolerante (comparando sin espacios) sí lo encuentra.
    codigo = "total = 5\n"
    respuesta = _parche("  total = 5", "  total = 50")
    resultado = aplicar_parches(codigo, respuesta)
    assert "total = 50" in resultado
    assert "total = 5\n" not in resultado


def test_parche_que_no_coincide_no_altera_el_codigo():
    codigo = "print('hola')\n"
    respuesta = _parche("no_existe_en_el_codigo", "algo")
    resultado = aplicar_parches(codigo, respuesta)
    assert resultado == codigo  # intacto byte por byte


def test_respuesta_vacia_no_cambia_nada():
    codigo = "valor = 10\n"
    assert aplicar_parches(codigo, "") == codigo


def test_reemplazo_tolerante_devuelve_flag():
    texto = "linea_a\n    linea_b\n"
    nuevo, ok = _reemplazo_tolerante(texto, "linea_b", "linea_b_corregida")
    assert ok is True
    assert "linea_b_corregida" in nuevo

    _, no_ok = _reemplazo_tolerante(texto, "inexistente", "x")
    assert no_ok is False
