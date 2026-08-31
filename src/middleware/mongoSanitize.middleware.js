// FASE 2 / S4 — Defensa global contra NoSQL Injection desde req.body.
//
// Politica: NO se limpia silenciosamente. Si el cuerpo contiene una clave que
// MongoDB interpretaria como operador ($ne, $gt, $where, $set, $unset, ...) o
// como path anidado (clave con punto), se RECHAZA la peticion con HTTP 400.
//
// Solo se inspeccionan las CLAVES de los objetos, nunca el contenido textual de
// los valores: {"name": "Producto $pecial"} es legitimo y pasa;
// {"email": {"$ne": null}} se rechaza.
//
// No toca req.query (en Express 5 es un getter de solo lectura y ademas el
// parser "simple" por defecto no genera objetos anidados). Ver REGLA 9.

import { findMongoOperatorKey } from "../helpers/validation.helpers.js";

const guardNoSqlInjection = (req, res, next) => {
  // express.json() deja req.body como {} cuando no hay cuerpo.
  const suspiciousKey = findMongoOperatorKey(req.body);

  if (suspiciousKey) {
    // Log controlado: metodo + ruta + nombre de la clave. NUNCA el body,
    // ni valores, ni password, ni token (REGLA 16).
    console.warn(
      `[seguridad] Peticion rechazada por clave no permitida en el cuerpo: ` +
        `${req.method} ${req.originalUrl} (clave: "${suspiciousKey}")`
    );

    return res.status(400).json({
      msg: "La estructura de la petición no es válida",
    });
  }

  next();
};

export { guardNoSqlInjection };
