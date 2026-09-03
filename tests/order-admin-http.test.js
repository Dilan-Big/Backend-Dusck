// FASE 4.3-C.3.1 — Tests HTTP de GET /api/orders (listado administrativo).
//
// Base de datos APARTE: `db-dusck-order-admin-test`, se elimina al empezar y al
// terminar (misma estrategia que `order-http.test.js` / `integration-s4.test.js`).
// Si no hay MongoDB disponible, la suite entera se marca `skip`.
//
// Alcance: SOLO GET /api/orders (auth, autorización, parsing/validación de query,
// filtros, orden, paginación, proyección). No re-testea la creación de órdenes.
//
// Ejecutar:  node --test tests/order-admin-http.test.js   (o)   npm test

import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";

import jwt from "jsonwebtoken";

const TEST_DB_URI = "mongodb://127.0.0.1:27017/db-dusck-order-admin-test";
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
    const OrderModel = (await import("../src/models/order.model.js")).default;

    await Promise.all([UserModel.init(), OrderModel.init()]);

    const server = app.listen(0);
    await once(server, "listening");
    const { port } = server.address();

    ctx = {
      mongoose,
      server,
      base: `http://127.0.0.1:${port}`,
      generateToken,
      jwtSecret: env.jwtSecret,
      models: { UserModel, OrderModel },
    };
  } catch (err) {
    mongoAvailable = false;
    console.warn(`[order-admin-http] MongoDB no disponible, se omite la suite: ${err.name}`);
  }
});

