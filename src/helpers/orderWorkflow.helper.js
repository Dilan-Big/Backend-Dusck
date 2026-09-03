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
