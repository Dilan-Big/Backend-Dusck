// FASE 4.3-B-R2.2 — Recovery Protocol (Product-local authority).
//
// Autoridad de la mutación de inventario: `product_b.stockOps[]` (co-localizado
// con `Product.stock`). `Order.stockAdjustments[]` es solo advisory y NUNCA se
// consulta para decidir si el stock se movió.
//
// Estos tests demuestran que, si el proceso Node muere entre reclamar la
// Idempotency-Key y finalizar la orden, `compensateOrder` recupera de forma
// segura leyendo `Product.stockOps`: restituye exactamente lo descontado, sin
// doble restitución y sin depender de inferencias.
//
// BD APARTE: `db-dusck-order-recovery-test`. Sin Mongo -> suite `skip`.

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";

import OrderModel from "../src/models/order.model.js";
import CounterModel from "../src/models/counter.model.js";
import ProductModel from "../src/models/product.model.js";
import {
  createOrder,
  compensateOrder,
  decrementProductStock,
  operationIdFor,
  ORDER_ERROR_CODES,
} from "../src/services/order.service.js";
import { STOCK_OP_STATE } from "../src/helpers/orderWorkflow.helper.js";

const TEST_DB_URI = "mongodb://127.0.0.1:27017/db-dusck-order-recovery-test";
let mongoAvailable = true;

test.before(async () => {
  try {
    await mongoose.connect(TEST_DB_URI, { serverSelectionTimeoutMS: 2000 });
    await mongoose.connection.dropDatabase();
    await Promise.all([OrderModel.init(), CounterModel.init(), ProductModel.init()]);
  } catch (err) {
    mongoAvailable = false;
    console.error(`[order-recovery] MongoDB no disponible, se omite la suite: ${err.name}`);
  }
});

