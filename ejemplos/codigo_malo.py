import sqlite3
import os
import logging
import bcrypt
import hmac
from typing import List, Optional

# Configuración de logging
LOGGING_FORMAT = '%(asctime)s - %(levelname)s - %(message)s'
logging.basicConfig(level=logging.INFO, format=LOGGING_FORMAT)

# Carga de variables de entorno
API_KEY = os.environ.get('API_KEY')
DB_NAME = os.environ.get('DB_NAME', 'db.sqlite')

# Excepción personalizada para errores de base de datos
class DatabaseError(Exception):
    """Excepción personalizada para errores de base de datos."""
    pass

# Función para conectar a la base de datos
def conectar_db() -> sqlite3.Connection:
    """
    Conecta a la base de datos.

    Returns:
        sqlite3.Connection: Conexión a la base de datos.
    """
    try:
        conn = sqlite3.connect(DB_NAME)
        return conn
    except sqlite3.Error as e:
        logging.error(f'Error al conectar a la base de datos: {e}')
        raise DatabaseError(f'Error al conectar a la base de datos: {e}')

# Función para crear una conexión y un cursor
def crear_cursor(conn: sqlite3.Connection) -> sqlite3.Cursor:
    """
    Crea un cursor para la conexión a la base de datos.

    Args:
        conn (sqlite3.Connection): Conexión a la base de datos.

    Returns:
        sqlite3.Cursor: Cursor para la conexión a la base de datos.
    """
    try:
        c = conn.cursor()
        return c
    except sqlite3.Error as e:
        logging.error(f'Error al crear cursor: {e}')
        raise DatabaseError(f'Error al crear cursor: {e}')

# Función para cerrar la conexión
def cerrar_conexion(conn: Optional[sqlite3.Connection]) -> None:
    """
    Cierra la conexión a la base de datos.

    Args:
        conn (Optional[sqlite3.Connection]): Conexión a la base de datos.
    """
    if conn is not None:
        try:
            conn.close()
        except sqlite3.Error as e:
            logging.error(f'Error al cerrar conexión: {e}')
            raise DatabaseError(f'Error al cerrar conexión: {e}')

# Función para hashear una contraseña
def hashear_contraseña(contraseña: str) -> str:
    """
    Hashea una contraseña utilizando bcrypt.

    Args:
        contraseña (str): Contraseña a hashear.

    Returns:
        str: Contraseña hasheada.
    """
    # Utiliza bcrypt para hashear la contraseña
    return bcrypt.hashpw(contraseña.encode(), bcrypt.gensalt())

# Función para verificar una contraseña
def verificar_contraseña(contraseña: str, hash_contraseña: str) -> bool:
    """
    Verifica si una contraseña coincide con su hash.

    Args:
        contraseña (str): Contraseña a verificar.
        hash_contraseña (str): Hash de la contraseña.

    Returns:
        bool: True si la contraseña coincide, False de lo contrario.
    """
    # Utiliza bcrypt para verificar la contraseña
    return bcrypt.checkpw(contraseña.encode(), hash_contraseña)

# Función para obtener el hash de la contraseña de un usuario
def obtener_hash_contraseña(username: str, conn: sqlite3.Connection) -> Optional[str]:
    """
    Obtiene el hash de la contraseña de un usuario.

    Args:
        username (str): Nombre de usuario.
        conn (sqlite3.Connection): Conexión a la base de datos.

    Returns:
        Optional[str]: Hash de la contraseña del usuario, o None si no existe.
    """
    try:
        c = crear_cursor(conn)
        c.execute("SELECT pass FROM users WHERE user=?", (username,))
        resultado = c.fetchone()
        if resultado is None:
            return None
        return resultado[0]
    except sqlite3.Error as e:
        logging.error(f'Error al obtener hash de contraseña: {e}')
        raise DatabaseError(f'Error al obtener hash de contraseña: {e}')

# Autenticación de usuario
def autenticar_usuario(username: str, password: str) -> bool:
    """
    Autentica a un usuario en la base de datos.

    Args:
        username (str): Nombre de usuario.
        password (str): Contraseña del usuario.

    Returns:
        bool: True si el usuario es autenticado, False de lo contrario.
    """
    conn = None
    try:
        conn = conectar_db()
        hash_contraseña = obtener_hash_contraseña(username, conn)
        if hash_contraseña is None:
            return False
        return verificar_contraseña(password, hash_contraseña)
    except DatabaseError as e:
        logging.error(f'Error al autenticar usuario: {e}')
        return False
    finally:
        cerrar_conexion(conn)

# Función para validar la entrada de datos
def validar_entrada_datos(username: str, password: str) -> bool:
    """
    Valida la entrada de datos para prevenir ataques de inyección de SQL.

    Args:
        username (str): Nombre de usuario.
        password (str): Contraseña del usuario.

    Returns:
        bool: True si la entrada de datos es válida, False de lo contrario.
    """
    if not isinstance(username, str) or not isinstance(password, str):
        return False
    if len(username) == 0 or len(password) == 0:
        return False
    return True

# Autenticación de usuario con validación de entrada de datos
def autenticar_usuario_seguro(username: str, password: str) -> bool:
    """
    Autentica a un usuario en la base de datos con validación de entrada de datos.

    Args:
        username (str): Nombre de usuario.
        password (str): Contraseña del usuario.

    Returns:
        bool: True si el usuario es autenticado, False de lo contrario.
    """
    if not validar_entrada_datos(username, password):
        return False
    return autenticar_usuario(username, password)

# Cálculo del promedio
def calcular_promedio(valores: List[float]) -> float:
    """
    Calcula el promedio de una lista de valores.

    Args:
        valores (list): Lista de valores numéricos.

    Returns:
        float: Promedio de los valores.
    """
    if len(valores) == 0:
        return 0.0

    suma = sum(valores)
    return suma / len(valores)

# Procesamiento de datos
def procesar_datos(datos: List[float]) -> List[float]:
    """
    Procesa una lista de datos, eliminando valores None y duplicando los demás.

    Args:
        datos (list): Lista de datos.

    Returns:
        list: Lista de datos procesados.
    """
    try:
        resultado = []
        for valor in datos:
            if valor is not None:
                resultado.append(valor * 2)
        return resultado
    except Exception as e:
        logging.error(f'Error al procesar datos: {e}')
        return []

# Pruebas unitarias
import unittest

class TestAutenticacion(unittest.TestCase):
    def test_autenticar_usuario(self):
        # Crear un usuario de prueba
        conn = conectar_db()
        c = crear_cursor(conn)
        c.execute("INSERT INTO users (user, pass) VALUES (?, ?)", ('test', hashear_contraseña('test')))
        conn.commit()
        cerrar_conexion(conn)

        # Autenticar al usuario
        self.assertTrue(autenticar_usuario('test', 'test'))

        # Eliminar el usuario de prueba
        conn = conectar_db()
        c = crear_cursor(conn)
        c.execute("DELETE FROM users WHERE user=?", ('test',))
        conn.commit()
        cerrar_conexion(conn)

class TestProcesamientoDatos(unittest.TestCase):
    def test_procesar_datos(self):
        datos = [1, 2, 3, None, 4, 5]
        resultado = procesar_datos(datos)
        self.assertEqual(resultado, [2, 4, 6, 8, 10])

if __name__ == '__main__':
    unittest.main()
