def calcular_descuento(precio, descuento):
    d = precio * descuento / 100
    p = precio - d
    return p

def proc(lst):
    r = []
    for i in lst:
        if i > 0:
            r.append(i)
    return r

x = 100
y = calcular_descuento(x, 20)
print(y)
