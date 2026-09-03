import OrderModel from "../models/order.model.js";

// FASE 4.3-C.3.1 — Order Read Service.
//
// Capa de LECTURA del dominio Order, separada de `order.service.js` (que es
// command-only: `createOrder` + recuperación). Esta función NO conoce Express
// (`req`/`res`), NO autentica, NO autoriza y NO muta documentos. Recibe
// argumentos YA validados/normalizados por el controller y ejecuta la consulta.
//
// Alcance: SOLO el listado administrativo `GET /api/orders`. NO implementa
// `GET /api/orders/:id`, workflow, export ni el reaper.

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

export { listFinalizedOrders };
