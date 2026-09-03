import { Schema, model } from "mongoose";

import {
  ORDER_STATUS,
  ORDER_STATUSES,
  ORDER_SOURCES,
  PAYMENT_METHOD,
  PAYMENT_METHODS,
  PAYMENT_STATUS,
  PAYMENT_STATUSES,
  EXPORT_STATUS,
  EXPORT_STATUSES,
  ORDER_CURRENCY,
  ORDER_CURRENCIES,
  MIN_ORDER_ITEM_QTY,
  MAX_ORDER_ITEM_QTY,
  ORDER_NUMBER_REGEX,
  STOCK_ADJUSTMENT_STATE,
  STOCK_ADJUSTMENT_STATES,
} from "../helpers/orderWorkflow.helper.js";

// FASE 4.3-A — Modelo Order (checkout contra entrega / COD).
//
// Implementa SOLO la persistencia del contrato cerrado en F4.2. NO incluye:
// creación de pedidos (`POST /api/orders`), decremento/compensación de stock,
// generación de `orderNumber`, transiciones de `status`, idempotencia funcional,
// reaper de skeletons, rate limiting ni exportación a Google Sheets. Esos son
// F4.3-B en adelante.
//
// Notas de diseño heredadas de F4.2:
//   - Order es un SNAPSHOT histórico: `items`, `customer`, `shippingAddress` y
//     `totals` se congelan al crear y NO se reconstruyen con populate().
//   - Importes en COP ENTERO (Number entero, nunca float/centavos/string).
//   - Patrón "skeleton": un pedido en creación existe con `finalized: false` y
//     sin `orderNumber`/`items`/`totals` resueltos todavía. Por eso `orderNumber`
//     es opcional + índice `sparse`, y `finalized` arranca en `false`.
//   - `userId` opcional (null = invitado / guest checkout).
//   - SIN variantes: `items` NO lleva variantId/size/color/sku (F4.2 lo cerró).

const intValidator = (label) => ({
  validator: Number.isInteger,
  message: `${label} debe ser un número entero`,
});

// --- requestedItems[] — estructura INTERNA de operación ------------------
// Los productos tal como los pidió el checkout, en crudo. Existe para poder
// compensar/restockear si la creación falla a medio camino (reaper, F4.3-B/E).
// NO confundir con `items` (snapshot final ya resuelto y con precios).
const RequestedItemSchema = new Schema(
  {
    productId: {
      type: Schema.Types.ObjectId,
      ref: "product_b",
      required: [true, "Cada línea solicitada necesita un producto"],
    },
    quantity: {
      type: Number,
      required: [true, "Cada línea solicitada necesita una cantidad"],
      min: [MIN_ORDER_ITEM_QTY, `La cantidad mínima por línea es ${MIN_ORDER_ITEM_QTY}`],
      max: [MAX_ORDER_ITEM_QTY, `La cantidad máxima por línea es ${MAX_ORDER_ITEM_QTY}`],
      validate: intValidator("La cantidad"),
    },
  },
  { _id: false },
);

