import mongoose from "mongoose";

import OrderModel from "../models/order.model.js";
import CounterModel from "../models/counter.model.js";
import ProductModel from "../models/product.model.js";
import { PRODUCT_STATUS } from "../helpers/productWorkflow.helper.js";
import {
  ORDER_STATUS,
  PAYMENT_METHOD,
  PAYMENT_STATUS,
  ORDER_CURRENCY,
  MIN_ORDER_ITEM_QTY,
  MAX_ORDER_ITEM_QTY,
  STOCK_ADJUSTMENT_STATE,
  STOCK_OP_STATE,
} from "../helpers/orderWorkflow.helper.js";
import { isValidObjectId, isFiniteInteger, isPlainString } from "../helpers/validation.helpers.js";

// FASE 4.3-B — Order Creation Service.
//
// Capa de dominio/aplicación: transforma una solicitud de checkout en una
// `Order` COD persistida y consistente. NO conoce Express (`req`/`res`); un
// controller de F4.3-C la conectará. NO lee ni modifica el Cart (F4.2: el
// pedido recibe `items[]` explícito). NO implementa rutas, workflow
// administrativo, rate limiting, Google Sheets ni el reaper.
//
// MongoDB es standalone (sin transacciones multi-documento): la consistencia se
// logra con operaciones atómicas condicionales + compensación explícita, el
// mismo patrón que `product.services.js` (`findOneAndUpdate({ _id, status })`).

// UUID (cualquier versión 1-5). DEBE coincidir con el `match` de
// `idempotencyKey` en `order.model.js` (F4.3-A). Duplicado deliberado: F4.3-B no
// modifica archivos de F4.3-A; unificarlo es una limpieza trivial para más
// adelante.
const IDEMPOTENCY_KEY_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Códigos de error de dominio (para el futuro controller y los tests).
export const ORDER_ERROR_CODES = Object.freeze({
  INVALID_INPUT: "ORDER_INVALID_INPUT", // 400 — request estructuralmente inválido
  INVALID_BUSINESS: "ORDER_INVALID_BUSINESS", // 422 — regla de negocio inválida
  PRODUCT_NOT_AVAILABLE: "ORDER_PRODUCT_NOT_AVAILABLE", // 404 — producto inexistente / no comprable
  STOCK_CONFLICT: "ORDER_STOCK_CONFLICT", // 409 — stock insuficiente (concurrencia)
  IDEMPOTENCY_IN_PROGRESS: "ORDER_IDEMPOTENCY_IN_PROGRESS", // 409 retryable — skeleton en curso
  INTERNAL: "ORDER_INTERNAL", // 500 — error inesperado
});

// Error de dominio: mismo patrón que `cart.service.js` (Error + `.code`), más
// `.status` y `.retryable` para que el controller no necesite un switch. Sin PII.
const orderError = (code, message, { status, retryable = false } = {}) =>
  Object.assign(new Error(message), { code, status, retryable, isOrderError: true });

const ERR = {
  input: (m) => orderError(ORDER_ERROR_CODES.INVALID_INPUT, m, { status: 400 }),
  business: (m) => orderError(ORDER_ERROR_CODES.INVALID_BUSINESS, m, { status: 422 }),
  notAvailable: () =>
    orderError(
      ORDER_ERROR_CODES.PRODUCT_NOT_AVAILABLE,
      "Uno de los productos del pedido no está disponible",
      { status: 404 },
    ),
  stock: (m) => orderError(ORDER_ERROR_CODES.STOCK_CONFLICT, m, { status: 409 }),
  inProgress: () =>
    orderError(
      ORDER_ERROR_CODES.IDEMPOTENCY_IN_PROGRESS,
      "Ya hay un pedido en proceso con esta clave; reinténtalo en unos segundos",
      { status: 409, retryable: true },
    ),
  internal: (m = "No se pudo completar el pedido") =>
    orderError(ORDER_ERROR_CODES.INTERNAL, m, { status: 500 }),
};

// Un producto es comprable en línea si está PUBLICADO + activo (misma regla que
// `cart.service.js::isPurchasable`).
const isPublishedActive = (p) =>
  !!p && p.status === PRODUCT_STATUS.PUBLISHED && p.isActive === true;

