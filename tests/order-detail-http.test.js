// FASE 4.3-C.3.2 — Tests HTTP de GET /api/orders/:id (detalle administrativo).
//
// Base de datos APARTE: `db-dusck-order-detail-test`, se elimina al empezar y al
// terminar (mismo patrón que `order-admin-http.test.js` / `order-http.test.js`).
// Si no hay MongoDB disponible, la suite entera se marca `skip`.
//
// Alcance: SOLO GET /api/orders/:id (auth, autorización, validación de :id,
// finalized:true, proyección, read-only). No re-testea creación ni listado.
//
// Ejecutar:  node --test tests/order-detail-http.test.js   (o)   npm test

import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";

import jwt from "jsonwebtoken";

const TEST_DB_URI = "mongodb://127.0.0.1:27017/db-dusck-order-detail-test";
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
    console.warn(`[order-detail-http] MongoDB no disponible, se omite la suite: ${err.name}`);
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

const getDetail = (id, { token } = {}) =>
  fetch(`${ctx.base}/api/orders/${id}`, {
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

const adminToken = async () => tokenFor(await makeUser("administrador"));

let orderSeq = 0;
const seedFinalizedOrder = async (over = {}) => {
  orderSeq += 1;
  const productId = over.productId ?? new ctx.mongoose.Types.ObjectId();
  const quantity = over.quantity ?? 2;
  const unitPrice = over.unitPrice ?? 50000;
  const status = over.status ?? "pending_confirmation";
  const changedBy = "changedBy" in over ? over.changedBy : null;

  return ctx.models.OrderModel.create({
    idempotencyKey: over.idempotencyKey ?? randomUUID(),
    source: "web",
    finalized: true,
    orderNumber: over.orderNumber ?? `DUSCK-2026-${String(orderSeq).padStart(6, "0")}`,
    userId: "userId" in over ? over.userId : null,
    requestedItems: [{ productId, quantity }],
    stockAdjustments: [
      {
        productId,
        requestedQty: quantity,
        decrementedQty: quantity,
        compensatedQty: 0,
        state: "decremented",
      },
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
    items: over.items ?? [
      {
        productId,
        productName: "Camiseta Essential",
        slug: "camiseta-essential",
        image: "image" in over ? over.image : "http://dusck.test/main.png",
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
    statusHistory: over.statusHistory ?? [{ status, changedAt: new Date(), changedBy }],
    ...("notes" in over ? { notes: over.notes } : {}),
    ...(over.exportState ? { export: over.exportState } : {}),
  });
};

const seedSkeleton = async () => {
  orderSeq += 1;
  const productId = new ctx.mongoose.Types.ObjectId();
  return ctx.models.OrderModel.create({
    idempotencyKey: randomUUID(),
    source: "web",
    finalized: false,
    requestedItems: [{ productId, quantity: 1 }],
    stockAdjustments: [
      { productId, requestedQty: 1, decrementedQty: 0, compensatedQty: 0, state: "pending" },
    ],
    customer: { recipientName: "Skeleton", phone: "3009999999", email: `sk${orderSeq}@dusck.co` },
    shippingAddress: {
      department: "Antioquia",
      city: "Medellín",
      neighborhood: "Centro",
      address: "Calle 1 # 1-1",
    },
  });
};

const ID_24 = "0123456789abcdef01234567"; // ObjectId válido en forma, inexistente

// ========================================================================
// AUTH
// ========================================================================

test("auth: guest / sin token -> 401", async (t) => {
  if (guard(t)) return;
  assert.equal((await getDetail(ID_24)).status, 401);
});

test("auth: token inválido (firma) -> 401", async (t) => {
  if (guard(t)) return;
  const bad = jwt.sign({ _id: "x", email: "x@x.co", role: "administrador" }, `wrong-${ctx.jwtSecret}`);
  assert.equal((await getDetail(ID_24, { token: bad })).status, 401);
});

test("auth: token expirado -> 401", async (t) => {
  if (guard(t)) return;
  const u = await makeUser("administrador");
  const expired = jwt.sign({ _id: u._id.toString(), email: u.email, role: u.role }, ctx.jwtSecret, {
    expiresIn: -3600,
  });
  assert.equal((await getDetail(ID_24, { token: expired })).status, 401);
});

test("auth: usuario inactivo -> 401", async (t) => {
  if (guard(t)) return;
  const u = await makeUser("administrador", { status: false });
  assert.equal((await getDetail(ID_24, { token: tokenFor(u) })).status, 401);
});

test("auth: editor -> 403", async (t) => {
  if (guard(t)) return;
  assert.equal((await getDetail(ID_24, { token: tokenFor(await makeUser("editor")) })).status, 403);
});

test("auth: subscriber -> 403", async (t) => {
  if (guard(t)) return;
  assert.equal(
    (await getDetail(ID_24, { token: tokenFor(await makeUser("subscriber")) })).status,
    403,
  );
});

test("auth: administrador -> 200 sobre orden finalizada", async (t) => {
  if (guard(t)) return;
  const o = await seedFinalizedOrder();
  assert.equal((await getDetail(o._id.toString(), { token: await adminToken() })).status, 200);
});

test("auth: shop_manager -> 200 sobre orden finalizada", async (t) => {
  if (guard(t)) return;
  const o = await seedFinalizedOrder();
  const res = await getDetail(o._id.toString(), {
    token: tokenFor(await makeUser("shop_manager")),
  });
  assert.equal(res.status, 200);
});

// ========================================================================
// ID
// ========================================================================

test("id: inválido -> 400 (abc / no-hex / longitud incorrecta)", async (t) => {
  if (guard(t)) return;
  const token = await adminToken();
  for (const bad of ["abc", "123", "zzzzzzzzzzzzzzzzzzzzzzzz", "0123456789abcdef0123456", "0123456789abcdef012345678"]) {
    const res = await getDetail(bad, { token });
    assert.equal(res.status, 400, `id="${bad}" debería ser 400`);
    assert.equal((await res.json()).msg, "El identificador del pedido no es válido");
  }
});

test("id: ObjectId válido inexistente -> 404", async (t) => {
  if (guard(t)) return;
  const res = await getDetail(ID_24, { token: await adminToken() });
  assert.equal(res.status, 404);
  assert.equal((await res.json()).msg, "El pedido no se encuentra registrado");
});

test("id: orden con finalized:false -> 404 (mismo mensaje, no revela skeleton)", async (t) => {
  if (guard(t)) return;
  const sk = await seedSkeleton();
  const res = await getDetail(sk._id.toString(), { token: await adminToken() });
  assert.equal(res.status, 404);
  assert.equal((await res.json()).msg, "El pedido no se encuentra registrado");
});

test("id: orden finalizada válida -> 200 con data.id coincidente", async (t) => {
  if (guard(t)) return;
  const o = await seedFinalizedOrder();
  const res = await getDetail(o._id.toString(), { token: await adminToken() });
  assert.equal(res.status, 200);
  const { msg, data } = await res.json();
  assert.equal(msg, "Pedido obtenido correctamente");
  assert.equal(data.id, o._id.toString());
});

// ========================================================================
// READ-ONLY
// ========================================================================

test("read-only: dos consultas idénticas, sin mutación del documento", async (t) => {
  if (guard(t)) return;
  const { OrderModel } = ctx.models;
  const token = await adminToken();
  const o = await seedFinalizedOrder();
  const before = await OrderModel.findById(o._id).lean();

  const r1 = await (await getDetail(o._id.toString(), { token })).json();
  const r2 = await (await getDetail(o._id.toString(), { token })).json();
  assert.deepEqual(r1, r2);

  const after = await OrderModel.findById(o._id).lean();
  assert.equal(after.updatedAt.getTime(), before.updatedAt.getTime(), "updatedAt no debe cambiar");
  assert.deepEqual(after.stockAdjustments, before.stockAdjustments, "recuperación intacta");
  assert.equal(after.finalized, true);
  assert.equal(after.stockOpsPruned, before.stockOpsPruned);
});

// ========================================================================
// PROJECTION — presentes
// ========================================================================

test("projection: estructura completa del detalle", async (t) => {
  if (guard(t)) return;
  const o = await seedFinalizedOrder({
    userId: new ctx.mongoose.Types.ObjectId(),
    documentId: "1012345678",
    addressComplement: "Apto 302",
    reference: "Frente al parque",
    notes: "Entregar en la tarde",
  });
  const { data } = await (await getDetail(o._id.toString(), { token: await adminToken() })).json();

  assert.deepEqual(
    Object.keys(data).sort(),
    [
      "createdAt",
      "customer",
      "id",
      "items",
      "notes",
      "orderNumber",
      "payment",
      "shippingAddress",
      "status",
      "statusHistory",
      "totals",
      "updatedAt",
      "userId",
    ].sort(),
  );

  assert.deepEqual(Object.keys(data.customer).sort(), ["documentId", "email", "phone", "recipientName"].sort());
  assert.equal(data.customer.documentId, "1012345678");

  assert.deepEqual(
    Object.keys(data.shippingAddress).sort(),
    ["address", "addressComplement", "city", "department", "neighborhood", "reference"].sort(),
  );
  assert.equal(data.shippingAddress.addressComplement, "Apto 302");
  assert.equal(data.shippingAddress.reference, "Frente al parque");

  assert.equal(data.items.length, 1);
  assert.deepEqual(
    Object.keys(data.items[0]).sort(),
    ["image", "productId", "productName", "quantity", "slug", "subtotal", "unitPrice"].sort(),
  );
  assert.equal(typeof data.items[0].productId, "string");

  assert.deepEqual(Object.keys(data.totals).sort(), ["currency", "grandTotal", "itemsSubtotal", "shipping"].sort());
  assert.equal(data.totals.currency, "COP");

  assert.deepEqual(Object.keys(data.payment).sort(), ["method", "status"].sort());
  assert.equal(data.payment.method, "cash_on_delivery");

  assert.ok(Array.isArray(data.statusHistory));
  assert.deepEqual(Object.keys(data.statusHistory[0]).sort(), ["changedAt", "changedBy", "note", "status"].sort());

  assert.equal(data.notes, "Entregar en la tarde");
  assert.equal(typeof data.userId, "string");
});

// ========================================================================
// CAMPOS INTERNOS — ausentes
// ========================================================================

test("internos: ningún campo interno aparece en la respuesta", async (t) => {
  if (guard(t)) return;
  const o = await seedFinalizedOrder({
    idempotencyKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    exportState: {
      status: "failed",
      attempts: 3,
      sheetRowRef: "ROW-SECRET-123",
      lastError: "ERR-SECRET-XYZ",
    },
  });
  const res = await getDetail(o._id.toString(), { token: await adminToken() });
  const body = await res.json();
  const { data } = body;
  const raw = JSON.stringify(body);

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
  ]) {
    assert.equal(forbidden in data, false, `data no debe exponer "${forbidden}"`);
    assert.equal(raw.includes(`"${forbidden}"`), false, `respuesta no debe contener la clave "${forbidden}"`);
  }
  assert.equal(raw.includes("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), false, "no debe filtrar idempotencyKey");
  assert.equal(raw.includes("ROW-SECRET-123"), false, "no debe filtrar export.sheetRowRef");
  assert.equal(raw.includes("ERR-SECRET-XYZ"), false, "no debe filtrar export.lastError");
});

// ========================================================================
// NULLS  (DEC-C3.2-G)
// ========================================================================

test("nulls: opcionales ausentes aparecen con null explícito", async (t) => {
  if (guard(t)) return;
  // orden invitado, sin documentId / addressComplement / reference / notes,
  // y con una entrada de statusHistory sin note y changedBy null
  const o = await seedFinalizedOrder({ userId: null });
  const { data } = await (await getDetail(o._id.toString(), { token: await adminToken() })).json();

  assert.equal(data.userId, null);
  assert.equal(data.customer.documentId, null);
  assert.equal(data.shippingAddress.addressComplement, null);
  assert.equal(data.shippingAddress.reference, null);
  assert.equal(data.notes, null);
  assert.ok("documentId" in data.customer, "la clave documentId debe existir");
  assert.ok("addressComplement" in data.shippingAddress);
  assert.ok("reference" in data.shippingAddress);
  assert.ok("notes" in data);

  assert.equal(data.statusHistory[0].note, null);
  assert.ok("note" in data.statusHistory[0]);
  assert.equal(data.statusHistory[0].changedBy, null);
  assert.ok("changedBy" in data.statusHistory[0]);
});

// ========================================================================
// INVITADO
// ========================================================================

test("invitado: userId null y visible para administrador y shop_manager", async (t) => {
  if (guard(t)) return;
  const o = await seedFinalizedOrder({ userId: null });
  const admin = await getDetail(o._id.toString(), { token: await adminToken() });
  const sm = await getDetail(o._id.toString(), {
    token: tokenFor(await makeUser("shop_manager")),
  });
  assert.equal(admin.status, 200);
  assert.equal(sm.status, 200);
  assert.equal((await admin.json()).data.userId, null);
  assert.equal((await sm.json()).data.userId, null);
});

// ========================================================================
// STATUS HISTORY
// ========================================================================

test("statusHistory: array completo, orden cronológico preservado, changedBy string|null", async (t) => {
  if (guard(t)) return;
  const actor = new ctx.mongoose.Types.ObjectId();
  const o = await seedFinalizedOrder({
    status: "confirmed",
    statusHistory: [
      { status: "pending_confirmation", changedAt: new Date("2026-02-15T10:00:00Z"), changedBy: null },
      { status: "confirmed", changedAt: new Date("2026-02-15T11:30:00Z"), changedBy: actor, note: "Cliente confirmó por WhatsApp" },
    ],
  });
  const { data } = await (await getDetail(o._id.toString(), { token: await adminToken() })).json();

  assert.equal(data.statusHistory.length, 2);
  assert.deepEqual(
    data.statusHistory.map((h) => h.status),
    ["pending_confirmation", "confirmed"],
  );
  assert.equal(data.statusHistory[0].changedBy, null);
  assert.equal(data.statusHistory[0].note, null);
  assert.equal(data.statusHistory[1].changedBy, actor.toString());
  assert.equal(typeof data.statusHistory[1].changedBy, "string");
  assert.equal(data.statusHistory[1].note, "Cliente confirmó por WhatsApp");
  assert.equal(new Date(data.statusHistory[0].changedAt) < new Date(data.statusHistory[1].changedAt), true);
});

// ========================================================================
// IMAGE NULL
// ========================================================================

test("items: image null se respeta", async (t) => {
  if (guard(t)) return;
  const o = await seedFinalizedOrder({ image: null });
  const { data } = await (await getDetail(o._id.toString(), { token: await adminToken() })).json();
  assert.equal(data.items[0].image, null);
});

// ========================================================================
// SEGURIDAD — query params ignorados, sin inyección
// ========================================================================

test("security: query params no alteran la consulta (finalized/projection/etc.)", async (t) => {
  if (guard(t)) return;
  const sk = await seedSkeleton();
  const token = await adminToken();

  // intentar "abrir" el skeleton vía query
  for (const q of [
    "?finalized=false",
    "?finalized=any",
    "?projection=+idempotencyKey",
    "?fields=idempotencyKey",
    "?populate=userId",
  ]) {
    const res = await getDetail(`${sk._id.toString()}${q}`, { token });
    assert.equal(res.status, 404, `${q} no debe exponer el skeleton`);
  }

  // orden finalizada: los query params se ignoran, la proyección no cambia
  const o = await seedFinalizedOrder({ idempotencyKey: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });
  const res = await getDetail(`${o._id.toString()}?fields=idempotencyKey&projection=export`, { token });
  assert.equal(res.status, 200);
  const raw = JSON.stringify(await res.json());
  assert.equal(raw.includes("idempotencyKey"), false);
  assert.equal(raw.includes("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"), false);
});
