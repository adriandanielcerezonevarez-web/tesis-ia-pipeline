"""
Configuración común para las pruebas unitarias (pytest).

- Añade la carpeta scripts/ al path para poder importar los módulos de IA.
- Si la librería 'openai' no está instalada, inserta un stub mínimo para que
  los módulos se puedan importar. Las funciones que probamos NO usan la API,
  así el stub es suficiente y las pruebas corren sin credenciales ni red.
"""

import os
import sys
import types

# 1. Hacer importables los módulos de scripts/
RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPTS = os.path.join(RAIZ, "scripts")
sys.path.insert(0, SCRIPTS)

# 2. Stub de 'openai' solo si no está instalada (evita sys.exit al importar)
try:
    import openai  # noqa: F401
except ImportError:
    stub = types.ModuleType("openai")

    class OpenAI:  # cliente ficticio: nunca se llama en las pruebas
        def __init__(self, *args, **kwargs):
            pass

    stub.OpenAI = OpenAI
    sys.modules["openai"] = stub