test.beforeEach(async () => {
  if (mongoAvailable) {
    await Promise.all([
      OrderModel.deleteMany({}),
      CounterModel.deleteMany({}),
      ProductModel.deleteMany({}),
    ]);
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

const S = STOCK_OP_STATE;

// --- fixtures --------------------------------------------------------

const makeProduct = (over = {}) =>
  ProductModel.create({
    name: over.name ?? "Producto",
    slug: over.slug ?? `p-${randomUUID().slice(0, 8)}`,
    description: "x",
    price: over.price ?? 10000,
    images: [{ url: "http://dusck.test/main.png", isMain: true }],
    variants: [],
    stock: over.stock ?? 10,
    status: over.status ?? "PUBLISHED",
    isActive: over.isActive ?? true,
    createdBy: new mongoose.Types.ObjectId(),
  });

const CUSTOMER = { recipientName: "Ana Gómez", phone: "3001234567", email: "ana@dusck.co" };
const ADDRESS = { department: "Antioquia", city: "Medellín", neighborhood: "Laureles", address: "Calle 12 # 34-56" };

// Crea un skeleton `finalized:false` con `requestedItems` para los productos dados.
const makeSkeleton = (lines, over = {}) =>
  OrderModel.create({
    idempotencyKey: over.idempotencyKey ?? randomUUID(),
    source: "web",
    userId: null,
    requestedItems: lines.map((l) => ({ productId: l.product._id, quantity: l.qty })),
    stockAdjustments: lines.map((l) => ({
      productId: l.product._id,
      requestedQty: l.qty,
      decrementedQty: 0,
      compensatedQty: 0,
      state: "pending",
    })),
    customer: CUSTOMER,
    shippingAddress: ADDRESS,
    finalized: over.finalized === true,
    ...(over.finalized ? { finalized: true, orderNumber: over.orderNumber ?? "DUSCK-2026-000777" } : {}),
  });

// Simula "el proceso murió a mitad de createOrder": para cada línea indicada,
// ejecuta el decremento atómico REAL (stock -= qty + stockOps entry decremented).
const crashAfterDecrements = async (skeleton, lines) => {
  for (const l of lines) {
    const opId = operationIdFor(skeleton._id, l.product._id);
    const res = await decrementProductStock(l.product._id, l.qty, opId);
    assert.equal(res.outcome, "decremented", "el decremento de setup debe aplicar");
  }
};

const stockOf = async (id) => (await ProductModel.findById(id)).stock;
const opsOf = async (id) => (await ProductModel.findById(id)).stockOps;
const line = (report, productId) => report.lines.find((l) => l.productId === String(productId));

// ====================================================================
// El ledger autoritativo se puebla y se cierra
// ====================================================================

test("createOrder: escribe product_b.stockOps y los poda al finalizar", async (t) => {
  if (skipIfNoMongo(t)) return;
  const a = await makeProduct({ stock: 10 });
  const b = await makeProduct({ stock: 10 });
  const order = await createOrder({
    items: [
      { productId: a._id.toString(), quantity: 2 },
      { productId: b._id.toString(), quantity: 3 },
    ],
    customer: CUSTOMER, shippingAddress: ADDRESS, userId: null, source: "web",
    idempotencyKey: randomUUID(),
  });

  assert.equal(order.finalized, true);
  assert.equal(await stockOf(a._id), 8);
  assert.equal(await stockOf(b._id), 7);
  // Poda tras finalize (C-B): stockOps de esta orden eliminados.
  assert.deepEqual(await opsOf(a._id), []);
  assert.deepEqual(await opsOf(b._id), []);
  const fresh = await OrderModel.findById(order._id);
  assert.equal(fresh.stockOpsPruned, true);
});

// ====================================================================
// Partial decrement — la autoridad conoce lo realmente descontado
// ====================================================================

test("partial decrement: A=2, B=3, C=0 -> stockOps lo dice; recovery compensa solo A y B", async (t) => {
  if (skipIfNoMongo(t)) return;
  const A = await makeProduct({ stock: 10 });
  const B = await makeProduct({ stock: 10 });
  const C = await makeProduct({ stock: 10 });

  const sk = await makeSkeleton([
    { product: A, qty: 2 }, { product: B, qty: 3 }, { product: C, qty: 4 },
  ]);
  // Proceso muerto tras descontar A y B, antes de tocar C.
  await crashAfterDecrements(sk, [{ product: A, qty: 2 }, { product: B, qty: 3 }]);
  assert.equal(await stockOf(A._id), 8);
  assert.equal(await stockOf(B._id), 7);
  assert.equal(await stockOf(C._id), 10);

  const report = await compensateOrder(sk._id);

  assert.equal(line(report, A._id).action, "compensated");
  assert.equal(line(report, A._id).compensatedQty, 2);
  assert.equal(line(report, B._id).action, "compensated");
  assert.equal(line(report, B._id).compensatedQty, 3);
  assert.equal(line(report, C._id).action, "noop"); // C jamás se descontó

  assert.equal(await stockOf(A._id), 10);
  assert.equal(await stockOf(B._id), 10);
  assert.equal(await stockOf(C._id), 10, "C nunca se toca -> sin corrupción");
  assert.equal(report.deleted, true);
  assert.equal(await OrderModel.countDocuments({}), 0);
});

// ====================================================================
// Partial compensation — recovery cierra solo lo que falta
// ====================================================================

test("partial compensation: A ya compensado, B no -> recovery solo restituye B", async (t) => {
  if (skipIfNoMongo(t)) return;
  const A = await makeProduct({ stock: 10 });
  const B = await makeProduct({ stock: 10 });
  const sk = await makeSkeleton([{ product: A, qty: 2 }, { product: B, qty: 3 }]);
  await crashAfterDecrements(sk, [{ product: A, qty: 2 }, { product: B, qty: 3 }]);

  // Una pasada previa ya compensó A.
  const { compensateProductOp } = await import("../src/services/order.service.js");
  await compensateProductOp(A._id, operationIdFor(sk._id, A._id));
  assert.equal(await stockOf(A._id), 10);
  assert.equal(await stockOf(B._id), 7);

  const report = await compensateOrder(sk._id);
  assert.equal(line(report, A._id).action, "noop", "A ya estaba compensado");
  assert.equal(line(report, B._id).action, "compensated");
  assert.equal(await stockOf(A._id), 10, "A no se vuelve a tocar");
  assert.equal(await stockOf(B._id), 10, "B restituido");
});

// ====================================================================
// Idempotencia
// ====================================================================

test("idempotente: compensateOrder dos veces NO duplica la restitución", async (t) => {
  if (skipIfNoMongo(t)) return;
  const A = await makeProduct({ stock: 10 });
  const sk = await makeSkeleton([{ product: A, qty: 2 }]);
  await crashAfterDecrements(sk, [{ product: A, qty: 2 }]);

  await compensateOrder(sk._id);
  assert.equal(await stockOf(A._id), 10);

  const second = await compensateOrder(sk._id);
  assert.equal(second.notFound, true, "el skeleton ya fue borrado");
  assert.equal(await stockOf(A._id), 10, "sigue en 10, no en 12");
});

test("idempotente: dos recovery CONCURRENTES -> una sola restitución", async (t) => {
  if (skipIfNoMongo(t)) return;
  const A = await makeProduct({ stock: 10 });
  const sk = await makeSkeleton([{ product: A, qty: 5 }]);
  await crashAfterDecrements(sk, [{ product: A, qty: 5 }]);

  await Promise.all([compensateOrder(sk._id), compensateOrder(sk._id)]);
  assert.equal(await stockOf(A._id), 10, "restituido una sola vez pese a la concurrencia");
});

test("idempotente: compensar cuando stockOps ya está TODO en 'compensated' es no-op", async (t) => {
  if (skipIfNoMongo(t)) return;
  const A = await makeProduct({ stock: 10 });
  const sk = await makeSkeleton([{ product: A, qty: 2 }]);
  await crashAfterDecrements(sk, [{ product: A, qty: 2 }]);
  const { compensateProductOp } = await import("../src/services/order.service.js");
  await compensateProductOp(A._id, operationIdFor(sk._id, A._id));
  assert.equal(await stockOf(A._id), 10);

  const report = await compensateOrder(sk._id);
  assert.equal(await stockOf(A._id), 10);
  assert.equal(report.deleted, true);
});

// ====================================================================
// Crash-like states
// ====================================================================

test("crash antes de cualquier decremento (sin stockOps) -> compensar borra el skeleton, stock intacto", async (t) => {
  if (skipIfNoMongo(t)) return;
  const A = await makeProduct({ stock: 10 });
  const B = await makeProduct({ stock: 10 });
  const sk = await makeSkeleton([{ product: A, qty: 2 }, { product: B, qty: 1 }]);

  const report = await compensateOrder(sk._id);
  assert.equal(await stockOf(A._id), 10);
  assert.equal(await stockOf(B._id), 10);
  assert.equal(report.deleted, true);
  assert.equal(await OrderModel.countDocuments({}), 0);
});

test("crash tras compensación completa pero antes de borrar el skeleton -> 2ª pasada limpia sin doble restitución", async (t) => {
  if (skipIfNoMongo(t)) return;
  const A = await makeProduct({ stock: 10 });
  const sk = await makeSkeleton([{ product: A, qty: 2 }]);
  await crashAfterDecrements(sk, [{ product: A, qty: 2 }]);
  const { compensateProductOp } = await import("../src/services/order.service.js");
  await compensateProductOp(A._id, operationIdFor(sk._id, A._id)); // stock ya en 10, op compensated
  // skeleton sigue existiendo
  const report = await compensateOrder(sk._id);
  assert.equal(await stockOf(A._id), 10, "no sube a 12");
  assert.equal(report.deleted, true);
});

// ====================================================================
// Orden finalizada — intocable
// ====================================================================

test("finalized: compensateOrder sobre finalized:true no modifica nada", async (t) => {
  if (skipIfNoMongo(t)) return;
  const A = await makeProduct({ stock: 10 });
  const sk = await makeSkeleton([{ product: A, qty: 2 }], { finalized: true, orderNumber: "DUSCK-2026-000123" });
  // stockOps evidencia inerte en una orden finalizada
  await decrementProductStock(A._id, 2, operationIdFor(sk._id, A._id));
  assert.equal(await stockOf(A._id), 8);

  const report = await compensateOrder(sk._id);
  assert.equal(report.finalized, true);
  assert.equal(report.skipped, true);
  assert.equal(report.deleted, false);
  assert.equal(await stockOf(A._id), 8, "stock intacto: la orden finalizada es intocable");
  assert.ok(await OrderModel.findById(sk._id));
});

test("finalized: una orden real creada por createOrder no es recuperable", async (t) => {
  if (skipIfNoMongo(t)) return;
  const A = await makeProduct({ stock: 10 });
  const order = await createOrder({
    items: [{ productId: A._id.toString(), quantity: 4 }],
    customer: CUSTOMER, shippingAddress: ADDRESS, userId: null, source: "web",
    idempotencyKey: randomUUID(),
  });
  const report = await compensateOrder(order._id);
  assert.equal(report.skipped, true);
  assert.equal(await stockOf(A._id), 6, "no se restituye stock de una venta real");
});

// ====================================================================
// Idempotency-Key
// ====================================================================

test("idempotency-key: tras compensar y borrar el skeleton, la misma key reintenta y crea UNA orden", async (t) => {
  if (skipIfNoMongo(t)) return;
  const A = await makeProduct({ stock: 10 });
  const key = randomUUID();
  const sk = await makeSkeleton([{ product: A, qty: 2 }], { idempotencyKey: key });
  await crashAfterDecrements(sk, [{ product: A, qty: 2 }]); // stock 8
  assert.equal(await stockOf(A._id), 8);

  await compensateOrder(sk._id);
  assert.equal(await stockOf(A._id), 10);
  assert.equal(await OrderModel.countDocuments({ idempotencyKey: key }), 0);

  const order = await createOrder({
    items: [{ productId: A._id.toString(), quantity: 2 }],
    customer: CUSTOMER, shippingAddress: ADDRESS, userId: null, source: "web",
    idempotencyKey: key,
  });
  assert.equal(order.finalized, true);
  assert.equal(await OrderModel.countDocuments({ idempotencyKey: key }), 1);
  assert.equal(await stockOf(A._id), 8, "descontado una sola vez");
});

test("idempotency-key: un skeleton VIVO con la misma key sigue devolviendo 409 retryable", async (t) => {
  if (skipIfNoMongo(t)) return;
  const A = await makeProduct({ stock: 10 });
  const key = randomUUID();
  const sk = await makeSkeleton([{ product: A, qty: 1 }], { idempotencyKey: key });
  await crashAfterDecrements(sk, [{ product: A, qty: 1 }]);

  await assert.rejects(
    () => createOrder({
      items: [{ productId: A._id.toString(), quantity: 1 }],
      customer: CUSTOMER, shippingAddress: ADDRESS, userId: null, source: "web",
      idempotencyKey: key,
    }),
    (err) => err.code === ORDER_ERROR_CODES.IDEMPOTENCY_IN_PROGRESS && err.retryable === true,
  );
});

// ====================================================================
// Rollback en línea (createOrder) — autoridad = stockOps
// ====================================================================

test("rollback en línea: fallo de stock en la última línea restituye exactamente lo descontado", async (t) => {
  if (skipIfNoMongo(t)) return;
  const A = await makeProduct({ stock: 5 });
  const B = await makeProduct({ stock: 5 });
  const C = await makeProduct({ stock: 0 }); // fuerza el fallo

  await assert.rejects(
    () => createOrder({
      items: [
        { productId: A._id.toString(), quantity: 2 },
        { productId: B._id.toString(), quantity: 3 },
        { productId: C._id.toString(), quantity: 4 },
      ],
      customer: CUSTOMER, shippingAddress: ADDRESS, userId: null, source: "web",
      idempotencyKey: randomUUID(),
    }),
    (err) => err.code === ORDER_ERROR_CODES.STOCK_CONFLICT,
  );

  assert.equal(await stockOf(A._id), 5, "A restituido exacto");
  assert.equal(await stockOf(B._id), 5, "B restituido exacto");
  assert.equal(await stockOf(C._id), 0, "C jamás descontado");
  assert.equal(await OrderModel.countDocuments({}), 0, "skeleton limpiado");
  assert.deepEqual(await opsOf(A._id), [], "stockOps de A podados");
  assert.deepEqual(await opsOf(B._id), []);
});
