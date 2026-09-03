// FASE 3 — Remediación PD-001 → PD-005 (Etapa 2).
//
// Prueba que los cinco bloqueantes de la auditoría quedaron resueltos:
//   PD-001  el contrato público de Product no expone metadata editorial.
//   PD-002  la migración es DRAFT-only, idempotente, dry-run segura y verificable.
//   PD-003  Product.stock no se puede desincronizar cuando hay variantes.
//   PD-004  las transiciones de estado son atómicas (una gana, la otra 409).
//   PD-005  el carrito solo acepta productos PUBLISHED + isActive.
//
// Base de datos APARTE: `db-dusck-pd-test`, se elimina al empezar y al terminar.
// Si no hay MongoDB disponible, la suite entera se marca `skip`.
//
// Ejecutar:  node --test tests/pd-remediation.test.js   (o)   npm test

import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

const TEST_DB_URI = "mongodb://127.0.0.1:27017/db-dusck-pd-test";
process.env.MONGO_URI = TEST_DB_URI;

let ctx = null;
let mongoAvailable = true;

const EDITORIAL_FIELDS = [
  "createdBy",
  "updatedBy",
  "submittedBy",
  "submittedAt",
  "approvedBy",
  "approvedAt",
  "rejectedBy",
  "rejectedAt",
  "rejectionReason",
  "publishedBy",
  "publishedAt",
  "status",
];

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
    const migration = await import("../scripts/migrate-product-domain.js");

    await Promise.all([UserModel.init(), CategoryModel.init(), ProductModel.init()]);

    const makeUser = async (over) => {
      const doc = await UserModel.create({
        password: encryptedPassword("Secret123"),
        status: true,
        ...over,
      });
      const token = generateToken({
        _id: doc._id,
        name: doc.name,
        email: doc.email,
        nickname: doc.nickname,
        role: doc.role,
      });
      return { doc, token };
    };

    const admin = await makeUser({ name: "Admin PD", nickname: "admin-pd", email: "admin-pd@dusck.com", role: "administrador" });
    const admin2 = await makeUser({ name: "Admin PD 2", nickname: "admin-pd-2", email: "admin-pd-2@dusck.com", role: "administrador" });
    const editorA = await makeUser({ name: "Editor PD", nickname: "editor-pd", email: "editor-pd@dusck.com", role: "editor" });
    const subscriber = await makeUser({ name: "Sub PD", nickname: "sub-pd", email: "sub-pd@dusck.com", role: "subscriber" });

    const cat = await CategoryModel.create({ name: "Cat PD", slug: "cat-pd" });

    const server = app.listen(0);
    await once(server, "listening");
    const { port } = server.address();

    ctx = {
      mongoose,
      models: { UserModel, CategoryModel, ProductModel },
      migration,
      server,
      base: `http://127.0.0.1:${port}`,
      users: { admin, admin2, editorA, subscriber },
      cat,
    };
  } catch (err) {
    mongoAvailable = false;
    console.warn(`[pd-remediation] MongoDB no disponible, se omite la suite: ${err.name}`);
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
    headers: { "content-type": "application/json", ...(token ? { "x-token": token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const guard = (t) => {
  if (!mongoAvailable) t.skip("MongoDB no disponible");
  return !mongoAvailable;
};

// Crea un producto directamente en la BD (evita recorrer el workflow completo
// cuando lo que se prueba es otra cosa). `over` permite fijar status/variants/etc.
const seedProduct = async (over = {}) => {
  const { ProductModel } = ctx.models;
  return ProductModel.create({
    name: "Prod PD",
    slug: `prod-pd-${Math.random().toString(36).slice(2, 9)}`,
    description: "descripcion",
    price: 10000,
    stock: 7,
    categories: [ctx.cat._id],
    images: [{ url: "http://dusck.test/pd.png", isMain: true }],
    createdBy: ctx.users.editorA.doc._id,
    ...over,
  });
};

// ───────────────────────────── PD-001 ──────────────────────────────────────

test("PD-001 · GET /product (anónimo) no expone ningún campo editorial", async (t) => {
  if (guard(t)) return;
  await seedProduct({ status: "PUBLISHED", isActive: true });

  const res = await api("/api/product");
  assert.equal(res.status, 200);
  const { data } = await res.json();
  assert.ok(Array.isArray(data) && data.length > 0);
  for (const p of data) {
    for (const f of EDITORIAL_FIELDS) {
      assert.equal(f in p, false, `GET /product expone "${f}"`);
    }
    // sí debe traer lo que el storefront usa
    for (const f of ["_id", "name", "slug", "price", "images", "categories", "stock", "isActive"]) {
      assert.equal(f in p, true, `GET /product NO trae "${f}"`);
    }
  }
});

test("PD-001 · GET /product/:id (anónimo) no expone ningún campo editorial", async (t) => {
  if (guard(t)) return;
  const p = await seedProduct({ status: "PUBLISHED", isActive: true });

  const res = await api(`/api/product/${p._id}`);
  assert.equal(res.status, 200);
  const { data } = await res.json();
  for (const f of EDITORIAL_FIELDS) {
    assert.equal(f in data, false, `GET /product/:id expone "${f}"`);
  }
});

test("PD-001 · un PUBLISHED que arrastra rejectionReason/rejectedBy NO lo filtra al público", async (t) => {
  if (guard(t)) return;
  const p = await seedProduct({
    status: "PUBLISHED",
    isActive: true,
    rejectionReason: "NOTA INTERNA: fotos borrosas, corregir antes de re-enviar",
    rejectedBy: ctx.users.admin.doc._id,
    rejectedAt: new Date(),
    publishedBy: ctx.users.admin.doc._id,
    publishedAt: new Date(),
  });

  const list = await (await api("/api/product")).json();
  const inList = list.data.find((x) => x._id === String(p._id));
  assert.ok(inList);
  assert.equal("rejectionReason" in inList, false);

  const detail = await (await api(`/api/product/${p._id}`)).json();
  assert.equal("rejectionReason" in detail.data, false);
  assert.equal("rejectedBy" in detail.data, false);
  assert.equal("publishedBy" in detail.data, false);
});

test("PD-001 · el contrato ADMIN sigue devolviendo la trazabilidad completa", async (t) => {
  if (guard(t)) return;
  const p = await seedProduct({
    status: "PUBLISHED",
    isActive: true,
    approvedBy: ctx.users.admin.doc._id,
    approvedAt: new Date(),
    publishedBy: ctx.users.admin.doc._id,
    publishedAt: new Date(),
  });

  const res = await api(`/api/product/${p._id}`, { token: ctx.users.admin.token });
  assert.equal(res.status, 200);
  const { data } = await res.json();
  assert.equal("createdBy" in data, true);
  assert.equal("approvedBy" in data, true);
  assert.equal("publishedBy" in data, true);
  assert.equal(data.status, "PUBLISHED");

  // y el listado de panel (?all=true) también
  const listRes = await api("/api/product?all=true", { token: ctx.users.admin.token });
  const listJson = await listRes.json();
  const row = listJson.data.find((x) => x._id === String(p._id));
  assert.ok(row && "createdBy" in row && "status" in row);
});

// ───────────────────────────── PD-003 ──────────────────────────────────────

test("PD-003 · producto SIN variantes: PATCH stock=20 -> stock 20 (fuente de verdad)", async (t) => {
  if (guard(t)) return;
  const p = await seedProduct({ status: "DRAFT", isActive: false });
  const res = await api(`/api/product/${p._id}`, {
    method: "PATCH",
    token: ctx.users.editorA.token,
    body: { stock: 20 },
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).data.stock, 20);
});

test("PD-003 · producto CON variantes: Product.stock = SUM(variants.stock)", async (t) => {
  if (guard(t)) return;
  const res = await api("/api/product", {
    method: "POST",
    token: ctx.users.editorA.token,
    body: {
      name: "Con variantes PD",
      slug: `con-variantes-pd-${Date.now()}`,
      description: "x",
      price: 1000,
      categories: [ctx.cat._id.toString()],
      images: [{ url: "http://dusck.test/v.png", isMain: true }],
      stock: 999, // debe ignorarse
      variants: [
        { sku: `PD-A-${Date.now()}`, color: "Negro", stock: 10 },
        { sku: `PD-B-${Date.now()}`, color: "Blanco", stock: 8 },
      ],
    },
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).data.stock, 18);
});

test("PD-003 · PATCH { stock: 999 } sobre producto CON variantes NO desincroniza", async (t) => {
  if (guard(t)) return;
  const p = await seedProduct({
    status: "DRAFT",
    isActive: false,
    variants: [
      { sku: `PD-C-${Date.now()}`, color: "Negro", stock: 10 },
      { sku: `PD-D-${Date.now()}`, color: "Azul", stock: 8 },
    ],
  });
  // el hook de creación ya dejó stock = 18
  const fresh = await ctx.models.ProductModel.findById(p._id).lean();
  assert.equal(fresh.stock, 18);

  const res = await api(`/api/product/${p._id}`, {
    method: "PATCH",
    token: ctx.users.editorA.token,
    body: { stock: 999 },
  });
  // se acepta la request pero el stock se recalcula, nunca queda 999
  assert.equal(res.status, 200);
  const after = (await res.json()).data;
  assert.equal(after.stock, 18);
});

test("PD-003 · modificar y eliminar variantes recalcula Product.stock", async (t) => {
  if (guard(t)) return;
  const p = await seedProduct({
    status: "DRAFT",
    isActive: false,
    variants: [
      { sku: `PD-E-${Date.now()}`, color: "Negro", stock: 10 },
      { sku: `PD-F-${Date.now()}`, color: "Azul", stock: 8 },
    ],
  });

  const upd = await api(`/api/product/${p._id}`, {
    method: "PATCH",
    token: ctx.users.editorA.token,
    body: { variants: [{ sku: `PD-G-${Date.now()}`, color: "Negro", stock: 15 }, { sku: `PD-H-${Date.now()}`, color: "Azul", stock: 5 }] },
  });
  assert.equal((await upd.json()).data.stock, 20);

  const del = await api(`/api/product/${p._id}`, {
    method: "PATCH",
    token: ctx.users.editorA.token,
    body: { variants: [{ sku: `PD-I-${Date.now()}`, color: "Negro", stock: 15 }] },
  });
  assert.equal((await del.json()).data.stock, 15);
});

test("PD-003 · quitar TODAS las variantes: vuelve a mandar el stock plano", async (t) => {
  if (guard(t)) return;
  const p = await seedProduct({
    status: "DRAFT",
    isActive: false,
    variants: [{ sku: `PD-J-${Date.now()}`, color: "Negro", stock: 10 }],
  });
  const res = await api(`/api/product/${p._id}`, {
    method: "PATCH",
    token: ctx.users.editorA.token,
    body: { variants: [], stock: 42 },
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).data.stock, 42);
});

test("PD-003 · stock negativo sigue rechazándose", async (t) => {
  if (guard(t)) return;
  const p = await seedProduct({ status: "DRAFT", isActive: false });
  const res = await api(`/api/product/${p._id}`, {
    method: "PATCH",
    token: ctx.users.editorA.token,
    body: { stock: -5 },
  });
  assert.equal(res.status, 400);
});

// ───────────────────────────── PD-004 ──────────────────────────────────────

test("PD-004 · carrera aprobar vs. rechazar: 1 gana (200), 1 pierde (409), estado coherente", async (t) => {
  if (guard(t)) return;
  const { admin, admin2, editorA } = ctx.users;

  // producto listo para revisión
  const created = await api("/api/product", {
    method: "POST",
    token: editorA.token,
    body: {
      name: "Carrera PD",
      slug: `carrera-pd-${Date.now()}`,
      description: "descripcion suficiente",
      price: 5000,
      categories: [ctx.cat._id.toString()],
      images: [{ url: "http://dusck.test/race.png", isMain: true }],
      stock: 3,
    },
  });
  const { data: product } = await created.json();
  await api(`/api/product/${product._id}/status`, {
    method: "PATCH",
    token: editorA.token,
    body: { toStatus: "PENDING_REVIEW" },
  });

  // dos transiciones concurrentes desde PENDING_REVIEW
  const [r1, r2] = await Promise.all([
    api(`/api/product/${product._id}/status`, { method: "PATCH", token: admin.token, body: { toStatus: "APPROVED" } }),
    api(`/api/product/${product._id}/status`, { method: "PATCH", token: admin2.token, body: { toStatus: "REJECTED", rejectionReason: "no" } }),
  ]);

  const statuses = [r1.status, r2.status].sort();
  assert.deepEqual(statuses, [200, 409], `esperado [200,409], recibido ${JSON.stringify(statuses)}`);

  // estado final coherente: o APPROVED sin metadata de rechazo, o REJECTED sin metadata de aprobación
  const finalDoc = await ctx.models.ProductModel.findById(product._id).lean();
  if (finalDoc.status === "APPROVED") {
    assert.ok(finalDoc.approvedBy && finalDoc.approvedAt);
    assert.ok(!finalDoc.rejectedBy && !finalDoc.rejectedAt);
    assert.ok(!finalDoc.rejectionReason);
  } else if (finalDoc.status === "REJECTED") {
    assert.ok(finalDoc.rejectedBy && finalDoc.rejectedAt && finalDoc.rejectionReason);
    assert.ok(!finalDoc.approvedBy && !finalDoc.approvedAt);
  } else {
    assert.fail(`estado final inesperado: ${finalDoc.status}`);
  }
});

test("PD-004 · la MISMA transición disparada dos veces en paralelo -> 1x200, 1x409", async (t) => {
  if (guard(t)) return;
  const { admin, admin2, editorA } = ctx.users;
  const p = await seedProduct({
    status: "PENDING_REVIEW",
    isActive: false,
    submittedBy: editorA.doc._id,
    submittedAt: new Date(),
  });

  const [r1, r2] = await Promise.all([
    api(`/api/product/${p._id}/status`, { method: "PATCH", token: admin.token, body: { toStatus: "APPROVED" } }),
    api(`/api/product/${p._id}/status`, { method: "PATCH", token: admin2.token, body: { toStatus: "APPROVED" } }),
  ]);

  assert.deepEqual([r1.status, r2.status].sort(), [200, 409]);

  const finalDoc = await ctx.models.ProductModel.findById(p._id).lean();
  assert.equal(finalDoc.status, "APPROVED");
  assert.ok(finalDoc.approvedBy && finalDoc.approvedAt);
});

// ───────────────────────────── PD-005 ──────────────────────────────────────

const cartAdd = (productId, quantity, token) =>
  api("/api/cart", { method: "PATCH", token, body: { productId, quantity } });

for (const status of ["DRAFT", "PENDING_REVIEW", "APPROVED", "REJECTED"]) {
  test(`PD-005 · carrito RECHAZA agregar un producto ${status}`, async (t) => {
    if (guard(t)) return;
    const extra = status === "REJECTED" ? { rejectionReason: "x", rejectedBy: ctx.users.admin.doc._id, rejectedAt: new Date() } : {};
    const p = await seedProduct({ status, isActive: status === "APPROVED", ...extra });
    const res = await cartAdd(String(p._id), 1, ctx.users.subscriber.token);
    assert.equal(res.status, 404, `${status} debería rechazarse`);
  });
}

test("PD-005 · carrito RECHAZA un PUBLISHED pero inactivo", async (t) => {
  if (guard(t)) return;
  const p = await seedProduct({ status: "PUBLISHED", isActive: false });
  const res = await cartAdd(String(p._id), 1, ctx.users.subscriber.token);
  assert.equal(res.status, 404);
});

test("PD-005 · carrito ACEPTA un PUBLISHED + activo con stock", async (t) => {
  if (guard(t)) return;
  const p = await seedProduct({ status: "PUBLISHED", isActive: true, stock: 5 });
  const res = await cartAdd(String(p._id), 2, ctx.users.subscriber.token);
  assert.equal(res.status, 200);
  const item = (await res.json()).data.items.find((i) => (i.productId._id || i.productId).toString() === String(p._id));
  assert.equal(item.quantity, 2);
});

test("PD-005 · quantity -1 (disminuir) sigue funcionando aunque el producto ya no esté publicado", async (t) => {
  if (guard(t)) return;
  const { subscriber, admin } = ctx.users;
  const p = await seedProduct({ status: "PUBLISHED", isActive: true, stock: 5 });

  // agrega 2
  assert.equal((await cartAdd(String(p._id), 2, subscriber.token)).status, 200);

  // el producto se despublica (isActive:false vía PATCH admin)
  await api(`/api/product/${p._id}`, { method: "PATCH", token: admin.token, body: { isActive: false } });

  // NO se puede incrementar
  assert.equal((await cartAdd(String(p._id), 1, subscriber.token)).status, 404);

  // SÍ se puede disminuir (delta con signo — contrato del carrito intacto)
  const dec = await cartAdd(String(p._id), -1, subscriber.token);
  assert.equal(dec.status, 200);
  const item = (await dec.json()).data.items.find((i) => (i.productId._id || i.productId).toString() === String(p._id));
  assert.equal(item.quantity, 1);
});

test("PD-005 · incremento por encima del stock sigue rechazándose (contrato previo)", async (t) => {
  if (guard(t)) return;
  const p = await seedProduct({ status: "PUBLISHED", isActive: true, stock: 2 });
  const res = await cartAdd(String(p._id), 5, ctx.users.subscriber.token);
  assert.equal(res.status, 400);
});

// ───────────────────────────── PD-002 ──────────────────────────────────────

test("PD-002 · planProductDoc: legacy activo -> DRAFT (NUNCA PUBLISHED)", async (t) => {
  if (guard(t)) return;
  const { planProductDoc } = ctx.migration;
  const validCategoryIds = new Set([String(ctx.cat._id)]);

  const plan = planProductDoc(
    { _id: "x", category: ctx.cat._id, isActive: true },
    { validCategoryIds, fallbackCreatedBy: String(ctx.users.admin.doc._id) },
  );
  assert.equal(plan.set.status, "DRAFT");
  assert.deepEqual(plan.set.categories.map(String), [String(ctx.cat._id)]);
  assert.equal(plan.set.variants.length, 0);
});

test("PD-002 · planProductDoc: category null / inválida -> [] y flag", async (t) => {
  if (guard(t)) return;
  const { planProductDoc } = ctx.migration;
  const validCategoryIds = new Set([String(ctx.cat._id)]);

  const noCat = planProductDoc({ _id: "a", category: null }, { validCategoryIds });
  assert.deepEqual(noCat.set.categories, []);
  assert.equal(noCat.flags.noCategory, true);

  const badCat = planProductDoc({ _id: "b", category: new ctx.mongoose.Types.ObjectId() }, { validCategoryIds });
  assert.deepEqual(badCat.set.categories, []);
  assert.equal(badCat.flags.invalidCategory, true);
});

test("PD-002 · planProductDoc: documento ya migrado -> null (idempotente)", async (t) => {
  if (guard(t)) return;
  const { planProductDoc } = ctx.migration;
  const plan = planProductDoc({ _id: "c", categories: [ctx.cat._id], status: "PUBLISHED" }, { validCategoryIds: new Set() });
  assert.equal(plan, null);
});

test("PD-002 · planProductDoc: sin createdBy -> usa fallback admin, o flag si no hay", async (t) => {
  if (guard(t)) return;
  const { planProductDoc } = ctx.migration;
  const vc = new Set([String(ctx.cat._id)]);

  const withFallback = planProductDoc({ _id: "d", category: ctx.cat._id }, { validCategoryIds: vc, fallbackCreatedBy: "adminId" });
  assert.equal(withFallback.set.createdBy, "adminId");
  assert.equal(withFallback.flags.noCreatedBy, false);

  const noFallback = planProductDoc({ _id: "e", category: ctx.cat._id }, { validCategoryIds: vc, fallbackCreatedBy: null });
  assert.equal("createdBy" in noFallback.set, false);
  assert.equal(noFallback.flags.noCreatedBy, true);
});

// La integración real de la migración (dry-run seguro, idempotencia, verify)
// vive en tests/migrate-product-domain.test.js, con su propia base aislada.
