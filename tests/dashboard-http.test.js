// UI-5.3 — Tests HTTP de GET /api/dashboard (panel de indicadores admin).
//
// Base de datos APARTE: `db-dusck-dashboard-test`, se elimina al empezar y al
// terminar (misma estrategia que `order-admin-http.test.js`). Si no hay MongoDB
// disponible, la suite entera se marca `skip`.
//
// Alcance: auth/autorización, forma del contrato, agregados sobre datos reales
// sembrados, rango vacío -> ceros (no error), validación de query.
//
// Ejecutar:  node --test tests/dashboard-http.test.js   (o)   npm test

import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";

const TEST_DB_URI = "mongodb://127.0.0.1:27017/db-dusck-dashboard-test";
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
    const UserModel = (await import("../src/models/user.model.js")).default;
    const OrderModel = (await import("../src/models/order.model.js")).default;
    const ProductModel = (await import("../src/models/product.model.js")).default;

    await Promise.all([UserModel.init(), OrderModel.init(), ProductModel.init()]);

    const server = app.listen(0);
    await once(server, "listening");
    const { port } = server.address();

    ctx = {
      mongoose,
      server,
      base: `http://127.0.0.1:${port}`,
      generateToken,
      models: { UserModel, OrderModel, ProductModel },
    };
  } catch (err) {
    mongoAvailable = false;
    console.warn(`[dashboard-http] MongoDB no disponible, se omite la suite: ${err.name}`);
  }
});

