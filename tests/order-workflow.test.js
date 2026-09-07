// UI-5.1 — Tests del workflow de órdenes.
//
// Base de datos APARTE: `db-dusck-order-workflow-test`, se elimina al empezar y
// al terminar (misma estrategia que `order-http.test.js` / `order-admin-http`).
// Si no hay MongoDB disponible, la suite entera se marca `skip`.
//
// Alcance: PATCH /api/orders/:id/status + PATCH /api/orders/:id/payment —
// máquina de estados, autorización, statusHistory append-only, actor del token,
// mass assignment, cancelación + restitución de inventario (idempotente y ante
// concurrencia), transición de pago, y las órdenes no finalizadas. NO re-testea
// la creación de órdenes (`order-http` / `order-service` ya la cubren).
//
// Ejecutar:  node --test tests/order-workflow.test.js   (o)   npm test

import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";

const TEST_DB_URI = "mongodb://127.0.0.1:27017/db-dusck-order-workflow-test";
process.env.MONGO_URI = TEST_DB_URI;

let ctx = null;
let mongoAvailable = true;

test.before(async () => {
  try {
    const mongoose = (await import("mongoose")).default;
    await mongoose.connect(TEST_DB_URI, { serverSelectionTimeoutMS: 2000 });
    await mongoose.connection.dropDatabase();

    const app = (await import("../src/app.js")).default;
    const { generateToken } = await import("../src/helpers/jwt.helpers.js");
    const { env } = await import("../src/config/env.config.js");
    const UserModel = (await import("../src/models/user.model.js")).default;
    const ProductModel = (await import("../src/models/product.model.js")).default;
    const OrderModel = (await import("../src/models/order.model.js")).default;
    const CounterModel = (await import("../src/models/counter.model.js")).default;
    const { createOrder } = await import("../src/services/order.service.js");

    await Promise.all([UserModel.init(), ProductModel.init(), OrderModel.init()]);

    const server = app.listen(0);
    await once(server, "listening");
    const { port } = server.address();

    ctx = {
      mongoose,
      server,
      base: `http://127.0.0.1:${port}`,
      generateToken,
      jwtSecret: env.jwtSecret,
      createOrder,
      models: { UserModel, ProductModel, OrderModel, CounterModel },
    };
  } catch (err) {
    mongoAvailable = false;
    console.warn(`[order-workflow] MongoDB no disponible, se omite la suite: ${err.name}`);
  }
});

test.beforeEach(async () => {
  if (!mongoAvailable) return;
  const { UserModel, ProductModel, OrderModel, CounterModel } = ctx.models;
  await Promise.all([
    UserModel.deleteMany({}),
    ProductModel.deleteMany({}),
    OrderModel.deleteMany({}),
    CounterModel.deleteMany({}),
  ]);
});

test.after(async () => {
  if (ctx) {
    await ctx.mongoose.connection.dropDatabase();
    await ctx.mongoose.disconnect();
    await new Promise((r) => ctx.server.close(r));
  }
});

const guard = (t) => {
  if (!mongoAvailable) t.skip("MongoDB no disponible");
  return !mongoAvailable;
};

// --- helpers ---------------------------------------------------------------

