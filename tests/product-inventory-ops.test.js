// FASE 4.3-B-R2.2 — Product-Local Inventory Idempotency + Atomic Recovery.
//
// Autoridad de inventario: `product_b.stockOps[]`, co-localizado con
// `Product.stock`. Estos tests ejercen las primitivas atómicas
// (`decrementProductStock`, `compensateProductOp`, `pruneStockOpsForOrder`)
// y demuestran las garantías críticas: decremento atómico, compensación
// atómica (una sola operación Product), idempotencia, no-oversell, poda segura,
// compatibilidad con los hooks de Product.
//
// BD APARTE: `db-dusck-inventory-ops-test`. Sin Mongo -> suite `skip`.

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";

import OrderModel from "../src/models/order.model.js";
import CounterModel from "../src/models/counter.model.js";
import ProductModel from "../src/models/product.model.js";
import {
  createOrder,
  decrementProductStock,
  compensateProductOp,
  pruneStockOpsForOrder,
  operationIdFor,
  ORDER_ERROR_CODES,
} from "../src/services/order.service.js";
import { STOCK_OP_STATE } from "../src/helpers/orderWorkflow.helper.js";

const TEST_DB_URI = "mongodb://127.0.0.1:27017/db-dusck-inventory-ops-test";
let mongoAvailable = true;

test.before(async () => {
  try {
    await mongoose.connect(TEST_DB_URI, { serverSelectionTimeoutMS: 2000 });
    await mongoose.connection.dropDatabase();
    await Promise.all([OrderModel.init(), CounterModel.init(), ProductModel.init()]);
  } catch (err) {
    mongoAvailable = false;
    console.error(`[inventory-ops] MongoDB no disponible, se omite la suite: ${err.name}`);
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

const makeProduct = (over = {}) =>
  ProductModel.create({
    name: over.name ?? "Prod",
    slug: over.slug ?? `p-${randomUUID().slice(0, 8)}`,
    description: "x",
    price: over.price ?? 10000,
    images: [{ url: "http://dusck.test/m.png", isMain: true }],
    variants: over.variants ?? [],
    stock: over.stock ?? 10,
    status: over.status ?? "PUBLISHED",
    isActive: over.isActive ?? true,
    createdBy: new mongoose.Types.ObjectId(),
  });

const CUSTOMER = { recipientName: "Ana Gómez", phone: "3001234567", email: "ana@dusck.co" };
const ADDRESS = { department: "Antioquia", city: "Medellín", neighborhood: "Laureles", address: "Calle 12 # 34-56" };
const oid = () => new mongoose.Types.ObjectId();
const stockOf = async (id) => (await ProductModel.findById(id)).stock;
const opsOf = async (id) => (await ProductModel.findById(id)).stockOps;
const opById = async (pid, opId) => (await opsOf(pid)).find((o) => o.id === opId);

// ====================================================================
// DECREMENT
// ====================================================================

test("dec/sufficient: op nueva + stock suficiente -> stock -= qty, entry decremented", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p = await makeProduct({ stock: 10 });
  const opId = `${oid()}:${p._id}`;
  const res = await decrementProductStock(p._id, 3, opId);
  assert.equal(res.outcome, "decremented");
  assert.equal(await stockOf(p._id), 7);
  const op = await opById(p._id, opId);
  assert.equal(op.qty, 3);
  assert.equal(op.state, S.DECREMENTED);
  assert.ok(op.at instanceof Date);
});

test("dec/insufficient: stock < qty -> STOCK_CONFLICT, sin mutación", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p = await makeProduct({ stock: 2 });
  const res = await decrementProductStock(p._id, 3, `${oid()}:${p._id}`);
  assert.equal(res.outcome, "stock_conflict");
  assert.equal(await stockOf(p._id), 2);
  assert.deepEqual(await opsOf(p._id), []);
});

test("dec/exact: stock === qty -> stock 0", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p = await makeProduct({ stock: 3 });
  const res = await decrementProductStock(p._id, 3, `${oid()}:${p._id}`);
  assert.equal(res.outcome, "decremented");
  assert.equal(await stockOf(p._id), 0);
});

test("dec/zero-stock: stock 0 -> STOCK_CONFLICT", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p = await makeProduct({ stock: 0 });
  const res = await decrementProductStock(p._id, 1, `${oid()}:${p._id}`);
  assert.equal(res.outcome, "stock_conflict");
});

