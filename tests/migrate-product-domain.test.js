// FASE 3 — PD-002 — Integración del migrador `category -> categories[]`.
//
// Base de datos APARTE: `db-dusck-migrate-test`, se elimina al empezar y al
// terminar. Solo contiene los documentos que crea este test, así que la
// verificación puede exigir CERO inconsistencias en toda la colección.
//
// Comprueba:
//   - `--dry-run` (dryRun:true) NO escribe nada;
//   - la migración lleva el catálogo legacy a DRAFT (NUNCA PUBLISHED, aunque
//     `isActive` fuera true);
//   - una referencia de categoría rota NO se copia al array (se cuenta);
//   - `category` null -> `categories: []`;
//   - segunda corrida = 0 cambios (idempotente);
//   - `verifyMigration` no reporta problemas tras migrar;
//   - `verifyMigration` SÍ detecta un PUBLISHED sin `publishedAt` (metadata imposible).
//
// Si no hay MongoDB disponible, la suite entera se marca `skip`.

import test from "node:test";
import assert from "node:assert/strict";

const TEST_DB_URI = "mongodb://127.0.0.1:27017/db-dusck-migrate-test";
process.env.MONGO_URI = TEST_DB_URI;

let ctx = null;
let mongoAvailable = true;

test.before(async () => {
  try {
    const mongoose = (await import("mongoose")).default;
    await mongoose.connect(TEST_DB_URI, { serverSelectionTimeoutMS: 2000 });
    await mongoose.connection.dropDatabase();

    const ProductModel = (await import("../src/models/product.model.js")).default;
    const CategoryModel = (await import("../src/models/category.model.js")).default;
    const migration = await import("../scripts/migrate-product-domain.js");

    const cat = await CategoryModel.create({ name: "Cat MIG", slug: "cat-mig" });

    ctx = {
      mongoose,
      migration,
      products: ProductModel.collection,
      categories: CategoryModel.collection,
      catId: cat._id,
      validCategoryIds: new Set([String(cat._id)]),
      fallbackCreatedBy: String(new mongoose.Types.ObjectId()),
    };
  } catch (err) {
    mongoAvailable = false;
    console.warn(`[migrate-product-domain] MongoDB no disponible, se omite la suite: ${err.name}`);
  }
});

test.after(async () => {
  if (ctx) {
    await ctx.mongoose.connection.dropDatabase();
    await ctx.mongoose.disconnect();
  }
});

const guard = (t) => {
  if (!mongoAvailable) t.skip("MongoDB no disponible");
  return !mongoAvailable;
};

// Inserta documentos LEGACY crudos (sin status/categories/variants).
async function seedLegacy() {
  await ctx.products.deleteMany({});
  const brokenCatId = new ctx.mongoose.Types.ObjectId();
  const docs = [
    { name: "Legacy Activo", slug: "legacy-activo", price: 100, stock: 5, category: ctx.catId, isActive: true, createdBy: new ctx.mongoose.Types.ObjectId() },
    { name: "Legacy Inactivo", slug: "legacy-inactivo", price: 100, stock: 0, category: ctx.catId, isActive: false, createdBy: new ctx.mongoose.Types.ObjectId() },
    { name: "Legacy Sin Categoria", slug: "legacy-sin-cat", price: 100, stock: 2, category: null, isActive: true, createdBy: new ctx.mongoose.Types.ObjectId() },
    { name: "Legacy Cat Rota", slug: "legacy-cat-rota", price: 100, stock: 1, category: brokenCatId, isActive: false, createdBy: new ctx.mongoose.Types.ObjectId() },
    { name: "Legacy Sin Autor", slug: "legacy-sin-autor", price: 100, stock: 3, category: ctx.catId, isActive: false },
  ];
  await ctx.products.insertMany(docs);
}

