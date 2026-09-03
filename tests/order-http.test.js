// FASE 4.3-C.1 — Tests HTTP de POST /api/orders.
//
// Base de datos APARTE: `db-dusck-order-http-test`, que se elimina al empezar y
// al terminar (misma estrategia que `integration-s4.test.js`). Si no hay MongoDB
// disponible, la suite entera se marca `skip`.
//
// Alcance: SOLO el wiring HTTP (route + authenticateOptionalStrict + controller
// + proyeccion publica + cart cleanup + error mapping). La logica de negocio
// (`order.service.js`) ya tiene su propia suite y NO se re-testea aqui.
//
// Ejecutar:  node --test tests/order-http.test.js   (o)   npm test

import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";

import jwt from "jsonwebtoken";

const TEST_DB_URI = "mongodb://127.0.0.1:27017/db-dusck-order-http-test";

// `env.config.js` exige MONGO_URI; se fija ANTES de importar codigo del backend
// (por eso todas las importaciones de la app son dinamicas, dentro del before()).
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
    const CartModel = (await import("../src/models/cart.model.js")).default;

    await Promise.all([
      UserModel.init(),
      ProductModel.init(),
      OrderModel.init(),
      CartModel.init(),
    ]);

    const server = app.listen(0);
    await once(server, "listening");
    const { port } = server.address();

    ctx = {
      mongoose,
      server,
      base: `http://127.0.0.1:${port}`,
      generateToken,
      jwtSecret: env.jwtSecret,
      models: { UserModel, ProductModel, OrderModel, CounterModel, CartModel },
    };
  } catch (err) {
    mongoAvailable = false;
    console.warn(`[order-http] MongoDB no disponible, se omite la suite: ${err.name}`);
  }
});