test("dec/not-purchasable: producto no PUBLISHED -> STOCK_CONFLICT opaco, sin mutación", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p = await makeProduct({ stock: 10, status: "DRAFT", isActive: false });
  const res = await decrementProductStock(p._id, 1, `${oid()}:${p._id}`);
  assert.equal(res.outcome, "stock_conflict");
  assert.equal(await stockOf(p._id), 10);
});

test("dec/new-opId: el id se registra tal cual", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p = await makeProduct({ stock: 10 });
  const orderId = oid();
  const opId = operationIdFor(orderId, p._id);
  await decrementProductStock(p._id, 1, opId);
  assert.equal((await opById(p._id, opId)).id, `${orderId}:${p._id}`);
});

test("dec/repeat-opId: 2º decremento con el mismo opId -> already_decremented, sin 2ª mutación", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p = await makeProduct({ stock: 10 });
  const opId = `${oid()}:${p._id}`;
  await decrementProductStock(p._id, 2, opId);
  const res = await decrementProductStock(p._id, 2, opId);
  assert.equal(res.outcome, "already_decremented");
  assert.equal(await stockOf(p._id), 8, "sigue en 8, no en 6");
  assert.equal((await opsOf(p._id)).length, 1);
});

test("dec/opId-compensated: decremento sobre una op ya compensada -> already_compensated, sin mutación", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p = await makeProduct({ stock: 10 });
  const opId = `${oid()}:${p._id}`;
  await decrementProductStock(p._id, 2, opId);
  await compensateProductOp(p._id, opId);
  assert.equal(await stockOf(p._id), 10);
  const res = await decrementProductStock(p._id, 2, opId);
  assert.equal(res.outcome, "already_compensated");
  assert.equal(await stockOf(p._id), 10);
});

test("dec/normalization-invariant: A×2 + A×3 -> UNA sola stockOps entry para A con qty 5", async (t) => {
  if (skipIfNoMongo(t)) return;
  const a = await makeProduct({ stock: 20, price: 10000 });
  const order = await createOrder({
    items: [
      { productId: a._id.toString(), quantity: 2 },
      { productId: a._id.toString(), quantity: 3 },
    ],
    customer: CUSTOMER, shippingAddress: ADDRESS, userId: null, source: "web",
    idempotencyKey: randomUUID(),
  });
  assert.equal(order.finalized, true);
  assert.equal(order.requestedItems.length, 1);
  assert.equal(order.requestedItems[0].quantity, 5);
  assert.equal(await stockOf(a._id), 15);
});

// ====================================================================
// IDEMPOTENCY
// ====================================================================

test("idem/retry-same-qty: reintento idéntico -> stock se mueve una vez", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p = await makeProduct({ stock: 10 });
  const opId = `${oid()}:${p._id}`;
  await decrementProductStock(p._id, 4, opId);
  await decrementProductStock(p._id, 4, opId);
  assert.equal(await stockOf(p._id), 6);
});

test("idem/retry-diff-qty: la op ya existe -> el qty del reintento se IGNORA", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p = await makeProduct({ stock: 10 });
  const opId = `${oid()}:${p._id}`;
  await decrementProductStock(p._id, 4, opId);
  const res = await decrementProductStock(p._id, 1, opId); // qty distinto
  assert.equal(res.outcome, "already_decremented");
  assert.equal(await stockOf(p._id), 6, "descontó 4 (registrado), no 4+1");
  assert.equal((await opById(p._id, opId)).qty, 4);
});

test("idem/already-compensated: compensar una op ya compensada -> null, sin 2º $inc", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p = await makeProduct({ stock: 10 });
  const opId = `${oid()}:${p._id}`;
  await decrementProductStock(p._id, 3, opId);
  const first = await compensateProductOp(p._id, opId);
  assert.ok(first, "1ª compensación aplica");
  const second = await compensateProductOp(p._id, opId);
  assert.equal(second, null, "2ª compensación no matchea");
  assert.equal(await stockOf(p._id), 10);
});

// ====================================================================
// CONCURRENCY
// ====================================================================

test("conc/last-unit: stock 1, dos órdenes qty 1 -> una crea, una STOCK_CONFLICT, stock 0", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p = await makeProduct({ stock: 1 });
  const mk = () => createOrder({
    items: [{ productId: p._id.toString(), quantity: 1 }],
    customer: CUSTOMER, shippingAddress: ADDRESS, userId: null, source: "web",
    idempotencyKey: randomUUID(),
  });
  const results = await Promise.allSettled([mk(), mk()]);
  const ok = results.filter((r) => r.status === "fulfilled");
  const bad = results.filter((r) => r.status === "rejected");
  assert.equal(ok.length, 1);
  assert.equal(bad.length, 1);
  assert.equal(bad[0].reason.code, ORDER_ERROR_CODES.STOCK_CONFLICT);
  assert.equal(await stockOf(p._id), 0, "nunca < 0");
});

