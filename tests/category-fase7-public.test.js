// F7-C — Publication + Storefront: contrato PÚBLICO de Category.
//
// Antes de F7, `GET /category` y `GET /category/:id` no tenían ningún filtro
// ni middleware de autenticación: devolvían TODAS las categorías (activas e
// inactivas) a cualquiera, sin importar el rol. El único filtro `isActive`
// vivía en Angular (`basicos.ts`, `category-list.ts`), como defensa, nunca
// como barrera real — hallazgo documentado en el F7.AUDIT report.
//
// Esta suite cubre el contrato NUEVO (endurecido en F7-CLOSURE para igualar
// exactamente el gate de `GET /product`):
//   · público (sin sesión, o con sesión no admin-capable) -> SOLO activas.
//   · admin-capable (administrador/shop_manager/editor) -> SOLO activas por
//     defecto; activas + inactivas SOLO con `?all=true` explícito. El panel
//     (`AdminCategoriesApi.list()`/`getById()`) manda `?all=true`; el
//     storefront (`HttpCategory`) nunca lo manda, así que un admin navegando
//     la tienda tampoco recibe inactivas aunque el interceptor adjunte token.
//   · `?all=true` NO amplía permisos: un rol no admin-capable (o anónimo) que
//     lo mande cae igualmente en el contrato público (nunca 403).
//   · Category no tiene campos administrativos que ocultar hoy (sin
//     `createdBy`/workflow), así que "no exponer metadata administrativa" se
//     reduce a "no exponer categorías inactivas fuera de `?all=true`+admin".
//
// BD APARTE: `db-dusck-fase7-category-test`. Sin Mongo -> suite `skip`.
// Ejecutar:  node --test tests/category-fase7-public.test.js

import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

const TEST_DB_URI = "mongodb://127.0.0.1:27017/db-dusck-fase7-category-test";
process.env.MONGO_URI = TEST_DB_URI;
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-fase7-category";

let ctx = null;
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

    await Promise.all([UserModel.init(), CategoryModel.init()]);

    const makeUser = async (over) => {
      const doc = await UserModel.create({ password: encryptedPassword("Secret123"), status: true, ...over });
      const token = generateToken({
        _id: doc._id, name: doc.name, email: doc.email, nickname: doc.nickname, role: doc.role,
      });
      return { doc, token };
    };

    const admin = await makeUser({ name: "Admin F7Cat", nickname: "admin-f7cat", email: "admin-f7cat@dusck.com", role: "administrador" });
    const shopManager = await makeUser({ name: "Shop F7Cat", nickname: "shop-f7cat", email: "shop-f7cat@dusck.com", role: "shop_manager" });
    const editor = await makeUser({ name: "Editor F7Cat", nickname: "editor-f7cat", email: "editor-f7cat@dusck.com", role: "editor" });
    const subscriber = await makeUser({ name: "Sub F7Cat", nickname: "sub-f7cat", email: "sub-f7cat@dusck.com", role: "subscriber" });

    const active = await CategoryModel.create({ name: "Hombre F7Cat", slug: "hombre-f7cat", isActive: true });
    const inactive = await CategoryModel.create({ name: "Retirada F7Cat", slug: "retirada-f7cat", isActive: false });

    const server = app.listen(0);
    await once(server, "listening");
    const { port } = server.address();

    ctx = {
      mongoose,
      server,
      base: `http://127.0.0.1:${port}`,
      users: { admin, shopManager, editor, subscriber },
      categories: { active, inactive },
    };
  } catch (err) {
    mongoAvailable = false;
    console.warn(`[category-fase7-public] MongoDB no disponible, se omite la suite: ${err.name} ${err.message}`);
  }
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

const api = (path, { token } = {}) =>
  fetch(`${ctx.base}${path}`, {
    headers: token ? { "x-token": token } : {},
  });

// ===========================================================================
// 1. categoría ACTIVA visible públicamente
// ===========================================================================

test("F7-C · categoría activa aparece en GET /category público (sin sesión)", async (t) => {
  if (guard(t)) return;
  const res = await api("/api/category");
  assert.equal(res.status, 200);
  const { data } = await res.json();
  const ids = data.map((c) => c._id);
  assert.ok(ids.includes(ctx.categories.active._id.toString()));
});

test("F7-C · GET /category/:id de una categoría activa (sin sesión) -> 200", async (t) => {
  if (guard(t)) return;
  const res = await api(`/api/category/${ctx.categories.active._id}`);
  assert.equal(res.status, 200);
  const { data } = await res.json();
  assert.equal(data.name, "Hombre F7Cat");
  assert.equal(data.isActive, true);
});

// ===========================================================================
// 2. categoría INACTIVA NO visible públicamente
// ===========================================================================

test("F7-C · categoría inactiva NO aparece en GET /category público (sin sesión)", async (t) => {
  if (guard(t)) return;
  const res = await api("/api/category");
  assert.equal(res.status, 200);
  const { data } = await res.json();
  const ids = data.map((c) => c._id);
  assert.ok(!ids.includes(ctx.categories.inactive._id.toString()));
});

