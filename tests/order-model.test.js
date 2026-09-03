// FASE 4.3-A — Tests del modelo Order (schema / persistencia).
//
// Dos bloques:
//   1. Validación de schema (`Model.prototype.validate()`) — NO necesita MongoDB.
//   2. Índices únicos (idempotencyKey, orderNumber sparse) y estructura Counter —
//      necesitan MongoDB. Si no hay Mongo disponible, ESOS tests se marcan `skip`
//      (misma estrategia que el resto de la suite del proyecto). Usa una base de
//      datos APARTE: `db-dusck-order-model-test`, que se elimina al empezar/terminar.
//
// Alcance: SOLO el modelo. No hay creación de pedidos, stock, idempotencia
// funcional, workflow ni exportación — eso es F4.3-B en adelante.
//
// Ejecutar:  node --test tests/order-model.test.js   (o)   npm test

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";

import OrderModel from "../src/models/order.model.js";
import CounterModel from "../src/models/counter.model.js";
import {
  ORDER_STATUS,
  ORDER_STATUSES,
  PAYMENT_METHOD,
  PAYMENT_STATUS,
  EXPORT_STATUS,
  ORDER_CURRENCY,
  MAX_ORDER_ITEM_QTY,
} from "../src/helpers/orderWorkflow.helper.js";

// --- fixtures ----------------------------------------------------------

const validItem = () => ({
  productId: new mongoose.Types.ObjectId(),
  productName: "Camiseta Essential",
  slug: "camiseta-essential",
  image: "http://dusck.test/camiseta.png",
  unitPrice: 85000,
  quantity: 2,
  subtotal: 170000,
});

const validOrder = (over = {}) => ({
  idempotencyKey: randomUUID(),
  source: "web",
  requestedItems: [{ productId: new mongoose.Types.ObjectId(), quantity: 2 }],
  customer: {
    recipientName: "Ana Gómez",
    phone: "3001234567",
    email: "ana@dusck.co",
  },
  shippingAddress: {
    department: "Antioquia",
    city: "Medellín",
    neighborhood: "Laureles",
    address: "Calle 12 # 34-56 apto 201",
  },
  ...over,
});

// Devuelve el ValidationError (o undefined si el documento es válido).
const validate = async (doc) => {
  try {
    await new OrderModel(doc).validate();
    return undefined;
  } catch (err) {
    return err;
  }
};
const paths = (err) => (err ? Object.keys(err.errors) : []);
const assertInvalidAt = async (doc, path) => {
  const err = await validate(doc);
  assert.ok(err && paths(err).includes(path), `esperaba error en "${path}" (obtenidos: ${paths(err)})`);
};
const assertValid = async (doc) => assert.equal(await validate(doc), undefined);

// --- setup MongoDB (solo para el bloque 2: índices únicos + Counter) --

const TEST_DB_URI = "mongodb://127.0.0.1:27017/db-dusck-order-model-test";
let mongoAvailable = true;

test.before(async () => {
  try {
    await mongoose.connect(TEST_DB_URI, { serverSelectionTimeoutMS: 2000 });
    await mongoose.connection.dropDatabase();
    // Construye los índices declarados (unique / sparse) antes de probarlos.
    await Promise.all([OrderModel.init(), CounterModel.init()]);
  } catch (err) {
    mongoAvailable = false;
    console.error(`[order-model] MongoDB no disponible, se omiten los tests de índices: ${err.name}`);
  }
});