// TALLAS — Resuelve la talla de una línea contra las variantes REALES del
// producto (nunca contra un enum del backend: coincidencia exacta con
// `variants[].size` tras trim). Reemplaza el antiguo BLOCKER-01 (que rechazaba
// de plano todo producto con variantes).
//
//   producto SIMPLE (variants: [])       -> la línea NO puede llevar talla.
//   producto CON variantes               -> talla OBLIGATORIA y debe existir.
//                                           Debe resolver a EXACTAMENTE una
//                                           variante (una talla que coincide con
//                                           varias variantes = matriz color×talla,
//                                           fuera de alcance: se rechaza, igual que
//                                           TODO producto con variantes antes de
//                                           esta funcionalidad -> no es regresión).
//
// Devuelve `{ size }` (talla canónica, o `undefined` para simple) o lanza
// `ERR.business` (422) con un mensaje sin PII.
const resolveLineSize = (product, rawSize) => {
  const trimmed = rawSize !== undefined && rawSize !== null ? String(rawSize).trim() : "";
  const hasVariants = Array.isArray(product.variants) && product.variants.length > 0;

  if (!hasVariants) {
    if (trimmed) {
      throw ERR.business("Uno de los productos no maneja tallas y no se puede pedir con talla");
    }
    return { size: undefined };
  }

  if (!trimmed) {
    throw ERR.business("Debes elegir una talla para uno de los productos");
  }
  const matches = product.variants.filter(
    (v) => typeof v.size === "string" && v.size.trim() === trimmed,
  );
  if (matches.length === 0) {
    throw ERR.business("La talla seleccionada no existe para uno de los productos");
  }
  if (matches.length > 1) {
    throw ERR.business(
      "Uno de los productos requiere además elegir color y no está disponible para compra en línea",
    );
  }
  return { size: matches[0].size.trim() };
};

// Imagen principal según la convención real de `product_b.images` ([{url,isMain}]):
// la marcada `isMain`, si no la primera, si no `null` (contrato de `OrderItem.image`).
const mainImageUrl = (images) => {
  if (!Array.isArray(images) || images.length === 0) return null;
  const main = images.find((i) => i && i.isMain);
  return (main && main.url) || images[0].url || null;
};

// Copia hacia un objeto NUEVO solo los campos del contrato (evita persistir
// basura del request). La validación de formato la hace el schema en `create()`.
const pickCustomer = (c = {}) => ({
  recipientName: c.recipientName,
  phone: c.phone,
  email: c.email,
  ...(c.documentId !== undefined && c.documentId !== null ? { documentId: c.documentId } : {}),
});

const pickAddress = (a = {}) => ({
  department: a.department,
  city: a.city,
  neighborhood: a.neighborhood,
  address: a.address,
  ...(a.addressComplement !== undefined && a.addressComplement !== null
    ? { addressComplement: a.addressComplement }
    : {}),
  ...(a.reference !== undefined && a.reference !== null ? { reference: a.reference } : {}),
});

// --- 1. Validación estructural (400) + rango de negocio inicial (422) ---

const validateInput = ({ items, customer, shippingAddress, notes, userId, source, idempotencyKey }) => {
  // F4.3-B solo crea pedidos de canal "web" (guest o autenticado). `admin` existe
  // en el enum del modelo pero NO lo maneja este servicio.
  if (source !== "web") {
    throw ERR.input("El origen del pedido debe ser 'web' en este flujo");
  }

  if (!isPlainString(idempotencyKey) || idempotencyKey.trim() === "") {
    throw ERR.input("La clave de idempotencia es obligatoria");
  }
  if (!IDEMPOTENCY_KEY_REGEX.test(idempotencyKey)) {
    throw ERR.input("La clave de idempotencia no es un UUID válido");
  }

  if (!Array.isArray(items) || items.length === 0) {
    throw ERR.input("El pedido debe incluir al menos un producto");
  }
  items.forEach((line, i) => {
    if (!line || typeof line !== "object") {
      throw ERR.input(`La línea #${i + 1} del pedido no es válida`);
    }
    if (!isValidObjectId(line.productId)) {
      throw ERR.input(`La línea #${i + 1} tiene un identificador de producto inválido`);
    }
    if (!isFiniteInteger(line.quantity)) {
      throw ERR.input(`La línea #${i + 1} tiene una cantidad inválida`);
    }
    if (line.quantity < MIN_ORDER_ITEM_QTY) {
      throw ERR.business(`La cantidad de la línea #${i + 1} debe ser al menos ${MIN_ORDER_ITEM_QTY}`);
    }
    // TALLAS — `size` OPCIONAL. Si viene, debe ser un string simple (nunca un
    // objeto `{ $ne: null }`) y no exceder 20 caracteres (= maxlength del
    // schema). Que la talla EXISTA para el producto se comprueba más adelante,
    // contra `product_b.variants[].size` (nunca contra un enum del backend).
    if (line.size !== undefined && line.size !== null) {
      if (!isPlainString(line.size)) {
        throw ERR.input(`La línea #${i + 1} tiene una talla inválida`);
      }
      if (line.size.trim().length > 20) {
        throw ERR.input(`La línea #${i + 1} tiene una talla demasiado larga`);
      }
    }
  });

  if (userId !== null && userId !== undefined && !isValidObjectId(String(userId))) {
    throw ERR.input("El identificador de usuario no es válido");
  }
  if (notes !== undefined && notes !== null && !isPlainString(notes)) {
    throw ERR.input("Las notas del pedido no son válidas");
  }

  const requireStringFields = (obj, keys, label) => {
    if (!obj || typeof obj !== "object") throw ERR.input(`Faltan los datos de ${label}`);
    for (const k of keys) {
      if (!isPlainString(obj[k]) || obj[k].trim() === "") {
        throw ERR.input(`Falta el campo '${k}' en ${label}`);
      }
    }
  };
  requireStringFields(customer, ["recipientName", "phone", "email"], "el cliente");
  requireStringFields(
    shippingAddress,
    ["department", "city", "neighborhood", "address"],
    "la dirección de entrega",
  );
};

