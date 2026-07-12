/**
 * crear_usuarios.js — Alta ÚNICA de usuarios en Firebase Authentication.
 * Crea cada usuario en Auth (correo + contraseña) y su perfil en users/{uid}
 * con su rol. Te PIDE las contraseñas al ejecutar: no quedan escritas en el código.
 *
 * Pasos previos:
 *   1) Consola Firebase > Authentication > Sign-in method:
 *      activa "Correo electrónico/contraseña".
 *   2) Consola Firebase > Configuración > Cuentas de servicio > "Generar clave privada"
 *      -> guarda el archivo como serviceAccountKey.json en esta misma carpeta.
 *   3) npm install firebase-admin
 *   4) node crear_usuarios.js
 */
const { initializeApp, cert } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");
const path = require("path");
const readline = require("readline");

const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
  || path.join(__dirname, "serviceAccountKey.json");

let auth, db;
try {
  initializeApp({ credential: cert(require(keyPath)) });
  auth = getAuth();
  db = getFirestore();
} catch (e) {
  console.error("\nNo se pudo inicializar Firebase Admin:");
  console.error("  " + e.message);
  console.error("Revisa que serviceAccountKey.json esté en esta carpeta y sea válido.\n");
  process.exit(1);
}

// Usuarios a crear. Cambia nombres/correos/roles si lo necesitas.
const USUARIOS = [
  { email: "admin@empresa.com",    name: "Administrador Principal", role: "admin" },
  { email: "profesor@empresa.com", name: "Profesor",               role: "admin" },
  { email: "adrian@empresa.com",   name: "Adrian",                 role: "user"  },
  { email: "allison@empresa.com",  name: "Allison",                role: "user"  },
];

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const preguntar = (q) => new Promise((res) => rl.question(q, res));

(async () => {
  console.log("\n=== Alta de usuarios del HelpDesk ARCE-CEREZO ===");
  console.log("(deja la contraseña vacía y pulsa Enter para saltar un usuario)\n");

  for (const u of USUARIOS) {
    const pass = (await preguntar(`Contraseña para ${u.email} (${u.role}): `)).trim();
    if (!pass) { console.log(`  SALTADO ${u.email}\n`); continue; }
    if (pass.length < 6) { console.log(`  SALTADO ${u.email}: mínimo 6 caracteres.\n`); continue; }
    try {
      let user;
      try {
        user = await auth.getUserByEmail(u.email);
        await auth.updateUser(user.uid, { password: pass });
      } catch {
        user = await auth.createUser({ email: u.email, password: pass });
      }
      await db.collection("users").doc(user.uid).set(
        { name: u.name, role: u.role, email: u.email, createdAt: new Date().toISOString() },
        { merge: true }
      );
      console.log(`  OK  ${u.email}  (${u.role})\n`);
    } catch (e) { console.error(`  ERROR ${u.email}: ${e.message}\n`); }
  }
  rl.close();
  console.log("Listo. Ahora publica las reglas: Firestore Database > Rules > pega firestore.rules > Publicar\n");
  process.exit(0);
})();
