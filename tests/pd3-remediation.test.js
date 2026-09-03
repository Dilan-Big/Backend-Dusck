// FASE 3 — Remediación 3 (cierre de los 2 hallazgos LOW de Audit 3).
//
//   PD3-001  `categories` no-array -> 400 INVALID_CATEGORIES (nunca 500).
//   PD3-002  la migración a DRAFT normaliza `isActive:false`; `verifyMigration`
//            detecta `DRAFT + isActive:true`.
//
// Base de datos APARTE: `db-dusck-pd3-test`, se elimina al empezar y al terminar.
// Si no hay MongoDB disponible, la suite entera se marca `skip`.
//
// Ejecutar:  node --test tests/pd3-remediation.test.js   (o)   npm test

import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

const TEST_DB_URI = "mongodb://127.0.0.1:27017/db-dusck-pd3-test";
process.env.MONGO_URI = TEST_DB_URI;

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
    const ProductModel = (await import("../src/models/product.model.js")).default;
    const migration = await import("../scripts/migrate-product-domain.js");

    await Promise.all([UserModel.init(), CategoryModel.init(), ProductModel.init()]);

    const editorDoc = await UserModel.create({
      name: "Editor PD3",
      nickname: "editor-pd3",
      email: "editor-pd3@dusck.com",
      role: "editor",
      status: true,
      password: encryptedPassword("Secret123"),
    });
    const editorToken = generateToken({
      _id: editorDoc._id,
      name: editorDoc.name,
      email: editorDoc.email,
      nickname: editorDoc.nickname,
      role: editorDoc.role,
    });

    const cat = await CategoryModel.create({ name: "Cat PD3", slug: "cat-pd3" });

    const server = app.listen(0);
    await once(server, "listening");
    const { port } = server.address();

    ctx = {
      mongoose,
      migration,
      models: { ProductModel },
      server,
      base: `http://127.0.0.1:${port}`,
      editor: { doc: editorDoc, token: editorToken },
      cat,
      products: ProductModel.collection,
    };
  } catch (err) {
    mongoAvailable = false;
    console.warn(`[pd3-remediation] MongoDB no disponible, se omite la suite: ${err.name}`);
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

const validDraft = (over = {}) => ({
  name: "Producto PD3",
  slug: `producto-pd3-${Math.random().toString(36).slice(2, 9)}`,
  description: "Descripcion",
  price: 1000,
  stock: 3,
  categories: [ctx.cat._id.toString()],
  images: [{ url: "http://dusck.test/pd3.png", isMain: true }],
  ...over,
});

const seedProduct = (over = {}) =>
  ctx.models.ProductModel.create({
    name: "Prod PD3 seed",
    slug: `prod-pd3-seed-${Math.random().toString(36).slice(2, 9)}`,
    description: "d",
    price: 1000,
    stock: 3,
    categories: [ctx.cat._id],
    images: [{ url: "http://dusck.test/s.png", isMain: true }],
    createdBy: ctx.editor.doc._id,
    status: "DRAFT",
    isActive: false,
    ...over,
  });

// ───────────────────────────── PD3-001 ─────────────────────────────────────

for (const bad of ["HOMBRE", 123, {}, null]) {
  test(`PD3-001 · POST /product con categories=${JSON.stringify(bad)} -> 400, no 500, sin escritura`, async (t) => {
    if (guard(t)) return;
    const before = await ctx.models.ProductModel.countDocuments();
    const res = await api("/api/product", { method: "POST", token: ctx.editor.token, body: validDraft({ categories: bad }) });
    assert.equal(res.status, 400, `categories ${JSON.stringify(bad)} debe dar 400`);
    const json = await res.json();
    assert.match(json.msg, /categor/i);
    const after = await ctx.models.ProductModel.countDocuments();
    assert.equal(after, before, "no debe crearse ningún producto con entrada inválida");
  });

  test(`PD3-001 · PATCH /product/:id con categories=${JSON.stringify(bad)} -> 400, no 500`, async (t) => {
    if (guard(t)) return;
    const p = await seedProduct();
    const snapshot = JSON.stringify((await ctx.models.ProductModel.findById(p._id).lean()).categories);
    const res = await api(`/api/product/${p._id}`, { method: "PATCH", token: ctx.editor.token, body: { categories: bad } });
    assert.equal(res.status, 400, `categories ${JSON.stringify(bad)} debe dar 400`);
    const after = await ctx.models.ProductModel.findById(p._id).lean();
    assert.equal(JSON.stringify(after.categories), snapshot, "categories no debe cambiar");
  });
}

test("PD3-001 · PATCH /product/:id con categories=5 (número) -> 400, no 500", async (t) => {
  if (guard(t)) return;
  const p = await seedProduct();
  const res = await api(`/api/product/${p._id}`, { method: "PATCH", token: ctx.editor.token, body: { categories: 5 } });
  assert.equal(res.status, 400);
});

test("PD3-001 · array válido con ids reales sigue funcionando (sin regresión)", async (t) => {
  if (guard(t)) return;
  const res = await api("/api/product", { method: "POST", token: ctx.editor.token, body: validDraft({ categories: [ctx.cat._id.toString()] }) });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).data.categories.length, 1);
});

test("PD3-001 · array vacío sigue permitido en DRAFT (forma OK, completitud es otro gate)", async (t) => {
  if (guard(t)) return;
  const p = await seedProduct();
  const res = await api(`/api/product/${p._id}`, { method: "PATCH", token: ctx.editor.token, body: { categories: [] } });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).data.categories, []);
});

