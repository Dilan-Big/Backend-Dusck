import { createOrder } from "../services/order.service.js";
import { listFinalizedOrders, getFinalizedOrderById } from "../services/order.read.service.js";
import {
  transitionOrderStatus,
  transitionOrderPayment,
} from "../services/order.workflow.service.js";
import { dbDeleteCartByUserId } from "../services/cart.service.js";
import { isPlainString, isValidObjectId, pickAllowed } from "../helpers/validation.helpers.js";
import { ORDER_STATUSES, ORDER_NUMBER_REGEX, PAYMENT_STATUSES } from "../helpers/orderWorkflow.helper.js";

// FASE 4.3-C — Wiring HTTP de POST /api/orders.
//
// Esta capa SOLO traduce HTTP <-> `order.service.js::createOrder`. NO conoce
// productos, precios, stock, idempotencia ni el Cart: todo eso es autoridad
// del servicio de dominio (F4.3-B / R2.2, cerrado). El controller:
//   - extrae `Idempotency-Key`, body y sesion opcional-estricta;
//   - construye un objeto de entrada NUEVO por lista blanca (jamas `...req.body`);
//   - fuerza `source: "web"` y deriva `userId` del token verificado, nunca del body;
//   - proyecta la Order a una forma publica (sin PII interna ni maquinaria);
//   - limpia el carrito autenticado best-effort tras el exito;
//   - mapea los errores de dominio (`err.isOrderError`) a HTTP.

// Campos de `customer` / `shippingAddress` que el contrato acepta del cliente.
// Cualquier otra clave del body se descarta (lista blanca por construccion).
const CUSTOMER_FIELDS = ["recipientName", "phone", "email", "documentId"];
const SHIPPING_FIELDS = [
  "department",
  "city",
  "neighborhood",
  "address",
  "addressComplement",
  "reference",
];

// Proyeccion PUBLICA de una Order finalizada. La respuesta NUNCA devuelve el
// documento Mongoose crudo: expondria `idempotencyKey`, `requestedItems`,
// `stockAdjustments`, `finalized`, `source`, `statusHistory`, `export` y demas
// maquinaria interna. Mismo patron que las proyecciones CLIENT/ADMIN de
// `cart.service.js`: lista blanca, se copian solo los campos del contrato.
const toPublicOrder = (order) => {
  const o = order && typeof order.toObject === "function" ? order.toObject() : order || {};
  const customer = o.customer || {};
  const address = o.shippingAddress || {};
  const totals = o.totals || {};
  const payment = o.payment || {};

  return {
    id: o._id !== undefined ? String(o._id) : undefined,
    orderNumber: o.orderNumber ?? null,
    status: o.status,
    userId: o.userId ? String(o.userId) : null,
    items: (Array.isArray(o.items) ? o.items : []).map((it) => ({
      productId: String(it.productId),
      productName: it.productName,
      slug: it.slug,
      image: it.image ?? null,
      // TALLAS — aditivo: `null` cuando el producto no tiene tallas.
      size: it.size ?? null,
      unitPrice: it.unitPrice,
      quantity: it.quantity,
      subtotal: it.subtotal,
    })),
    totals: {
      itemsSubtotal: totals.itemsSubtotal ?? 0,
      shipping: totals.shipping ?? 0,
      grandTotal: totals.grandTotal ?? 0,
      currency: totals.currency ?? "COP",
    },
    payment: {
      method: payment.method,
      status: payment.status,
    },
    customer: {
      recipientName: customer.recipientName,
      phone: customer.phone,
      email: customer.email,
      ...(customer.documentId ? { documentId: customer.documentId } : {}),
    },
    shippingAddress: {
      department: address.department,
      city: address.city,
      neighborhood: address.neighborhood,
      address: address.address,
      ...(address.addressComplement ? { addressComplement: address.addressComplement } : {}),
      ...(address.reference ? { reference: address.reference } : {}),
    },
    ...(o.notes ? { notes: o.notes } : {}),
    createdAt: o.createdAt,
  };
};