// --- 2/3. Normalización por (productId + size) + revalidación de rango ----------
//
// TALLAS — la identidad de una línea es (productId + talla): dos tallas del mismo
// producto NO se fusionan (son operaciones de inventario distintas, contra
// variantes distintas). Una línea sin talla (producto simple) se agrupa por
// productId a secas — comportamiento previo intacto. La talla CANÓNICA que se
// conserva en la línea es la primera vista tras `trim` (la validación de que
// exista para el producto ocurre después, en `createOrder`).
const normalizeItems = (items) => {
  const byKey = new Map();
  for (const raw of items) {
    const productId = String(raw.productId);
    const size =
      raw.size !== undefined && raw.size !== null && String(raw.size).trim()
        ? String(raw.size).trim()
        : undefined;
    const key = `${productId}::${size ? size.toLowerCase() : ""}`;
    const prev = byKey.get(key);
    byKey.set(key, { productId, size, quantity: (prev ? prev.quantity : 0) + raw.quantity });
  }
  const normalized = [...byKey.values()];

  // El límite 1..50 se revalida DESPUÉS de sumar: la normalización no puede
  // usarse para evadirlo (A×40 + A×11 = 51 -> inválido). Aplica POR (producto+talla).
  for (const line of normalized) {
    if (line.quantity < MIN_ORDER_ITEM_QTY || line.quantity > MAX_ORDER_ITEM_QTY) {
      throw ERR.business(
        `La cantidad total de un producto debe estar entre ${MIN_ORDER_ITEM_QTY} y ${MAX_ORDER_ITEM_QTY}`,
      );
    }
  }
  return normalized;
};

// --- F4.3-B-R2.2 — Inventory operation boundary (Product-local) -----
//
// AUTORIDAD de la mutación de inventario: `product_b.stockOps[]` (co-localizado
// con `Product.stock`). `Order.stockAdjustments[]` es un espejo advisory.
//
//   operationId = `${order._id}:${productId}`  (una sola op por (orden, producto);
//   `normalizeItems` ya colapsó los productos duplicados).

// TALLAS — clave determinista de la talla para el `operationId` (trim +
// minúsculas). Solo se usa para construir el id del ledger; el snapshot conserva
// la talla canónica tal cual. `""`/ausente -> sin sufijo (producto simple).
const sizeKeyFor = (size) => (size ? String(size).trim().toLowerCase() : "");

// `operationId` del ledger `product_b.stockOps[]`. Una sola operación por
// (orden, producto, talla): `normalizeItems` colapsa los duplicados de esa
// misma tripleta ANTES de generar el id.
//   producto simple  -> `${orderId}:${productId}`            (formato histórico, intacto)
//   producto c/talla -> `${orderId}:${productId}:${sizeKey}` (una op por talla; sin colisión)
const operationIdFor = (orderId, productId, size) => {
  const base = `${String(orderId)}:${String(productId)}`;
  const key = sizeKeyFor(size);
  return key ? `${base}:${key}` : base;
};