// --- stockAdjustments[] — LEDGER de recuperación (F4.3-B-R) -------------
// Registro atómico, POR PRODUCTO, de lo que este skeleton hizo REALMENTE con el
// stock: solicitado / descontado / compensado / estado. Permite a un futuro
// reaper recuperar una creación interrumpida por un crash del proceso SIN
// inferir cantidades desde `requestedItems`. NO confundir con `requestedItems`
// (solicitud original, inmutable) ni con `items` (snapshot final con precios).
// El servicio (`order.service.js`) lo crea 1:1 con `requestedItems` y lo
// transiciona con operaciones atómicas de un solo documento.
const StockAdjustmentSchema = new Schema(
  {
    productId: {
      type: Schema.Types.ObjectId,
      ref: "product_b",
      required: [true, "Cada ajuste de stock necesita un producto"],
    },
    // = cantidad de `requestedItems` para este producto. Inmutable.
    requestedQty: {
      type: Number,
      required: [true, "Cada ajuste de stock necesita la cantidad solicitada"],
      min: [MIN_ORDER_ITEM_QTY, `La cantidad mínima por ajuste es ${MIN_ORDER_ITEM_QTY}`],
      max: [MAX_ORDER_ITEM_QTY, `La cantidad máxima por ajuste es ${MAX_ORDER_ITEM_QTY}`],
      validate: intValidator("La cantidad solicitada"),
    },
    // Unidades REALMENTE retiradas de Product.stock por este skeleton. 0 hasta
    // que el decremento atómico queda confirmado (state = decremented).
    decrementedQty: {
      type: Number,
      default: 0,
      min: [0, "La cantidad descontada no puede ser negativa"],
      validate: intValidator("La cantidad descontada"),
    },
    // Unidades ya restituidas a Product.stock. 0 hasta compensación confirmada.
    compensatedQty: {
      type: Number,
      default: 0,
      min: [0, "La cantidad compensada no puede ser negativa"],
      validate: intValidator("La cantidad compensada"),
    },
    state: {
      type: String,
      enum: {
        values: STOCK_ADJUSTMENT_STATES,
        message: "El estado del ajuste de stock no es válido",
      },
      default: STOCK_ADJUSTMENT_STATE.PENDING,
    },
  },
  { _id: false },
);

// --- customer — SNAPSHOT del comprador, independiente de User ------------
// Se rellena desde `User` cuando hay sesión, pero una vez creado el pedido no
// cambia aunque el usuario edite su perfil.
const CustomerSchema = new Schema(
  {
    recipientName: {
      type: String,
      required: [true, "El nombre de quien recibe es obligatorio"],
      trim: true,
      minlength: [2, "El nombre de quien recibe debe tener al menos 2 caracteres"],
      maxlength: [80, "El nombre de quien recibe no puede exceder los 80 caracteres"],
    },
    // Teléfono móvil colombiano YA NORMALIZADO a 10 dígitos (empieza por 3).
    // La normalización (quitar +57, espacios, guiones) es responsabilidad de la
    // capa de servicio en F4.3-B; el modelo valida el formato final.
    phone: {
      type: String,
      required: [true, "El teléfono de contacto es obligatorio"],
      trim: true,
      match: [/^3\d{9}$/, "El teléfono debe ser un móvil colombiano de 10 dígitos"],
    },
    email: {
      type: String,
      required: [true, "El correo de contacto es obligatorio"],
      trim: true,
      lowercase: true,
      maxlength: [120, "El correo no puede exceder los 120 caracteres"],
      match: [/^\S+@\S+\.\S+$/, "El correo de contacto no tiene un formato válido"],
    },
    // Opcional (DEC-12). Cédula del destinatario para el recaudo COD de algunas
    // transportadoras. String siempre (nunca Number), sin formato tributario.
    documentId: {
      type: String,
      trim: true,
      maxlength: [20, "El documento no puede exceder los 20 caracteres"],
    },
  },
  { _id: false },
);

// --- shippingAddress — SNAPSHOT textual de la entrega -------------------
// Sin geocoding, sin lat/lng, sin catálogo de departamentos/municipios.
const ShippingAddressSchema = new Schema(
  {
    department: {
      type: String,
      required: [true, "El departamento es obligatorio"],
      trim: true,
      minlength: [2, "El departamento debe tener al menos 2 caracteres"],
      maxlength: [60, "El departamento no puede exceder los 60 caracteres"],
    },
    city: {
      type: String,
      required: [true, "La ciudad o municipio es obligatorio"],
      trim: true,
      minlength: [2, "La ciudad debe tener al menos 2 caracteres"],
      maxlength: [80, "La ciudad no puede exceder los 80 caracteres"],
    },
    neighborhood: {
      type: String,
      required: [true, "El barrio es obligatorio"],
      trim: true,
      minlength: [2, "El barrio debe tener al menos 2 caracteres"],
      maxlength: [80, "El barrio no puede exceder los 80 caracteres"],
    },
    address: {
      type: String,
      required: [true, "La dirección es obligatoria"],
      trim: true,
      minlength: [5, "La dirección debe tener al menos 5 caracteres"],
      maxlength: [160, "La dirección no puede exceder los 160 caracteres"],
    },
    addressComplement: {
      type: String,
      trim: true,
      maxlength: [80, "El complemento no puede exceder los 80 caracteres"],
    },
    reference: {
      type: String,
      trim: true,
      maxlength: [160, "La referencia no puede exceder los 160 caracteres"],
    },
  },
  { _id: false },
);

