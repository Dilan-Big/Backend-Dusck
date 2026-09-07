// FASE 4.3-A — Order Domain (COD).
//
// Constantes del dominio Order: estados válidos, canal de origen, método y
// estado de pago, estado de exportación, moneda y topes de cantidad.
//
// Alcance de F4.3-A: SOLO las constantes que el schema necesita para declarar
// sus `enum`. La tabla de transiciones permitidas (rol + estado origen/destino),
// la obligatoriedad de `note` y los efectos sobre stock/pago se implementarán en
// F4.3-B/E, en este mismo archivo, siguiendo el patrón de
// `productWorkflow.helper.js` (que ya resuelve lo equivalente para Product).
//
// El backend es la autoridad. Nada de esto se duplica de forma distinta en
// Angular: el frontend solo refleja lo que este dominio ya define.

// UI-5.1 — la máquina de estados del pedido (más abajo) resuelve autorización
// por rol, igual que `productWorkflow.helper.js`. `global.config.js` no importa
// nada de `helpers/`, así que no hay ciclo (mismo import que productWorkflow).
import { ROLES } from "../config/global.config.js";

// --- Estados del pedido --------------------------------------------------
//
// Contrato F4.2 (cerrado): exactamente estos 8 estados, ni uno más.
// `payment.status` es un eje INDEPENDIENTE de `status` (no se mezclan).

export const ORDER_STATUS = Object.freeze({
  PENDING_CONFIRMATION: "pending_confirmation",
  CONFIRMED: "confirmed",
  READY_TO_SHIP: "ready_to_ship",
  SHIPPED: "shipped",
  DELIVERED: "delivered",
  CANCELLED: "cancelled",
  FAILED_DELIVERY: "failed_delivery",
  RETURNED: "returned",
});

export const ORDER_STATUSES = Object.values(ORDER_STATUS);

// Estados terminales: no admiten ninguna transición saliente (se valida en
// F4.3-B, no en el schema).
export const ORDER_TERMINAL_STATUSES = Object.freeze([
  ORDER_STATUS.DELIVERED,
  ORDER_STATUS.CANCELLED,
  ORDER_STATUS.RETURNED,
]);

// --- Canal de origen ---------------------------------------------------
//
// Contrato F4.2 (fuente de verdad): `source` es el CANAL desde el que se creó
// la orden, no el tipo de comprador.
//   web   -> storefront / checkout público (puede ser invitado o autenticado).
//   admin -> alta desde una superficie administrativa que use el dominio Order.
//
// "guest vs authenticated" NO es un valor de `source`: se deduce de `userId`
// (null = invitado, ObjectId = usuario autenticado). No se añade ningún campo
// extra (checkoutType / customerType / authType) — `source` + `userId` bastan.
//
// El flujo `source = "admin"` NO se implementa todavía (sigue siendo F4.3-A);
// el valor existe en el enum para no tener que migrar el schema en F4.7.
export const ORDER_SOURCE = Object.freeze({
  WEB: "web",
  ADMIN: "admin",
});

export const ORDER_SOURCES = Object.values(ORDER_SOURCE);

// --- Pago (COD) ------------------------------------------------------
//
// F4 es exclusivamente pago contra entrega: sin pasarela, sin tarjetas, sin PSE.

export const PAYMENT_METHOD = Object.freeze({
  CASH_ON_DELIVERY: "cash_on_delivery",
});

export const PAYMENT_METHODS = Object.values(PAYMENT_METHOD);

export const PAYMENT_STATUS = Object.freeze({
  PENDING: "pending",
  PAID: "paid",
  FAILED: "failed",
});

export const PAYMENT_STATUSES = Object.values(PAYMENT_STATUS);

// --- Exportación a Google Sheets (marcador, no integración) -----------
//
// F4.3-A solo persiste el estado. El job asíncrono que escribe en Sheets es F4.6.

export const EXPORT_STATUS = Object.freeze({
  PENDING: "pending",
  SYNCED: "synced",
  FAILED: "failed",
});

export const EXPORT_STATUSES = Object.values(EXPORT_STATUS);

// --- Moneda ---------------------------------------------------------
//
// DUSCK opera en pesos colombianos ENTEROS (sin centavos): todos los importes
// se guardan como Number entero, nunca float ni string monetario.
export const ORDER_CURRENCY = "COP";
export const ORDER_CURRENCIES = Object.freeze([ORDER_CURRENCY]);

// --- Cantidades por línea --------------------------------------------
//
// Contrato F4.2: 1 <= quantity <= 50 por línea de pedido.
export const MIN_ORDER_ITEM_QTY = 1;
export const MAX_ORDER_ITEM_QTY = 50;

// --- orderNumber -----------------------------------------------------
//
// Formato humano definido en F4.2: DUSCK-AAAA-NNNNNN (año de 4 dígitos, secuencia
// de 6). La GENERACIÓN (colección `counters`) es F4.3-B; aquí solo el patrón que
// el schema valida cuando el campo está presente.
export const ORDER_NUMBER_REGEX = /^DUSCK-\d{4}-\d{6}$/;

