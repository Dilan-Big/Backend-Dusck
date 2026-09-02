// Traduce errores de escritura de Mongoose a respuestas HTTP con status
// semanticamente correcto y un `msg` util para el operador, SIN filtrar stack
// traces ni detalles internos (REGLA 16).
//
//   - clave duplicada (indice unico)      -> 409 Conflict
//   - ValidationError de esquema           -> 400 Bad Request
//   - CastError (ObjectId/numero invalido) -> 400 Bad Request
//   - cualquier otro                       -> 500 Internal Server Error

const DUP_FIELD_LABELS = {
  email: "correo electrónico",
  nickname: "nickname",
  slug: "slug",
  name: "nombre",
};

const sendWriteError = (res, error, entityLabel = "registro") => {
  // Duplicado: E11000. `keyPattern` / `keyValue` traen el/los campo(s) en conflicto.
  if (error && error.code === 11000) {
    const field = Object.keys(error.keyPattern || error.keyValue || {})[0];
    const label = DUP_FIELD_LABELS[field] || field || "valor";
    return res.status(409).json({
      msg: `El ${label} ya está en uso`,
    });
  }

  // Validacion de esquema: se devuelve el primer mensaje declarado en el modelo.
  if (error && error.name === "ValidationError") {
    const first = Object.values(error.errors || {})[0];
    return res.status(400).json({
      msg: first && first.message ? first.message : "Datos inválidos",
    });
  }

  // Cast: p. ej. un ObjectId mal formado o un numero no numerico.
  if (error && error.name === "CastError") {
    return res.status(400).json({
      msg: "Uno de los campos tiene un formato inválido",
    });
  }

  console.error(`Error al escribir ${entityLabel} -> ${error && error.name}`);
  return res.status(500).json({
    msg: `No se pudo completar la operación sobre el ${entityLabel}`,
  });
};

export { sendWriteError };
