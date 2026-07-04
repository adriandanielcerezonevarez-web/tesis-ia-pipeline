import sqlite3
import os
import logging

# Configuración de logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

# Carga de variables de entorno
API_KEY = os.environ.get('API_KEY')
DB_NAME = os.environ.get('DB_NAME', 'db.sqlite')

# Conexión a la base de datos
def conectar_db():
    try:
        conn = sqlite3.connect(DB_NAME)
        return conn
    except sqlite3.Error as e:
        logging.error(f'Error al conectar a la base de datos: {e}')
        return None

# Autenticación de usuario
def autenticar_usuario(username, password):
    """
    Autentica a un usuario en la base de datos.

    Args:
        username (str): Nombre de usuario.
        password (str): Contraseña del usuario.

    Returns:
        bool: True si el usuario es autenticado, False de lo contrario.
    """
    conn = conectar_db()
    if conn is None:
        return False

    try:
        c = conn.cursor()
        c.execute("SELECT * FROM users WHERE user=? AND pass=?", (username, password))
        resultado = c.fetchall()
        conn.close()
        return len(resultado) > 0
    except sqlite3.Error as e:
        logging.error(f'Error al autenticar usuario: {e}')
        return False

# Cálculo del promedio
def calcular_promedio(valores):
    """
    Calcula el promedio de una lista de valores.

    Args:
        valores (list): Lista de valores numéricos.

    Returns:
        float: Promedio de los valores.
    """
    if len(valores) == 0:
        return 0

    suma = sum(valores)
    return suma / len(valores)

# Procesamiento de datos
def procesar_datos(datos):
    """
    Procesa una lista de datos, eliminando valores None y duplicando los demás.

    Args:
        datos (list): Lista de datos.

    Returns:
        list: Lista de datos procesados.
    """
    resultado = []
    for valor in datos:
        if valor is not None:
            resultado.append(valor * 2)
    return resultado