/**
 * DECREMENTO ATÓMICO de stock: `$inc stock -qty` + registro de la operación en
 * `stockOps` en UNA sola escritura sobre el documento Product.
 *
 * TALLAS — dos caminos, seleccionados por `size`:
 *   · SIN `size` (producto simple): filtro `variants: { $size: 0 }` + `$inc stock`
 *     — EXACTAMENTE el comportamiento previo, byte a byte.
 *   · CON `size` (producto con variantes): el filtro exige que exista UNA variante
 *     de esa talla con stock suficiente; el `$inc` baja `variants.$[v].stock` Y
 *     el agregado `stock` en la MISMA escritura atómica (nunca se desincronizan);
 *     el `arrayFilters` acota el `$inc` a esa única variante. `createOrder` ya
 *     garantizó (antes de llamar aquí) que la talla resuelve a exactamente una
 *     variante, así que el arrayFilter nunca toca más de un elemento.
 *
 * @returns {Promise<{outcome:"decremented"|"already_decremented"|"already_compensated"|"stock_conflict"}>}
 */
const decrementProductStock = async (productId, qty, operationId, size) => {
  const wantsSize = !!(size && String(size).trim());

  const filter = {
    _id: productId,
    status: PRODUCT_STATUS.PUBLISHED,
    isActive: true,
    "stockOps.id": { $ne: operationId }, // guard de idempotencia
  };
  let update;
  let options = { returnDocument: "after" };

  if (wantsSize) {
    const canonical = String(size).trim();
    filter.variants = { $elemMatch: { size: canonical, stock: { $gte: qty } } };
    update = {
      $inc: { "variants.$[v].stock": -qty, stock: -qty },
      $push: {
        stockOps: {
          id: operationId,
          qty,
          size: canonical,
          state: STOCK_OP_STATE.DECREMENTED,
          at: new Date(),
        },
      },
    };
    options.arrayFilters = [{ "v.size": canonical, "v.stock": { $gte: qty } }];
  } else {
    filter.variants = { $size: 0 };
    filter.stock = { $gte: qty };
    update = {
      $inc: { stock: -qty },
      $push: { stockOps: { id: operationId, qty, state: STOCK_OP_STATE.DECREMENTED, at: new Date() } },
    };
  }

  const updated = await ProductModel.findOneAndUpdate(filter, update, options);
  if (updated) return { outcome: "decremented" };

  // No hubo match. Desambiguar SIN modificar estado: ¿ya existe la operación?
  const probe = await ProductModel.findOne(
    { _id: productId, "stockOps.id": operationId },
    { "stockOps.$": 1 },
  );
  const op = probe && Array.isArray(probe.stockOps) ? probe.stockOps[0] : null;
  if (op) {
    return op.state === STOCK_OP_STATE.COMPENSATED
      ? { outcome: "already_compensated" }
      : { outcome: "already_decremented" };
  }
  // La operación NO existe -> el fallo del filtro fue stock insuficiente o
  // producto ya no comprable (mismo trato opaco que el decremento previo).
  return { outcome: "stock_conflict" };
};

/**
 * COMPENSACIÓN ATÓMICA de una operación de stock: `$inc stock +qty` (con `qty`
 * leído del PROPIO registro, nunca del caller) + `state -> compensated`, todo en
 * UNA update pipeline sobre el documento Product. Cierra la ventana
 * "state cambiado / stock sin restaurar": no existe punto intermedio.
 *
 * TALLAS — si el registro de la operación lleva `size` (producto con variantes),
 * la MISMA pipeline devuelve `qty` a `variants[].stock` de esa talla ADEMÁS del
 * agregado `stock`. La talla se lee del PROPIO registro (`$$op.size`), nunca del
 * caller — misma autoridad-en-el-documento que `qty`. Sigue siendo UNA sola
 * escritura a Product (el test CRITICAL `comp/atomic` cuenta exactamente 1).
 *
 * Idempotente: si la operación no está en `decremented` (ausente o ya
 * `compensated`), el filtro no matchea y NADA se modifica.
 *
 * @returns {Promise<import("mongoose").Document|null>} el Product actualizado si
 *          ESTA llamada aplicó la compensación; `null` si fue no-op.
 */
