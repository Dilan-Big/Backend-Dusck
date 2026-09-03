import OrderModel from "../models/order.model.js";

// FASE 4.3-C.3.1 / C.3.2 — Order Read Service.
//
// Capa de LECTURA del dominio Order, separada de `order.service.js` (que es
// command-only: `createOrder` + recuperación). Estas funciones NO conocen
// Express (`req`/`res`), NO autentican, NO autorizan y NO mutan documentos
// (nada de `save`/`updateOne`/`findOneAndUpdate`/`deleteOne`). Reciben
// argumentos YA validados/normalizados por el controller.
//
// Alcance: consultas administrativas de solo lectura —
//   `GET /api/orders`      (listado, C.3.1)  -> listFinalizedOrders
//   `GET /api/orders/:id`  (detalle, C.3.2)  -> getFinalizedOrderById
// NO implementa workflow, export ni el reaper.

// Proyección administrativa del LISTADO (server-side). Se traen solo los campos
// que `toAdminOrderListItem` necesita; `items` se limita a `quantity` (basta
// para `itemsCount`). NUNCA se seleccionan: idempotencyKey, finalized, source,
// requestedItems, stockAdjustments, stockOpsPruned, export, shippingAddress,
// statusHistory, notes, customer.documentId — reservados / internos.
const LIST_PROJECTION = [
  "orderNumber",
  "userId",
  "status",
  "payment",
  "totals",
  "items.quantity",
  "customer.recipientName",
  "customer.email",
  "customer.phone",
  "createdAt",
  "updatedAt",
].join(" ");

/**
 * Lista órdenes FINALIZADAS que cumplen `filter`, paginadas y ordenadas.
 *
 * `finalized: true` se fuerza SIEMPRE aquí (última palabra): el cliente nunca
 * controla `finalized`, y aunque `filter` trajera esa clave se sobrescribe.
 *
 * @param {object}  params
 * @param {object}  params.filter  filtro Mongo ya construido con primitivas
 *                                 validadas (sin operadores del cliente).
 * @param {object}  params.sort    p. ej. `{ createdAt: -1, _id: -1 }`.
 * @param {number}  params.skip    entero seguro >= 0.
 * @param {number}  params.limit   1..100.
 * @returns {Promise<{ total:number, docs:object[] }>}  `docs` son objetos planos
 *          (`lean`) con la proyección del listado.
 */
const listFinalizedOrders = async ({ filter, sort, skip, limit }) => {
  const query = { ...filter, finalized: true };

  const [total, docs] = await Promise.all([
    OrderModel.countDocuments(query),
    OrderModel.find(query).select(LIST_PROJECTION).sort(sort).skip(skip).limit(limit).lean(),
  ]);

  return { total, docs };
};

// FASE 4.3-C.3.2 — Detalle administrativo `GET /api/orders/:id`.
//
// Whitelist POSITIVA: solo los campos aprobados para el detalle. Un campo nuevo
// añadido al schema en el futuro NO se filtra por defecto. NUNCA se seleccionan
// `idempotencyKey`, `finalized`, `source`, `requestedItems`, `stockAdjustments`,
// `stockOpsPruned`, `export` ni `__v` (este último ya ausente: `versionKey:false`).
// `stockOps` vive en `Product`, no en `Order`.
const DETAIL_PROJECTION = [
  "orderNumber",
  "userId",
  "status",
  "createdAt",
  "updatedAt",
  "customer",
  "shippingAddress",
  "items",
  "totals",
  "payment",
  "statusHistory",
  "notes",
].join(" ");

/**
 * Detalle de UNA orden FINALIZADA por su `_id`.
 *
 * `finalized: true` es impuesto AQUÍ (no se confía solo en el controller). Un
 * `_id` que no exista o que apunte a un skeleton (`finalized:false`) devuelve
 * `null` — el controller lo traduce al mismo 404, sin revelar el skeleton
 * (DEC-C3.2-B).
 *
 * @param {string} id  ObjectId de 24 hex YA validado por el controller
 *                     (`isValidObjectId`). Se usa como valor literal, nunca como
 *                     filtro construido con `req.params`.
 * @returns {Promise<object|null>}  objeto plano (`lean`) con `DETAIL_PROJECTION`,
 *          o `null` si no hay orden finalizada con ese id.
 */
const getFinalizedOrderById = async (id) => {
  return OrderModel.findOne({ _id: id, finalized: true }).select(DETAIL_PROJECTION).lean();
};

export { listFinalizedOrders, getFinalizedOrderById };