// --- Stock Adjustment Ledger (F4.3-B-R) ------------------------------
//
// Estado persistente POR PRODUCTO para el protocolo de recuperación ante un
// crash del proceso de creación de órdenes. Vive en `Order.stockAdjustments[]`
// (skeleton). Permite distinguir INEQUÍVOCAMENTE, sin inferir nada de
// `requestedItems` (que es solo la solicitud original):
//   solicitado / realmente descontado / ya compensado / pendiente de compensar.
//
//   pending      -> aún no se intentó tocar el stock de este producto.
//   decrementing -> INTENCIÓN registrada (write-ahead) inmediatamente antes del
//                   `$inc` negativo sobre Product.stock. Un crash aquí es
//                   AMBIGUO: no se puede probar si el `$inc` llegó a ejecutarse.
//                   El reaper NO compensa esta línea a ciegas; la marca para
//                   revisión. Solo el propio proceso creador, que tiene la
//                   prueba en memoria, puede compensarla.
//   decremented  -> el `$inc` negativo quedó confirmado; `decrementedQty` = las
//                   unidades REALMENTE retiradas de Product.stock.
//   compensated  -> esas unidades se devolvieron (o la línea se cerró tras un
//                   decremento fallido). `compensatedQty` lo prueba. Estado
//                   TERMINAL: nunca se reabre => la compensación es idempotente.
export const STOCK_ADJUSTMENT_STATE = Object.freeze({
  PENDING: "pending",
  DECREMENTING: "decrementing",
  DECREMENTED: "decremented",
  COMPENSATED: "compensated",
});

export const STOCK_ADJUSTMENT_STATES = Object.values(STOCK_ADJUSTMENT_STATE);

// --- Product-Local Inventory Operations (F4.3-B-R2.2) -----------------
//
// Estado de una operación de inventario del checkout, registrada en
// `product_b.stockOps[]` (NO en Order). Co-localizada con `Product.stock` para
// que el decremento/restitución de stock y el registro de la operación sean una
// ÚNICA escritura atómica sobre el documento Product (imposible con el ledger
// previo en Order, que vivía en un documento distinto que `stock`).
//
// A partir de R2.2 `product_b.stockOps[]` es la AUTORIDAD de la mutación de
// inventario; `Order.stockAdjustments[]` pasa a ser un espejo advisory / de
// auditoría y NUNCA se consulta para decidir si el stock se movió.
//
//   decremented  -> `qty` unidades retiradas de `Product.stock` por esta
//                   operación (todo-o-nada por línea; `qty` inmutable).
//   compensated  -> esas `qty` unidades fueron restituidas. Estado TERMINAL:
//                   la compensación nunca reabre la operación => idempotente.
export const STOCK_OP_STATE = Object.freeze({
  DECREMENTED: "decremented",
  COMPENSATED: "compensated",
});

export const STOCK_OP_STATES = Object.values(STOCK_OP_STATE);

// ======================================================================
// UI-5.1 — Máquina de estados del pedido (workflow de negocio)
// ======================================================================
//
// F4.3-A/B dejó los 8 estados de `ORDER_STATUS` declarados en el schema pero
// SIN una máquina de transición: una orden nacía en `pending_confirmation` y
// ahí se quedaba. UI-5.1 añade la ÚNICA autoridad de "qué transición es legal,
// para qué actor, con qué efectos". Mismo patrón que `productWorkflow.helper.js`
// (`PRODUCT_TRANSITIONS` + `canTransitionProduct`): la tabla vive aquí y NADIE
// más (controller / service / route / frontend) reimplementa las reglas.
//
// Ejes INDEPENDIENTES (contrato F4.2, no se mezclan):
//   · `order.status`   — ciclo logístico del pedido (esta máquina).
//   · `payment.status` — cobro COD (PAYMENT_TRANSITIONS, más abajo).
//
// Alcance deliberado de UI-5.1: SOLO el camino lineal feliz + cancelación desde
// los 3 estados previos al despacho. `failed_delivery` y `returned` siguen
// declarados en el enum pero permanecen INALCANZABLES — las excepciones de
// entrega y las devoluciones son una fase posterior y no se improvisan aquí.

// Roles que gestionan la operación de pedidos. Coincide con la política ya
// vigente en las rutas de lectura (`GET /api/orders` -> administrador +
// shop_manager). NO se introduce un rol nuevo ni un sistema de permisos
// granular: la autoridad sigue siendo el rol de `req.user` (cargado de Mongo
// en cada request por `autentication.middleware.js`).
export const ORDER_FULFILLMENT_ROLES = Object.freeze([ROLES.ADMIN, ROLES.SHOP_MANAGER]);

const OT = (from, to) => `${from}->${to}`;