// --- items[] — SNAPSHOT final de lo comprado --------------------------
// Precio y nombre CONGELADOS: si el Product cambia después, el pedido no.
// `unitPrice` y `subtotal` los calcula el SERVICIO (F4.3-B), no el schema.
const OrderItemSchema = new Schema(
  {
    productId: {
      type: Schema.Types.ObjectId,
      ref: "product_b",
      required: [true, "Cada ítem del pedido necesita un producto"],
    },
    productName: {
      type: String,
      required: [true, "Cada ítem necesita el nombre del producto (snapshot)"],
      trim: true,
      maxlength: [100, "El nombre del producto no puede exceder los 100 caracteres"],
    },
    slug: {
      type: String,
      required: [true, "Cada ítem necesita el slug del producto (snapshot)"],
      trim: true,
      maxlength: [160, "El slug no puede exceder los 160 caracteres"],
    },
    // URL de la imagen principal en el momento de la compra. Coherente con
    // `product_b.images[].url` (string). `null` si el producto no tenía imagen.
    image: {
      type: String,
      trim: true,
      default: null,
    },
    // Pesos colombianos ENTEROS. Nunca float, nunca string.
    unitPrice: {
      type: Number,
      required: [true, "Cada ítem necesita un precio unitario (snapshot)"],
      min: [0, "El precio unitario no puede ser negativo"],
      validate: intValidator("El precio unitario"),
    },
    quantity: {
      type: Number,
      required: [true, "Cada ítem necesita una cantidad"],
      min: [MIN_ORDER_ITEM_QTY, `La cantidad mínima por ítem es ${MIN_ORDER_ITEM_QTY}`],
      max: [MAX_ORDER_ITEM_QTY, `La cantidad máxima por ítem es ${MAX_ORDER_ITEM_QTY}`],
      validate: intValidator("La cantidad"),
    },
    // = unitPrice * quantity. Lo calcula el servicio; el schema solo valida forma.
    subtotal: {
      type: Number,
      required: [true, "Cada ítem necesita un subtotal (snapshot)"],
      min: [0, "El subtotal no puede ser negativo"],
      validate: intValidator("El subtotal"),
    },
  },
  { _id: false },
);

// --- totals — autoridad del backend, todo en COP entero ---------------
// F4: `shipping` siempre 0 (no hay política de envío). El CÁLCULO es F4.3-B.
const TotalsSchema = new Schema(
  {
    itemsSubtotal: {
      type: Number,
      default: 0,
      min: [0, "El subtotal de ítems no puede ser negativo"],
      validate: intValidator("El subtotal de ítems"),
    },
    shipping: {
      type: Number,
      default: 0,
      min: [0, "El costo de envío no puede ser negativo"],
      validate: intValidator("El costo de envío"),
    },
    grandTotal: {
      type: Number,
      default: 0,
      min: [0, "El total no puede ser negativo"],
      validate: intValidator("El total"),
    },
    currency: {
      type: String,
      enum: {
        values: ORDER_CURRENCIES,
        message: `La moneda debe ser ${ORDER_CURRENCY}`,
      },
      default: ORDER_CURRENCY,
    },
  },
  { _id: false },
);

// --- payment — COD, sin pasarela --------------------------------------
const PaymentSchema = new Schema(
  {
    method: {
      type: String,
      enum: {
        values: PAYMENT_METHODS,
        message: "El método de pago no es válido para esta fase (solo contra entrega)",
      },
      default: PAYMENT_METHOD.CASH_ON_DELIVERY,
    },
    status: {
      type: String,
      enum: {
        values: PAYMENT_STATUSES,
        message: "El estado de pago no es válido",
      },
      default: PAYMENT_STATUS.PENDING,
    },
  },
  { _id: false },
);