test("F7-C · GET /category/:id de una categoría inactiva (sin sesión) -> 404, no 200 con isActive:false", async (t) => {
  if (guard(t)) return;
  const res = await api(`/api/category/${ctx.categories.inactive._id}`);
  assert.equal(res.status, 404);
});

test("F7-C · categoría inactiva tampoco visible para un subscriber autenticado (no es admin-capable)", async (t) => {
  if (guard(t)) return;
  const { subscriber } = ctx.users;
  const list = await api("/api/category", { token: subscriber.token });
  const { data } = await list.json();
  assert.ok(!data.map((c) => c._id).includes(ctx.categories.inactive._id.toString()));

  const detail = await api(`/api/category/${ctx.categories.inactive._id}`, { token: subscriber.token });
  assert.equal(detail.status, 404);
});

// ===========================================================================
// 3. usuario administrativo conserva el acceso necesario — pero SOLO con
//    `?all=true` explícito (F7-CLOSURE: mismo gate que GET /product)
// ===========================================================================

for (const role of ["admin", "shopManager", "editor"]) {
  test(`F7-CLOSURE · ${role} + ?all=true SÍ ve categorías inactivas en GET /category`, async (t) => {
    if (guard(t)) return;
    const user = ctx.users[role];
    const list = await api("/api/category?all=true", { token: user.token });
    assert.equal(list.status, 200);
    const { data } = await list.json();
    const ids = data.map((c) => c._id);
    assert.ok(ids.includes(ctx.categories.active._id.toString()));
    assert.ok(ids.includes(ctx.categories.inactive._id.toString()), `${role} con ?all=true debe ver categorías inactivas`);

    const detail = await api(`/api/category/${ctx.categories.inactive._id}?all=true`, { token: user.token });
    assert.equal(detail.status, 200, `${role} con ?all=true debe poder abrir el detalle de una categoría inactiva`);
  });

  test(`F7-CLOSURE · ${role} SIN ?all=true mantiene el contrato público (solo activas, inactiva -> 404)`, async (t) => {
    if (guard(t)) return;
    const user = ctx.users[role];
    const list = await api("/api/category", { token: user.token });
    assert.equal(list.status, 200);
    const { data } = await list.json();
    const ids = data.map((c) => c._id);
    assert.ok(ids.includes(ctx.categories.active._id.toString()));
    assert.ok(
      !ids.includes(ctx.categories.inactive._id.toString()),
      `${role} sin ?all=true NO debe recibir inactivas (contrato público — storefront)`,
    );

    const detail = await api(`/api/category/${ctx.categories.inactive._id}`, { token: user.token });
    assert.equal(detail.status, 404, `${role} sin ?all=true no puede abrir una categoría inactiva`);
  });
}

// ===========================================================================
// 3b. `?all=true` NO amplía permisos por sí solo — rol no admin-capable /
//     anónimo lo mande o no, jamás recibe inactivas (F7-CLOSURE, sin 403:
//     degrada al contrato público igual que GET /product?all=true)
// ===========================================================================

test("F7-CLOSURE · ?all=true SIN token NO expone inactivas (degrada a público, no 403)", async (t) => {
  if (guard(t)) return;
  const list = await api("/api/category?all=true");
  assert.equal(list.status, 200);
  const { data } = await list.json();
  assert.ok(!data.map((c) => c._id).includes(ctx.categories.inactive._id.toString()));

  const detail = await api(`/api/category/${ctx.categories.inactive._id}?all=true`);
  assert.equal(detail.status, 404, "una request anónima con ?all=true no accede a una categoría inactiva");
});

test("F7-CLOSURE · subscriber + ?all=true NO expone inactivas (degrada a público, no 403)", async (t) => {
  if (guard(t)) return;
  const { subscriber } = ctx.users;
  const list = await api("/api/category?all=true", { token: subscriber.token });
  assert.equal(list.status, 200);
  const { data } = await list.json();
  assert.ok(!data.map((c) => c._id).includes(ctx.categories.inactive._id.toString()));

  const detail = await api(`/api/category/${ctx.categories.inactive._id}?all=true`, { token: subscriber.token });
  assert.equal(detail.status, 404, "un subscriber con ?all=true no accede a una categoría inactiva");
});

// ===========================================================================
// 4. ningún campo administrativo innecesario se expone
// ===========================================================================

test("F7-C · la categoría pública no expone más campos que name/slug/description/isActive(+timestamps)", async (t) => {
  if (guard(t)) return;
  const res = await api(`/api/category/${ctx.categories.active._id}`);
  const { data } = await res.json();
  const allowed = new Set(["_id", "name", "slug", "description", "isActive", "createdAt", "updatedAt"]);
  for (const key of Object.keys(data)) {
    assert.ok(allowed.has(key), `campo inesperado en la categoría pública: "${key}"`);
  }
});