test("PD-002 · dry-run no escribe; total/pendientes reportados", async (t) => {
  if (guard(t)) return;
  const { migrateCollection } = ctx.migration;
  await seedLegacy();

  const dry = await migrateCollection({
    products: ctx.products,
    validCategoryIds: ctx.validCategoryIds,
    fallbackCreatedBy: ctx.fallbackCreatedBy,
    dryRun: true,
  });

  assert.equal(dry.applied, 0);
  assert.equal(dry.planned, 5);
  assert.equal(dry.summary.toDraft, 5);
  assert.equal(dry.summary.noCategory, 1);
  assert.equal(dry.summary.invalidCategory, 1);
  // hay un admin de respaldo -> el doc sin autor recibe createdBy, no queda "sin autor"
  assert.equal(dry.summary.noCreatedBy, 0);
  const sinAutorPlan = dry.plans.find((p) => p.slug === "legacy-sin-autor");
  assert.equal(String(sinAutorPlan.set.createdBy), ctx.fallbackCreatedBy);

  // nada cambió en la BD
  const stillLegacy = await ctx.products.countDocuments({ status: { $exists: false } });
  assert.equal(stillLegacy, 5);
});

test("PD-002 · migración: todo a DRAFT, cat rota NO se copia, idempotente, verify OK", async (t) => {
  if (guard(t)) return;
  const { migrateCollection, verifyMigration } = ctx.migration;
  await seedLegacy();

  const run = await migrateCollection({
    products: ctx.products,
    validCategoryIds: ctx.validCategoryIds,
    fallbackCreatedBy: ctx.fallbackCreatedBy,
  });
  assert.equal(run.applied, 5);

  const all = await ctx.products.find({}).toArray();
  for (const d of all) {
    assert.equal(d.status, "DRAFT", `${d.slug} no quedó DRAFT`);
    assert.ok(Array.isArray(d.categories));
    assert.deepEqual(d.variants, []);
    assert.ok(d.createdBy, `${d.slug} sin createdBy`);
    // ninguna metadata editorial inventada
    for (const f of ["approvedBy", "approvedAt", "publishedBy", "publishedAt", "submittedBy"]) {
      assert.ok(d[f] === undefined || d[f] === null, `${d.slug} tiene ${f} inventado`);
    }
  }

  const activo = all.find((d) => d.slug === "legacy-activo");
  assert.deepEqual(activo.categories.map(String), [String(ctx.catId)]);
  // PD3-002 — legacy `isActive:true` que pasa a DRAFT se normaliza a `false`
  // (invariante isActive===true ⇒ status===PUBLISHED).
  assert.equal(activo.isActive, false);

  const rota = all.find((d) => d.slug === "legacy-cat-rota");
  assert.deepEqual(rota.categories, []); // la ref rota NO se copió

  const sinCat = all.find((d) => d.slug === "legacy-sin-cat");
  assert.deepEqual(sinCat.categories, []);

  const sinAutor = all.find((d) => d.slug === "legacy-sin-autor");
  assert.equal(String(sinAutor.createdBy), ctx.fallbackCreatedBy);

  // el campo legacy `category` se conserva (no se hace $unset)
  assert.ok(all.every((d) => "category" in d));

  // idempotente
  const again = await migrateCollection({
    products: ctx.products,
    validCategoryIds: ctx.validCategoryIds,
    fallbackCreatedBy: ctx.fallbackCreatedBy,
  });
  assert.equal(again.applied, 0);

  // verify: sin problemas
  const problems = await verifyMigration(ctx.products, ctx.validCategoryIds);
  assert.deepEqual(problems, [], `verify reportó: ${problems.join(" | ")}`);
});

test("PD-002 · verifyMigration DETECTA metadata imposible (PUBLISHED sin publishedAt)", async (t) => {
  if (guard(t)) return;
  const { verifyMigration } = ctx.migration;
  await ctx.products.deleteMany({});
  await ctx.products.insertOne({
    name: "Roto", slug: "roto", price: 1, stock: 1,
    categories: [ctx.catId], status: "PUBLISHED", isActive: true,
    variants: [], createdBy: new ctx.mongoose.Types.ObjectId(),
    // publishedAt ausente a propósito
  });

  const problems = await verifyMigration(ctx.products, ctx.validCategoryIds);
  assert.ok(problems.some((p) => p.includes("PUBLISHED sin 'publishedAt'")), problems.join(" | "));
});