const compensateProductOp = async (productId, operationId) => {
  return ProductModel.findOneAndUpdate(
    {
      _id: productId,
      stockOps: { $elemMatch: { id: operationId, state: STOCK_OP_STATE.DECREMENTED } },
    },
    [
      // 1. Bind del registro de la operación (qty + size son autoridad del doc).
      {
        $set: {
          __compOp: {
            $first: {
              $filter: {
                input: "$stockOps",
                as: "o",
                cond: { $eq: ["$$o.id", operationId] },
              },
            },
          },
        },
      },
      // 2. Restituye stock (agregado + variante si aplica) y marca compensated.
      {
        $set: {
          stock: { $add: ["$stock", "$__compOp.qty"] },
          variants: {
            $cond: [
              { $ne: [{ $ifNull: ["$__compOp.size", null] }, null] },
              {
                $map: {
                  input: { $ifNull: ["$variants", []] },
                  as: "v",
                  in: {
                    $cond: [
                      { $eq: ["$$v.size", "$__compOp.size"] },
                      { $mergeObjects: ["$$v", { stock: { $add: ["$$v.stock", "$__compOp.qty"] } }] },
                      "$$v",
                    ],
                  },
                },
              },
              "$variants",
            ],
          },
          stockOps: {
            $map: {
              input: "$stockOps",
              as: "o",
              in: {
                $cond: [
                  { $eq: ["$$o.id", operationId] },
                  { $mergeObjects: ["$$o", { state: STOCK_OP_STATE.COMPENSATED, compensatedAt: "$$NOW" }] },
                  "$$o",
                ],
              },
            },
          },
        },
      },
      // 3. Limpia el campo temporal.
      { $unset: "__compOp" },
    ],
    { returnDocument: "after", updatePipeline: true },
  );
};

/**
 * Poda del ledger de operaciones de una orden YA finalizada (C-A + C-B).
 * SOLO se invoca con `order.finalized === true` confirmado. `$pull` dirigido a
 * las operaciones de esta orden (jamás toca las de otra). Idempotente.
 */
const pruneStockOpsForOrder = async (order) => {
  if (!order || order.finalized !== true) return; // C-A: nunca podar una orden no finalizada
  // TALLAS — el id del ledger incorpora la talla (ver `operationIdFor`), así que
  // la poda reconstruye la tripleta exacta (orden + producto + talla).
  const opIds = order.requestedItems.map((l) => operationIdFor(order._id, l.productId, l.size));
  const productIds = order.requestedItems.map((l) => l.productId);
  await ProductModel.updateMany(
    { _id: { $in: productIds } },
    { $pull: { stockOps: { id: { $in: opIds } } } },
  );
  await OrderModel.updateOne({ _id: order._id, finalized: true }, { $set: { stockOpsPruned: true } });
};

/**
 * F4.3-B-R2.2 — Compensación IDEMPOTENTE de una orden interrumpida (skeleton
 * `finalized:false`), guiada por la AUTORIDAD `product_b.stockOps[]`.
 *
 * Primitiva compartida: hoy la usa el rollback en línea de `createOrder`; un
 * futuro reaper la invocará por cada skeleton huérfano. NO escanea, NO agenda.
 *
 * Garantías:
 *  - NUNCA toca una orden `finalized:true` (regla #1).
 *  - Compensa exactamente las operaciones que `stockOps` prueba en `decremented`;
 *    `qty` sale del propio registro. Operación ausente o ya `compensated` -> no-op.
 *  - La compensación de cada línea es UNA operación atómica sobre Product
 *    (`compensateProductOp`): imposible restituir stock sin marcar `compensated`
 *    y viceversa.
 *  - Ejecutable N veces sin duplicar restitución.
 *  - Borra el skeleton (y poda sus stockOps) solo si ninguna línea falló.
 *
 * @param {import("mongoose").Types.ObjectId|string|{_id:any}} skeletonOrId
 * @returns {Promise<object>} reporte técnico SIN PII
 */