const createOrderController = async (req, res) => {
  try {
    // 1. Header obligatorio. Se pasa TAL CUAL al servicio: la validacion de
    //    formato (UUID) y de presencia es autoridad de `createOrder`
    //    (`ORDER_INVALID_INPUT` -> 400). El controller NO implementa idempotencia.
    const idempotencyKey = req.header("Idempotency-Key");

    const body = req.body && typeof req.body === "object" ? req.body : {};

    // 2/3/4. Objeto de entrada NUEVO. Nunca `...req.body`. Los campos
    //        server-owned (userId, price, totals, status, payment, orderNumber,
    //        source, finalized, stock*, requestedItems, stockAdjustments,
    //        statusHistory, export) se ignoran aunque vengan en el body.
    const items = Array.isArray(body.items)
      ? body.items.map((line) =>
          line && typeof line === "object"
            ? // TALLAS — `size` OPCIONAL por línea. Lista blanca: nada más del
              // objeto de línea se propaga (nunca `variantId`/`color`/`sku`/precio).
              {
                productId: line.productId,
                quantity: line.quantity,
                ...(line.size !== undefined ? { size: line.size } : {}),
              }
            : line,
        )
      : body.items; // no-array -> el servicio lo rechaza con 400

    const customer = pickAllowed(
      body.customer && typeof body.customer === "object" ? body.customer : {},
      CUSTOMER_FIELDS,
    );
    const shippingAddress = pickAllowed(
      body.shippingAddress && typeof body.shippingAddress === "object" ? body.shippingAddress : {},
      SHIPPING_FIELDS,
    );
    const notes = body.notes;

    // 5/6. `userId` SIEMPRE del token verificado (authenticateOptionalStrict),
    //      jamas de `req.body`. Invitado -> null. `source` forzado a "web".
    const userId = req.user?._id ?? null;

    // 7. Delegacion. `createOrder` es la unica autoridad de negocio.
    const order = await createOrder({
      items,
      customer,
      shippingAddress,
      notes,
      userId,
      source: "web",
      idempotencyKey,
    });

    // 9. Cart cleanup — SOLO usuario autenticado, SOLO tras exito, best-effort.
    //    El Cart NO participa en `createOrder` (el pedido lleva `items` explicito).
    //    Un fallo aqui no toca la respuesta ni la Order: Order es la fuente de
    //    verdad y el carrito es estado de UI desechable, re-limpiable de forma
    //    idempotente. Invitado: no hay carrito que limpiar.
    if (req.user?._id) {
      try {
        await dbDeleteCartByUserId(req.user._id);
      } catch (error) {
        console.error(`[order.controller] cart cleanup -> ${error && error.name}`);
      }
    }

    // 8. Respuesta publica. 201 tambien para una repeticion idempotente: la
    //    garantia (misma key -> misma orden -> sin doble decremento) la da el
    //    servicio; F4.3-C.1 no distingue fresh/replay (no se toca order.service).
    return res.status(201).json({
      msg: "Pedido creado exitosamente",
      data: toPublicOrder(order),
    });
  } catch (error) {
    // 10/11. Errores de dominio: `.status` + `.message` ya son PII-free y
    //        aptos para el cliente. Nunca se filtra `.stack`, `.name`, errores
    //        de Mongo, `keyPattern`/`keyValue` ni detalle de recuperacion.
    if (error && error.isOrderError) {
      return res.status(error.status || 500).json({
        msg: error.message,
        ...(error.retryable ? { retryable: true } : {}),
      });
    }

    console.error(`[order.controller] ${error && error.name}`);
    return res.status(500).json({
      msg: "No se pudo completar el pedido",
    });
  }
};

// ====================================================================
// FASE 4.3-C.3.1 — GET /api/orders (listado administrativo, SOLO LECTURA)
// ====================================================================
//
// Adapter HTTP: lee y VALIDA `req.query`, construye un filtro Mongo con
// primitivas validadas (jamás `{ ...req.query }`), delega en
// `order.read.service.js` y proyecta la respuesta pública. `finalized: true` lo
// fuerza el servicio; el cliente nunca lo controla. NO consulta Mongo aquí.

