import OrderModel from "../models/order.model.js";
import ProductModel from "../models/product.model.js";
import {
  ORDER_STATUS,
  PAYMENT_STATUS,
  STOCK_OP_STATE,
  canTransitionOrder,
  canTransitionPayment,
  orderTransitionError,
} from "../helpers/orderWorkflow.helper.js";

// UI-5.1 — Order Workflow Service (command-only).
//
// Capa de dominio para el CICLO DE VIDA de una orden ya finalizada:
// transiciones de `status`, transiciones de `payment.status` y la restitución
// de inventario asociada a una cancelación. Separada a propósito de:
//   · `order.service.js`       -> creación (`createOrder`) + recuperación de skeletons.
//   · `order.read.service.js`  -> consultas administrativas de solo lectura.
//
// NO conoce Express (`req`/`res`). NO toca `createOrder`, el cálculo de precios,
// el snapshot de productos ni la idempotencia del checkout. NO implementa
// analítica, dashboard, lookup de invitado ni `GET /api/orders/mine`.
//
// MongoDB standalone (sin transacciones multi-documento): la consistencia se
// logra con operaciones atómicas condicionales + un guard de idempotencia por
// producto, el mismo patrón que `order.service.js::decrementProductStock`.

// Resultado uniforme para el controller: `{ ok:true, order }` o
// `{ ok:false, status, msg }` (status HTTP ya resuelto aquí). Solo se lanza una
// excepción ante un fallo INESPERADO (el controller la mapea a 500).
const fail = (status, msg) => ({ ok: false, status, msg });

// operationId de la restitución por cancelación. Distinto del que usa el
// checkout (`${orderId}:${productId}[:${size}]`) por el sufijo `:cancel`, para no
// colisionar nunca con una entrada del decremento original ni con su poda.
//
// TALLAS — incorpora la talla (una restitución por talla), igual que
// `order.service.js::operationIdFor`. Producto simple -> `${orderId}:${productId}:cancel`
// (formato histórico intacto, los tests previos siguen matcheando).
const restockOpIdFor = (orderId, productId, size) => {
  const key = size ? String(size).trim().toLowerCase() : "";
  const base = `${String(orderId)}:${String(productId)}`;
  return key ? `${base}:${key}:cancel` : `${base}:cancel`;
};

/**
 * Restituye al inventario las unidades que el checkout reservó, para una orden
 * que ACABA de pasar a `cancelled`. Idempotente y segura ante concurrencia:
 *
 *  - Una operación ATÓMICA por producto: `$inc stock +qty` + `$push stockOps`
 *    en la MISMA escritura sobre el documento Product.
 *  - Guard `"stockOps.id": { $ne: opId }` -> si la restitución de esa línea ya
 *    se aplicó (retry, doble cancelación, reaper), el filtro no matchea y NADA
 *    se modifica. Ejecutable N veces sin doble devolución.
 *  - `order.items[]` tiene como MUCHO una línea por producto (`normalizeItems`
 *    colapsó los duplicados al crear), así que un `opId` identifica una única
 *    devolución.
 *  - Best-effort por línea: nunca lanza. Si una línea falla, se registra (sin
 *    PII) y `stockRestored` queda en `false` para el backstop.
 *
 * @param {import("mongoose").Document|object} order  orden YA en `cancelled`.
 * @returns {Promise<{orderId:string, lines:object[], failures:string[]}>}
 */
const restockOrderInventory = async (order) => {
  const orderId = order && order._id !== undefined ? order._id : order;
  const report = { orderId: String(orderId), lines: [], failures: [] };

  // Guard de seguridad: SOLO se restituye stock de una orden cancelada.
  if (!order || order.status !== ORDER_STATUS.CANCELLED) {
    return report;
  }

  const items = Array.isArray(order.items) ? order.items : [];
  for (const line of items) {
    // TALLAS — si la línea comprada llevaba talla, la restitución devuelve las
    // unidades a `variants[].stock` de ESA talla Y al agregado `stock`, en la
    // MISMA escritura atómica (nunca se desincronizan). Sin talla -> `$inc stock`
    // a secas, exactamente como antes.
    const size = typeof line.size === "string" && line.size.trim() ? line.size.trim() : undefined;
    const opId = restockOpIdFor(orderId, line.productId, size);
    let action = "noop";
    try {
      const inc = size
        ? { stock: line.quantity, "variants.$[v].stock": line.quantity }
        : { stock: line.quantity };
      const options = { returnDocument: "after" };
      if (size) options.arrayFilters = [{ "v.size": size }];

      const updated = await ProductModel.findOneAndUpdate(
        { _id: line.productId, "stockOps.id": { $ne: opId } },
        {
          $inc: inc,
          $push: {
            stockOps: {
              id: opId,
              qty: line.quantity,
              ...(size ? { size } : {}),
              state: STOCK_OP_STATE.COMPENSATED,
              at: new Date(),
              compensatedAt: new Date(),
            },
          },
        },
        options,
      );
      // `updated` != null  -> ESTA llamada restituyó la línea.
      // `updated` == null  -> ya estaba restituida (guard) o el producto no
      //                       existe; en ambos casos no hay nada que hacer.
      action = updated ? "restocked" : "already_restocked_or_absent";
    } catch {
      action = "failed";
      report.failures.push(String(line.productId));
    }
    report.lines.push({
      productId: String(line.productId),
      quantity: line.quantity,
      ...(size ? { size } : {}),
      action,
    });
  }

  // Marcador de observabilidad + objetivo del backstop. Best-effort: la
  // corrección NO depende de él (el guard `stockOps.id` ya garantiza la
  // idempotencia). Solo se marca si TODAS las líneas quedaron resueltas.
  if (report.failures.length === 0) {
    await OrderModel.updateOne(
      { _id: orderId, status: ORDER_STATUS.CANCELLED, stockRestored: false },
      { $set: { stockRestored: true } },
    ).catch(() => {});
  } else {
    // §29 — no ocultar. Solo identificadores técnicos, nunca PII.
    console.error(
      `[order.workflow] restitución de stock incompleta (order ${report.orderId}): ` +
        `${report.failures.length} producto(s) sin restituir; ` +
        `stockRestored queda false para el backstop`,
    );
  }

  return report;
};