const compensateOrder = async (skeletonOrId) => {
  const id = skeletonOrId && skeletonOrId._id !== undefined ? skeletonOrId._id : skeletonOrId;

  const skeleton = await OrderModel.findById(id);
  if (!skeleton) {
    return { orderId: String(id), notFound: true, finalized: false, deleted: false, failures: [], lines: [] };
  }

  const base = {
    orderId: String(skeleton._id),
    idempotencyKey: skeleton.idempotencyKey,
    finalized: skeleton.finalized === true,
    deleted: false,
    failures: [],
  };
  if (base.finalized) {
    // Regla #1: una orden finalizada es intocable para el recovery.
    return { ...base, skipped: true, lines: [] };
  }

  const lines = [];
  const opIds = [];
  const productIds = skeleton.requestedItems.map((l) => l.productId);

  for (const line of skeleton.requestedItems) {
    const operationId = operationIdFor(skeleton._id, line.productId, line.size);
    opIds.push(operationId);
    let action = "noop";
    let compensatedQty = 0;
    try {
      // `compensateProductOp` lee `qty` Y `size` del propio registro del ledger.
      const updated = await compensateProductOp(line.productId, operationId);
      if (updated) {
        action = "compensated";
        const op = (updated.stockOps || []).find((o) => o.id === operationId);
        compensatedQty = op ? op.qty : 0;
        // Espejo advisory (best-effort): NO condiciona nada. Con tallas puede
        // haber varias líneas del mismo producto -> se acota además por `size`.
        await OrderModel.updateOne(
          {
            _id: skeleton._id,
            finalized: false,
            stockAdjustments: {
              $elemMatch: line.size
                ? { productId: line.productId, size: line.size }
                : { productId: line.productId },
            },
          },
          {
            $set: {
              "stockAdjustments.$.state": STOCK_ADJUSTMENT_STATE.COMPENSATED,
              "stockAdjustments.$.decrementedQty": compensatedQty,
              "stockAdjustments.$.compensatedQty": compensatedQty,
            },
          },
        ).catch(() => {});
      }
    } catch {
      action = "failed";
      base.failures.push(String(line.productId));
    }
    lines.push({
      productId: String(line.productId),
      requestedQty: line.quantity,
      action, // "compensated" | "noop" | "failed"
      compensatedQty,
    });
  }

  // Si ninguna línea falló, tras el bucle NINGUNA operación de esta orden queda
  // en `decremented` (o se compensó ahora, o ya estaba compensada/ausente):
  // el skeleton puede podarse y borrarse.
  if (base.failures.length === 0) {
    try {
      await ProductModel.updateMany(
        { _id: { $in: productIds } },
        { $pull: { stockOps: { id: { $in: opIds } } } },
      );
      await OrderModel.deleteOne({ _id: skeleton._id, finalized: false });
      base.deleted = true;
    } catch {
      /* el reaper reintentará la poda/borrado del skeleton `finalized:false` */
    }
  }

  return { ...base, lines };
};

// Rollback en línea: capa fina sobre `compensateOrder`. Ya no necesita "prueba en
// memoria" — la autoridad (`product_b.stockOps`) es consultable directamente.
const rollback = async (skeleton) => {
  try {
    const report = await compensateOrder(skeleton._id);
    if (report.failures.length > 0) {
      // §29: NO ocultar. Solo identificadores técnicos, nunca PII.
      console.error(
        `[order.service] compensación de stock incompleta (order ${report.orderId}): ` +
          `${report.failures.length} producto(s) sin restituir; ` +
          `el skeleton queda finalized:false para el reaper`,
      );
    }
  } catch {
    // Un fallo de la compensación jamás debe tapar el error original.
    console.error(
      `[order.service] la compensación de stock lanzó una excepción (order ${skeleton?._id}); ` +
        `el skeleton queda finalized:false para el reaper`,
    );
  }
};

// --- Función principal ---------------------------------------------

/**
 * Crea una `Order` COD a partir de una solicitud de checkout web.
 *
 * @param {object} input
 * @param {{productId:string, quantity:number}[]} input.items  líneas solicitadas (crudas)
 * @param {object} input.customer                              { recipientName, phone, email, documentId? }
 * @param {object} input.shippingAddress                       { department, city, neighborhood, address, addressComplement?, reference? }
 * @param {string} [input.notes]
 * @param {import("mongoose").Types.ObjectId|string|null} [input.userId]  null = invitado
 * @param {"web"} input.source
 * @param {string} input.idempotencyKey                        UUID generado por el cliente
 * @returns {Promise<import("mongoose").Document>}             la Order finalizada (nueva o la ya existente para esa key)
 * @throws  Error de dominio con `.code` (ver ORDER_ERROR_CODES), `.status`, `.retryable`
 */