const api = (path, { method = "GET", body, token } = {}) =>
  fetch(`${ctx.base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { "x-token": token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const patchStatus = (id, body, token) =>
  api(`/api/orders/${id}/status`, { method: "PATCH", body, token });
const patchPayment = (id, body, token) =>
  api(`/api/orders/${id}/payment`, { method: "PATCH", body, token });

let userSeq = 0;
const makeUser = (role, over = {}) => {
  userSeq += 1;
  return ctx.models.UserModel.create({
    name: `Usuario ${role} ${userSeq}`,
    nickname: `n${userSeq}${randomUUID().slice(0, 8)}`,
    email: `u-${role}-${userSeq}-${randomUUID().slice(0, 6)}@dusck.co`,
    password: "hash-no-usado",
    role,
    status: over.status ?? true,
  });
};

const tokenFor = (user) =>
  ctx.generateToken({
    _id: user._id,
    name: user.name,
    email: user.email,
    nickname: user.nickname,
    role: user.role,
  });

const adminToken = async () => tokenFor(await makeUser("administrador"));
const managerToken = async () => tokenFor(await makeUser("shop_manager"));
const subscriberToken = async () => tokenFor(await makeUser("subscriber"));

const makeProduct = (over = {}) =>
  ctx.models.ProductModel.create({
    name: over.name ?? "Camiseta Essential",
    slug: over.slug ?? `camiseta-${randomUUID().slice(0, 8)}`,
    description: "Algodón peinado",
    price: over.price ?? 50000,
    images: [{ url: "http://dusck.test/main.png", isMain: true }],
    variants: [],
    stock: over.stock ?? 20,
    status: over.status ?? "PUBLISHED",
    isActive: over.isActive ?? true,
    createdBy: new ctx.mongoose.Types.ObjectId(),
  });

const CUSTOMER = { recipientName: "Ana Gómez", phone: "3001234567", email: "ana@dusck.co" };
const SHIPPING = {
  department: "Antioquia",
  city: "Medellín",
  neighborhood: "Laureles",
  address: "Calle 12 # 34-56 apto 201",
};

// Crea una Order REAL vía el servicio de creación (decrementa stock, poda
// stockOps, finaliza). Devuelve el documento Mongoose de la orden.
const createRealOrder = async ({ productId, quantity = 2, userId = null } = {}) =>
  ctx.createOrder({
    items: [{ productId: String(productId), quantity }],
    customer: CUSTOMER,
    shippingAddress: SHIPPING,
    userId,
    source: "web",
    idempotencyKey: randomUUID(),
  });

const stockOf = async (id) => (await ctx.models.ProductModel.findById(id)).stock;
const orderOf = async (id) => ctx.models.OrderModel.findById(id).lean();

// Lleva una orden real hasta `targetStatus` recorriendo el camino feliz.
const HAPPY_PATH = ["confirmed", "ready_to_ship", "shipped", "delivered"];
const advanceTo = async (orderId, targetStatus, token) => {
  for (const s of HAPPY_PATH) {
    const res = await patchStatus(orderId, { status: s }, token);
    assert.equal(res.status, 200, `no se pudo avanzar a ${s}`);
    if (s === targetStatus) return;
  }
};

// ========================================================================
// A. TRANSICIONES VÁLIDAS DEL CAMINO FELIZ  (TEST 1–4)
// ========================================================================

test("TEST 1 — pending_confirmation -> confirmed (actor autorizado)", async (t) => {
  if (guard(t)) return;
  const token = await adminToken();
  const p = await makeProduct({ stock: 10 });
  const order = await createRealOrder({ productId: p._id, quantity: 2 });

  const res = await patchStatus(order._id, { status: "confirmed", note: "Confirmado por teléfono" }, token);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.data.status, "confirmed");
});

test("TEST 2 — confirmed -> ready_to_ship", async (t) => {
  if (guard(t)) return;
  const token = await adminToken();
  const p = await makeProduct({ stock: 10 });
  const order = await createRealOrder({ productId: p._id });
  await patchStatus(order._id, { status: "confirmed" }, token);

  const res = await patchStatus(order._id, { status: "ready_to_ship" }, token);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).data.status, "ready_to_ship");
});

test("TEST 3 — ready_to_ship -> shipped", async (t) => {
  if (guard(t)) return;
  const token = await managerToken(); // shop_manager también gestiona pedidos
  const p = await makeProduct({ stock: 10 });
  const order = await createRealOrder({ productId: p._id });
  await advanceTo(order._id, "ready_to_ship", token);

  const res = await patchStatus(order._id, { status: "shipped" }, token);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).data.status, "shipped");
});

test("TEST 4 — shipped -> delivered", async (t) => {
  if (guard(t)) return;
  const token = await adminToken();
  const p = await makeProduct({ stock: 10 });
  const order = await createRealOrder({ productId: p._id });
  await advanceTo(order._id, "shipped", token);

  const res = await patchStatus(order._id, { status: "delivered" }, token);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).data.status, "delivered");
});

// ========================================================================
// B. TRANSICIONES INVÁLIDAS  (TEST 5–7)
// ========================================================================

test("TEST 5 — pending_confirmation -> delivered se rechaza (salto ilegal) -> 409", async (t) => {
  if (guard(t)) return;
  const token = await adminToken();
  const p = await makeProduct({ stock: 10 });
  const order = await createRealOrder({ productId: p._id });

  const res = await patchStatus(order._id, { status: "delivered" }, token);
  assert.equal(res.status, 409);
  assert.equal((await orderOf(order._id)).status, "pending_confirmation");
});

test("TEST 6 — delivered -> confirmed se rechaza (retroceso) -> 409", async (t) => {
  if (guard(t)) return;
  const token = await adminToken();
  const p = await makeProduct({ stock: 10 });
  const order = await createRealOrder({ productId: p._id });
  await advanceTo(order._id, "delivered", token);

  const res = await patchStatus(order._id, { status: "confirmed" }, token);
  assert.equal(res.status, 409);
  assert.equal((await orderOf(order._id)).status, "delivered");
});

test("TEST 7 — cancelled -> confirmed se rechaza (estado terminal) -> 409", async (t) => {
  if (guard(t)) return;
  const token = await adminToken();
  const p = await makeProduct({ stock: 10 });
  const order = await createRealOrder({ productId: p._id });
  await patchStatus(order._id, { status: "cancelled", note: "cliente se arrepintió" }, token);

  const res = await patchStatus(order._id, { status: "confirmed" }, token);
  assert.equal(res.status, 409);
  assert.equal((await orderOf(order._id)).status, "cancelled");
});

test("extra — shipped -> pending_confirmation se rechaza", async (t) => {
  if (guard(t)) return;
  const token = await adminToken();
  const p = await makeProduct({ stock: 10 });
  const order = await createRealOrder({ productId: p._id });
  await advanceTo(order._id, "shipped", token);
  const res = await patchStatus(order._id, { status: "pending_confirmation" }, token);
  assert.equal(res.status, 409);
});

test("extra — shipped -> cancelled se rechaza (no cancelable tras despacho)", async (t) => {
  if (guard(t)) return;
  const token = await adminToken();
  const p = await makeProduct({ stock: 10 });
  const order = await createRealOrder({ productId: p._id, quantity: 3 });
  await advanceTo(order._id, "shipped", token);

  const res = await patchStatus(order._id, { status: "cancelled", note: "x" }, token);
  assert.equal(res.status, 409);
  // Stock NO se restituye: sigue descontado.
  assert.equal(await stockOf(p._id), 7);
});

test("extra — status inexistente -> 400", async (t) => {
  if (guard(t)) return;
  const token = await adminToken();
  const p = await makeProduct({ stock: 10 });
  const order = await createRealOrder({ productId: p._id });
  const res = await patchStatus(order._id, { status: "processing" }, token);
  assert.equal(res.status, 400);
});

test("extra — id inválido -> 400", async (t) => {
  if (guard(t)) return;
  const token = await adminToken();
  const res = await patchStatus("no-es-objectid", { status: "confirmed" }, token);
  assert.equal(res.status, 400);
});

// ========================================================================
// C. STATUS HISTORY  (TEST 8)
// ========================================================================

test("TEST 8 — cada transición añade una entrada a statusHistory (append-only)", async (t) => {
  if (guard(t)) return;
  const token = await adminToken();
  const p = await makeProduct({ stock: 10 });
  const order = await createRealOrder({ productId: p._id });

  const h0 = (await orderOf(order._id)).statusHistory;
  assert.equal(h0.length, 1);
  assert.equal(h0[0].status, "pending_confirmation");

  await patchStatus(order._id, { status: "confirmed", note: "ok" }, token);
  await patchStatus(order._id, { status: "ready_to_ship" }, token);

  const h = (await orderOf(order._id)).statusHistory;
  assert.equal(h.length, 3);
  assert.deepEqual(
    h.map((e) => e.status),
    ["pending_confirmation", "confirmed", "ready_to_ship"],
  );
  // La entrada previa NO se altera; la nueva lleva la nota y el actor.
  assert.equal(h[0].status, "pending_confirmation");
  assert.equal(h[1].note, "ok");
  assert.ok(new Date(h[0].changedAt) <= new Date(h[1].changedAt));
});

// ========================================================================
// D. ACTOR  (TEST 9)  +  MASS ASSIGNMENT  (TEST 10)
// ========================================================================

test("TEST 9 — changedBy proviene del token, no del body", async (t) => {
  if (guard(t)) return;
  const admin = await makeUser("administrador");
  const token = tokenFor(admin);
  const otherId = new ctx.mongoose.Types.ObjectId();
  const p = await makeProduct({ stock: 10 });
  const order = await createRealOrder({ productId: p._id });

  await patchStatus(
    order._id,
    { status: "confirmed", changedBy: String(otherId), note: "n" },
    token,
  );

  const h = (await orderOf(order._id)).statusHistory;
  const last = h[h.length - 1];
  assert.equal(String(last.changedBy), String(admin._id));
  assert.notEqual(String(last.changedBy), String(otherId));
});

test("TEST 10 — mass assignment: userId/total/finalized/statusHistory del body se ignoran", async (t) => {
  if (guard(t)) return;
  const token = await adminToken();
  const p = await makeProduct({ stock: 10 });
  const order = await createRealOrder({ productId: p._id, quantity: 2 });
  const before = await orderOf(order._id);

  const res = await patchStatus(
    order._id,
    {
      status: "confirmed",
      userId: String(new ctx.mongoose.Types.ObjectId()),
      total: 1,
      totals: { grandTotal: 1 },
      finalized: false,
      orderNumber: "DUSCK-9999-000001",
      statusHistory: [],
      payment: { status: "paid" },
    },
    token,
  );
  assert.equal(res.status, 200);

  const after = await orderOf(order._id);
  assert.equal(after.status, "confirmed"); // lo único que cambió
  assert.equal(String(after.userId ?? null), String(before.userId ?? null));
  assert.equal(after.totals.grandTotal, before.totals.grandTotal);
  assert.equal(after.finalized, true);
  assert.equal(after.orderNumber, before.orderNumber);
  assert.equal(after.payment.status, "pending");
  assert.equal(after.statusHistory.length, 2); // creación + confirmed
});

// ========================================================================
// E. AUTORIZACIÓN  (TEST 11, 13)
// ========================================================================

test("TEST 11 — usuario sin permisos (subscriber) no puede cambiar estado -> 403", async (t) => {
  if (guard(t)) return;
  const token = await subscriberToken();
  const p = await makeProduct({ stock: 10 });
  const order = await createRealOrder({ productId: p._id });

  const res = await patchStatus(order._id, { status: "confirmed" }, token);
  assert.equal(res.status, 403);
  assert.equal((await orderOf(order._id)).status, "pending_confirmation");
});

test("TEST 11b — sin token -> 401", async (t) => {
  if (guard(t)) return;
  const p = await makeProduct({ stock: 10 });
  const order = await createRealOrder({ productId: p._id });
  const res = await patchStatus(order._id, { status: "confirmed" }, undefined);
  assert.equal(res.status, 401);
});

test("TEST 11c — editor no puede gestionar pedidos -> 403", async (t) => {
  if (guard(t)) return;
  const token = tokenFor(await makeUser("editor"));
  const p = await makeProduct({ stock: 10 });
  const order = await createRealOrder({ productId: p._id });
  const res = await patchStatus(order._id, { status: "confirmed" }, token);
  assert.equal(res.status, 403);
});

// ========================================================================
// F. PAYMENT WORKFLOW  (TEST 12, 13)
// ========================================================================

test("TEST 12 — payment pending -> paid (actor autorizado)", async (t) => {
  if (guard(t)) return;
  const token = await adminToken();
  const p = await makeProduct({ stock: 10 });
  const order = await createRealOrder({ productId: p._id });

  const res = await patchPayment(order._id, { status: "paid", note: "Recibido contra entrega" }, token);
  assert.equal(res.status, 200);

  const after = await orderOf(order._id);
  assert.equal(after.payment.status, "paid");
  assert.ok(after.payment.paidAt, "paidAt debe quedar sellado");
  assert.equal(after.payment.note, "Recibido contra entrega");
  // El eje de order.status NO se toca.
  assert.equal(after.status, "pending_confirmation");
});

test("TEST 12b — payment pending -> failed exige nota (422 sin ella)", async (t) => {
  if (guard(t)) return;
  const token = await adminToken();
  const p = await makeProduct({ stock: 10 });
  const order = await createRealOrder({ productId: p._id });

  const noNote = await patchPayment(order._id, { status: "failed" }, token);
  assert.equal(noNote.status, 422);

  const ok = await patchPayment(order._id, { status: "failed", note: "cliente no tenía efectivo" }, token);
  assert.equal(ok.status, 200);
  assert.equal((await orderOf(order._id)).payment.status, "failed");
});

test("TEST 12c — retroceso financiero paid -> pending / paid -> failed se rechaza -> 409", async (t) => {
  if (guard(t)) return;
  const token = await adminToken();
  const p = await makeProduct({ stock: 10 });
  const order = await createRealOrder({ productId: p._id });
  await patchPayment(order._id, { status: "paid" }, token);

  assert.equal((await patchPayment(order._id, { status: "pending" }, token)).status, 409);
  assert.equal((await patchPayment(order._id, { status: "failed" }, token)).status, 409);
  assert.equal((await orderOf(order._id)).payment.status, "paid");
});

test("TEST 13 — usuario normal no puede tocar payment -> 403", async (t) => {
  if (guard(t)) return;
  const token = await subscriberToken();
  const p = await makeProduct({ stock: 10 });
  const order = await createRealOrder({ productId: p._id });

  const res = await patchPayment(order._id, { status: "paid" }, token);
  assert.equal(res.status, 403);
  assert.equal((await orderOf(order._id)).payment.status, "pending");
});

test("TEST 13b — invitado (sin token) no puede tocar payment -> 401", async (t) => {
  if (guard(t)) return;
  const p = await makeProduct({ stock: 10 });
  const order = await createRealOrder({ productId: p._id });
  const res = await patchPayment(order._id, { status: "paid" }, undefined);
  assert.equal(res.status, 401);
});

// ========================================================================
// G. CANCELACIÓN + INVENTARIO  (TEST 14, 15, 16)
// ========================================================================

test("TEST 14 — confirmed -> cancelled: status + history + stock restituido EXACTAMENTE una vez", async (t) => {
  if (guard(t)) return;
  const token = await adminToken();
  const p = await makeProduct({ stock: 10 });
  const order = await createRealOrder({ productId: p._id, quantity: 3 });
  assert.equal(await stockOf(p._id), 7, "createOrder descontó 3");
  await patchStatus(order._id, { status: "confirmed" }, token);

  const res = await patchStatus(order._id, { status: "cancelled", note: "cliente canceló" }, token);
  assert.equal(res.status, 200);

  const after = await orderOf(order._id);
  assert.equal(after.status, "cancelled");
  assert.equal(after.stockRestored, true);
  assert.equal(after.statusHistory.at(-1).status, "cancelled");
  assert.equal(after.statusHistory.at(-1).note, "cliente canceló");
  assert.equal(await stockOf(p._id), 10, "stock restituido a su valor original");

  // El producto lleva UNA operación de restitución para esta orden.
  const prod = await ctx.models.ProductModel.findById(p._id).lean();
  const cancelOps = (prod.stockOps || []).filter((o) => o.id === `${order._id}:${p._id}:cancel`);
  assert.equal(cancelOps.length, 1);
  assert.equal(cancelOps[0].qty, 3);
  assert.equal(cancelOps[0].state, "compensated");
});

test("TEST 14b — cancelar sin nota -> 422, sin efectos", async (t) => {
  if (guard(t)) return;
  const token = await adminToken();
  const p = await makeProduct({ stock: 10 });
  const order = await createRealOrder({ productId: p._id, quantity: 2 });

  const res = await patchStatus(order._id, { status: "cancelled" }, token);
  assert.equal(res.status, 422);
  assert.equal((await orderOf(order._id)).status, "pending_confirmation");
  assert.equal(await stockOf(p._id), 8, "el stock no se tocó");
});

test("TEST 14c — cancelar desde pending_confirmation también restituye stock", async (t) => {
  if (guard(t)) return;
  const token = await adminToken();
  const p = await makeProduct({ stock: 5 });
  const order = await createRealOrder({ productId: p._id, quantity: 2 });
  assert.equal(await stockOf(p._id), 3);

  const res = await patchStatus(order._id, { status: "cancelled", note: "sin stock real" }, token);
  assert.equal(res.status, 200);
  assert.equal(await stockOf(p._id), 5);
});

test("TEST 15 — doble cancelación concurrente: 1 éxito, 1 conflicto, stock restituido una sola vez", async (t) => {
  if (guard(t)) return;
  const token = await adminToken();
  const p = await makeProduct({ stock: 10 });
  const order = await createRealOrder({ productId: p._id, quantity: 4 });
  assert.equal(await stockOf(p._id), 6);
  await patchStatus(order._id, { status: "confirmed" }, token);

  const [a, b] = await Promise.all([
    patchStatus(order._id, { status: "cancelled", note: "req A" }, token),
    patchStatus(order._id, { status: "cancelled", note: "req B" }, token),
  ]);

  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 409], "exactamente una gana");
  assert.equal(await stockOf(p._id), 10, "stock restituido EXACTAMENTE una vez (no 14)");

  const after = await orderOf(order._id);
  assert.equal(after.status, "cancelled");
  // Una sola entrada 'cancelled' en el historial.
  assert.equal(after.statusHistory.filter((e) => e.status === "cancelled").length, 1);
});

test("TEST 16 — delivered -> cancelled se rechaza (no cancelable) -> 409, stock intacto", async (t) => {
  if (guard(t)) return;
  const token = await adminToken();
  const p = await makeProduct({ stock: 10 });
  const order = await createRealOrder({ productId: p._id, quantity: 2 });
  await advanceTo(order._id, "delivered", token);
  assert.equal(await stockOf(p._id), 8);

  const res = await patchStatus(order._id, { status: "cancelled", note: "tarde" }, token);
  assert.equal(res.status, 409);
  assert.equal((await orderOf(order._id)).status, "delivered");
  assert.equal(await stockOf(p._id), 8, "stock NO se restituye");
});

test("extra — re-ejecutar la restitución (idempotencia del servicio) no duplica stock", async (t) => {
  if (guard(t)) return;
  const token = await adminToken();
  const p = await makeProduct({ stock: 10 });
  const order = await createRealOrder({ productId: p._id, quantity: 3 });
  await patchStatus(order._id, { status: "cancelled", note: "x" }, token);
  assert.equal(await stockOf(p._id), 10);

  const { restockOrderInventory } = await import("../src/services/order.workflow.service.js");
  const fresh = await ctx.models.OrderModel.findById(order._id);
  await restockOrderInventory(fresh);
  await restockOrderInventory(fresh);
  assert.equal(await stockOf(p._id), 10, "sigue en 10 tras re-ejecutar");
});

// ========================================================================
// H. ORDEN NO FINALIZADA  (TEST 17)
// ========================================================================

test("TEST 17 — no se puede gestionar un skeleton (finalized:false) -> 404", async (t) => {
  if (guard(t)) return;
  const token = await adminToken();
  const skeleton = await ctx.models.OrderModel.create({
    idempotencyKey: randomUUID(),
    source: "web",
    finalized: false,
    requestedItems: [{ productId: new ctx.mongoose.Types.ObjectId(), quantity: 1 }],
    customer: CUSTOMER,
    shippingAddress: SHIPPING,
  });

  assert.equal((await patchStatus(skeleton._id, { status: "confirmed" }, token)).status, 404);
  assert.equal((await patchPayment(skeleton._id, { status: "paid" }, token)).status, 404);
  assert.equal((await orderOf(skeleton._id)).status, "pending_confirmation");
});

test("TEST 17b — orden inexistente -> 404", async (t) => {
  if (guard(t)) return;
  const token = await adminToken();
  const ghost = new ctx.mongoose.Types.ObjectId();
  assert.equal((await patchStatus(ghost, { status: "confirmed" }, token)).status, 404);
});

// ========================================================================
// I. CONCURRENCIA DE ESTADOS  (TEST 18)
// ========================================================================

test("TEST 18 — dos operadores hacen confirmed -> ready_to_ship a la vez: solo uno gana", async (t) => {
  if (guard(t)) return;
  const token = await adminToken();
  const p = await makeProduct({ stock: 10 });
  const order = await createRealOrder({ productId: p._id });
  await patchStatus(order._id, { status: "confirmed" }, token);

  const [a, b] = await Promise.all([
    patchStatus(order._id, { status: "ready_to_ship" }, token),
    patchStatus(order._id, { status: "ready_to_ship" }, token),
  ]);

  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const after = await orderOf(order._id);
  assert.equal(after.status, "ready_to_ship");
  assert.equal(after.statusHistory.filter((e) => e.status === "ready_to_ship").length, 1);
});

test("TEST 18b — confirmar vs cancelar concurrentes desde pending: uno gana, estado coherente", async (t) => {
  if (guard(t)) return;
  const token = await adminToken();
  const p = await makeProduct({ stock: 10 });
  const order = await createRealOrder({ productId: p._id, quantity: 2 });

  const [a, b] = await Promise.all([
    patchStatus(order._id, { status: "confirmed" }, token),
    patchStatus(order._id, { status: "cancelled", note: "carrera" }, token),
  ]);

  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const after = await orderOf(order._id);
  assert.ok(["confirmed", "cancelled"].includes(after.status));
  // Si ganó la cancelación, el stock se restituyó; si ganó confirmar, sigue descontado.
  const expected = after.status === "cancelled" ? 10 : 8;
  assert.equal(await stockOf(p._id), expected);
});