test("conc/five-parallel: stock 5, cinco órdenes qty 1 -> todas OK, stock 0, sin oversell", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p = await makeProduct({ stock: 5 });
  const mk = () => createOrder({
    items: [{ productId: p._id.toString(), quantity: 1 }],
    customer: CUSTOMER, shippingAddress: ADDRESS, userId: null, source: "web",
    idempotencyKey: randomUUID(),
  });
  const results = await Promise.allSettled([mk(), mk(), mk(), mk(), mk()]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 5);
  assert.equal(await stockOf(p._id), 0);
});

test("conc/retry-parallel: mismo opId en paralelo -> una sola mutación, una sola entry", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p = await makeProduct({ stock: 10 });
  const opId = `${oid()}:${p._id}`;
  await Promise.all([
    decrementProductStock(p._id, 3, opId),
    decrementProductStock(p._id, 3, opId),
    decrementProductStock(p._id, 3, opId),
  ]);
  assert.equal(await stockOf(p._id), 7, "descontó 3 una sola vez");
  assert.equal((await opsOf(p._id)).length, 1);
});

test("conc/compensate-parallel: misma op compensada en paralelo -> una sola restitución", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p = await makeProduct({ stock: 10 });
  const opId = `${oid()}:${p._id}`;
  await decrementProductStock(p._id, 5, opId);
  await Promise.all([
    compensateProductOp(p._id, opId),
    compensateProductOp(p._id, opId),
    compensateProductOp(p._id, opId),
  ]);
  assert.equal(await stockOf(p._id), 10, "restituido una sola vez");
  assert.equal((await opById(p._id, opId)).state, S.COMPENSATED);
});

// ====================================================================
// COMPENSATION
// ====================================================================

test("comp/valid: op decremented -> stock += qty y state compensated en UNA operación", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p = await makeProduct({ stock: 10 });
  const opId = `${oid()}:${p._id}`;
  await decrementProductStock(p._id, 4, opId); // stock 6
  const updated = await compensateProductOp(p._id, opId);
  assert.ok(updated);
  assert.equal(updated.stock, 10, "stock restaurado");
  const op = updated.stockOps.find((o) => o.id === opId);
  assert.equal(op.state, S.COMPENSATED);
  assert.ok(op.compensatedAt instanceof Date);
});

test("comp/nonexistent: op inexistente -> null, sin mutación", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p = await makeProduct({ stock: 10 });
  const r = await compensateProductOp(p._id, `${oid()}:${p._id}`);
  assert.equal(r, null);
  assert.equal(await stockOf(p._id), 10);
});

test("comp/already-compensated: no-op", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p = await makeProduct({ stock: 10 });
  const opId = `${oid()}:${p._id}`;
  await decrementProductStock(p._id, 2, opId);
  await compensateProductOp(p._id, opId);
  const r = await compensateProductOp(p._id, opId);
  assert.equal(r, null);
  assert.equal(await stockOf(p._id), 10);
});

test("comp/crash-like: stockOps decremented + orden no finalizada -> compensateProductOp restituye exacto", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p = await makeProduct({ stock: 10 });
  const orderId = oid();
  const opId = operationIdFor(orderId, p._id);
  await decrementProductStock(p._id, 3, opId); // simula el decremento previo al crash
  assert.equal(await stockOf(p._id), 7);
  const updated = await compensateProductOp(p._id, opId);
  assert.equal(updated.stock, 10);
});

// ====================================================================
// CRITICAL — 37: atomic compensation (una sola operación)
// ====================================================================