const SORT_FIELDS = new Set(["createdAt", "orderNumber", "status"]);
const ORDER_DIRECTIONS = new Set(["asc", "desc"]);
const LIST_MAX_LIMIT = 100;
const LIST_DEFAULT_LIMIT = 20;

// Fecha simple (YYYY-MM-DD) vs. instante ISO-8601 con zona. Se aceptan ambos.
// Una fecha simple representa un DÍA CALENDARIO en la zona operativa de DUSCK,
// America/Bogota. Colombia usa un offset FIJO UTC-5 (sin horario de verano),
// así que basta anclar la cadena a `-05:00` — `new Date(...)` la convierte al
// instante UTC correcto y MongoDB sigue trabajando en UTC. Sin dependencias.
const BOGOTA_OFFSET = "-05:00";
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
// Mismo criterio de forma que `CustomerSchema.email` (order.model.js).
const EMAIL_RE = /^\S+@\S+\.\S+$/;

// Error de parámetro de query -> HTTP 400. Sin PII.
class QueryParamError extends Error {
  constructor(message) {
    super(message);
    this.isQueryParamError = true;
  }
}

// Entero positivo estricto: solo dígitos (no "1.5", "-1", "+1", " 1", "", "1e3"),
// entero seguro, dentro de rango. `undefined` -> valor por defecto.
const parseIntParam = (raw, { field, min, max, def }) => {
  if (raw === undefined) return def;
  if (!isPlainString(raw) || !/^\d+$/.test(raw)) {
    throw new QueryParamError(`El parámetro '${field}' no es válido`);
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(n) || n < min || (max !== undefined && n > max)) {
    throw new QueryParamError(`El parámetro '${field}' está fuera de rango`);
  }
  return n;
};

// Fecha simple o ISO-8601 con zona.
//   YYYY-MM-DD  -> inicio (`createdFrom`) o fin (`createdTo`) de ESE día
//                  calendario en America/Bogota (UTC-5). p. ej. `createdTo=
//                  2026-02-15` => 2026-02-15T23:59:59.999-05:00.
//   ISO con zona -> se respeta EXACTAMENTE el offset que envió el cliente.
const parseDateParam = (raw, { field, endOfDay }) => {
  if (raw === undefined) return undefined;
  if (!isPlainString(raw)) {
    throw new QueryParamError(`El parámetro '${field}' no es una fecha válida`);
  }
  let iso;
  if (DATE_ONLY_RE.test(raw)) {
    iso = `${raw}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}${BOGOTA_OFFSET}`;
  } else if (ISO_DATETIME_RE.test(raw)) {
    iso = raw;
  } else {
    throw new QueryParamError(`El parámetro '${field}' no es una fecha ISO-8601 válida`);
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    throw new QueryParamError(`El parámetro '${field}' no es una fecha válida`);
  }
  return d;
};

