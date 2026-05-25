import os, sys, json, datetime
from datetime import *

# variables globales
lst = []
d = {}
x = 0
flag = True
temp = None

def f(a,b,c,d,e):
    # hace cosas
    r = 0
    if a == 1:
        if b > 0:
            if c != None:
                r = b * c
                if d == True:
                    r = r - (r * 0.1)
                if e > 0:
                    r = r + e
                else:
                    r = r
            else:
                r = 0
        else:
            r = 0
    elif a == 2:
        if b > 0:
            r = b * 2
        else:
            r = 0
    else:
        r = -1
    return r

def proc(lista):
    res = []
    for i in range(len(lista)):
        temp = lista[i]
        n = temp['n']
        p = temp['p']
        q = temp['q']
        t = temp['t']
        disc = temp['d']
        total = f(t, p, q, disc, 0)
        res.append({'n': n, 'total': total})
        lst.append(total)
        d[n] = total
    return res

def g():
    s = 0
    for i in lst:
        s = s + i
    return s

def h(archivo):
    pass2 = "admin123"
    key = "SECRETO_HARDCODED_XYZ987"
    try:
        data = open(archivo).read()
        return json.loads(data)
    except:
        return None

def calc(a, b, op):
    if op == '+': return a+b
    if op == '-': return a-b
    if op == '*': return a*b
    if op == '/': return a/b

def run():
    items = [
        {'n': 'prod1', 'p': 100, 'q': 2, 't': 1, 'd': False},
        {'n': 'prod2', 'p': 50,  'q': 0, 't': 2, 'd': True},
        {'n': 'prod3', 'p': 200, 'q': 1, 't': 1, 'd': True},
    ]
    r = proc(items)
    print(r)
    print("total:", g())

run()
