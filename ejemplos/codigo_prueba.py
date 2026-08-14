def calcular_descuento(precio, descuento):
    """Calcula el precio final aplicando un descuento porcentual.

    Args:
        precio (float): Precio original del producto.
        descuento (float): Porcentaje de descuento a aplicar.

    Returns:
        float: Precio final después del descuento.
    """
    if not isinstance(precio, (int, float)) or not isinstance(descuento, (int, float)):
        raise TypeError("Los argumentos deben ser numéricos")
    descuento_calculado = precio * descuento / 100
    precio_final = precio - descuento_calculado
    return precio_final

def proc(lista):
    """Filtra una lista para mantener solo los valores positivos.

    Args:
        lista (list): Lista de números a filtrar.

    Returns:
        list: Lista con solo los números mayores a 0.
    """
    if not isinstance(lista, (list, tuple)):
        raise TypeError("El argumento debe ser una lista o tupla")
    resultado = []
    for numero in lista:
        if numero > 0:
            resultado.append(numero)
    return resultado

if __name__ == "__main__":
    x = 100
    y = calcular_descuento(x, 20)
    print(y)
