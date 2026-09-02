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

    // Asegura que los indices unicos (email, nickname, slug) esten construidos
    // ANTES de los tests de duplicados (si no, un insert duplicado "pasaria").
    await Promise.all([UserModel.init(), CategoryModel.init(), ProductModel.init()]);

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
      helpers: { encryptedPassword, generateToken },
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

// ---------------------------------------------------------------------------
// R1.4 — DELETE USER: proteccion en el BACKEND (anti-lockout)
// ---------------------------------------------------------------------------

const makeUser = async (over = {}) => {
  const { UserModel } = ctx.models;
  const { encryptedPassword } = ctx.helpers;
  const n = Math.random().toString(36).slice(2, 8);
  return UserModel.create({
    name: `Tmp ${n}`,
    nickname: `tmp-${n}`,
    email: `tmp-${n}@dusck.com`,
    password: encryptedPassword("Secret123"),
    role: "subscriber",
    status: true,
    ...over,
  });
};

const tokenFor = (user) =>
  ctx.helpers.generateToken({
    _id: user._id,
    name: user.name,
    email: user.email,
    nickname: user.nickname,
    role: user.role,
  });

test("R1.4 admin elimina OTRO usuario -> 200 y desaparece", async (t) => {
  if (guard(t)) return;
  const { UserModel } = ctx.models;
  const victim = await makeUser();

  const res = await api(`/api/users/${victim._id}`, {
    method: "DELETE",
    token: ctx.token,
  });
  assert.equal(res.status, 200);
  assert.equal(await UserModel.findById(victim._id), null);
});

test("R1.4 admin intenta eliminarSE a si mismo -> 409 y sigue existiendo", async (t) => {
  if (guard(t)) return;
  const { UserModel } = ctx.models;

  const res = await api(`/api/users/${ctx.ids.admin}`, {
    method: "DELETE",
    token: ctx.token,
  });
  assert.equal(res.status, 409);
  assert.ok(await UserModel.findById(ctx.ids.admin));
});

test("R1.4 el sistema no puede quedarse sin administradores activos", async (t) => {
  if (guard(t)) return;
  const { UserModel } = ctx.models;

  // Dos admins activos extra. Un admin puede borrar a OTRO admin...
  const a2 = await makeUser({ role: "administrador", status: true });
  const a3 = await makeUser({ role: "administrador", status: true });
  const a2Token = tokenFor(a2);

  const delOther = await api(`/api/users/${a3._id}`, { method: "DELETE", token: a2Token });
  assert.equal(delOther.status, 200);

  // ...pero NINGUN admin puede borrarse a si mismo (garantiza que nunca se llega
  // a 0: solo los admins pueden borrar admins y ninguno puede quitarse a si
  // mismo). El guard `activeAdmins <= 1` del controlador es la red adicional.
  const delSelf = await api(`/api/users/${a2._id}`, { method: "DELETE", token: a2Token });
  assert.equal(delSelf.status, 409);
  assert.ok(await UserModel.findById(a2._id));

  await UserModel.findByIdAndDelete(a2._id);
});

test("R1.4 la regla del ultimo admin usa 'activos': cuenta administradores status:true", async (t) => {
  if (guard(t)) return;
  const { dbCountUsers } = await import("../src/services/user.service.js");
  const { ROLES } = await import("../src/config/global.config.js");

  const before = await dbCountUsers({ role: ROLES.ADMIN, status: true });
  const inactive = await makeUser({ role: "administrador", status: false });
  const after = await dbCountUsers({ role: ROLES.ADMIN, status: true });
  assert.equal(after, before, "un admin inactivo no incrementa el conteo de activos");

  await ctx.models.UserModel.findByIdAndDelete(inactive._id);
});

// ---------------------------------------------------------------------------
// R1.5 — ROLE AUTHORIZATION usa el rol ACTUAL de MongoDB, no el del JWT
// ---------------------------------------------------------------------------

