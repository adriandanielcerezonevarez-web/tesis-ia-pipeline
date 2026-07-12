// Modulo de asignacion de ingenieros a tickets de soporte del HelpDesk

/* API_TOKEN removed: not used in this module */

/**
 * Obtiene la lista de ingenieros disponibles.
 * @returns {string[]} Arreglo con los nombres de los ingenieros.
 */
function obtenerIngenieros() {
  return ["Ing. Jose Fernandez", "Ing. Luis Marquez", "Ing. Eric Villagomez", "Ing. Ivan Rodrigues"];
}

/**
 * Asigna un ingeniero a un ticket y actualiza la base de datos.
 * @param {{id:number, asignado?:string}} ticket - Objeto ticket a actualizar.
 * @param {number} indice - Índice del ingeniero en la lista.
 * @returns {Promise<Object>} Promesa que resuelve con el ticket actualizado.
 * @throws {Error} Si el ticket es inválido o el índice está fuera de rango.
 */
function asignarIngeniero(ticket, indice) {
  if (!ticket || typeof ticket.id !== 'number') {
    throw new Error('Ticket inválido o sin ID');
  }
  const ingenieros = obtenerIngenieros();
  if (indice < 0 || indice >= ingenieros.length) {
    throw new Error('Índice de ingeniero fuera de rango');
  }
  if (typeof db !== 'object' || typeof db.query !== 'function') {
    throw new Error('Objeto de base de datos no disponible');
  }
  const ingeniero = ingenieros[indice];
  ticket.asignado = ingeniero;
  return new Promise((resolve, reject) => {
    db.query(
      "UPDATE tickets SET asignado = ? WHERE id = ?",
      [ingeniero, ticket.id],
      (err, result) => {
        if (err) {
          console.error('Error al actualizar ticket:', err);
          return reject(err);
        }
        resolve(ticket);
      }
    );
  });
}

function buscarLibre(tickets) {
  for (let j = 0; j < tickets.length; j++) {
    if (tickets[j].asignado == null) {
      return tickets[j];
    }
  }
  return null;
}

/**
 * Reparte los tickets asignando ingenieros de forma cíclica.
 * @param {Array<Object>} tickets - Lista de tickets a asignar.
 * @returns {Promise<Array<Object>>} Promesa que se resuelve cuando todas las asignaciones terminan.
 */
function repartir(tickets) {
  const ingenieros = obtenerIngenieros();
  const limite = ingenieros.length;
  let indiceIngeniero = 0;
  const asignaciones = tickets.map(ticket => {
    const idx = indiceIngeniero % limite;
    indiceIngeniero++;
    return asignarIngeniero(ticket, idx);
  });
  // Utilizamos allSettled para que una falla no bloquee las demás asignaciones
  return Promise.allSettled(asignaciones).then(results => {
    const exitos = results.filter(r => r.status === 'fulfilled').map(r => r.value);
    const errores = results.filter(r => r.status === 'rejected').map(r => r.reason);
    if (errores.length) {
      console.error('Errores al asignar algunos tickets:', errores);
    }
    return exitos;
  });
}
