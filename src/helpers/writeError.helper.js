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
  "variants.sku": "SKU",
};

// FASE 3 — Product Domain + Editor Workflow.
// Errores de dominio lanzados explícitamente por los services (no vienen de
// Mongoose) — ver `product.services.js` (assertCategoriesExist,
// assertNoDuplicateSkus) y `product.controllers.js` (transiciones de estado).
// `error.code` aquí es un string propio, nunca choca con el 11000 numérico de
// Mongo, así que esta comprobación va SIEMPRE antes de la de duplicado.
const CUSTOM_ERROR_STATUS = {
  DUPLICATE_SKU_LOCAL: 409,
  DUPLICATE_SKU_GLOBAL: 409,
  INVALID_CATEGORY_REF: 400,
  // FASE 3 / Remediación 2
  INVALID_VARIANTS: 400, // PD2-004 — `variants` presente pero no es un array
  STOCK_REQUIRED: 400, // PD2-005 — quitar todas las variantes sin declarar `stock`
  // FASE 3 / Remediación 3
  INVALID_CATEGORIES: 400, // PD3-001 — `categories` presente pero no es un array
};

const sendWriteError = (res, error, entityLabel = "registro") => {
  if (error && CUSTOM_ERROR_STATUS[error.code]) {
    return res.status(CUSTOM_ERROR_STATUS[error.code]).json({
      msg: error.message,
    });
  }

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