test("R1.5 rol cambiado en BD: autoriza con el rol nuevo aunque el JWT sea viejo", async (t) => {
  if (guard(t)) return;
  const { UserModel } = ctx.models;

  const u = await makeUser({ role: "editor" });
  const oldToken = tokenFor(u); // JWT dice role: editor

  // editor NO puede listar roles (authorizationUser(['administrador']))
  const before = await api("/api/roles", { token: oldToken });
  assert.equal(before.status, 403);

  // Un admin lo promueve en BD.
  await UserModel.findByIdAndUpdate(u._id, { role: "administrador" });

  // MISMO token viejo (sigue diciendo editor) -> ahora SI, porque el middleware
  // lee req.user.role desde Mongo.
  const after = await api("/api/roles", { token: oldToken });
  assert.equal(after.status, 200);

  await UserModel.findByIdAndDelete(u._id);
});

test("R1.5 rol degradado en BD: pierde acceso aunque el JWT diga admin", async (t) => {
  if (guard(t)) return;
  const { UserModel } = ctx.models;

  const u = await makeUser({ role: "administrador" });
  const adminToken = tokenFor(u); // JWT dice administrador

  const before = await api("/api/roles", { token: adminToken });
  assert.equal(before.status, 200);

  await UserModel.findByIdAndUpdate(u._id, { role: "subscriber" });

  const after = await api("/api/roles", { token: adminToken });
  assert.equal(after.status, 403);

  await UserModel.findByIdAndDelete(u._id);
});

// ---------------------------------------------------------------------------
// R1.7 — SEMANTICA HTTP EN ERRORES DE ESCRITURA (nunca 200 cuando falla)
// ---------------------------------------------------------------------------

test("R1.7 POST /users email duplicado -> 409 (no 200)", async (t) => {
  if (guard(t)) return;
  const res = await api("/api/users", {
    method: "POST",
    token: ctx.token,
    body: {
      name: "Dup Mail",
      nickname: "dup-mail", // <= 20, no existe
      email: "admin-s4@dusck.com", // ya existe
      password: "Secret123",
      role: "subscriber",
    },
  });
  assert.equal(res.status, 409);
  const json = await res.json();
  assert.equal(json.data, undefined);
  assert.match(json.msg, /correo/i);
});

test("R1.7 POST /users nickname duplicado -> 409", async (t) => {
  if (guard(t)) return;
  const res = await api("/api/users", {
    method: "POST",
    token: ctx.token,
    body: {
      name: "Dup Nick",
      nickname: "admin-s4", // ya existe
      email: "dup-nick@dusck.com",
      password: "Secret123",
      role: "subscriber",
    },
  });
  assert.equal(res.status, 409);
});

test("R1.7 POST /users sin password -> 400", async (t) => {
  if (guard(t)) return;
  const res = await api("/api/users", {
    method: "POST",
    token: ctx.token,
    body: {
      name: "No Pass",
      nickname: "no-pass",
      email: "no-pass@dusck.com",
      role: "subscriber",
    },
  });
  assert.equal(res.status, 400);
});

test("R1.7 POST /category slug duplicado -> 409; slug invalido -> 400", async (t) => {
  if (guard(t)) return;
  const dup = await api("/api/category", {
    method: "POST",
    token: ctx.token,
    body: { name: "Cat Dup S4", slug: "ropa-s4" }, // slug ya existe
  });
  assert.equal(dup.status, 409);

  const bad = await api("/api/category", {
    method: "POST",
    token: ctx.token,
    body: { name: "Cat Bad S4", slug: "Slug Invalido!!" },
  });
  assert.equal(bad.status, 400);
});

test("R1.7 POST /product validacion (price<0) -> 400; slug duplicado -> 409", async (t) => {
  if (guard(t)) return;
  const neg = await api("/api/product", {
    method: "POST",
    token: ctx.token,
    body: {
      name: "Prod Neg S4",
      slug: "prod-neg-s4",
      price: -1,
      stock: 1,
      category: ctx.ids.category,
    },
  });
  assert.equal(neg.status, 400);

  const dup = await api("/api/product", {
    method: "POST",
    token: ctx.token,
    body: {
      name: "Prod Dup S4",
      slug: "camiseta-s4", // ya existe
      price: 1,
      stock: 1,
      category: ctx.ids.category,
    },
  });
  assert.equal(dup.status, 409);
});