test("CRITICAL comp/atomic: before stock=6 qty=4 decremented -> after stock=10 state=compensated (ONE Product op)", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p = await makeProduct({ stock: 10 });
  const opId = `${oid()}:${p._id}`;
  await decrementProductStock(p._id, 4, opId);
  assert.equal(await stockOf(p._id), 6, "before: stock 6");
  assert.equal((await opById(p._id, opId)).qty, 4, "before: qty 4, state decremented");
  assert.equal((await opById(p._id, opId)).state, S.DECREMENTED);

  // Cuenta cuántas escrituras a Product hace la compensación.
  let productWrites = 0;
  const realFOU = ProductModel.findOneAndUpdate.bind(ProductModel);
  t.mock.method(ProductModel, "findOneAndUpdate", function (f, u, o) { productWrites++; return realFOU(f, u, o); });
  const realUpd = ProductModel.updateOne.bind(ProductModel);
  t.mock.method(ProductModel, "updateOne", function (f, u, o) { productWrites++; return realUpd(f, u, o); });
  const realUpdMany = ProductModel.updateMany.bind(ProductModel);
  t.mock.method(ProductModel, "updateMany", function (f, u, o) { productWrites++; return realUpdMany(f, u, o); });

  await compensateProductOp(p._id, opId);

  assert.equal(productWrites, 1, "exactamente UNA escritura a Product");
  assert.equal(await stockOf(p._id), 10, "after: stock 10");
  assert.equal((await opById(p._id, opId)).state, S.COMPENSATED, "after: state compensated");
});

// ====================================================================
// CRITICAL — 38: wrong caller qty
// ====================================================================

test("CRITICAL comp/qty-from-record: stockOps.qty=4, caller no puede forzar 3 -> stock += 4", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p = await makeProduct({ stock: 10 });
  const opId = `${oid()}:${p._id}`;
  await decrementProductStock(p._id, 4, opId); // stock 6, qty registrado = 4
  // `compensateProductOp` no acepta un qty del caller: la cantidad sale del doc.
  await compensateProductOp(p._id, opId);
  assert.equal(await stockOf(p._id), 10, "restauró 4 (del registro), no 3");
});

// ====================================================================
// CRITICAL — 39: double compensation
// ====================================================================

test("CRITICAL comp/double: compensate() x2 -> stock restaurado exactamente una vez", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p = await makeProduct({ stock: 10 });
  const opId = `${oid()}:${p._id}`;
  await decrementProductStock(p._id, 5, opId);
  await compensateProductOp(p._id, opId);
  await compensateProductOp(p._id, opId);
  assert.equal(await stockOf(p._id), 10);
  assert.equal((await opById(p._id, opId)).state, S.COMPENSATED);
});

// ====================================================================
// CRITICAL — 43: concurrent last unit  /  44: same operation concurrently
// (also covered above; kept explicit per test matrix)
// ====================================================================

test("CRITICAL conc/last-unit-explicit: stock 1 -> A ok, B falla, stock 0", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p = await makeProduct({ stock: 1 });
  const opA = `${oid()}:${p._id}`;
  const opB = `${oid()}:${p._id}`;
  const [rA, rB] = await Promise.all([
    decrementProductStock(p._id, 1, opA),
    decrementProductStock(p._id, 1, opB),
  ]);
  const outcomes = [rA.outcome, rB.outcome].sort();
  assert.deepEqual(outcomes, ["decremented", "stock_conflict"]);
  assert.equal(await stockOf(p._id), 0);
});

test("CRITICAL conc/same-op-concurrent: mismo opId x2 -> una mutación, una entry", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p = await makeProduct({ stock: 10 });
  const opId = `${oid()}:${p._id}`;
  await Promise.all([decrementProductStock(p._id, 2, opId), decrementProductStock(p._id, 2, opId)]);
  assert.equal(await stockOf(p._id), 8);
  assert.equal((await opsOf(p._id)).length, 1);
});

// ====================================================================
// CRITICAL — 42: multiproduct recovery (via createOrder rollback)
// ====================================================================

test("CRITICAL multiproduct-recovery: A dec, B dec, C absent -> A & B restored, C unchanged", async (t) => {
  if (skipIfNoMongo(t)) return;
  const A = await makeProduct({ stock: 5 });
  const B = await makeProduct({ stock: 5 });
  const C = await makeProduct({ stock: 0 });
  await assert.rejects(
    () => createOrder({
      items: [
        { productId: A._id.toString(), quantity: 2 },
        { productId: B._id.toString(), quantity: 2 },
        { productId: C._id.toString(), quantity: 1 },
      ],
      customer: CUSTOMER, shippingAddress: ADDRESS, userId: null, source: "web",
      idempotencyKey: randomUUID(),
    }),
    (err) => err.code === ORDER_ERROR_CODES.STOCK_CONFLICT,
  );
  assert.equal(await stockOf(A._id), 5);
  assert.equal(await stockOf(B._id), 5);
  assert.equal(await stockOf(C._id), 0);
});

// ====================================================================
// PRUNING
// ====================================================================