test("PD3-001 · array con ObjectId inexistente conserva su error de referencia (no INVALID_CATEGORIES)", async (t) => {
  if (guard(t)) return;
  const fakeId = new ctx.mongoose.Types.ObjectId().toString();
  const res = await api("/api/product", { method: "POST", token: ctx.editor.token, body: validDraft({ categories: [fakeId] }) });
  assert.equal(res.status, 400);
  // la semántica existente: "no existen" (assertCategoriesExist), no la forma
  assert.match((await res.json()).msg, /no existen|no existe/i);
});

test("PD3-001 · array con string no-ObjectId conserva el CastError -> 400 (no 500)", async (t) => {
  if (guard(t)) return;
  const res = await api("/api/product", { method: "POST", token: ctx.editor.token, body: validDraft({ categories: ["HOMBRE"] }) });
  assert.equal(res.status, 400);
});

// ───────────────────────────── PD3-002 ─────────────────────────────────────

test("PD3-002 · Caso A — legacy status:undefined + isActive:true -> plan DRAFT + isActive:false", async (t) => {
  if (guard(t)) return;
  const { planProductDoc } = ctx.migration;
  const plan = planProductDoc(
    { _id: "a", category: ctx.cat._id, isActive: true },
    { validCategoryIds: new Set([String(ctx.cat._id)]), fallbackCreatedBy: String(ctx.editor.doc._id) },
  );
  assert.equal(plan.set.status, "DRAFT");
  assert.equal(plan.set.isActive, false);
});

test("PD3-002 · Caso B — legacy status:undefined + isActive:false -> DRAFT + false", async (t) => {
  if (guard(t)) return;
  const { planProductDoc } = ctx.migration;
  const plan = planProductDoc({ _id: "b", category: ctx.cat._id, isActive: false }, { validCategoryIds: new Set([String(ctx.cat._id)]), fallbackCreatedBy: "x" });
  assert.equal(plan.set.status, "DRAFT");
  assert.equal(plan.set.isActive, false);
});

test("PD3-002 · Caso C — legacy sin isActive -> DRAFT + false", async (t) => {
  if (guard(t)) return;
  const { planProductDoc } = ctx.migration;
  const plan = planProductDoc({ _id: "c", category: ctx.cat._id }, { validCategoryIds: new Set([String(ctx.cat._id)]), fallbackCreatedBy: "x" });
  assert.equal(plan.set.status, "DRAFT");
  assert.equal(plan.set.isActive, false);
});

test("PD3-002 · Caso D — documento ya migrado (DRAFT+false) -> null (idempotente)", async (t) => {
  if (guard(t)) return;
  const { planProductDoc } = ctx.migration;
  const plan = planProductDoc(
    { _id: "d", categories: [ctx.cat._id], status: "DRAFT", isActive: false },
    { validCategoryIds: new Set([String(ctx.cat._id)]) },
  );
  assert.equal(plan, null);
});

test("PD3-002 · Caso E — verifyMigration DETECTA 'DRAFT con isActive:true'", async (t) => {
  if (guard(t)) return;
  const { verifyMigration } = ctx.migration;
  await ctx.products.deleteMany({});
  await ctx.products.insertOne({
    name: "Incoherente", slug: "incoherente-pd3", price: 1, stock: 1,
    categories: [ctx.cat._id], status: "DRAFT", isActive: true,
    variants: [], createdBy: new ctx.mongoose.Types.ObjectId(),
  });
  const problems = await verifyMigration(ctx.products, new Set([String(ctx.cat._id)]));
  assert.ok(problems.some((p) => p.includes("DRAFT con 'isActive:true'")), problems.join(" | "));
  await ctx.products.deleteMany({});
});

test("PD3-002 · migración real aislada: legacy activo -> DRAFT + isActive:false; verify limpio; idempotente", async (t) => {
  if (guard(t)) return;
  const { migrateCollection, verifyMigration } = ctx.migration;
  await ctx.products.deleteMany({});
  await ctx.products.insertMany([
    { name: "L1", slug: "l1-pd3", price: 10, stock: 1, category: ctx.cat._id, isActive: true, createdBy: new ctx.mongoose.Types.ObjectId() },
    { name: "L2", slug: "l2-pd3", price: 10, stock: 1, category: ctx.cat._id, isActive: false, createdBy: new ctx.mongoose.Types.ObjectId() },
    { name: "L3", slug: "l3-pd3", price: 10, stock: 1, category: ctx.cat._id, createdBy: new ctx.mongoose.Types.ObjectId() },
  ]);
  const vc = new Set([String(ctx.cat._id)]);

  // dry-run: 0 escrituras
  const dry = await migrateCollection({ products: ctx.products, validCategoryIds: vc, dryRun: true });
  assert.equal(dry.applied, 0);
  assert.equal(await ctx.products.countDocuments({ status: { $exists: true } }), 0);

  const run = await migrateCollection({ products: ctx.products, validCategoryIds: vc });
  assert.equal(run.applied, 3);

  for (const d of await ctx.products.find({}).toArray()) {
    assert.equal(d.status, "DRAFT");
    assert.equal(d.isActive, false, `${d.slug} debería quedar inactivo`);
  }

  assert.deepEqual(await verifyMigration(ctx.products, vc), []);

  const again = await migrateCollection({ products: ctx.products, validCategoryIds: vc });
  assert.equal(again.applied, 0);
  await ctx.products.deleteMany({});
});