/**
 * Mueve `order.status` a `toStatus` si la transición es legal para `actor`.
 *
 * @param {object} params
 * @param {string} params.orderId   ObjectId de 24 hex YA validado por el controller.
 * @param {string} params.toStatus  estado destino (del body, por lista blanca).
 * @param {{_id:any, role:string}} params.actor  `req.user` (nunca el body).
 * @param {string} [params.note]    nota del operador (queda en statusHistory).
 * @returns {Promise<{ok:true, order:object} | {ok:false, status:number, msg:string}>}
 */
const transitionOrderStatus = async ({ orderId, toStatus, actor, note }) => {
  const order = await OrderModel.findById(orderId);
  // Un skeleton (`finalized:false`) o un id inexistente -> mismo 404, sin
  // revelar el skeleton (misma política que `getFinalizedOrderById`).
  if (!order || order.finalized !== true) {
    return fail(404, "El pedido no se encuentra registrado");
  }

  const check = canTransitionOrder(order, toStatus, actor);
  if (!check.ok) {
    const e = orderTransitionError(check.reason);
    return fail(e.status, e.msg);
  }

  const trimmedNote = typeof note === "string" ? note.trim() : "";
  if (check.rule.requiresNote && !trimmedNote) {
    return fail(
      422,
      toStatus === ORDER_STATUS.CANCELLED
        ? "Debes indicar el motivo de la cancelación"
        : "Esta transición requiere una nota que la explique",
    );
  }

  const fromStatus = order.status;
  const historyEntry = {
    status: toStatus,
    changedAt: new Date(),
    changedBy: actor._id,
    ...(trimmedNote ? { note: trimmedNote } : {}),
  };

  // Transición ATÓMICA: el filtro exige que el pedido SIGA en `fromStatus`. Dos
  // administradores que intenten la misma (o distinta) transición desde el
  // mismo estado -> MongoDB serializa los updates de un solo documento: el
  // primero cambia `status`, el segundo ya no matchea -> `null` -> 409.
  const updated = await OrderModel.findOneAndUpdate(
    { _id: orderId, finalized: true, status: fromStatus },
    { $set: { status: toStatus }, $push: { statusHistory: historyEntry } },
    { returnDocument: "after", runValidators: true },
  );

  if (!updated) {
    return fail(
      409,
      "El pedido cambió de estado mientras se procesaba tu solicitud. Vuelve a cargarlo e inténtalo de nuevo.",
    );
  }

  // Cancelación -> restitución de inventario (idempotente). Un fallo aquí NO
  // invalida la cancelación (ya está registrada): `stockRestored:false` queda
  // como deuda para el backstop.
  if (check.rule.restock) {
    await restockOrderInventory(updated).catch((err) => {
      console.error(`[order.workflow] restockOrderInventory lanzó -> ${err && err.name}`);
    });
    // Releer para devolver `stockRestored` ya actualizado.
    const fresh = await OrderModel.findById(orderId);
    return { ok: true, order: fresh || updated };
  }

  return { ok: true, order: updated };
};

/**
 * Mueve `order.payment.status` a `toStatus` si la transición es legal para
 * `actor`. Eje INDEPENDIENTE de `order.status` (no se cruzan validaciones).
 *
 * @returns {Promise<{ok:true, order:object} | {ok:false, status:number, msg:string}>}
 */
const transitionOrderPayment = async ({ orderId, toStatus, actor, note }) => {
  const order = await OrderModel.findById(orderId);
  if (!order || order.finalized !== true) {
    return fail(404, "El pedido no se encuentra registrado");
  }

  const check = canTransitionPayment(order, toStatus, actor);
  if (!check.ok) {
    const e = orderTransitionError(check.reason);
    return fail(e.status, e.msg);
  }

  const trimmedNote = typeof note === "string" ? note.trim() : "";
  if (check.rule.requiresNote && !trimmedNote) {
    return fail(422, "Debes indicar por qué el pago no se pudo completar");
  }

  const fromPaymentStatus = order.payment.status;
  const set = { "payment.status": toStatus };
  if (toStatus === PAYMENT_STATUS.PAID) set["payment.paidAt"] = new Date();
  if (trimmedNote) set["payment.note"] = trimmedNote;

  const updated = await OrderModel.findOneAndUpdate(
    { _id: orderId, finalized: true, "payment.status": fromPaymentStatus },
    { $set: set },
    { returnDocument: "after", runValidators: true },
  );

  if (!updated) {
    return fail(
      409,
      "El estado de pago cambió mientras se procesaba tu solicitud. Vuelve a cargarlo e inténtalo de nuevo.",
    );
  }

  return { ok: true, order: updated };
};

export {
  transitionOrderStatus,
  transitionOrderPayment,
  restockOrderInventory,
  restockOpIdFor,
};
