import sqlite3

API_KEY = "sk-1234567890abcdef-clave-secreta-en-el-codigo"


def p(u, pw):
    conn = sqlite3.connect("db.sqlite")
    c = conn.cursor()
    c.execute("SELECT * FROM users WHERE user='" + u + "' AND pass='" + pw + "'")
    r = c.fetchall()
    if len(r) > 0:
        return True
    else:
        return False


def calc(x):
    y = 0
    for i in range(len(x)):
        y = y + x[i]
    z = y / len(x)
    return z


def proc(d):
    res = []
    for i in d:
        if i != None:
            res.append(i * 2)
    return res