const makeOrderDoc = (product, qty, over = {}) =>
  OrderModel.create({
    idempotencyKey: randomUUID(), source: "web", userId: null,
    requestedItems: [{ productId: product._id, quantity: qty }],
    stockAdjustments: [{ productId: product._id, requestedQty: qty, decrementedQty: 0, compensatedQty: 0, state: "pending" }],
    customer: CUSTOMER, shippingAddress: ADDRESS,
    finalized: over.finalized === true,
    ...(over.finalized ? { finalized: true, orderNumber: over.orderNumber ?? "DUSCK-2026-000900" } : {}),
  });

test("prune/finalized: orden finalizada -> $pull elimina sus stockOps y marca stockOpsPruned", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p = await makeProduct({ stock: 10 });
  const order = await makeOrderDoc(p, 3, { finalized: true, orderNumber: "DUSCK-2026-000901" });
  await decrementProductStock(p._id, 3, operationIdFor(order._id, p._id));
  assert.equal((await opsOf(p._id)).length, 1);

  await pruneStockOpsForOrder(order);
  assert.deepEqual(await opsOf(p._id), []);
  assert.equal((await OrderModel.findById(order._id)).stockOpsPruned, true);
});

test("prune/not-finalized-guard: orden NO finalizada -> pruneStockOpsForOrder NO elimina nada (C-A)", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p = await makeProduct({ stock: 10 });
  const order = await makeOrderDoc(p, 3, { finalized: false });
  await decrementProductStock(p._id, 3, operationIdFor(order._id, p._id));

  await pruneStockOpsForOrder(order); // order.finalized !== true -> return inmediato
  assert.equal((await opsOf(p._id)).length, 1, "evidencia de recovery preservada");
  assert.equal((await OrderModel.findById(order._id)).stockOpsPruned, false);
});

test("prune/before-finalize: createOrder NUNCA poda antes de finalized:true (C-B)", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p = await makeProduct({ stock: 10 });
  // Intercepta la finalización para inspeccionar el estado JUSTO ANTES de podar.
  let opsAtFinalize = null;
  const realFOU = OrderModel.findOneAndUpdate.bind(OrderModel);
  t.mock.method(OrderModel, "findOneAndUpdate", async function (f, u, o) {
    const r = await realFOU(f, u, o);
    if (u && u.$set && u.$set.finalized === true && r) {
      // en este instante la orden YA está finalized:true; los stockOps aún existen
      opsAtFinalize = (await ProductModel.findById(p._id)).stockOps.length;
    }
    return r;
  });
  await createOrder({
    items: [{ productId: p._id.toString(), quantity: 2 }],
    customer: CUSTOMER, shippingAddress: ADDRESS, userId: null, source: "web",
    idempotencyKey: randomUUID(),
  });
  assert.equal(opsAtFinalize, 1, "la op existía en el momento de finalizar (poda es posterior)");
  assert.deepEqual(await opsOf(p._id), [], "poda ejecutada DESPUÉS de finalize");
});

test("prune/retry-after-prune: op podada + orden finalizada -> createOrder con la misma key NO re-descuenta", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p = await makeProduct({ stock: 10 });
  const key = randomUUID();
  const order = await createOrder({
    items: [{ productId: p._id.toString(), quantity: 2 }],
    customer: CUSTOMER, shippingAddress: ADDRESS, userId: null, source: "web", idempotencyKey: key,
  });
  assert.equal(await stockOf(p._id), 8);
  assert.deepEqual(await opsOf(p._id), []); // podado

  const again = await createOrder({
    items: [{ productId: p._id.toString(), quantity: 2 }],
    customer: CUSTOMER, shippingAddress: ADDRESS, userId: null, source: "web", idempotencyKey: key,
  });
  assert.equal(String(again._id), String(order._id), "misma orden");
  assert.equal(await stockOf(p._id), 8, "NO se re-descuenta");
});