const createOrder = async (input) => {
  validateInput(input);
  const normalized = normalizeItems(input.items);
  const userId = input.userId ? new mongoose.Types.ObjectId(String(input.userId)) : null;

  // --- 4. Idempotencia: ¿ya existe una orden con esta clave? ---
  const existing = await OrderModel.findOne({ idempotencyKey: input.idempotencyKey });
  if (existing) {
    if (existing.finalized) return existing; // Caso B: retry de una orden ya creada
    throw ERR.inProgress(); // Caso C: skeleton en curso -> 409 retryable
  }

  // --- 5. Claim atómico vía índice unique: insertar el skeleton ---
  let skeleton;
  try {
    skeleton = await OrderModel.create({
      idempotencyKey: input.idempotencyKey,
      source: "web",
      userId,
      requestedItems: normalized.map((l) => ({
        productId: l.productId,
        quantity: l.quantity,
        ...(l.size ? { size: l.size } : {}),
      })),
      // Espejo ADVISORY (F4.3-B-R2.2): 1:1 con `requestedItems`, todas en
      // `pending`. La autoridad de la mutación de stock es `product_b.stockOps`;
      // esto es solo auditoría y puede quedar desincronizado tras un crash.
      stockAdjustments: normalized.map((l) => ({
        productId: l.productId,
        ...(l.size ? { size: l.size } : {}),
        requestedQty: l.quantity,
        decrementedQty: 0,
        compensatedQty: 0,
        state: STOCK_ADJUSTMENT_STATE.PENDING,
      })),
      customer: pickCustomer(input.customer),
      shippingAddress: pickAddress(input.shippingAddress),
      notes: input.notes ?? undefined,
      finalized: false,
    });
  } catch (err) {
    if (err && err.code === 11000) {
      // Otra petición reclamó la misma clave a la vez.
      const other = await OrderModel.findOne({ idempotencyKey: input.idempotencyKey });
      if (other && other.finalized) return other;
      throw ERR.inProgress();
    }
    if (err && err.name === "ValidationError") {
      // customer / shippingAddress / requestedItems con formato inválido.
      const first = Object.values(err.errors || {})[0];
      throw ERR.business(first && first.message ? first.message : "Los datos del pedido no son válidos");
    }
    throw ERR.internal();
  }

  // A partir de aquí SOMOS los dueños exclusivos de `skeleton`.
  try {
    // --- 8/9/10. Cargar y validar productos ---
    const ids = normalized.map((l) => l.productId);
    const products = await ProductModel.find({ _id: { $in: ids } });
    const byId = new Map(products.map((p) => [String(p._id), p]));

    for (const line of normalized) {
      const p = byId.get(line.productId);
      // Contrato opaco (F4.2): inexistente y no-comprable devuelven lo mismo.
      if (!isPublishedActive(p)) throw ERR.notAvailable();
      // TALLAS — reemplaza BLOCKER-01. Un producto con variantes YA es comprable,
      // pero SIEMPRE con una talla válida (obligatoria, existente, no ambigua).
      // Un producto simple sigue sin aceptar talla. `resolveLineSize` lanza 422
      // con mensaje sin PII si algo no cuadra. La talla CANÓNICA (la del propio
      // producto) se fija en la línea para el decremento y el snapshot; el
      // `operationId` del ledger es consistente entre creación y recuperación
      // porque `sizeKeyFor` normaliza a minúsculas (ver `operationIdFor`).
      const { size } = resolveLineSize(p, line.size);
      line.size = size;

      const unitPrice = Math.round(Number(p.price));
      if (!Number.isInteger(unitPrice) || unitPrice <= 0) {
        throw ERR.business("Uno de los productos no tiene un precio válido");
      }
    }

    // --- 11. Decremento de stock: UNA operación atómica por producto ---
    //
    // `decrementProductStock` hace `$inc stock -qty` + `$push stockOps{decremented}`
    // en una sola escritura sobre el documento Product (autoridad de inventario).
    // El espejo `Order.stockAdjustments` se actualiza best-effort DESPUÉS y no
    // condiciona nada (un crash entre ambos es inocuo).
    const S = STOCK_ADJUSTMENT_STATE;
    for (const line of normalized) {
      // TALLAS — el `operationId` incorpora la talla (una op por talla) y
      // `decrementProductStock` baja `variants[].stock` + el agregado `stock` en
      // la MISMA escritura atómica. Sin talla -> camino simple intacto.
      const operationId = operationIdFor(skeleton._id, line.productId, line.size);
      const res = await decrementProductStock(line.productId, line.quantity, operationId, line.size);

      if (res.outcome === "stock_conflict") {
        const p = byId.get(line.productId);
        const label = line.size ? ` (talla ${line.size})` : "";
        throw ERR.stock(`No hay stock suficiente de "${p ? p.name : "un producto"}"${label}`);
      }
      if (res.outcome === "already_compensated") {
        // Esta operación ya fue descontada y revertida por un recovery: el
        // skeleton se está desmontando en paralelo. Abortar el intento (retryable).
        throw ERR.inProgress();
      }
      // "decremented" | "already_decremented" (reintento del driver): el stock
      // de este producto YA está descontado y registrado en `stockOps`.

      // Espejo advisory (best-effort). Con tallas puede haber varias líneas del
      // mismo producto -> se acota también por `size` (o su ausencia).
      await OrderModel.updateOne(
        {
          _id: skeleton._id,
          finalized: false,
          stockAdjustments: {
            $elemMatch: {
              productId: line.productId,
              ...(line.size ? { size: line.size } : {}),
              state: { $in: [S.PENDING, S.DECREMENTING] },
            },
          },
        },
        {
          $set: {
            "stockAdjustments.$.state": S.DECREMENTED,
            "stockAdjustments.$.decrementedQty": line.quantity,
          },
        },
      ).catch(() => {});
    }

    // --- 12/13. Snapshot de productos + totals (backend es la autoridad) ---
    const items = normalized.map((line) => {
      const p = byId.get(line.productId);
      const unitPrice = Math.round(Number(p.price));
      return {
        productId: p._id,
        productName: p.name,
        slug: p.slug,
        image: mainImageUrl(p.images),
        // TALLAS — talla CANÓNICA congelada en el snapshot (omitida si el
        // producto no tiene variantes).
        ...(line.size ? { size: line.size } : {}),
        unitPrice,
        quantity: line.quantity,
        subtotal: unitPrice * line.quantity,
      };
    });
    const itemsSubtotal = items.reduce((sum, it) => sum + it.subtotal, 0);
    const shipping = 0; // F4: sin política de envío
    const totals = {
      itemsSubtotal,
      shipping,
      grandTotal: itemsSubtotal + shipping,
      currency: ORDER_CURRENCY,
    };

    // --- 14. orderNumber vía Counter ($inc atómico, upsert). Huecos aceptables. ---
    const year = new Date().getFullYear();
    const counter = await CounterModel.findOneAndUpdate(
      { _id: `order-${year}` },
      { $inc: { seq: 1 } },
      { returnDocument: "after", upsert: true },
    );
    const orderNumber = `DUSCK-${year}-${String(counter.seq).padStart(6, "0")}`;

    // --- 15/16. Finalización ATÓMICA (impide doble finalización del mismo skeleton) ---
    const finalizedOrder = await OrderModel.findOneAndUpdate(
      { _id: skeleton._id, finalized: false },
      {
        $set: {
          finalized: true,
          orderNumber,
          items,
          totals,
          status: ORDER_STATUS.PENDING_CONFIRMATION,
          payment: { method: PAYMENT_METHOD.CASH_ON_DELIVERY, status: PAYMENT_STATUS.PENDING },
          statusHistory: [
            { status: ORDER_STATUS.PENDING_CONFIRMATION, changedAt: new Date(), changedBy: userId },
          ],
        },
      },
      { returnDocument: "after", runValidators: true },
    );

    if (!finalizedOrder) {
      // El skeleton ya no está en `finalized:false`: o alguien lo finalizó, o
      // se borró. Si quedó finalizado, es el resultado idempotente correcto.
      const current = await OrderModel.findById(skeleton._id);
      if (current && current.finalized) return current;
      throw ERR.internal("No se pudo finalizar el pedido");
    }

    // --- 17. Poda del ledger de inventario — SIEMPRE tras `finalized:true` (C-B).
    // Best-effort: un fallo aquí NO invalida un pedido ya finalizado; el backstop
    // (`stockOpsPruned:false`) lo reintenta. Los stockOps que queden en un pedido
    // finalizado son evidencia inerte (recovery jamás toca `finalized:true`).
    await pruneStockOpsForOrder(finalizedOrder).catch(() => {});

    // --- 18. Devolver la orden ---
    return finalizedOrder;
  } catch (err) {
    // Cualquier fallo tras el claim: compensar (vía `product_b.stockOps`) y limpiar.
    await rollback(skeleton);
    throw err && err.isOrderError ? err : ERR.internal();
  }
};

export {
  createOrder,
  compensateOrder,
  decrementProductStock,
  compensateProductOp,
  pruneStockOpsForOrder,
  operationIdFor,
};
