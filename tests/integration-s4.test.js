// FASE 2 / S4 — Tests de integracion contra una base de datos REAL de prueba.
//
// Requiere un MongoDB accesible en localhost (el mismo que usa el proyecto en
// desarrollo). Usa una base de datos APARTE: `db-dusck-s4-test`, que se elimina
// al empezar y al terminar. NO toca `db-dusck`.
//
// Si no hay MongoDB disponible, la suite entera se marca como `skip` en lugar
// de fallar (para no romper la regresion en entornos sin Mongo).
//
// Ejecutar:  npm test        (o)   node --test tests/integration-s4.test.js

import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

const TEST_DB_URI = "mongodb://127.0.0.1:27017/db-dusck-s4-test";

// El env.config del proyecto llama a required('MONGO_URI'). Lo fijamos ANTES
// de importar cualquier modulo del backend (por eso todas las importaciones de
// codigo de la app son dinamicas, dentro del before()).
process.env.MONGO_URI = TEST_DB_URI;

let ctx = null; // { app, server, base, mongoose, models, token, ids }
let mongoAvailable = true;

test.before(async () => {
  try {
    const mongoose = (await import("mongoose")).default;
    await mongoose.connect(TEST_DB_URI, { serverSelectionTimeoutMS: 2000 });
    await mongoose.connection.dropDatabase();

    const app = (await import("../src/app.js")).default;
    const { encryptedPassword } = await import("../src/helpers/bycryp.helper.js");
    const { generateToken } = await import("../src/helpers/jwt.helpers.js");
    const UserModel = (await import("../src/models/user.model.js")).default;
    const CategoryModel = (await import("../src/models/category.model.js")).default;
    const ProductModel = (await import("../src/models/product.model.js")).default;

    const admin = await UserModel.create({
      name: "Admin S4",
      nickname: "admin-s4",
      email: "admin-s4@dusck.com",
      password: encryptedPassword("Secret123"),
      role: "administrador",
      status: true,
    });

    // Segundo usuario (subscriber): un $ne en el login podria "seleccionarlo".
    await UserModel.create({
      name: "Sub S4",
      nickname: "sub-s4",
      email: "sub-s4@dusck.com",
      password: encryptedPassword("Secret123"),
      role: "subscriber",
      status: true,
    });

    const category = await CategoryModel.create({
      name: "Ropa S4",
      slug: "ropa-s4",
      description: "categoria de prueba",
    });

    const originalOwner = new mongoose.Types.ObjectId();
    const product = await ProductModel.create({
      name: "Camiseta S4",
      slug: "camiseta-s4",
      description: "producto de prueba",
      price: 100,
      stock: 10,
      category: category._id,
      createdBy: originalOwner,
      images: [{ url: "http://dusck.test/a.png", isMain: true }],
    });

    const token = generateToken({
      _id: admin._id,
      name: admin.name,
      email: admin.email,
      nickname: admin.nickname,
      role: admin.role,
    });

    const server = app.listen(0);
    await once(server, "listening");
    const { port } = server.address();

    ctx = {
      mongoose,
      models: { UserModel, CategoryModel, ProductModel },
      server,
      base: `http://127.0.0.1:${port}`,
      token,
      ids: {
        admin: admin._id.toString(),
        category: category._id.toString(),
        product: product._id.toString(),
        originalOwner: originalOwner.toString(),
      },
    };
  } catch (err) {
    mongoAvailable = false;
    console.warn(
      `[integration-s4] MongoDB no disponible, se omite la suite: ${err.name}`
    );
  }
});

test.after(async () => {
  if (ctx) {
    await ctx.mongoose.connection.dropDatabase();
    await ctx.mongoose.disconnect();
    await new Promise((r) => ctx.server.close(r));
  }
});