// Proyección PÚBLICA de un ítem del listado administrativo (contrato C.3.0/§22).
// Objeto NUEVO por construcción: aunque el `.select()` del servicio fallara,
// aquí nunca se filtran campos internos ni `shippingAddress`/`documentId`/
// `statusHistory`/`notes` (reservados para GET /api/orders/:id).
const toAdminOrderListItem = (order) => {
  const o = order || {};
  const customer = o.customer || {};
  const payment = o.payment || {};
  const totals = o.totals || {};
  return {
    id: o._id !== undefined ? String(o._id) : undefined,
    orderNumber: o.orderNumber ?? null,
    userId: o.userId ? String(o.userId) : null,
    status: o.status,
    payment: {
      method: payment.method,
      status: payment.status,
    },
    totals: {
      itemsSubtotal: totals.itemsSubtotal ?? 0,
      shipping: totals.shipping ?? 0,
      grandTotal: totals.grandTotal ?? 0,
      currency: totals.currency ?? "COP",
    },
    itemsCount: Array.isArray(o.items) ? o.items.length : 0,
    customer: {
      recipientName: customer.recipientName,
      email: customer.email,
      phone: customer.phone,
    },
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
};

const listOrdersController = async (req, res) => {
  try {
    const q = req.query && typeof req.query === "object" ? req.query : {};

    // --- Paginación ---
    const page = parseIntParam(q.page, { field: "page", min: 1, def: 1 });
    const limit = parseIntParam(q.limit, {
      field: "limit",
      min: 1,
      max: LIST_MAX_LIMIT,
      def: LIST_DEFAULT_LIMIT,
    });
    const skip = (page - 1) * limit;
    if (!Number.isSafeInteger(skip)) {
      throw new QueryParamError("El parámetro 'page' está fuera de rango");
    }

    // --- Ordenamiento (whitelist estricta + tie-breaker estable) ---
    const sortField = q.sort === undefined ? "createdAt" : q.sort;
    if (!isPlainString(sortField) || !SORT_FIELDS.has(sortField)) {
      throw new QueryParamError("El parámetro 'sort' no es válido");
    }
    const orderDir = q.order === undefined ? "desc" : q.order;
    if (!isPlainString(orderDir) || !ORDER_DIRECTIONS.has(orderDir)) {
      throw new QueryParamError("El parámetro 'order' no es válido");
    }
    const dir = orderDir === "asc" ? 1 : -1;
    const sort = { [sortField]: dir, _id: dir };

    // --- Filtros (construcción EXPLÍCITA con primitivas validadas) ---
    const filter = {};

    if (q.status !== undefined) {
      if (!isPlainString(q.status) || !ORDER_STATUSES.includes(q.status)) {
        throw new QueryParamError("El parámetro 'status' no es válido");
      }
      filter.status = q.status;
    }

    if (q.orderNumber !== undefined) {
      if (!isPlainString(q.orderNumber) || !ORDER_NUMBER_REGEX.test(q.orderNumber)) {
        throw new QueryParamError(
          "El parámetro 'orderNumber' no tiene el formato DUSCK-AAAA-NNNNNN",
        );
      }
      filter.orderNumber = q.orderNumber; // igualdad exacta, nunca regex
    }

    if (q.userId !== undefined) {
      if (!isValidObjectId(q.userId)) {
        throw new QueryParamError("El parámetro 'userId' no es un identificador válido");
      }
      filter.userId = q.userId;
    }

    if (q.customerEmail !== undefined) {
      if (!isPlainString(q.customerEmail)) {
        throw new QueryParamError("El parámetro 'customerEmail' no es válido");
      }
      const normalizedEmail = q.customerEmail.trim().toLowerCase();
      if (!EMAIL_RE.test(normalizedEmail)) {
        throw new QueryParamError("El parámetro 'customerEmail' no es un correo válido");
      }
      filter["customer.email"] = normalizedEmail; // igualdad exacta
    }

    const createdFrom = parseDateParam(q.createdFrom, { field: "createdFrom", endOfDay: false });
    const createdTo = parseDateParam(q.createdTo, { field: "createdTo", endOfDay: true });
    if (createdFrom && createdTo && createdFrom.getTime() > createdTo.getTime()) {
      throw new QueryParamError("'createdFrom' no puede ser posterior a 'createdTo'");
    }
    if (createdFrom || createdTo) {
      filter.createdAt = {};
      if (createdFrom) filter.createdAt.$gte = createdFrom;
      if (createdTo) filter.createdAt.$lte = createdTo;
    }

    // --- Consulta (delegada; `finalized: true` lo fuerza el servicio) ---
    const { total, docs } = await listFinalizedOrders({ filter, sort, skip, limit });

    const totalPages = total === 0 ? 0 : Math.ceil(total / limit);

    return res.status(200).json({
      msg: "Pedidos obtenidos correctamente",
      data: {
        items: docs.map(toAdminOrderListItem),
        pagination: { page, limit, total, totalPages },
      },
    });
  } catch (error) {
    if (error && error.isQueryParamError) {
      return res.status(400).json({ msg: error.message });
    }
    console.error(`[order.controller] listOrders -> ${error && error.name}`);
    return res.status(500).json({ msg: "No se pudo obtener el listado de pedidos" });
  }
};

// ====================================================================
// FASE 4.3-C.3.2 — GET /api/orders/:id (detalle administrativo, SOLO LECTURA)
// ====================================================================
//
// Adapter HTTP: valida `:id` con el helper existente, delega la lectura en
// `order.read.service.js::getFinalizedOrderById` (que impone `finalized:true`) y
// proyecta la respuesta con una función literal. NO consulta Mongo aquí, NO
// consulta Product, NO acepta query params, NO muta nada.

// Serializa un ObjectId (o string) a String; `null`/`undefined` -> `null`.
const idToString = (v) => (v === null || v === undefined ? null : String(v));

// Proyección PÚBLICA del DETALLE administrativo (contrato F4.3-C.3.2). Objeto
// NUEVO por construcción — nunca `{ ...order }`, nunca el documento Mongo crudo.
// Los campos internos (`idempotencyKey`, `finalized`, `source`, `requestedItems`,
// `stockAdjustments`, `stockOpsPruned`, `export`, `__v`) no se leen ni se emiten.
// Los opcionales aparecen SIEMPRE con `null` explícito (DEC-C3.2-G).
const toAdminOrderDetail = (order) => {
  const o = order || {};
  const customer = o.customer || {};
  const address = o.shippingAddress || {};
  const totals = o.totals || {};
  const payment = o.payment || {};

  return {
    id: idToString(o._id),
    orderNumber: o.orderNumber ?? null,
    userId: idToString(o.userId),
    status: o.status ?? null,
    createdAt: o.createdAt ?? null,
    updatedAt: o.updatedAt ?? null,
    customer: {
      recipientName: customer.recipientName ?? null,
      phone: customer.phone ?? null,
      email: customer.email ?? null,
      documentId: customer.documentId ?? null,
    },
    shippingAddress: {
      department: address.department ?? null,
      city: address.city ?? null,
      neighborhood: address.neighborhood ?? null,
      address: address.address ?? null,
      addressComplement: address.addressComplement ?? null,
      reference: address.reference ?? null,
    },
    items: (Array.isArray(o.items) ? o.items : []).map((it) => ({
      productId: idToString(it.productId),
      productName: it.productName ?? null,
      slug: it.slug ?? null,
      image: it.image ?? null,
      // TALLAS — aditivo: `null` cuando el producto no tiene tallas.
      size: it.size ?? null,
      unitPrice: it.unitPrice ?? null,
      quantity: it.quantity ?? null,
      subtotal: it.subtotal ?? null,
    })),
    totals: {
      itemsSubtotal: totals.itemsSubtotal ?? 0,
      shipping: totals.shipping ?? 0,
      grandTotal: totals.grandTotal ?? 0,
      currency: totals.currency ?? "COP",
    },
    payment: {
      method: payment.method ?? null,
      status: payment.status ?? null,
    },
    // Orden cronológico tal cual está almacenado (append-only): NO se reordena.
    statusHistory: (Array.isArray(o.statusHistory) ? o.statusHistory : []).map((h) => ({
      status: h.status ?? null,
      changedAt: h.changedAt ?? null,
      changedBy: idToString(h.changedBy), // string | null — sin populate (DEC-C3.2-C)
      note: h.note ?? null,
    })),
    notes: o.notes ?? null,
  };
};

const getOrderByIdController = async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return res.status(400).json({ msg: "El identificador del pedido no es válido" });
    }

    // El servicio impone `finalized: true`. Un skeleton (`finalized:false`) o un
    // id inexistente devuelven `null` -> mismo 404, sin revelar el skeleton.
    const order = await getFinalizedOrderById(id);
    if (!order) {
      return res.status(404).json({ msg: "El pedido no se encuentra registrado" });
    }

    return res.status(200).json({
      msg: "Pedido obtenido correctamente",
      data: toAdminOrderDetail(order),
    });
  } catch (error) {
    console.error(`[order.controller] getOrderById -> ${error && error.name}`);
    return res.status(500).json({ msg: "No se pudo obtener el pedido" });
  }
};