// --- statusHistory[] — bitácora append-only del ciclo de vida ---------
// Las reglas de transición y la obligatoriedad de `note` (para cancelaciones /
// entregas fallidas / devoluciones) las aplica el workflow en F4.3-B.
const StatusHistoryEntrySchema = new Schema(
  {
    status: {
      type: String,
      required: [true, "Cada entrada de historial necesita un estado"],
      enum: {
        values: ORDER_STATUSES,
        message: "El estado del historial no es válido",
      },
    },
    changedAt: {
      type: Date,
      required: [true, "Cada entrada de historial necesita una fecha"],
      default: Date.now,
    },
    // null para cambios automáticos del sistema (p. ej. la creación del pedido).
    changedBy: {
      type: Schema.Types.ObjectId,
      ref: "user",
      default: null,
    },
    note: {
      type: String,
      trim: true,
      maxlength: [500, "La nota del historial no puede exceder los 500 caracteres"],
    },
  },
  { _id: false },
);

// --- export — marcador de sincronización con Google Sheets ------------
// SOLO estado persistente. El job que escribe en Sheets es F4.6.
const ExportSchema = new Schema(
  {
    status: {
      type: String,
      enum: {
        values: EXPORT_STATUSES,
        message: "El estado de exportación no es válido",
      },
      default: EXPORT_STATUS.PENDING,
    },
    attempts: {
      type: Number,
      default: 0,
      min: [0, "El número de intentos no puede ser negativo"],
      validate: intValidator("El número de intentos"),
    },
    syncedAt: { type: Date, default: null },
    sheetRowRef: { type: String, trim: true, default: null },
    // Solo mensaje corto / error.name — NUNCA PII ni el payload del pedido.
    lastError: { type: String, trim: true, maxlength: [300, "El detalle de error es demasiado largo"], default: null },
  },
  { _id: false },
);