test.after(async () => {
  if (mongoAvailable) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

const skipIfNoMongo = (t) => {
  if (!mongoAvailable) t.skip("MongoDB no disponible");
  return !mongoAvailable;
};

// ====================================================================
// 1. SCHEMA  (sin base de datos)
// ====================================================================

test("Order: un documento válido pasa la validación y aplica los defaults del contrato", async () => {
  const doc = new OrderModel(validOrder());
  assert.equal(await validate(validOrder()), undefined);

  assert.equal(doc.finalized, false);
  assert.equal(doc.userId, null);
  assert.equal(doc.status, ORDER_STATUS.PENDING_CONFIRMATION);
  assert.equal(doc.payment.method, PAYMENT_METHOD.CASH_ON_DELIVERY);
  assert.equal(doc.payment.status, PAYMENT_STATUS.PENDING);
  assert.equal(doc.totals.currency, ORDER_CURRENCY);
  assert.equal(doc.totals.shipping, 0);
  assert.equal(doc.totals.itemsSubtotal, 0);
  assert.equal(doc.totals.grandTotal, 0);
  assert.equal(doc.export.status, EXPORT_STATUS.PENDING);
  assert.equal(doc.export.attempts, 0);
  assert.equal(doc.export.syncedAt, null);
  assert.deepEqual(doc.items.toObject(), []);
  assert.deepEqual(doc.statusHistory.toObject(), []);
  assert.equal(doc.orderNumber, undefined);
});

test("Order: sin datos -> falla la validación de los campos obligatorios de nivel superior", async () => {
  const err = await validate({});
  assert.ok(err, "debería producir un ValidationError");
  for (const p of ["idempotencyKey", "source", "requestedItems", "customer", "shippingAddress"]) {
    assert.ok(paths(err).includes(p), `falta el error de "${p}" (obtenidos: ${paths(err)})`);
  }
});

test("Order: customer incompleto -> error en cada campo obligatorio del subdocumento", async () => {
  const err = await validate(validOrder({ customer: { recipientName: "" } }));
  assert.ok(err);
  for (const p of ["customer.recipientName", "customer.phone", "customer.email"]) {
    assert.ok(paths(err).includes(p), `falta "${p}" (obtenidos: ${paths(err)})`);
  }
});

test("Order: shippingAddress incompleto -> error en department/city/neighborhood/address", async () => {
  const err = await validate(validOrder({ shippingAddress: { department: "Cundinamarca" } }));
  assert.ok(err);
  for (const p of ["shippingAddress.city", "shippingAddress.neighborhood", "shippingAddress.address"]) {
    assert.ok(paths(err).includes(p), `falta "${p}" (obtenidos: ${paths(err)})`);
  }
});

test("Order: addressComplement y reference son opcionales", async () => {
  await assertValid(validOrder());
});

test("Order: customer.documentId es opcional y se acepta como string", async () => {
  await assertValid(
    validOrder({ customer: { recipientName: "Ana Gómez", phone: "3001234567", email: "ana@dusck.co", documentId: "1017234567" } }),
  );
});

test("Order: source solo acepta el enum {web, admin} (canal, no tipo de comprador)", async () => {
  await assertValid(validOrder({ source: "web" }));
  await assertValid(validOrder({ source: "admin" }));
  // guest/authenticated NO son valores de source: se deducen de userId.
  await assertInvalidAt(validOrder({ source: "guest" }), "source");
  await assertInvalidAt(validOrder({ source: "authenticated" }), "source");
  await assertInvalidAt(validOrder({ source: "" }), "source");
});

test("Order: guest vs autenticado se representa con userId, no con source", async () => {
  // Invitado: source web + userId null (default).
  const guest = new OrderModel(validOrder({ source: "web" }));
  assert.equal(await validate(guest.toObject()), undefined);
  assert.equal(guest.userId, null);
  // Autenticado: source web + userId presente.
  const uid = new mongoose.Types.ObjectId();
  const authed = new OrderModel(validOrder({ source: "web", userId: uid }));
  assert.equal(await validate(authed.toObject()), undefined);
  assert.ok(authed.userId.equals(uid));
});

test("Order: status solo acepta los 8 estados aprobados", async () => {
  for (const s of ORDER_STATUSES) {
    await assertValid(validOrder({ status: s }));
  }
  for (const s of ["processing", "paid", "completed", "refunded", "pending_payment"]) {
    await assertInvalidAt(validOrder({ status: s }), "status");
  }
});

test("Order: payment.method solo cash_on_delivery; payment.status solo pending|paid|failed", async () => {
  await assertInvalidAt(validOrder({ payment: { method: "stripe" } }), "payment.method");
  await assertInvalidAt(validOrder({ payment: { method: "pse" } }), "payment.method");
  for (const st of ["pending", "paid", "failed"]) {
    await assertValid(validOrder({ payment: { status: st } }));
  }
  await assertInvalidAt(validOrder({ payment: { status: "refunded" } }), "payment.status");
});

test("Order: export.status solo pending|synced|failed", async () => {
  for (const st of ["pending", "synced", "failed"]) {
    await assertValid(validOrder({ export: { status: st } }));
  }
  await assertInvalidAt(validOrder({ export: { status: "queued" } }), "export.status");
});

test("Order: totals.currency solo acepta COP", async () => {
  await assertValid(validOrder({ totals: { currency: "COP" } }));
  await assertInvalidAt(validOrder({ totals: { currency: "USD" } }), "totals.currency");
});

test("Order: importes monetarios deben ser enteros no negativos (COP)", async () => {
  await assertInvalidAt(validOrder({ totals: { grandTotal: 1.5 } }), "totals.grandTotal");
  await assertInvalidAt(validOrder({ totals: { itemsSubtotal: -1 } }), "totals.itemsSubtotal");
  await assertInvalidAt(validOrder({ items: [{ ...validItem(), unitPrice: 850.5 }] }), "items.0.unitPrice");
  await assertInvalidAt(validOrder({ items: [{ ...validItem(), subtotal: -100 }] }), "items.0.subtotal");
  await assertValid(validOrder({ items: [validItem()] }));
});

test("Order: quantity por línea debe ser entero y estar en 1..50 (requestedItems e items)", async () => {
  const pid = new mongoose.Types.ObjectId();
  await assertInvalidAt(validOrder({ requestedItems: [{ productId: pid, quantity: 0 }] }), "requestedItems.0.quantity");
  await assertInvalidAt(validOrder({ requestedItems: [{ productId: pid, quantity: MAX_ORDER_ITEM_QTY + 1 }] }), "requestedItems.0.quantity");
  await assertInvalidAt(validOrder({ requestedItems: [{ productId: pid, quantity: 1.5 }] }), "requestedItems.0.quantity");
  await assertValid(validOrder({ requestedItems: [{ productId: pid, quantity: 1 }] }));
  await assertValid(validOrder({ requestedItems: [{ productId: pid, quantity: MAX_ORDER_ITEM_QTY }] }));

  await assertInvalidAt(validOrder({ items: [{ ...validItem(), quantity: 0 }] }), "items.0.quantity");
  await assertInvalidAt(validOrder({ items: [{ ...validItem(), quantity: 51 }] }), "items.0.quantity");
});

test("Order: requestedItems no puede estar vacío", async () => {
  await assertInvalidAt(validOrder({ requestedItems: [] }), "requestedItems");
});

test("Order: requestedItems NO admite variantId/size/color/sku (se ignoran, no se persisten)", async () => {
  const doc = new OrderModel(
    validOrder({
      requestedItems: [
        { productId: new mongoose.Types.ObjectId(), quantity: 1, variantId: new mongoose.Types.ObjectId(), size: "M", color: "Negro", sku: "X" },
      ],
    }),
  );
  assert.equal(await validate(doc.toObject()), undefined);
  assert.deepEqual(Object.keys(doc.requestedItems[0].toObject()).sort(), ["productId", "quantity"].sort());
});

test("Order: items NO admite variantId/size/color/sku (F4 sin variantes)", async () => {
  const doc = new OrderModel(
    validOrder({ items: [{ ...validItem(), variantId: new mongoose.Types.ObjectId(), size: "L", color: "Azul", sku: "Y" }] }),
  );
  assert.equal(await validate(doc.toObject()), undefined);
  assert.deepEqual(
    Object.keys(doc.items[0].toObject()).sort(),
    ["image", "productId", "productName", "quantity", "slug", "subtotal", "unitPrice"],
  );
});

test("Order: phone debe ser móvil colombiano normalizado (10 dígitos, empieza por 3)", async () => {
  const withPhone = (phone) => validOrder({ customer: { recipientName: "Ana", phone, email: "a@b.co" } });
  await assertInvalidAt(withPhone("123"), "customer.phone");
  await assertInvalidAt(withPhone("6012345678"), "customer.phone"); // fijo
  await assertInvalidAt(withPhone("+573001234567"), "customer.phone"); // sin normalizar
  await assertInvalidAt(withPhone("300 123 4567"), "customer.phone"); // sin normalizar
  await assertValid(withPhone("3001234567"));
});

test("Order: email de contacto valida un formato básico", async () => {
  await assertInvalidAt(
    validOrder({ customer: { recipientName: "Ana", phone: "3001234567", email: "no-es-email" } }),
    "customer.email",
  );
});

test("Order: orderNumber es opcional pero, si viene, respeta DUSCK-AAAA-NNNNNN", async () => {
  await assertValid(validOrder()); // ausente -> ok
  await assertValid(validOrder({ orderNumber: "DUSCK-2026-000001" }));
  await assertInvalidAt(validOrder({ orderNumber: "ORD-1" }), "orderNumber");
  await assertInvalidAt(validOrder({ orderNumber: "DUSCK-26-1" }), "orderNumber");
});

test("Order: idempotencyKey es obligatoria y debe ser un UUID", async () => {
  await assertInvalidAt(validOrder({ idempotencyKey: "no-es-uuid" }), "idempotencyKey");
  await assertInvalidAt(validOrder({ idempotencyKey: "" }), "idempotencyKey");
  await assertValid(validOrder({ idempotencyKey: randomUUID() }));
});

test("Order: statusHistory valida el estado de cada entrada; changedBy admite null", async () => {
  await assertValid(
    validOrder({ statusHistory: [{ status: ORDER_STATUS.CONFIRMED, changedBy: null, note: "confirmado por teléfono" }] }),
  );
  await assertInvalidAt(validOrder({ statusHistory: [{ status: "bogus" }] }), "statusHistory.0.status");
});

test("Order: notes respeta el máximo de 500 caracteres", async () => {
  await assertValid(validOrder({ notes: "x".repeat(500) }));
  await assertInvalidAt(validOrder({ notes: "x".repeat(501) }), "notes");
});

// ====================================================================
// 2. ÍNDICES ÚNICOS + Counter  (necesitan MongoDB)
// ====================================================================

test("Order: idempotencyKey tiene índice único (dos pedidos con la misma clave -> E11000)", async (t) => {
  if (skipIfNoMongo(t)) return;
  const key = randomUUID();
  await OrderModel.create(validOrder({ idempotencyKey: key }));
  await assert.rejects(
    () => OrderModel.create(validOrder({ idempotencyKey: key })),
    (err) => err && err.code === 11000,
  );
});

test("Order: orderNumber tiene índice único", async (t) => {
  if (skipIfNoMongo(t)) return;
  await OrderModel.create(validOrder({ orderNumber: "DUSCK-2026-000123" }));
  await assert.rejects(
    () => OrderModel.create(validOrder({ orderNumber: "DUSCK-2026-000123" })),
    (err) => err && err.code === 11000,
  );
});

test("Order: el índice de orderNumber es sparse (varios skeletons sin orderNumber conviven)", async (t) => {
  if (skipIfNoMongo(t)) return;
  const a = await OrderModel.create(validOrder());
  const b = await OrderModel.create(validOrder());
  assert.equal(a.orderNumber, undefined);
  assert.equal(b.orderNumber, undefined);
});

test("Order: un skeleton se persiste con finalized:false y sin orderNumber", async (t) => {
  if (skipIfNoMongo(t)) return;
  const doc = await OrderModel.create(validOrder());
  const fromDb = await OrderModel.findById(doc._id).lean();
  assert.equal(fromDb.finalized, false);
  assert.equal(fromDb.orderNumber, undefined);
  assert.equal(fromDb.status, ORDER_STATUS.PENDING_CONFIRMATION);
  assert.equal(fromDb.payment.status, PAYMENT_STATUS.PENDING);
  assert.equal(fromDb.export.status, EXPORT_STATUS.PENDING);
  assert.ok(fromDb.createdAt instanceof Date);
  assert.ok(fromDb.updatedAt instanceof Date);
});

test("Counter: estructura persistente con _id string y $inc atómico (sin servicio generador)", async (t) => {
  if (skipIfNoMongo(t)) return;
  const created = await CounterModel.create({ _id: "order-2026" });
  assert.equal(created.seq, 0);

  const bumped = await CounterModel.findOneAndUpdate(
    { _id: "order-2026" },
    { $inc: { seq: 1 } },
    { returnDocument: "after", upsert: true },
  );
  assert.equal(bumped.seq, 1);

  const upserted = await CounterModel.findOneAndUpdate(
    { _id: "order-2027" },
    { $inc: { seq: 1 } },
    { returnDocument: "after", upsert: true },
  );
  assert.equal(upserted.seq, 1);
});