const api = (path, { method = "GET", body, token } = {}) =>
  fetch(`${ctx.base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { "x-token": token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const guard = (t) => {
  if (!mongoAvailable) t.skip("MongoDB no disponible");
  return !mongoAvailable;
};

// ---------------------------------------------------------------------------
// F1 — LOGIN
// ---------------------------------------------------------------------------

test("F1 login legitimo -> 200 + token", async (t) => {
  if (guard(t)) return;
  const res = await api("/api/auth/login", {
    method: "POST",
    body: { email: "admin-s4@dusck.com", password: "Secret123" },
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.ok(typeof json.token === "string" && json.token.length > 20);
  assert.equal(json.data.password, undefined);
});

test("F1 login con { email: { $ne: null } } -> rechazado, sin token", async (t) => {
  if (guard(t)) return;
  const res = await api("/api/auth/login", {
    method: "POST",
    body: { email: { $ne: null }, password: "cualquier-cosa" },
  });
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.equal(json.token, undefined);
});

test("F1 login con { email: { $gt: '' } } -> rechazado", async (t) => {
  if (guard(t)) return;
  const res = await api("/api/auth/login", {
    method: "POST",
    body: { email: { $gt: "" }, password: "x" },
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).token, undefined);
});

test("F1 login con { email: { $regex: '.*' } } -> rechazado", async (t) => {
  if (guard(t)) return;
  const res = await api("/api/auth/login", {
    method: "POST",
    body: { email: { $regex: ".*", $options: "i" }, password: "x" },
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).token, undefined);
});

test("F1 login con operador anidado -> rechazado", async (t) => {
  if (guard(t)) return;
  const res = await api("/api/auth/login", {
    method: "POST",
    body: { email: { x: { $where: "true" } }, password: "x" },
  });
  assert.equal(res.status, 400);
});

test("F1 bypass: { email: { $ne: null }, password: 'incorrecta' } NO autentica", async (t) => {
  if (guard(t)) return;
  const res = await api("/api/auth/login", {
    method: "POST",
    body: { email: { $ne: null }, password: "incorrecta" },
  });
  assert.notEqual(res.status, 200);
  assert.equal((await res.json()).token, undefined);
});

// ---------------------------------------------------------------------------
// F2 — CATEGORY / PRODUCT UPDATE
// ---------------------------------------------------------------------------

test("F2 category PATCH { $unset: { name: 1 } } -> 400 y documento intacto", async (t) => {
  if (guard(t)) return;
  const { CategoryModel } = ctx.models;
  const before = await CategoryModel.findById(ctx.ids.category).lean();

  const res = await api(`/api/category/${ctx.ids.category}`, {
    method: "PATCH",
    token: ctx.token,
    body: { $unset: { name: 1 } },
  });
  assert.equal(res.status, 400);

  const after = await CategoryModel.findById(ctx.ids.category).lean();
  assert.equal(after.name, before.name);
});

test("F2 category PATCH { $rename: { name: 'hacked' } } -> 400 y documento intacto", async (t) => {
  if (guard(t)) return;
  const { CategoryModel } = ctx.models;
  const before = await CategoryModel.findById(ctx.ids.category).lean();

  const res = await api(`/api/category/${ctx.ids.category}`, {
    method: "PATCH",
    token: ctx.token,
    body: { $rename: { name: "hacked" } },
  });
  assert.equal(res.status, 400);

  const after = await CategoryModel.findById(ctx.ids.category).lean();
  assert.equal(after.name, before.name);
  assert.equal(after.hacked, undefined);
});

test("F2 product PATCH { $inc: { stock: 500 } } -> 400 y stock intacto", async (t) => {
  if (guard(t)) return;
  const { ProductModel } = ctx.models;
  const before = await ProductModel.findById(ctx.ids.product).lean();

  const res = await api(`/api/product/${ctx.ids.product}`, {
    method: "PATCH",
    token: ctx.token,
    body: { $inc: { stock: 500 } },
  });
  assert.equal(res.status, 400);

  const after = await ProductModel.findById(ctx.ids.product).lean();
  assert.equal(after.stock, before.stock);
});

test("F2 product PATCH { $unset: { price: 1 } } -> 400 y price intacto", async (t) => {
  if (guard(t)) return;
  const { ProductModel } = ctx.models;
  const before = await ProductModel.findById(ctx.ids.product).lean();

  const res = await api(`/api/product/${ctx.ids.product}`, {
    method: "PATCH",
    token: ctx.token,
    body: { $unset: { price: 1 } },
  });
  assert.equal(res.status, 400);

  const after = await ProductModel.findById(ctx.ids.product).lean();
  assert.equal(after.price, before.price);
});

test("F2 product PATCH mass-assignment: createdBy NO cambia; campos validos si", async (t) => {
  if (guard(t)) return;
  const { ProductModel } = ctx.models;

  const res = await api(`/api/product/${ctx.ids.product}`, {
    method: "PATCH",
    token: ctx.token,
    body: {
      name: "Camiseta S4 v2",
      isActive: false,
      createdBy: ctx.ids.admin, // intento de robo de propiedad
      _id: "507f1f77bcf86cd799439099", // intento de cambiar el _id
    },
  });
  assert.equal(res.status, 200);

  const after = await ProductModel.findById(ctx.ids.product).lean();
  assert.equal(after.name, "Camiseta S4 v2");
  assert.equal(after.isActive, false);
  assert.equal(after.createdBy.toString(), ctx.ids.originalOwner);
  assert.equal(after._id.toString(), ctx.ids.product);
});

test("F2 category PATCH legitimo -> 200 y documento actualizado", async (t) => {
  if (guard(t)) return;
  const { CategoryModel } = ctx.models;

  const res = await api(`/api/category/${ctx.ids.category}`, {
    method: "PATCH",
    token: ctx.token,
    body: { description: "descripcion nueva legitima" },
  });
  assert.equal(res.status, 200);

  const after = await CategoryModel.findById(ctx.ids.category).lean();
  assert.equal(after.description, "descripcion nueva legitima");
});

test("F2 PATCH con ObjectId invalido -> 400", async (t) => {
  if (guard(t)) return;
  const rp = await api("/api/product/no-es-id", {
    method: "PATCH",
    token: ctx.token,
    body: { name: "x" },
  });
  assert.equal(rp.status, 400);

  const rc = await api("/api/category/no-es-id", {
    method: "PATCH",
    token: ctx.token,
    body: { name: "x" },
  });
  assert.equal(rc.status, 400);
});

// ---------------------------------------------------------------------------
// F3 — CART
// ---------------------------------------------------------------------------

test("F3 cart PATCH productId como objeto -> 400", async (t) => {
  if (guard(t)) return;
  const res = await api("/api/cart", {
    method: "PATCH",
    token: ctx.token,
    body: { productId: { $ne: null }, quantity: 1 },
  });
  assert.equal(res.status, 400);
});

test("F3 cart PATCH quantity como objeto -> 400", async (t) => {
  if (guard(t)) return;
  const res = await api("/api/cart", {
    method: "PATCH",
    token: ctx.token,
    body: { productId: ctx.ids.product, quantity: { $gt: 0 } },
  });
  assert.equal(res.status, 400);
});

test("F3 cart PATCH quantity decimal -> 400", async (t) => {
  if (guard(t)) return;
  const res = await api("/api/cart", {
    method: "PATCH",
    token: ctx.token,
    body: { productId: ctx.ids.product, quantity: 1.5 },
  });
  assert.equal(res.status, 400);
});

test("F3 cart PATCH quantity fuera de rango -> 400", async (t) => {
  if (guard(t)) return;
  const res = await api("/api/cart", {
    method: "PATCH",
    token: ctx.token,
    body: { productId: ctx.ids.product, quantity: 9999 },
  });
  assert.equal(res.status, 400);
});

test("F3 cart PATCH legitimo (add 2, luego -1) -> 200 y estado coherente", async (t) => {
  if (guard(t)) return;
  const add = await api("/api/cart", {
    method: "PATCH",
    token: ctx.token,
    body: { productId: ctx.ids.product, quantity: 2 },
  });
  assert.equal(add.status, 200);
  const addJson = await add.json();
  const item = addJson.data.items.find(
    (i) => (i.productId._id || i.productId).toString() === ctx.ids.product
  );
  assert.equal(item.quantity, 2);

  const dec = await api("/api/cart", {
    method: "PATCH",
    token: ctx.token,
    body: { productId: ctx.ids.product, quantity: -1 },
  });
  assert.equal(dec.status, 200);
  const decJson = await dec.json();
  const item2 = decJson.data.items.find(
    (i) => (i.productId._id || i.productId).toString() === ctx.ids.product
  );
  assert.equal(item2.quantity, 1);
});

test("F3 cart admin GET con ObjectId invalido -> 400 (no 500)", async (t) => {
  if (guard(t)) return;
  const res = await api("/api/cart/admin/no-es-id", { token: ctx.token });
  assert.equal(res.status, 400);
});

// ---------------------------------------------------------------------------
// F4 / FASE 1 — USER (no debe romperse ni debilitarse)
// ---------------------------------------------------------------------------

test("F4 user PATCH perfil con { name: { $ne: null } } -> 400", async (t) => {
  if (guard(t)) return;
  const res = await api(`/api/users/${ctx.ids.admin}`, {
    method: "PATCH",
    token: ctx.token,
    body: { name: { $ne: null } },
  });
  assert.equal(res.status, 400);
});

test("FASE 1 sigue viva: PATCH /users/:id NO permite escalar role", async (t) => {
  if (guard(t)) return;
  const { UserModel } = ctx.models;

  const res = await api(`/api/users/${ctx.ids.admin}`, {
    method: "PATCH",
    token: ctx.token,
    body: { name: "Admin S4 renombrado", role: "subscriber" },
  });
  assert.equal(res.status, 200);

  const after = await UserModel.findById(ctx.ids.admin).lean();
  assert.equal(after.name, "Admin S4 renombrado");
  assert.equal(after.role, "administrador"); // role NO cambio
});

test("FASE 1 sigue viva: endpoint admin de role funciona", async (t) => {
  if (guard(t)) return;
  const { UserModel } = ctx.models;
  const sub = await UserModel.findOne({ nickname: "sub-s4" }).lean();

  const res = await api(`/api/users/${sub._id}/role`, {
    method: "PATCH",
    token: ctx.token,
    body: { role: "editor" },
  });
  assert.equal(res.status, 200);

  const after = await UserModel.findById(sub._id).lean();
  assert.equal(after.role, "editor");
});

test("regresion: listado de productos y categorias sigue respondiendo", async (t) => {
  if (guard(t)) return;
  const p = await api("/api/product");
  assert.equal(p.status, 200);
  const c = await api("/api/category");
  assert.equal(c.status, 200);
});
