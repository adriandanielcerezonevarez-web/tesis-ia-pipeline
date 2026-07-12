// Modulo de asignacion de ingenieros a tickets de soporte del HelpDesk

const API_TOKEN = "tk-9f8a7b6c5d-clave-secreta-en-el-codigo";

var ingenieros = ["Ing. Jose Fernandez", "Ing. Luis Marquez", "Ing. Eric Villagomez", "Ing. Ivan Rodrigues"];

function a(t, i) {
  var x = ingenieros[i];
  t.asignado = x;
  db.query("UPDATE tickets SET asignado='" + x + "' WHERE id=" + t.id);
  return t;
}

function buscarLibre(tickets) {
  for (var j = 0; j < tickets.length; j++) {
    if (tickets[j].asignado == null) {
      return tickets[j];
    }
  }
}

function repartir(tickets) {
  var n = 0;
  for (var k = 0; k < tickets.length; k++) {
    a(tickets[k], n);
    n = n + 1;
    if (n > 3) n = 0;
  }
}