test("prune/crash-mid-pull: fallo del $pull -> stockOpsPruned queda false; reintento lo completa", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p1 = await makeProduct({ stock: 10 });
  const p2 = await makeProduct({ stock: 10 });
  const order = await OrderModel.create({
    idempotencyKey: randomUUID(), source: "web", userId: null,
    requestedItems: [{ productId: p1._id, quantity: 1 }, { productId: p2._id, quantity: 1 }],
    stockAdjustments: [
      { productId: p1._id, requestedQty: 1, decrementedQty: 0, compensatedQty: 0, state: "pending" },
      { productId: p2._id, requestedQty: 1, decrementedQty: 0, compensatedQty: 0, state: "pending" },
    ],
    customer: CUSTOMER, shippingAddress: ADDRESS, finalized: true, orderNumber: "DUSCK-2026-000902",
  });
  await decrementProductStock(p1._id, 1, operationIdFor(order._id, p1._id));
  await decrementProductStock(p2._id, 1, operationIdFor(order._id, p2._id));

  const realUpdMany = ProductModel.updateMany.bind(ProductModel);
  const mock = t.mock.method(ProductModel, "updateMany", () => Promise.reject(new Error("fallo simulado de $pull")));
  await assert.rejects(() => pruneStockOpsForOrder(order));
  assert.equal((await OrderModel.findById(order._id)).stockOpsPruned, false, "no se marca como podado");

  mock.mock.restore();
  await pruneStockOpsForOrder(order); // reintento
  assert.deepEqual(await opsOf(p1._id), []);
  assert.deepEqual(await opsOf(p2._id), []);
  assert.equal((await OrderModel.findById(order._id)).stockOpsPruned, true);
});

// ====================================================================
// PRODUCT HOOK COMPATIBILITY
// ====================================================================

test("hook/simple-inc-push: $inc stock + $push stockOps NO dispara recálculo por variants", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p = await makeProduct({ stock: 10, variants: [] });
  await decrementProductStock(p._id, 4, `${oid()}:${p._id}`);
  assert.equal(await stockOf(p._id), 6, "stock respeta el $inc, el hook no lo pisa");
});

test("hook/simple-pipeline: compensación (pipeline) NO dispara recálculo por variants", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p = await makeProduct({ stock: 10, variants: [] });
  const opId = `${oid()}:${p._id}`;
  await decrementProductStock(p._id, 4, opId);
  await compensateProductOp(p._id, opId);
  assert.equal(await stockOf(p._id), 10);
});

test("hook/variant-untouched: producto con variantes -> $inc+$push no recalcula; stock agregado del create intacto salvo el $inc", async (t) => {
  if (skipIfNoMongo(t)) return;
  const v = await ProductModel.create({
    name: "Var", slug: `v-${randomUUID().slice(0, 8)}`, description: "x", price: 10000,
    images: [{ url: "http://d/m.png", isMain: true }],
    variants: [{ sku: `S1-${Date.now()}`, color: "n", size: "M", stock: 5 }, { sku: `S2-${Date.now()}`, color: "a", size: "L", stock: 3 }],
    status: "PUBLISHED", isActive: true, createdBy: oid(),
  });
  assert.equal(v.stock, 8, "hook pre('save') agregó 5+3");
  // Operación directa sobre stockOps (no vía checkout — checkout bloquea variantes).
  const upd = await ProductModel.findOneAndUpdate(
    { _id: v._id },
    { $inc: { stock: -1 }, $push: { stockOps: { id: "x:y", qty: 1, state: "decremented", at: new Date() } } },
    { returnDocument: "after" },
  );
  assert.equal(upd.stock, 7, "el hook NO recalcula de vuelta a 8");
  assert.equal(upd.stockOps.length, 1);
});

test("hook/pull: $pull stockOps no altera stock ni dispara hooks", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p = await makeProduct({ stock: 10 });
  const opId = `${oid()}:${p._id}`;
  await decrementProductStock(p._id, 3, opId);
  await ProductModel.updateMany({ _id: p._id }, { $pull: { stockOps: { id: opId } } });
  assert.equal(await stockOf(p._id), 7, "stock sin cambios por el $pull");
  assert.deepEqual(await opsOf(p._id), []);
});

// ====================================================================
// LEGACY DOC COMPATIBILITY
// ====================================================================

test("legacy: un Product sin stockOps (default []) acepta un decremento sin migración", async (t) => {
  if (skipIfNoMongo(t)) return;
  // Inserta un doc "legado" saltándose los defaults del path stockOps.
  const raw = await ProductModel.collection.insertOne({
    name: "Legacy", slug: `legacy-${randomUUID().slice(0, 8)}`, description: "x", price: 10000,
    images: [{ url: "http://d/m.png", isMain: true }], variants: [], stock: 9,
    status: "PUBLISHED", isActive: true, createdBy: oid(), createdAt: new Date(), updatedAt: new Date(),
  });
  const res = await decrementProductStock(raw.insertedId, 2, `${oid()}:${raw.insertedId}`);
  assert.equal(res.outcome, "decremented");
  const doc = await ProductModel.findById(raw.insertedId);
  assert.equal(doc.stock, 7);
  assert.equal(doc.stockOps.length, 1);
});