// --- Order --------------------------------------------------------
const OrderSchema = new Schema(
  {
    // Referencia humana DUSCK-AAAA-NNNNNN. Opcional a nivel de schema porque un
    // pedido "skeleton" (en creación) aún no lo tiene; el índice único es
    // `sparse` para permitir varios documentos sin este campo. La GENERACIÓN es
    // F4.3-B (colección `counters`).
    orderNumber: {
      type: String,
      trim: true,
      unique: true,
      sparse: true,
      match: [ORDER_NUMBER_REGEX, "El número de pedido no tiene el formato DUSCK-AAAA-NNNNNN"],
    },

    // null = invitado (guest checkout). Con sesión válida, el `_id` del User.
    userId: {
      type: Schema.Types.ObjectId,
      ref: "user",
      default: null,
    },

    // Clave de idempotencia (UUID generado por el cliente). Obligatoria y única
    // a nivel global: es el "claim" atómico que evita pedidos duplicados. El
    // ALGORITMO de idempotencia (skeleton, retry, respuesta al repetir) es F4.3-B.
    idempotencyKey: {
      type: String,
      required: [true, "La clave de idempotencia es obligatoria"],
      trim: true,
      unique: true,
      match: [
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        "La clave de idempotencia debe ser un UUID válido",
      ],
    },

    // false mientras el pedido se está creando (skeleton); true cuando quedó
    // completo. El flujo que lo pone en true es F4.3-B.
    finalized: {
      type: Boolean,
      default: false,
    },

    // Canal/origen (contrato F4.2): "web" = storefront/checkout público,
    // "admin" = alta administrativa. "guest vs authenticated" NO vive aquí: se
    // deduce de `userId` (null = invitado). El servicio de F4.3-B asigna el valor.
    source: {
      type: String,
      required: [true, "El origen del pedido es obligatorio"],
      enum: {
        values: ORDER_SOURCES,
        message: "El origen del pedido no es válido",
      },
    },

    // Solicitud ORIGINAL del checkout, en crudo y normalizada por producto.
    // Inmutable tras crear el skeleton. Se usa como ENUMERACIÓN de los productos
    // que la orden pudo tocar; la cantidad realmente descontada y si se movió el
    // stock son autoridad de `product_b.stockOps[]`, NUNCA de aquí.
    requestedItems: {
      type: [RequestedItemSchema],
      required: true,
      validate: {
        validator: (v) => Array.isArray(v) && v.length > 0,
        message: "El pedido necesita al menos una línea solicitada",
      },
    },

    // ADVISORY / AUDITORÍA (desde F4.3-B-R2.2). Espejo best-effort del ledger
    // autoritativo `product_b.stockOps[]`. Puede quedar desincronizado si el
    // proceso muere entre la mutación atómica del Product y este espejo — es
    // aceptable: recovery y compensación NO lo consultan para decidir nada.
    stockAdjustments: {
      type: [StockAdjustmentSchema],
      default: [],
    },

    // F4.3-B-R2.2 — marcador del pruning del ledger de operaciones de inventario.
    // Se pone en true SOLO tras `finalized:true` + `$pull` de las stockOps de esta
    // orden en cada producto. Un futuro reaper de backstop escanea
    // `{ finalized:true, stockOpsPruned:false }` para reintentar una poda que
    // quedó a medias por un crash. Nunca implica tocar stock.
    stockOpsPruned: {
      type: Boolean,
      default: false,
    },

    customer: {
      type: CustomerSchema,
      required: [true, "El pedido necesita los datos del cliente"],
    },

    shippingAddress: {
      type: ShippingAddressSchema,
      required: [true, "El pedido necesita una dirección de entrega"],
    },

    // Snapshot final. Vacío en un skeleton; lo llena el servicio en F4.3-B.
    items: {
      type: [OrderItemSchema],
      default: [],
    },

    totals: {
      type: TotalsSchema,
      default: () => ({}),
    },

    payment: {
      type: PaymentSchema,
      default: () => ({}),
    },

    status: {
      type: String,
      enum: {
        values: ORDER_STATUSES,
        message: "El estado del pedido no es válido",
      },
      default: ORDER_STATUS.PENDING_CONFIRMATION,
    },

    statusHistory: {
      type: [StatusHistoryEntrySchema],
      default: [],
    },

    // Observaciones del cliente. NO es un sustituto de talla/color/SKU.
    notes: {
      type: String,
      trim: true,
      maxlength: [500, "Las notas no pueden exceder los 500 caracteres"],
    },

    export: {
      type: ExportSchema,
      default: () => ({}),
    },
  },
  {
    versionKey: false,
    timestamps: true,
  },
);

// --- Índices ------------------------------------------------------
// (`idempotencyKey` y `orderNumber` ya declaran su índice único en el campo.)
//
//   { status, createdAt }         Panel admin: listar/filtrar por estado, más
//                                 recientes primero (GET /api/orders?status=).
//   { userId, createdAt }         "Mis pedidos" del usuario autenticado
//                                 (GET /api/orders/mine), recientes primero.
//   { finalized, createdAt }      Listado admin por defecto (finalized:true) y
//                                 barrido del reaper (finalized:false + antiguos).
//   { export.status }             Job asíncrono de exportación a Sheets (F4.6):
//                                 selecciona los pedidos con export pendiente.
OrderSchema.index({ status: 1, createdAt: -1 });
OrderSchema.index({ userId: 1, createdAt: -1 });
OrderSchema.index({ finalized: 1, createdAt: -1 });
OrderSchema.index({ "export.status": 1 });

//   { stockOpsPruned } PARCIAL  Backstop de poda del ledger de inventario
//                               (F4.3-B-R2.2): solo indexa las órdenes ya
//                               finalizadas cuya poda de `stockOps` quedó
//                               pendiente. Conjunto minúsculo en régimen normal.
OrderSchema.index(
  { stockOpsPruned: 1 },
  { partialFilterExpression: { finalized: true, stockOpsPruned: false } },
);

const OrderModel = model("order", OrderSchema);

export default OrderModel;