test.beforeEach(async () => {
  if (!mongoAvailable) return;
  await Promise.all([
    ctx.models.OrderModel.deleteMany({}),
    ctx.models.ProductModel.deleteMany({}),
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

// --- helpers --------------------------------------------------------------

const getDashboard = ({ query = "", token } = {}) =>
  fetch(`${ctx.base}/api/dashboard${query}`, {
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
const seedOrder = async (over = {}) => {
  orderSeq += 1;
  const productId = over.productId ?? new ctx.mongoose.Types.ObjectId();
  const quantity = over.quantity ?? 2;
  const unitPrice = over.unitPrice ?? 50000;
  const status = over.status ?? "delivered";
  const grandTotal = unitPrice * quantity;

  const doc = await ctx.models.OrderModel.create({
    idempotencyKey: randomUUID(),
    source: "web",
    finalized: over.finalized ?? true,
    orderNumber: `DUSCK-2026-${String(orderSeq).padStart(6, "0")}`,
    userId: null,
    requestedItems: [{ productId, quantity }],
    customer: {
      recipientName: "Ana Gómez",
      phone: "3001234567",
      email: `cliente${orderSeq}@dusck.co`,
    },
    shippingAddress: {
      department: "Antioquia",
      city: "Medellín",
      neighborhood: "Laureles",
      address: "Calle 12 # 34-56",
    },
    items: [
      {
        productId,
        productName: over.productName ?? "Camiseta Essential",
        slug: over.slug ?? "camiseta-essential",
        image: null,
        unitPrice,
        quantity,
        subtotal: grandTotal,
      },
    ],
    totals: { itemsSubtotal: grandTotal, shipping: 0, grandTotal, currency: "COP" },
    payment: { method: "cash_on_delivery", status: over.paymentStatus ?? "pending" },
    status,
    statusHistory: [{ status, changedAt: new Date(), changedBy: null }],
  });

  if (over.createdAt) {
    await ctx.models.OrderModel.collection.updateOne(
      { _id: doc._id },
      { $set: { createdAt: over.createdAt } },
    );
    doc.createdAt = over.createdAt;
  }
  return doc;
};

let productSeq = 0;
const seedProduct = async (over = {}) => {
  productSeq += 1;
  return ctx.models.ProductModel.create({
    name: over.name ?? `Producto ${productSeq}`,
    slug: over.slug ?? `producto-${productSeq}-${randomUUID().slice(0, 6)}`,
    price: over.price ?? 50000,
    stock: over.stock ?? 20,
    status: over.status ?? "PUBLISHED",
    isActive: over.isActive ?? true,
    createdBy: over.createdBy ?? new ctx.mongoose.Types.ObjectId(),
  });
};

// ========================================================================
// A. AUTH / AUTORIZACIÓN
// ========================================================================

test("auth: sin token -> 401", async (t) => {
  if (guard(t)) return;
  assert.equal((await getDashboard({})).status, 401);
});

test("auth: token válido pero usuario inactivo -> 401", async (t) => {
  if (guard(t)) return;
  const u = await makeUser("administrador", { status: false });
  assert.equal((await getDashboard({ token: tokenFor(u) })).status, 401);
});

test("auth: editor -> 403", async (t) => {
  if (guard(t)) return;
  const res = await getDashboard({ token: tokenFor(await makeUser("editor")) });
  assert.equal(res.status, 403);
});

test("auth: subscriber -> 403", async (t) => {
  if (guard(t)) return;
  const res = await getDashboard({ token: tokenFor(await makeUser("subscriber")) });
  assert.equal(res.status, 403);
});

test("auth: administrador -> 200", async (t) => {
  if (guard(t)) return;
  assert.equal((await getDashboard({ token: await adminToken() })).status, 200);
});

test("auth: shop_manager -> 200", async (t) => {
  if (guard(t)) return;
  const res = await getDashboard({ token: tokenFor(await makeUser("shop_manager")) });
  assert.equal(res.status, 200);
});

// ========================================================================
// B. CONTRATO / ESTADOS VACÍOS
// ========================================================================

test("vacío: 0 pedidos / 0 productos -> 200 con contadores en 0 (no es error)", async (t) => {
  if (guard(t)) return;
  const res = await getDashboard({ token: await adminToken() });
  assert.equal(res.status, 200);
  const { data } = await res.json();

  assert.equal(data.summary.period.ordersCount, 0);
  assert.equal(data.summary.period.salesTotal, 0);
  assert.equal(data.summary.period.averageTicket, 0);
  assert.equal(data.summary.collectedRevenue.period, 0);
  assert.equal(data.summary.currency, "COP");
  assert.equal(data.orders.total, 0);
  // los 8 estados presentes y en 0
  assert.deepEqual(Object.keys(data.orders.byStatus).sort(), [
    "cancelled",
    "confirmed",
    "delivered",
    "failed_delivery",
    "pending_confirmation",
    "ready_to_ship",
    "returned",
    "shipped",
  ]);
  assert.ok(Object.values(data.orders.byStatus).every((n) => n === 0));
  assert.deepEqual(data.topProducts, []);
  assert.deepEqual(data.alerts, []);
  assert.equal(data.inventory.totalProducts, 0);
  assert.equal(data.inventory.lowStockThreshold, 5);
  // serie temporal: un bucket por día del rango por defecto, todos en 0
  assert.ok(Array.isArray(data.salesSeries));
  assert.ok(data.salesSeries.length >= 28);
  assert.ok(data.salesSeries.every((b) => b.ordersCount === 0 && b.salesTotal === 0));
  assert.equal(data.range.timezone, "America/Bogota");
  assert.equal(data.range.granularity, "day");
});

test("agregados: ventas del período excluyen canceladas; collectedRevenue = solo pagadas", async (t) => {
  if (guard(t)) return;
  const now = new Date();
  await seedOrder({ status: "delivered", paymentStatus: "paid", unitPrice: 100000, quantity: 1, createdAt: now });
  await seedOrder({ status: "confirmed", paymentStatus: "pending", unitPrice: 30000, quantity: 1, createdAt: now });
  await seedOrder({ status: "cancelled", paymentStatus: "pending", unitPrice: 999999, quantity: 1, createdAt: now });

  const res = await getDashboard({ token: await adminToken() });
  const { data } = await res.json();

  assert.equal(data.orders.total, 3); // total incluye la cancelada
  assert.equal(data.orders.byStatus.cancelled, 1);
  assert.equal(data.summary.period.ordersCount, 2); // ventas: NO canceladas
  assert.equal(data.summary.period.salesTotal, 130000);
  assert.equal(data.summary.period.averageTicket, 65000);
  assert.equal(data.summary.collectedRevenue.period, 100000); // solo la pagada
});

test("agregados: topProducts ordena por unidades vendidas (snapshot de items)", async (t) => {
  if (guard(t)) return;
  const now = new Date();
  const buzoId = new ctx.mongoose.Types.ObjectId();
  await seedOrder({ productId: buzoId, productName: "Buzo N", slug: "buzo-n", quantity: 5, createdAt: now });
  await seedOrder({ productId: buzoId, productName: "Buzo N", slug: "buzo-n", quantity: 3, createdAt: now });
  await seedOrder({ productName: "Gorra", slug: "gorra", quantity: 1, createdAt: now });

  const res = await getDashboard({ token: await adminToken() });
  const { data } = await res.json();

  assert.ok(data.topProducts.length >= 2);
  assert.equal(data.topProducts[0].productName, "Buzo N");
  assert.equal(data.topProducts[0].unitsSold, 8);
});

test("inventario: cuenta total / publicados / stock bajo / agotados (excluye ARCHIVED)", async (t) => {
  if (guard(t)) return;
  await seedProduct({ stock: 20, status: "PUBLISHED" });
  await seedProduct({ stock: 3, status: "PUBLISHED" }); // low
  await seedProduct({ stock: 0, status: "PUBLISHED", isActive: true }); // out + alerta
  await seedProduct({ stock: 50, status: "DRAFT" });
  await seedProduct({ stock: 0, status: "ARCHIVED" }); // no cuenta

  const res = await getDashboard({ token: await adminToken() });
  const { data } = await res.json();

  assert.equal(data.inventory.totalProducts, 4);
  assert.equal(data.inventory.publishedProducts, 3);
  assert.equal(data.inventory.lowStock, 1);
  assert.equal(data.inventory.outOfStock, 1);

  const outAlert = data.alerts.find((a) => a.code === "published_out_of_stock");
  assert.ok(outAlert);
  assert.equal(outAlert.severity, "danger");
  assert.equal(outAlert.count, 1);
});

// ========================================================================
// C. VALIDACIÓN DE QUERY
// ========================================================================

test("query: 'from' con formato inválido -> 400", async (t) => {
  if (guard(t)) return;
  const res = await getDashboard({ query: "?from=ayer", token: await adminToken() });
  assert.equal(res.status, 400);
});

test("query: 'from' posterior a 'to' -> 400", async (t) => {
  if (guard(t)) return;
  const res = await getDashboard({
    query: "?from=2026-05-01&to=2026-04-01",
    token: await adminToken(),
  });
  assert.equal(res.status, 400);
});

test("query: 'granularity' inválida -> 400", async (t) => {
  if (guard(t)) return;
  const res = await getDashboard({ query: "?granularity=week", token: await adminToken() });
  assert.equal(res.status, 400);
});

test("query: granularity=month agrupa por mes", async (t) => {
  if (guard(t)) return;
  const res = await getDashboard({
    query: "?from=2026-01-01&to=2026-06-30&granularity=month",
    token: await adminToken(),
  });
  const { data } = await res.json();
  assert.equal(data.range.granularity, "month");
  assert.deepEqual(
    data.salesSeries.map((b) => b.bucket),
    ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"],
  );
});

// UI-5.4 — el selector de fecha específica del frontend envía from == to +
// granularity=day. El backend YA lo soporta sin cambios: un único bucket de ese
// día calendario (America/Bogota), métricas acotadas a ese día.
test("query: from == to (día específico) -> un solo bucket, métricas de ese día", async (t) => {
  if (guard(t)) return;
  const day = "2026-08-15";
  const inDay = new Date(`${day}T10:00:00.000-05:00`); // 10:00 en Bogotá
  const outDay = new Date(`2026-08-16T02:00:00.000-05:00`); // día siguiente

  await seedOrder({ status: "delivered", unitPrice: 40000, quantity: 2, createdAt: inDay });
  await seedOrder({ status: "confirmed", unitPrice: 10000, quantity: 1, createdAt: inDay });
  await seedOrder({ status: "delivered", unitPrice: 99999, quantity: 1, createdAt: outDay });

  const res = await getDashboard({
    query: `?from=${day}&to=${day}&granularity=day`,
    token: await adminToken(),
  });
  assert.equal(res.status, 200);
  const { data } = await res.json();

  assert.equal(data.range.granularity, "day");
  assert.deepEqual(
    data.salesSeries.map((b) => b.bucket),
    [day],
  );
  assert.equal(data.salesSeries[0].salesTotal, 90000); // 80000 + 10000 (no la del día 16)
  assert.equal(data.summary.period.ordersCount, 2);
  assert.equal(data.summary.period.salesTotal, 90000);
  assert.equal(data.orders.total, 2);
});