test.beforeEach(async () => {
  if (!mongoAvailable) return;
  await ctx.models.OrderModel.deleteMany({});
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

const listOrders = ({ query = "", token } = {}) =>
  fetch(`${ctx.base}/api/orders${query}`, {
    method: "GET",
    headers: { ...(token ? { "x-token": token } : {}) },
  });

let userSeq = 0;
const makeUser = async (role, over = {}) => {
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

let orderSeq = 0;
const seedOrder = async (over = {}) => {
  orderSeq += 1;
  const productId = over.productId ?? new ctx.mongoose.Types.ObjectId();
  const quantity = over.quantity ?? 2;
  const unitPrice = over.unitPrice ?? 50000;
  const status = over.status ?? "pending_confirmation";

  const doc = await ctx.models.OrderModel.create({
    idempotencyKey: randomUUID(),
    source: "web",
    finalized: over.finalized ?? true,
    orderNumber: over.orderNumber ?? `DUSCK-2026-${String(orderSeq).padStart(6, "0")}`,
    userId: over.userId ?? null,
    requestedItems: [{ productId, quantity }],
    stockAdjustments: [
      { productId, requestedQty: quantity, decrementedQty: quantity, compensatedQty: 0, state: "decremented" },
    ],
    stockOpsPruned: true,
    customer: {
      recipientName: over.recipientName ?? "Ana Gómez",
      phone: over.phone ?? "3001234567",
      email: over.email ?? `cliente${orderSeq}@dusck.co`,
      ...(over.documentId ? { documentId: over.documentId } : {}),
    },
    shippingAddress: {
      department: "Antioquia",
      city: "Medellín",
      neighborhood: "Laureles",
      address: "Calle 12 # 34-56",
      ...(over.addressComplement ? { addressComplement: over.addressComplement } : {}),
      ...(over.reference ? { reference: over.reference } : {}),
    },
    items: [
      {
        productId,
        productName: "Camiseta Essential",
        slug: "camiseta-essential",
        image: null,
        unitPrice,
        quantity,
        subtotal: unitPrice * quantity,
      },
    ],
    totals: {
      itemsSubtotal: unitPrice * quantity,
      shipping: 0,
      grandTotal: unitPrice * quantity,
      currency: "COP",
    },
    payment: { method: "cash_on_delivery", status: "pending" },
    status,
    statusHistory: [{ status, changedAt: new Date(), changedBy: null }],
    ...(over.notes ? { notes: over.notes } : {}),
  });

  if (over.createdAt) {
    // Raw driver: Mongoose fuerza `createdAt` en create() con timestamps:true;
    // esto lo reescribe sin pasar por la capa de timestamps.
    await ctx.models.OrderModel.collection.updateOne(
      { _id: doc._id },
      { $set: { createdAt: over.createdAt } },
    );
    doc.createdAt = over.createdAt;
  }
  return doc;
};

const seedMany = async (n, over = {}) => {
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(await seedOrder(over));
  return out;
};

const adminToken = async () => tokenFor(await makeUser("administrador"));

// ========================================================================
// A. AUTH
// ========================================================================

test("auth: guest / sin token -> 401", async (t) => {
  if (guard(t)) return;
  const res = await listOrders({});
  assert.equal(res.status, 401);
});

test("auth: token inválido (firma) -> 401", async (t) => {
  if (guard(t)) return;
  const bad = jwt.sign({ _id: "x", email: "x@x.co", role: "administrador" }, `wrong-${ctx.jwtSecret}`);
  const res = await listOrders({ token: bad });
  assert.equal(res.status, 401);
});

test("auth: token expirado -> 401", async (t) => {
  if (guard(t)) return;
  const u = await makeUser("administrador");
  const expired = jwt.sign({ _id: u._id.toString(), email: u.email, role: u.role }, ctx.jwtSecret, {
    expiresIn: -3600,
  });
  const res = await listOrders({ token: expired });
  assert.equal(res.status, 401);
});

test("auth: token válido pero usuario inactivo -> 401", async (t) => {
  if (guard(t)) return;
  const u = await makeUser("administrador", { status: false });
  const res = await listOrders({ token: tokenFor(u) });
  assert.equal(res.status, 401);
});

test("auth: editor -> 403", async (t) => {
  if (guard(t)) return;
  const res = await listOrders({ token: tokenFor(await makeUser("editor")) });
  assert.equal(res.status, 403);
});

test("auth: subscriber -> 403", async (t) => {
  if (guard(t)) return;
  const res = await listOrders({ token: tokenFor(await makeUser("subscriber")) });
  assert.equal(res.status, 403);
});

test("auth: administrador -> 200", async (t) => {
  if (guard(t)) return;
  const res = await listOrders({ token: await adminToken() });
  assert.equal(res.status, 200);
});

test("auth: shop_manager -> 200", async (t) => {
  if (guard(t)) return;
  const res = await listOrders({ token: tokenFor(await makeUser("shop_manager")) });
  assert.equal(res.status, 200);
});

// ========================================================================
// B. DEFAULT PAGINATION
// ========================================================================

test("pagination: defaults page=1 limit=20, total y totalPages correctos", async (t) => {
  if (guard(t)) return;
  await seedMany(25);
  const res = await listOrders({ token: await adminToken() });
  assert.equal(res.status, 200);
  const { data } = await res.json();
  assert.equal(data.pagination.page, 1);
  assert.equal(data.pagination.limit, 20);
  assert.equal(data.pagination.total, 25);
  assert.equal(data.pagination.totalPages, 2);
  assert.equal(data.items.length, 20);
});

// ========================================================================
// C. LIMIT
// ========================================================================

test("limit: 1 y 100 son válidos", async (t) => {
  if (guard(t)) return;
  await seedMany(3);
  const token = await adminToken();
  const r1 = await listOrders({ query: "?limit=1", token });
  assert.equal(r1.status, 200);
  assert.equal((await r1.json()).data.items.length, 1);
  const r100 = await listOrders({ query: "?limit=100", token });
  assert.equal(r100.status, 200);
  assert.equal((await r100.json()).data.pagination.limit, 100);
});

test("limit: 0 / 101 / abc / 1.5 -> 400", async (t) => {
  if (guard(t)) return;
  const token = await adminToken();
  for (const bad of ["0", "101", "abc", "1.5", "-1", "100000"]) {
    const res = await listOrders({ query: `?limit=${bad}`, token });
    assert.equal(res.status, 400, `limit=${bad} debería ser 400`);
  }
});

// ========================================================================
// D. PAGE
// ========================================================================

test("page: 1 y 2 devuelven páginas distintas y no solapadas", async (t) => {
  if (guard(t)) return;
  await seedMany(30);
  const token = await adminToken();
  const p1 = await (await listOrders({ query: "?page=1&limit=10", token })).json();
  const p2 = await (await listOrders({ query: "?page=2&limit=10", token })).json();
  assert.equal(p1.data.items.length, 10);
  assert.equal(p2.data.items.length, 10);
  assert.equal(p2.data.pagination.page, 2);
  const ids1 = new Set(p1.data.items.map((o) => o.id));
  assert.ok(p2.data.items.every((o) => !ids1.has(o.id)), "las páginas no deben solaparse");
});

test("page: 0 / negativo / decimal / string -> 400", async (t) => {
  if (guard(t)) return;
  const token = await adminToken();
  for (const bad of ["0", "-1", "1.5", "abc", "", "99999999999999999999"]) {
    const res = await listOrders({ query: `?page=${bad}`, token });
    assert.equal(res.status, 400, `page=${bad} debería ser 400`);
  }
});

test("page: más allá de los datos -> 200 con items vacío", async (t) => {
  if (guard(t)) return;
  await seedMany(5);
  const res = await listOrders({ query: "?page=99&limit=20", token: await adminToken() });
  assert.equal(res.status, 200);
  const { data } = await res.json();
  assert.deepEqual(data.items, []);
  assert.equal(data.pagination.total, 5);
});

// ========================================================================
// E. SORT  /  F. ORDER
// ========================================================================

test("sort: createdAt / orderNumber / status válidos; otro -> 400", async (t) => {
  if (guard(t)) return;
  const token = await adminToken();
  await seedMany(3);
  for (const s of ["createdAt", "orderNumber", "status"]) {
    const res = await listOrders({ query: `?sort=${s}`, token });
    assert.equal(res.status, 200, `sort=${s} debería ser 200`);
  }
  for (const s of ["totals.grandTotal", "customer.email", "__proto__", "foo", "userId"]) {
    const res = await listOrders({ query: `?sort=${encodeURIComponent(s)}`, token });
    assert.equal(res.status, 400, `sort=${s} debería ser 400`);
  }
});

test("order: asc / desc respetados; otro -> 400", async (t) => {
  if (guard(t)) return;
  const token = await adminToken();
  await seedOrder({ orderNumber: "DUSCK-2026-900001" });
  await seedOrder({ orderNumber: "DUSCK-2026-900002" });
  await seedOrder({ orderNumber: "DUSCK-2026-900003" });

  const asc = await (
    await listOrders({ query: "?sort=orderNumber&order=asc", token })
  ).json();
  const desc = await (
    await listOrders({ query: "?sort=orderNumber&order=desc", token })
  ).json();
  assert.deepEqual(
    asc.data.items.map((o) => o.orderNumber),
    ["DUSCK-2026-900001", "DUSCK-2026-900002", "DUSCK-2026-900003"],
  );
  assert.deepEqual(
    desc.data.items.map((o) => o.orderNumber),
    ["DUSCK-2026-900003", "DUSCK-2026-900002", "DUSCK-2026-900001"],
  );

  const bad = await listOrders({ query: "?order=sideways", token });
  assert.equal(bad.status, 400);
});

// ========================================================================
// G. STATUS
// ========================================================================

test("status: filtro exacto por cada estado válido", async (t) => {
  if (guard(t)) return;
  const { ORDER_STATUSES } = await import("../src/helpers/orderWorkflow.helper.js");
  const token = await adminToken();
  for (const s of ORDER_STATUSES) await seedOrder({ status: s });

  for (const s of ORDER_STATUSES) {
    const res = await listOrders({ query: `?status=${s}`, token });
    assert.equal(res.status, 200);
    const { data } = await res.json();
    assert.equal(data.pagination.total, 1, `status=${s} debería devolver exactamente 1`);
    assert.ok(data.items.every((o) => o.status === s));
  }
});

test("status: inválido -> 400", async (t) => {
  if (guard(t)) return;
  const token = await adminToken();
  for (const bad of ["entregado", "PENDING", "confirmed ", "1"]) {
    const res = await listOrders({ query: `?status=${encodeURIComponent(bad)}`, token });
    assert.equal(res.status, 400, `status=${bad} debería ser 400`);
  }
});

// ========================================================================
// H. ORDER NUMBER
// ========================================================================

test("orderNumber: coincidencia exacta, sin búsqueda parcial", async (t) => {
  if (guard(t)) return;
  const token = await adminToken();
  await seedOrder({ orderNumber: "DUSCK-2026-000123" });
  await seedOrder({ orderNumber: "DUSCK-2026-000124" });

  const ok = await listOrders({ query: "?orderNumber=DUSCK-2026-000123", token });
  assert.equal(ok.status, 200);
  const { data } = await ok.json();
  assert.equal(data.pagination.total, 1);
  assert.equal(data.items[0].orderNumber, "DUSCK-2026-000123");

  // formato inválido / prefijo parcial -> 400 (nunca "contains")
  for (const bad of ["DUSCK-2026-0001", "000123", "DUSCK-2026-.*", "dusck-2026-000123"]) {
    const res = await listOrders({ query: `?orderNumber=${encodeURIComponent(bad)}`, token });
    assert.equal(res.status, 400, `orderNumber=${bad} debería ser 400`);
  }
});

// ========================================================================
// I. USER ID
// ========================================================================

test("userId: ObjectId válido filtra; inválido -> 400", async (t) => {
  if (guard(t)) return;
  const token = await adminToken();
  const uid = new ctx.mongoose.Types.ObjectId();
  await seedOrder({ userId: uid });
  await seedOrder({ userId: new ctx.mongoose.Types.ObjectId() });
  await seedOrder({ userId: null });

  const ok = await listOrders({ query: `?userId=${uid.toString()}`, token });
  assert.equal(ok.status, 200);
  const { data } = await ok.json();
  assert.equal(data.pagination.total, 1);
  assert.equal(data.items[0].userId, uid.toString());

  for (const bad of ["no-es-id", "123", uid.toString().slice(0, 10)]) {
    const res = await listOrders({ query: `?userId=${bad}`, token });
    assert.equal(res.status, 400, `userId=${bad} debería ser 400`);
  }
});

// ========================================================================
// J. CUSTOMER EMAIL
// ========================================================================

test("customerEmail: exacto + normalización (uppercase / espacios); sin coincidencia parcial", async (t) => {
  if (guard(t)) return;
  const token = await adminToken();
  await seedOrder({ email: "cliente.vip@example.com" });
  await seedOrder({ email: "cliente.vip.2@example.com" }); // NO debe coincidir por prefijo

  const exact = await listOrders({ query: "?customerEmail=cliente.vip@example.com", token });
  assert.equal((await exact.json()).data.pagination.total, 1);

  const upper = await listOrders({
    query: `?customerEmail=${encodeURIComponent("  CLIENTE.VIP@EXAMPLE.COM  ")}`,
    token,
  });
  assert.equal(upper.status, 200);
  assert.equal((await upper.json()).data.pagination.total, 1);

  // no es un correo -> 400 (nunca se interpreta como "contains")
  const partial = await listOrders({ query: "?customerEmail=cliente.vip", token });
  assert.equal(partial.status, 400);
});

// ========================================================================
// K. DATES
// ========================================================================

test("dates: rango createdFrom/createdTo, inclusivo de día completo, y validaciones", async (t) => {
  if (guard(t)) return;
  const token = await adminToken();
  await seedOrder({ createdAt: new Date("2026-01-10T09:00:00.000Z"), orderNumber: "DUSCK-2026-810001" });
  await seedOrder({ createdAt: new Date("2026-02-15T12:00:00.000Z"), orderNumber: "DUSCK-2026-810002" });
  await seedOrder({ createdAt: new Date("2026-03-20T18:00:00.000Z"), orderNumber: "DUSCK-2026-810003" });

  // rango cerrado (date-only): febrero completo -> solo la de feb
  const feb = await listOrders({
    query: "?createdFrom=2026-02-01&createdTo=2026-02-28",
    token,
  });
  assert.equal(feb.status, 200);
  const febData = await feb.json();
  assert.equal(febData.data.pagination.total, 1);
  assert.equal(febData.data.items[0].orderNumber, "DUSCK-2026-810002");

  // date-only en createdTo incluye TODO el día (order a las 12:00 del mismo día)
  const sameDay = await listOrders({
    query: "?createdFrom=2026-02-15&createdTo=2026-02-15",
    token,
  });
  assert.equal((await sameDay.json()).data.pagination.total, 1);

  // solo createdFrom
  const fromOnly = await listOrders({ query: "?createdFrom=2026-02-01", token });
  assert.equal((await fromOnly.json()).data.pagination.total, 2);

  // ISO completo válido
  const iso = await listOrders({
    query: `?createdFrom=${encodeURIComponent("2026-03-01T00:00:00.000Z")}`,
    token,
  });
  assert.equal(iso.status, 200);
  assert.equal((await iso.json()).data.pagination.total, 1);

  // inválidos
  for (const q of [
    "?createdFrom=not-a-date",
    "?createdTo=2026-13-40",
    "?createdFrom=2026/01/01",
    "?createdFrom=2026",
  ]) {
    const res = await listOrders({ query: q, token });
    assert.equal(res.status, 400, `${q} debería ser 400`);
  }

  // from > to
  const inverted = await listOrders({
    query: "?createdFrom=2026-03-01&createdTo=2026-01-01",
    token,
  });
  assert.equal(inverted.status, 400);
});

test("dates (America/Bogota): date-only = día calendario COLOMBIA, no UTC", async (t) => {
  if (guard(t)) return;
  const token = await adminToken();

  // Día calendario Colombia 2026-02-15 (UTC-5, sin DST):
  //   inicio -> 2026-02-15T00:00:00-05:00 = 2026-02-15T05:00:00.000Z
  //   fin    -> 2026-02-15T23:59:59.999-05:00 = 2026-02-16T04:59:59.999Z
  const atStart = await seedOrder({
    createdAt: new Date("2026-02-15T05:00:00.000Z"),
    orderNumber: "DUSCK-2026-820001",
  });
  const justBeforeStart = await seedOrder({
    createdAt: new Date("2026-02-15T04:59:59.999Z"),
    orderNumber: "DUSCK-2026-820002",
  });
  const atEnd = await seedOrder({
    createdAt: new Date("2026-02-16T04:59:59.999Z"),
    orderNumber: "DUSCK-2026-820003",
  });
  const justAfterEnd = await seedOrder({
    createdAt: new Date("2026-02-16T05:00:00.000Z"),
    orderNumber: "DUSCK-2026-820004",
  });
  // 2026-02-15T00:30:00Z == 2026-02-14T19:30-05:00 -> es el DÍA 14 en Colombia
  const utcMidnightButDay14InCol = await seedOrder({
    createdAt: new Date("2026-02-15T00:30:00.000Z"),
    orderNumber: "DUSCK-2026-820005",
  });

  const numbersOf = async (res) =>
    (await res.json()).data.items.map((o) => o.orderNumber).sort();

  // A + C — createdFrom date-only: incluye el inicio del día Colombia, excluye lo anterior
  const fromRes = await listOrders({ query: "?createdFrom=2026-02-15", token });
  assert.equal(fromRes.status, 200);
  const fromNums = await numbersOf(fromRes);
  assert.ok(fromNums.includes(atStart.orderNumber), "A: inicio del día Colombia incluido");
  assert.ok(!fromNums.includes(justBeforeStart.orderNumber), "C: justo antes del inicio excluido");
  assert.ok(!fromNums.includes(utcMidnightButDay14InCol.orderNumber), "medianoche UTC (día 14 en Col) excluida");

  // B + D — createdTo date-only: incluye el fin del día Colombia, excluye lo posterior
  const toRes = await listOrders({ query: "?createdTo=2026-02-15", token });
  const toNums = await numbersOf(toRes);
  assert.ok(toNums.includes(atEnd.orderNumber), "B: fin del día Colombia incluido");
  assert.ok(!toNums.includes(justAfterEnd.orderNumber), "D: justo después del fin excluido");

  // E — mismo date-only from y to = EXACTAMENTE ese día calendario Colombia
  const dayRes = await listOrders({
    query: "?createdFrom=2026-02-15&createdTo=2026-02-15",
    token,
  });
  const dayNums = await numbersOf(dayRes);
  assert.deepEqual(
    dayNums,
    [atStart.orderNumber, atEnd.orderNumber].sort(),
    "E: solo las órdenes dentro del día calendario Colombia 2026-02-15",
  );
});

test("dates (ISO con zona explícita): se respeta el offset del cliente, no se reinterpreta", async (t) => {
  if (guard(t)) return;
  const token = await adminToken();
  // F — orden a las 23:00Z del 10-jun
  await seedOrder({
    createdAt: new Date("2026-06-10T23:00:00.000Z"),
    orderNumber: "DUSCK-2026-830001",
  });

  // createdFrom = 2026-06-10T20:00:00-05:00 == 2026-06-11T01:00:00Z  -> la orden (23:00Z) queda FUERA
  const after = await listOrders({
    query: `?createdFrom=${encodeURIComponent("2026-06-10T20:00:00.000-05:00")}`,
    token,
  });
  assert.equal(after.status, 200);
  assert.equal((await after.json()).data.pagination.total, 0, "F: offset -05:00 del cliente respetado");

  // createdFrom = 2026-06-10T15:00:00-05:00 == 2026-06-10T20:00:00Z  -> la orden (23:00Z) queda DENTRO
  const before = await listOrders({
    query: `?createdFrom=${encodeURIComponent("2026-06-10T15:00:00.000-05:00")}`,
    token,
  });
  assert.equal((await before.json()).data.pagination.total, 1, "F: offset -05:00 del cliente respetado");

  // Y un instante Z explícito mantiene su significado UTC
  const zExact = await listOrders({
    query: `?createdFrom=${encodeURIComponent("2026-06-10T22:59:59.999Z")}&createdTo=${encodeURIComponent("2026-06-10T23:00:00.001Z")}`,
    token,
  });
  assert.equal((await zExact.json()).data.pagination.total, 1);
});

// ========================================================================
// L. SECURITY
// ========================================================================

test("security: parámetros desconocidos se ignoran", async (t) => {
  if (guard(t)) return;
  await seedMany(3);
  const res = await listOrders({ query: "?page=1&foo=bar&hack=1", token: await adminToken() });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).data.pagination.total, 3);
});

test("security: operadores Mongo en query no alteran el filtro", async (t) => {
  if (guard(t)) return;
  const token = await adminToken();
  await seedOrder({ status: "confirmed" });
  await seedOrder({ status: "delivered" });
  await seedOrder({ status: "cancelled" });

  for (const q of [
    "?status[$ne]=confirmed",
    "?status[$in][]=confirmed",
    "?createdAt[$gte]=2026-01-01",
    `?${encodeURIComponent("customer.email[$regex]")}=.*`,
    "?userId[$exists]=true",
  ]) {
    const res = await listOrders({ query: q, token });
    assert.equal(res.status, 200, `${q} no debería romper`);
    assert.equal((await res.json()).data.pagination.total, 3, `${q} no debe filtrar nada`);
  }
});

test("security: limit por encima de 100 rechazado; sort arbitrario rechazado", async (t) => {
  if (guard(t)) return;
  const token = await adminToken();
  assert.equal((await listOrders({ query: "?limit=101", token })).status, 400);
  assert.equal((await listOrders({ query: "?limit=999999", token })).status, 400);
  assert.equal((await listOrders({ query: "?sort=constructor", token })).status, 400);
});

// ========================================================================
// M. PROJECTION
// ========================================================================

test("projection: solo campos administrativos de resumen; nada interno ni PII reservada", async (t) => {
  if (guard(t)) return;
  const token = await adminToken();
  await seedOrder({
    documentId: "1012345678",
    addressComplement: "Apto 302",
    reference: "Frente al parque",
    notes: "Llamar antes",
    userId: new ctx.mongoose.Types.ObjectId(),
  });

  const res = await listOrders({ token });
  assert.equal(res.status, 200);
  const { data } = await res.json();
  const item = data.items[0];

  assert.deepEqual(
    Object.keys(item).sort(),
    [
      "createdAt",
      "customer",
      "id",
      "itemsCount",
      "orderNumber",
      "payment",
      "status",
      "totals",
      "updatedAt",
      "userId",
    ].sort(),
  );
  assert.deepEqual(Object.keys(item.customer).sort(), ["email", "phone", "recipientName"].sort());
  assert.deepEqual(Object.keys(item.payment).sort(), ["method", "status"].sort());
  assert.equal(item.itemsCount, 1);

  const raw = JSON.stringify(data);
  for (const forbidden of [
    "idempotencyKey",
    "finalized",
    "source",
    "requestedItems",
    "stockAdjustments",
    "stockOps",
    "stockOpsPruned",
    "export",
    "__v",
    "shippingAddress",
    "statusHistory",
    "documentId",
  ]) {
    assert.ok(!(forbidden in item), `item no debe tener "${forbidden}"`);
    assert.ok(!raw.includes(`"${forbidden}"`), `respuesta no debe contener "${forbidden}"`);
  }
  assert.ok(!raw.includes("Apto 302"), "no debe filtrar addressComplement");
  assert.ok(!raw.includes("Frente al parque"), "no debe filtrar reference");
  assert.ok(!raw.includes("Llamar antes"), "no debe filtrar notes");
  assert.ok(!raw.includes("1012345678"), "no debe filtrar documentId");
});

// ========================================================================
// N. EMPTY
// ========================================================================

test("empty: sin órdenes -> items=[], total=0, totalPages=0", async (t) => {
  if (guard(t)) return;
  const res = await listOrders({ token: await adminToken() });
  assert.equal(res.status, 200);
  const { data } = await res.json();
  assert.deepEqual(data.items, []);
  assert.equal(data.pagination.total, 0);
  assert.equal(data.pagination.totalPages, 0);
});

test("empty: skeletons (finalized:false) nunca aparecen en el listado", async (t) => {
  if (guard(t)) return;
  await seedOrder({ finalized: false, orderNumber: undefined });
  await seedOrder({ finalized: true });
  const res = await listOrders({ token: await adminToken() });
  const { data } = await res.json();
  assert.equal(data.pagination.total, 1);
  assert.equal(data.items[0].status, "pending_confirmation");
});

// ========================================================================
// combinación de filtros
// ========================================================================

test("filtros combinados (AND): status + createdFrom + limit", async (t) => {
  if (guard(t)) return;
  const token = await adminToken();
  await seedOrder({ status: "confirmed", createdAt: new Date("2026-05-01T10:00:00Z") });
  await seedOrder({ status: "confirmed", createdAt: new Date("2026-01-01T10:00:00Z") });
  await seedOrder({ status: "delivered", createdAt: new Date("2026-05-02T10:00:00Z") });

  const res = await listOrders({
    query: "?status=confirmed&createdFrom=2026-04-01&limit=10",
    token,
  });
  assert.equal(res.status, 200);
  const { data } = await res.json();
  assert.equal(data.pagination.total, 1);
  assert.equal(data.items[0].status, "confirmed");
});
