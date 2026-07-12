/* ================================================================
   HELPDESK ARCE-CEREZO — Ejemplo de configuración de Firebase
   ----------------------------------------------------------------
   Copia este archivo como  firebase-config.js  y rellena los valores
   de TU proyecto (Consola de Firebase > Configuración del proyecto).

   IMPORTANTE:
   - firebase-config.js está en .gitignore: no se sube al repositorio.
   - La apiKey web de Firebase es un identificador público, NO un secreto,
     pero igual debe restringirse por dominio (referrer) en:
     Google Cloud Console > Credenciales > Restricciones de la clave.
   - Las contraseñas de los usuarios las gestiona Firebase Authentication,
     nunca se escriben en el código.
   ================================================================ */

const FIREBASE_CONFIG = {
  apiKey:            "TU_API_KEY",
  authDomain:        "TU_PROYECTO.firebaseapp.com",
  projectId:         "TU_PROYECTO",
  storageBucket:     "TU_PROYECTO.firebasestorage.app",
  messagingSenderId: "TU_SENDER_ID",
  appId:             "TU_APP_ID"
};

const FIREBASE_CONFIGURED = true;