// Cada arista válida del grafo de estados del pedido:
//   roles         quién puede ejecutarla.
//   requiresNote  exige `note` no vacía en el body (queda en statusHistory).
//   restock       la transición devuelve al inventario las unidades que el
//                 checkout reservó (solo cancelaciones). Ver
//                 `order.workflow.service.js::restockOrderInventory`.
export const ORDER_TRANSITIONS = Object.freeze({
  [OT(ORDER_STATUS.PENDING_CONFIRMATION, ORDER_STATUS.CONFIRMED)]: {
    roles: ORDER_FULFILLMENT_ROLES,
  },
  [OT(ORDER_STATUS.CONFIRMED, ORDER_STATUS.READY_TO_SHIP)]: {
    roles: ORDER_FULFILLMENT_ROLES,
  },
  [OT(ORDER_STATUS.READY_TO_SHIP, ORDER_STATUS.SHIPPED)]: {
    roles: ORDER_FULFILLMENT_ROLES,
  },
  [OT(ORDER_STATUS.SHIPPED, ORDER_STATUS.DELIVERED)]: {
    roles: ORDER_FULFILLMENT_ROLES,
  },
  // Cancelación: solo ANTES del despacho. `note` obligatoria (por qué se
  // canceló) y `restock` (las unidades vuelven al inventario, exactamente una
  // vez — ver el servicio). `shipped`/`delivered` NO son cancelables: una
  // devolución posterior sería otra funcionalidad, fuera de UI-5.1.
  [OT(ORDER_STATUS.PENDING_CONFIRMATION, ORDER_STATUS.CANCELLED)]: {
    roles: ORDER_FULFILLMENT_ROLES,
    requiresNote: true,
    restock: true,
  },
  [OT(ORDER_STATUS.CONFIRMED, ORDER_STATUS.CANCELLED)]: {
    roles: ORDER_FULFILLMENT_ROLES,
    requiresNote: true,
    restock: true,
  },
  [OT(ORDER_STATUS.READY_TO_SHIP, ORDER_STATUS.CANCELLED)]: {
    roles: ORDER_FULFILLMENT_ROLES,
    requiresNote: true,
    restock: true,
  },
});

// Estados desde los que una cancelación restituye stock. Derivado de la tabla
// (no duplicado): lo consume el servicio de recuperación / un futuro reaper.
export const ORDER_RESTOCK_FROM_STATUSES = Object.freeze(
  Object.entries(ORDER_TRANSITIONS)
    .filter(([, rule]) => rule.restock)
    .map(([key]) => key.split("->")[0]),
);

/**
 * ¿Puede `user` mover `order.status` a `toStatus`?
 * @returns {{ok:true, rule:object} | {ok:false, reason:string}}
 */
export function canTransitionOrder(order, toStatus, user) {
  if (!ORDER_STATUSES.includes(toStatus)) {
    return { ok: false, reason: "invalid-status" };
  }
  const rule = ORDER_TRANSITIONS[OT(order.status, toStatus)];
  if (!rule) {
    return { ok: false, reason: "transition-not-allowed" };
  }
  if (!rule.roles.includes(user?.role)) {
    return { ok: false, reason: "role-not-allowed" };
  }
  return { ok: true, rule };
}

// --- Pago (COD) — eje independiente de `order.status` ------------------
//
// F4 es contra entrega: sin pasarela. El cobro lo confirma manualmente un
// operador. Solo se permite AVANZAR desde `pending`; los retrocesos
// financieros (`paid -> pending`, `paid -> failed`) NO se permiten — un
// reembolso sería un workflow aparte, fuera de UI-5.1.
const PT = (from, to) => `${from}->${to}`;

export const PAYMENT_TRANSITIONS = Object.freeze({
  [PT(PAYMENT_STATUS.PENDING, PAYMENT_STATUS.PAID)]: {
    roles: ORDER_FULFILLMENT_ROLES,
  },
  [PT(PAYMENT_STATUS.PENDING, PAYMENT_STATUS.FAILED)]: {
    roles: ORDER_FULFILLMENT_ROLES,
    requiresNote: true,
  },
});

/**
 * ¿Puede `user` mover `order.payment.status` a `toStatus`?
 * @returns {{ok:true, rule:object} | {ok:false, reason:string}}
 */
export function canTransitionPayment(order, toStatus, user) {
  if (!PAYMENT_STATUSES.includes(toStatus)) {
    return { ok: false, reason: "invalid-status" };
  }
  const current = order?.payment?.status;
  const rule = PAYMENT_TRANSITIONS[PT(current, toStatus)];
  if (!rule) {
    return { ok: false, reason: "transition-not-allowed" };
  }
  if (!rule.roles.includes(user?.role)) {
    return { ok: false, reason: "role-not-allowed" };
  }
  return { ok: true, rule };
}

// Mensaje + status HTTP para un `reason` de `canTransitionOrder` /
// `canTransitionPayment`. Alineado con las convenciones del backend:
//   invalid-status         -> 400 (payload inválido)
//   transition-not-allowed -> 409 (conflicto con el estado actual)
//   role-not-allowed       -> 403 (autorización)
export function orderTransitionError(reason) {
  switch (reason) {
    case "invalid-status":
      return { status: 400, msg: "El estado destino no es válido" };
    case "transition-not-allowed":
      return {
        status: 409,
        msg: "Esa transición no está permitida desde el estado actual del pedido",
      };
    case "role-not-allowed":
      return { status: 403, msg: "Tu rol no tiene autorización para gestionar pedidos" };
    default:
      return { status: 409, msg: "Transición de estado no permitida" };
  }
}