// ====================================================================
// UI-5.1 — PATCH /api/orders/:id/status  (transición del ciclo de vida)
// ====================================================================
//
// Adapter HTTP puro: valida `:id` y el body por LISTA BLANCA (`status`, `note`
// — nada más se lee, jamás `...req.body`), deriva el actor de `req.user`
// (nunca del body) y delega TODA la regla de negocio en
// `order.workflow.service.js::transitionOrderStatus` (máquina de estados +
// autorización por rol + atomicidad + restitución de inventario). El servicio
// devuelve `{ ok, status, msg }`; aquí solo se traduce a HTTP.

const MAX_STATUS_NOTE = 500; // = maxlength de `statusHistory.note` (order.model.js)
const MAX_PAYMENT_NOTE = 300; // = maxlength de `payment.note` (order.model.js)

// `note` opcional: si viene, debe ser string y no exceder el límite del schema.
const validateNote = (raw, max) => {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (!isPlainString(raw)) return { ok: false };
  if (raw.length > max) return { ok: false };
  return { ok: true, value: raw };
};

const updateOrderStatusController = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return res.status(400).json({ msg: "El identificador del pedido no es válido" });
    }

    const body = req.body && typeof req.body === "object" ? req.body : {};
    // `status` es el campo del contrato; `toStatus` se acepta como alias por
    // coherencia con `PATCH /product/:id/status`.
    const status = body.status ?? body.toStatus;
    if (!isPlainString(status) || !ORDER_STATUSES.includes(status)) {
      return res.status(400).json({ msg: "Debes indicar un `status` de pedido válido" });
    }

    const note = validateNote(body.note, MAX_STATUS_NOTE);
    if (!note.ok) {
      return res.status(400).json({
        msg: `La nota no es válida (texto de hasta ${MAX_STATUS_NOTE} caracteres)`,
      });
    }

    const result = await transitionOrderStatus({
      orderId: id,
      toStatus: status,
      actor: req.user, // autoridad del actor: SIEMPRE del token verificado
      note: note.value,
    });

    if (!result.ok) {
      return res.status(result.status).json({ msg: result.msg });
    }

    return res.status(200).json({
      msg: "Estado del pedido actualizado correctamente",
      data: toAdminOrderDetail(result.order.toObject ? result.order.toObject() : result.order),
    });
  } catch (error) {
    console.error(`[order.controller] updateOrderStatus -> ${error && error.name}`);
    return res.status(500).json({ msg: "No se pudo actualizar el estado del pedido" });
  }
};