test.beforeEach(async () => {
  if (!mongoAvailable) return;
  const { UserModel, ProductModel, OrderModel, CounterModel, CartModel } = ctx.models;
  await Promise.all([
    UserModel.deleteMany({}),
    ProductModel.deleteMany({}),
    OrderModel.deleteMany({}),
    CounterModel.deleteMany({}),
    CartModel.deleteMany({}),
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

const api = (path, { method = "POST", body, token, idempotencyKey, rawBody } = {}) =>
  fetch(`${ctx.base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { "x-token": token } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body:
      rawBody !== undefined
        ? rawBody
        : body === undefined
          ? undefined
          : JSON.stringify(body),
  });

const postOrder = (opts = {}) => api("/api/orders", { method: "POST", ...opts });

const makeProduct = (over = {}) => {
  const { ProductModel } = ctx.models;
  const hasVariants = Array.isArray(over.variants) && over.variants.length > 0;
  return ProductModel.create({
    name: over.name ?? "Camiseta Essential",
    slug: over.slug ?? `camiseta-${randomUUID().slice(0, 8)}`,
    description: over.description ?? "Algodón peinado",
    price: over.price ?? 50000,
    images: over.images ?? [
      { url: "http://dusck.test/sec.png", isMain: false },
      { url: "http://dusck.test/main.png", isMain: true },
    ],
    variants: over.variants ?? [],
    stock: hasVariants ? undefined : (over.stock ?? 20),
    status: over.status ?? "PUBLISHED",
    isActive: over.isActive ?? true,
    createdBy: over.createdBy ?? new ctx.mongoose.Types.ObjectId(),
  });
};

let userSeq = 0;
const makeUser = (over = {}) => {
  const { UserModel } = ctx.models;
  userSeq += 1;
  return UserModel.create({
    name: over.name ?? `Cliente ${userSeq}`,
    nickname: over.nickname ?? `cliente-${userSeq}-${randomUUID().slice(0, 4)}`,
    email: over.email ?? `cliente-${userSeq}-${randomUUID().slice(0, 6)}@dusck.co`,
    password: over.password ?? "hash-no-usado-en-estos-tests",
    role: over.role ?? "subscriber",
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

const CUSTOMER = { recipientName: "Ana Gómez", phone: "3001234567", email: "ana@dusck.co" };
const SHIPPING = {
  department: "Antioquia",
  city: "Medellín",
  neighborhood: "Laureles",
  address: "Calle 12 # 34-56 apto 201",
};

const orderBody = (over = {}) => ({
  items: over.items ?? [{ productId: over.productId, quantity: over.quantity ?? 2 }],
  customer: "customer" in over ? over.customer : CUSTOMER,
  shippingAddress: "shippingAddress" in over ? over.shippingAddress : SHIPPING,
  ...("notes" in over ? { notes: over.notes } : {}),
});

// ========================================================================
// SUCCESS
// ========================================================================

test("success: pedido de INVITADO -> 201, userId null, source no expuesto, Order persistida", async (t) => {
  if (guard(t)) return;
  const { OrderModel } = ctx.models;
  const p = await makeProduct({ price: 50000, stock: 10 });

  const res = await postOrder({
    idempotencyKey: randomUUID(),
    body: orderBody({ productId: p._id.toString(), quantity: 2 }),
  });

  assert.equal(res.status, 201);
  const json = await res.json();
  assert.equal(json.msg, "Pedido creado exitosamente");
  assert.equal(json.data.userId, null);
  assert.match(json.data.orderNumber, /^DUSCK-\d{4}-\d{6}$/);
  assert.equal(json.data.totals.grandTotal, 100000);
  assert.equal(json.data.totals.currency, "COP");
  assert.equal(json.data.payment.method, "cash_on_delivery");
  assert.equal(json.data.payment.status, "pending");
  assert.equal(json.data.status, "pending_confirmation");
  assert.equal("source" in json.data, false);

  const persisted = await OrderModel.findOne({ orderNumber: json.data.orderNumber });
  assert.ok(persisted);
  assert.equal(persisted.finalized, true);
  assert.equal(persisted.userId, null);
});

test("success: pedido AUTENTICADO -> 201 con userId = id del usuario del token", async (t) => {
  if (guard(t)) return;
  const user = await makeUser();
  const p = await makeProduct();

  const res = await postOrder({
    token: tokenFor(user),
    idempotencyKey: randomUUID(),
    body: orderBody({ productId: p._id.toString(), quantity: 1 }),
  });

  assert.equal(res.status, 201);
  const json = await res.json();
  assert.equal(json.data.userId, user._id.toString());

  const persisted = await ctx.models.OrderModel.findOne({ orderNumber: json.data.orderNumber });
  assert.equal(persisted.userId.toString(), user._id.toString());
});

// ========================================================================
// AUTH — authenticateOptionalStrict
// ========================================================================

test("auth: sin x-token -> se procesa como invitado (201)", async (t) => {
  if (guard(t)) return;
  const p = await makeProduct();
  const res = await postOrder({
    idempotencyKey: randomUUID(),
    body: orderBody({ productId: p._id.toString() }),
  });
  assert.equal(res.status, 201);
  assert.equal((await res.json()).data.userId, null);
});

test("auth: x-token valido -> autenticado", async (t) => {
  if (guard(t)) return;
  const user = await makeUser();
  const p = await makeProduct();
  const res = await postOrder({
    token: tokenFor(user),
    idempotencyKey: randomUUID(),
    body: orderBody({ productId: p._id.toString() }),
  });
  assert.equal(res.status, 201);
  assert.equal((await res.json()).data.userId, user._id.toString());
});

test("auth: x-token invalido (firma incorrecta) -> 401, no crea Order", async (t) => {
  if (guard(t)) return;
  const p = await makeProduct();
  const badToken = jwt.sign({ _id: "x", email: "x@x.co" }, `wrong-${ctx.jwtSecret}`);
  const res = await postOrder({
    token: badToken,
    idempotencyKey: randomUUID(),
    body: orderBody({ productId: p._id.toString() }),
  });
  assert.equal(res.status, 401);
  assert.equal(await ctx.models.OrderModel.countDocuments(), 0);
});

test("auth: x-token expirado -> 401", async (t) => {
  if (guard(t)) return;
  const user = await makeUser();
  const p = await makeProduct();
  const expired = jwt.sign(
    { _id: user._id.toString(), email: user.email },
    ctx.jwtSecret,
    { expiresIn: -3600 },
  );
  const res = await postOrder({
    token: expired,
    idempotencyKey: randomUUID(),
    body: orderBody({ productId: p._id.toString() }),
  });
  assert.equal(res.status, 401);
});

test("auth: x-token malformado -> 401", async (t) => {
  if (guard(t)) return;
  const p = await makeProduct();
  for (const bad of ["not-a-jwt", "aaa.bbb.ccc", "a.b"]) {
    const res = await postOrder({
      token: bad,
      idempotencyKey: randomUUID(),
      body: orderBody({ productId: p._id.toString() }),
    });
    assert.equal(res.status, 401, `token "${bad}" deberia dar 401`);
  }
});

test("auth: token valido pero usuario BORRADO -> 401 (no se degrada a invitado)", async (t) => {
  if (guard(t)) return;
  const user = await makeUser();
  const token = tokenFor(user);
  const p = await makeProduct();
  await ctx.models.UserModel.deleteOne({ _id: user._id });

  const res = await postOrder({
    token,
    idempotencyKey: randomUUID(),
    body: orderBody({ productId: p._id.toString() }),
  });
  assert.equal(res.status, 401);
  assert.equal(await ctx.models.OrderModel.countDocuments(), 0);
});

test("auth: token valido pero usuario INACTIVO -> 401", async (t) => {
  if (guard(t)) return;
  const user = await makeUser({ status: false });
  const p = await makeProduct();
  const res = await postOrder({
    token: tokenFor(user),
    idempotencyKey: randomUUID(),
    body: orderBody({ productId: p._id.toString() }),
  });
  assert.equal(res.status, 401);
});

// ========================================================================
// IDEMPOTENCY-KEY (header)
// ========================================================================

test("idempotency-key: ausente -> 400", async (t) => {
  if (guard(t)) return;
  const p = await makeProduct();
  const res = await postOrder({ body: orderBody({ productId: p._id.toString() }) });
  assert.equal(res.status, 400);
});

test("idempotency-key: no es UUID -> 400", async (t) => {
  if (guard(t)) return;
  const p = await makeProduct();
  const res = await postOrder({
    idempotencyKey: "1234-abcd-no-uuid",
    body: orderBody({ productId: p._id.toString() }),
  });
  assert.equal(res.status, 400);
});

test("idempotency-key: UUID valido -> 201", async (t) => {
  if (guard(t)) return;
  const p = await makeProduct();
  const res = await postOrder({
    idempotencyKey: randomUUID(),
    body: orderBody({ productId: p._id.toString() }),
  });
  assert.equal(res.status, 201);
});

test("idempotency-key: misma key dos veces -> misma Order, sin doble decremento de stock", async (t) => {
  if (guard(t)) return;
  const { OrderModel, ProductModel } = ctx.models;
  const p = await makeProduct({ stock: 10 });
  const key = randomUUID();
  const body = orderBody({ productId: p._id.toString(), quantity: 3 });

  const r1 = await postOrder({ idempotencyKey: key, body });
  const r2 = await postOrder({ idempotencyKey: key, body });

  assert.equal(r1.status, 201);
  assert.equal(r2.status, 201);
  const j1 = await r1.json();
  const j2 = await r2.json();
  assert.equal(j1.data.orderNumber, j2.data.orderNumber);
  assert.equal(j1.data.id, j2.data.id);

  assert.equal(await OrderModel.countDocuments(), 1);
  const after = await ProductModel.findById(p._id);
  assert.equal(after.stock, 7, "el stock solo debe bajar una vez (10 - 3)");
});

test("idempotency-key: dos requests CONCURRENTES con la misma key -> nunca duplican Order ni stock", async (t) => {
  if (guard(t)) return;
  const { OrderModel, ProductModel } = ctx.models;
  const p = await makeProduct({ stock: 10 });
  const key = randomUUID();
  const body = orderBody({ productId: p._id.toString(), quantity: 2 });

  const [r1, r2] = await Promise.all([
    postOrder({ idempotencyKey: key, body }),
    postOrder({ idempotencyKey: key, body }),
  ]);

  for (const r of [r1, r2]) {
    assert.ok([201, 409].includes(r.status), `status inesperado ${r.status}`);
  }
  assert.equal(await OrderModel.countDocuments(), 1);
  const after = await ProductModel.findById(p._id);
  assert.equal(after.stock, 8, "el stock solo debe bajar una vez (10 - 2)");
});

// ========================================================================
// INPUT (validacion estructural via order.service)
// ========================================================================

test("input: items ausente -> 400", async (t) => {
  if (guard(t)) return;
  const res = await postOrder({
    idempotencyKey: randomUUID(),
    body: { customer: CUSTOMER, shippingAddress: SHIPPING },
  });
  assert.equal(res.status, 400);
});

test("input: items vacio -> 400", async (t) => {
  if (guard(t)) return;
  const res = await postOrder({
    idempotencyKey: randomUUID(),
    body: orderBody({ items: [] }),
  });
  assert.equal(res.status, 400);
});

test("input: quantity invalida (decimal / string / cero) -> 400 o 422", async (t) => {
  if (guard(t)) return;
  const p = await makeProduct();
  for (const quantity of [1.5, "2", 0, -1]) {
    const res = await postOrder({
      idempotencyKey: randomUUID(),
      body: orderBody({ productId: p._id.toString(), quantity }),
    });
    assert.ok([400, 422].includes(res.status), `quantity ${quantity} -> ${res.status}`);
  }
});

test("input: customer ausente -> 400", async (t) => {
  if (guard(t)) return;
  const p = await makeProduct();
  const res = await postOrder({
    idempotencyKey: randomUUID(),
    body: orderBody({ productId: p._id.toString(), customer: undefined }),
  });
  assert.equal(res.status, 400);
});

test("input: shippingAddress con campos faltantes -> 400", async (t) => {
  if (guard(t)) return;
  const p = await makeProduct();
  const res = await postOrder({
    idempotencyKey: randomUUID(),
    body: orderBody({
      productId: p._id.toString(),
      shippingAddress: { department: "Antioquia", city: "Medellín" },
    }),
  });
  assert.equal(res.status, 400);
});

test("input: productos duplicados -> se fusionan (una linea, cantidad sumada)", async (t) => {
  if (guard(t)) return;
  const p = await makeProduct({ price: 10000, stock: 10 });
  const res = await postOrder({
    idempotencyKey: randomUUID(),
    body: orderBody({
      items: [
        { productId: p._id.toString(), quantity: 2 },
        { productId: p._id.toString(), quantity: 3 },
      ],
    }),
  });
  assert.equal(res.status, 201);
  const json = await res.json();
  assert.equal(json.data.items.length, 1);
  assert.equal(json.data.items[0].quantity, 5);
  assert.equal(json.data.totals.grandTotal, 50000);
  const after = await ctx.models.ProductModel.findById(p._id);
  assert.equal(after.stock, 5);
});

test("input: > 50 tras fusionar duplicados -> 422", async (t) => {
  if (guard(t)) return;
  const p = await makeProduct({ stock: 200 });
  const res = await postOrder({
    idempotencyKey: randomUUID(),
    body: orderBody({
      items: [
        { productId: p._id.toString(), quantity: 40 },
        { productId: p._id.toString(), quantity: 11 },
      ],
    }),
  });
  assert.equal(res.status, 422);
});

// ========================================================================
// BUSINESS ERRORS
// ========================================================================

test("business: producto inexistente -> 404", async (t) => {
  if (guard(t)) return;
  const res = await postOrder({
    idempotencyKey: randomUUID(),
    body: orderBody({ productId: new ctx.mongoose.Types.ObjectId().toString() }),
  });
  assert.equal(res.status, 404);
});

test("business: producto inactivo -> 404", async (t) => {
  if (guard(t)) return;
  const p = await makeProduct({ status: "PUBLISHED", isActive: false });
  const res = await postOrder({
    idempotencyKey: randomUUID(),
    body: orderBody({ productId: p._id.toString() }),
  });
  assert.equal(res.status, 404);
});

test("business: producto no publicado (DRAFT) -> 404", async (t) => {
  if (guard(t)) return;
  const p = await makeProduct({ status: "DRAFT", isActive: false });
  const res = await postOrder({
    idempotencyKey: randomUUID(),
    body: orderBody({ productId: p._id.toString() }),
  });
  assert.equal(res.status, 404);
});

test("business: producto con variantes -> 422", async (t) => {
  if (guard(t)) return;
  const p = await makeProduct({
    variants: [{ sku: `SKU-${randomUUID().slice(0, 6)}`, color: "Rojo", size: "M", stock: 5 }],
  });
  const res = await postOrder({
    idempotencyKey: randomUUID(),
    body: orderBody({ productId: p._id.toString(), quantity: 1 }),
  });
  assert.equal(res.status, 422);
});

test("business: stock insuficiente -> 409", async (t) => {
  if (guard(t)) return;
  const p = await makeProduct({ stock: 1 });
  const res = await postOrder({
    idempotencyKey: randomUUID(),
    body: orderBody({ productId: p._id.toString(), quantity: 5 }),
  });
  assert.equal(res.status, 409);
});

// ========================================================================
// MALFORMED JSON
// ========================================================================

test("malformed JSON -> 400 con contrato { msg }", async (t) => {
  if (guard(t)) return;
  const res = await postOrder({ idempotencyKey: randomUUID(), rawBody: '{"items": [' });
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.equal(json.msg, "El cuerpo de la petición no es un JSON válido");
});

// ========================================================================
// SERVER-OWNED FIELDS — el backend los ignora
// ========================================================================

test("server-owned: campos autoritativos del body son ignorados", async (t) => {
  if (guard(t)) return;
  const user = await makeUser();
  const p = await makeProduct({ price: 50000, stock: 10 });

  const res = await postOrder({
    token: tokenFor(user),
    idempotencyKey: randomUUID(),
    body: {
      items: [
        {
          productId: p._id.toString(),
          quantity: 2,
          unitPrice: 1,
          subtotal: 1,
          price: 1,
        },
      ],
      customer: CUSTOMER,
      shippingAddress: SHIPPING,
      userId: new ctx.mongoose.Types.ObjectId().toString(),
      price: 1,
      unitPrice: 1,
      subtotal: 1,
      itemsSubtotal: 1,
      grandTotal: 1,
      totals: { grandTotal: 1, currency: "USD" },
      stock: 9999,
      status: "delivered",
      payment: { method: "credit_card", status: "paid" },
      finalized: true,
      source: "admin",
      orderNumber: "DUSCK-2000-000001",
      currency: "USD",
    },
  });

  assert.equal(res.status, 201);
  const json = await res.json();
  // userId viene del token, no del body
  assert.equal(json.data.userId, user._id.toString());
  // precios/totales calculados por el backend desde Product
  assert.equal(json.data.items[0].unitPrice, 50000);
  assert.equal(json.data.items[0].subtotal, 100000);
  assert.equal(json.data.totals.grandTotal, 100000);
  assert.equal(json.data.totals.currency, "COP");
  // status / payment / orderNumber los fija el servicio
  assert.equal(json.data.status, "pending_confirmation");
  assert.equal(json.data.payment.method, "cash_on_delivery");
  assert.equal(json.data.payment.status, "pending");
  assert.notEqual(json.data.orderNumber, "DUSCK-2000-000001");
  assert.match(json.data.orderNumber, /^DUSCK-\d{4}-\d{6}$/);
  // stock real del producto: 10 - 2
  const after = await ctx.models.ProductModel.findById(p._id);
  assert.equal(after.stock, 8);
});

// ========================================================================
// RESPONSE SECURITY — la respuesta no filtra maquinaria interna
// ========================================================================

test("response security: data NO contiene campos internos", async (t) => {
  if (guard(t)) return;
  const p = await makeProduct();
  const res = await postOrder({
    idempotencyKey: randomUUID(),
    body: orderBody({ productId: p._id.toString() }),
  });
  assert.equal(res.status, 201);
  const { data } = await res.json();

  for (const forbidden of [
    "idempotencyKey",
    "requestedItems",
    "stockAdjustments",
    "stockOps",
    "stockOpsPruned",
    "finalized",
    "source",
    "statusHistory",
    "export",
    "updatedAt",
    "__v",
  ]) {
    assert.equal(forbidden in data, false, `data no debe exponer "${forbidden}"`);
  }
});

// ========================================================================
// CART CLEANUP
// ========================================================================

test("cart: pedido AUTENTICADO exitoso -> el carrito del usuario se elimina", async (t) => {
  if (guard(t)) return;
  const { CartModel } = ctx.models;
  const user = await makeUser();
  const p = await makeProduct();
  await CartModel.create({ userId: user._id, items: [{ productId: p._id, quantity: 1 }] });

  const res = await postOrder({
    token: tokenFor(user),
    idempotencyKey: randomUUID(),
    body: orderBody({ productId: p._id.toString() }),
  });
  assert.equal(res.status, 201);
  assert.equal(await CartModel.findOne({ userId: user._id }), null);
});

test("cart: pedido de INVITADO -> no toca ningun carrito", async (t) => {
  if (guard(t)) return;
  const { CartModel } = ctx.models;
  const other = await makeUser();
  const p = await makeProduct();
  await CartModel.create({ userId: other._id, items: [{ productId: p._id, quantity: 1 }] });

  const res = await postOrder({
    idempotencyKey: randomUUID(),
    body: orderBody({ productId: p._id.toString() }),
  });
  assert.equal(res.status, 201);
  assert.ok(await CartModel.findOne({ userId: other._id }), "el carrito ajeno debe seguir intacto");
});

test("cart: pedido fallido (stock) -> el carrito NO se elimina", async (t) => {
  if (guard(t)) return;
  const { CartModel } = ctx.models;
  const user = await makeUser();
  const p = await makeProduct({ stock: 1 });
  await CartModel.create({ userId: user._id, items: [{ productId: p._id, quantity: 1 }] });

  const res = await postOrder({
    token: tokenFor(user),
    idempotencyKey: randomUUID(),
    body: orderBody({ productId: p._id.toString(), quantity: 5 }),
  });
  assert.equal(res.status, 409);
  assert.ok(await CartModel.findOne({ userId: user._id }), "el carrito debe seguir existiendo");
});

test("cart: si el borrado del carrito falla, la Order igual responde 201", async (t) => {
  if (guard(t)) return;
  const { CartModel } = ctx.models;
  const user = await makeUser();
  const p = await makeProduct();
  await CartModel.create({ userId: user._id, items: [{ productId: p._id, quantity: 1 }] });

  const original = CartModel.findOneAndDelete;
  CartModel.findOneAndDelete = () => {
    throw new Error("simulated cart failure");
  };
  t.after(() => {
    CartModel.findOneAndDelete = original;
  });

  const res = await postOrder({
    token: tokenFor(user),
    idempotencyKey: randomUUID(),
    body: orderBody({ productId: p._id.toString() }),
  });
  assert.equal(res.status, 201);
});