// ====================================================================
// UI-5.1 — PATCH /api/orders/:id/payment  (estado de cobro COD)
// ====================================================================
//
// Eje INDEPENDIENTE de `order.status`. Misma mecánica: lista blanca
// (`status`, `note`), actor de `req.user`, negocio en el servicio
// (`transitionOrderPayment`). Solo `pending -> paid | failed`; sin retrocesos.

const updateOrderPaymentController = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return res.status(400).json({ msg: "El identificador del pedido no es válido" });
    }

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const status = body.status;
    if (!isPlainString(status) || !PAYMENT_STATUSES.includes(status)) {
      return res.status(400).json({ msg: "Debes indicar un `status` de pago válido" });
    }

    const note = validateNote(body.note, MAX_PAYMENT_NOTE);
    if (!note.ok) {
      return res.status(400).json({
        msg: `La nota no es válida (texto de hasta ${MAX_PAYMENT_NOTE} caracteres)`,
      });
    }

    const result = await transitionOrderPayment({
      orderId: id,
      toStatus: status,
      actor: req.user,
      note: note.value,
    });

    if (!result.ok) {
      return res.status(result.status).json({ msg: result.msg });
    }

    return res.status(200).json({
      msg: "Estado de pago actualizado correctamente",
      data: toAdminOrderDetail(result.order.toObject ? result.order.toObject() : result.order),
    });
  } catch (error) {
    console.error(`[order.controller] updateOrderPayment -> ${error && error.name}`);
    return res.status(500).json({ msg: "No se pudo actualizar el estado de pago del pedido" });
  }
};

export {
  createOrderController,
  toPublicOrder,
  listOrdersController,
  toAdminOrderListItem,
  getOrderByIdController,
  toAdminOrderDetail,
  updateOrderStatusController,
  updateOrderPaymentController,
};
