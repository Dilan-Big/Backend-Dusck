/**
 * MIGRACIÓN: `category` (ObjectId único, legacy) -> `categories` (arreglo) +
 * bootstrap de los campos del Product Domain + Editor Workflow.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PROCEDIMIENTO OPERATIVO OBLIGATORIO (en este orden, NUNCA saltarse pasos):
 *
 *   1. BACKUP        mongodump --uri "<MONGO_URI>" --collection <colección de Product>
 *                    (este script NO hace backup: es responsabilidad del operador,
 *                     y así no depende de credenciales ni herramientas externas).
 *   2. DRY-RUN       node scripts/migrate-product-domain.js --dry-run
 *                    -> NO escribe nada. Imprime el plan y los conteos.
 *   3. REVISIÓN      Revisar los conteos: cuántos productos migran, cuántos
 *                    quedan sin categoría, cuántos tienen una referencia de
 *                    categoría inválida, y el estado legacy resultante (DRAFT).
 *   4. MIGRACIÓN     node scripts/migrate-product-domain.js
 *   5. VERIFICACIÓN  node scripts/migrate-product-domain.js --verify
 *                    -> NO escribe nada. Exit 1 si detecta cualquier
 *                       inconsistencia (status ausente, categories ausente,
 *                       ref de categoría inválida, metadata de status imposible).
 *   6. ROLLBACK      NO existe rollback automático. El rollback ES la
 *                    restauración del backup del paso 1:
 *                        mongorestore --drop --uri "<MONGO_URI>" <dump>
 *                    Debe restaurarse la colección de Product completa.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * REGLAS DE LA MIGRACIÓN (fuente de verdad, documentadas ANTES de ejecutar):
 *
 *   status     -> SIEMPRE "DRAFT". Ningún producto histórico se publica
 *                 automáticamente. El catálogo legacy vuelve al circuito
 *                 editorial y un administrador decide qué publicar y cuándo.
 *                 (PD-002 — antes se infería PUBLISHED de `isActive`, lo que
 *                  publicaba en masa productos nunca revisados.)
 *   isActive   -> se PRESERVA tal cual estaba (si faltaba: `false`). Como el
 *                 estado es DRAFT, `isActive` no hace visible nada: el filtro
 *                 público exige status === PUBLISHED **y** isActive === true.
 *   categories -> [category]   si `category` existe Y apunta a una categoría real;
 *                 []           si `category` es null/ausente;
 *                 []           si `category` apunta a una categoría inexistente
 *                              (la referencia rota NO se copia; se cuenta y se
 *                               reporta, nunca se crea la categoría).
 *   variants   -> [] (producto "simple"; su `stock` plano queda intacto como
 *                 fuente de verdad).
 *   *By / *At  -> NO se inventan. approvedBy/approvedAt/publishedBy/publishedAt/
 *                 submittedBy/submittedAt/rejectedBy/rejectedAt = quedan sin
 *                 asignar (null). Un DRAFT es coherente con todos ellos vacíos.
 *   createdBy  -> se PRESERVA si existe. Si falta, se asigna al primer usuario
 *                 `administrador` encontrado (el schema nuevo lo exige como
 *                 required). Si no hay ningún administrador, se DEJA como está
 *                 y se reporta.
 *
 * Lo que este script NUNCA hace:
 *   - dropDatabase / deleteMany / drop / updateMany masivo;
 *   - $unset del campo legacy `category` (se deja intacto para auditoría /
 *     rollback manual; el schema de Mongoose ya no lo declara);
 *   - tocar documentos que YA tienen `categories` Y `status` (idempotente).
 *
 * Uso:
 *   node scripts/migrate-product-domain.js --dry-run   (plan, sin escribir)
 *   node scripts/migrate-product-domain.js             (aplica los cambios)
 *   node scripts/migrate-product-domain.js --verify    (verifica, sin escribir)
 */

import mongoose from "mongoose";

import { env } from "../src/config/env.config.js";
import UserModel from "../src/models/user.model.js";
import ProductModel from "../src/models/product.model.js";

const LEGACY_STATUS = "DRAFT";

// ─── Núcleo PURO (sin I/O): decidir el patch de UN documento legacy ──────────

/**
 * Calcula el `$set` para un documento crudo de Product.
 *
 * @param {object} doc  documento crudo tal como está en Mongo.
 * @param {object} ctx
 * @param {Set<string>} ctx.validCategoryIds  ids de categorías que existen.
 * @param {string|null} ctx.fallbackCreatedBy id de admin de respaldo (o null).
 * @returns {{ set: object, flags: object } | null}
 *          `null` si el documento ya está migrado (nada que hacer).
 */
export function planProductDoc(doc, { validCategoryIds, fallbackCreatedBy = null } = {}) {
  const alreadyMigrated = doc.categories !== undefined && doc.status !== undefined;
  if (alreadyMigrated) return null;

  const set = {};
  const flags = { noCategory: false, invalidCategory: false, noCreatedBy: false };

  if (doc.categories === undefined) {
    if (doc.category === undefined || doc.category === null) {
      set.categories = [];
      flags.noCategory = true;
    } else if (validCategoryIds && validCategoryIds.has(String(doc.category))) {
      set.categories = [doc.category];
    } else {
      // Referencia rota: NO se copia (evita un array con un id que no resuelve).
      set.categories = [];
      flags.invalidCategory = true;
    }
  }

  if (doc.status === undefined) {
    // SIEMPRE DRAFT — nunca se infiere PUBLISHED de `isActive` (PD-002).
    set.status = LEGACY_STATUS;
    // PD3-002 — un producto que entra al circuito editorial como DRAFT nunca
    // queda activo: la invariante del dominio es `isActive===true ⇒ status===PUBLISHED`.
    // Se fuerza `false` AUNQUE el documento legacy tuviera `isActive:true`
    // (DRAFT ya lo hacía invisible; esto elimina además el estado incoherente).
    set.isActive = false;
  } else if (doc.isActive === undefined) {
    set.isActive = false;
  }

  if (doc.variants === undefined) {
    set.variants = [];
  }

  if (!doc.createdBy) {
    if (fallbackCreatedBy) {
      set.createdBy = fallbackCreatedBy;
    } else {
      flags.noCreatedBy = true;
    }
  }

  return { set, flags };
}

/** Agrega los flags de un lote de planes en un resumen legible. */
export function summarizePlan(plans) {
  const summary = {
    pending: plans.length,
    toDraft: 0,
    noCategory: 0,
    invalidCategory: 0,
    noCreatedBy: 0,
  };
  for (const p of plans) {
    if (p.set.status === LEGACY_STATUS) summary.toDraft += 1;
    if (p.flags.noCategory) summary.noCategory += 1;
    if (p.flags.invalidCategory) summary.invalidCategory += 1;
    if (p.flags.noCreatedBy) summary.noCreatedBy += 1;
  }
  return summary;
}

// ─── Núcleo con colección (I/O sobre una colección ya abierta) ──────────────

/**
 * Aplica (o planifica, si `dryRun`) la migración sobre una colección concreta.
 * NO abre ni cierra conexiones: recibe la colección ya lista. Así los tests
 * pueden ejercitarlo con su propia base de datos aislada.
 *
 * @returns {{ planned:number, applied:number, plans:Array, summary:object }}
 */
export async function migrateCollection({ products, validCategoryIds, fallbackCreatedBy = null, dryRun = false }) {
  const cursor = products.find({
    $or: [{ categories: { $exists: false } }, { status: { $exists: false } }],
  });

  const plans = [];
  while (await cursor.hasNext()) {
    const doc = await cursor.next();
    const plan = planProductDoc(doc, { validCategoryIds, fallbackCreatedBy });
    if (plan) plans.push({ _id: doc._id, slug: doc.slug, ...plan });
  }

  const summary = summarizePlan(plans);

  if (dryRun || plans.length === 0) {
    return { planned: plans.length, applied: 0, plans, summary };
  }

  let applied = 0;
  for (const p of plans) {
    await products.updateOne({ _id: p._id }, { $set: p.set });
    applied += 1;
  }
  return { planned: plans.length, applied, plans, summary };
}

// ─── Verificación post-migración (sin escribir) ─────────────────────────────

/**
 * Recorre la colección y devuelve la lista de problemas encontrados.
 * Vacía = migración consistente. (El campo legacy `category` residual NO es un
 * problema: la migración lo conserva a propósito.)
 */
export async function verifyMigration(collection, validCategoryIds) {
  const problems = [];

  const checks = [
    ["sin 'status'", { status: { $exists: false } }],
    ["sin 'categories'", { categories: { $exists: false } }],
    ["sin 'variants'", { variants: { $exists: false } }],
    ["sin 'createdBy'", { $or: [{ createdBy: { $exists: false } }, { createdBy: null }] }],
    [
      "PUBLISHED sin 'publishedAt'",
      { status: "PUBLISHED", $or: [{ publishedAt: { $exists: false } }, { publishedAt: null }] },
    ],
    [
      "REJECTED sin 'rejectionReason'",
      {
        status: "REJECTED",
        $or: [
          { rejectionReason: { $exists: false } },
          { rejectionReason: null },
          { rejectionReason: "" },
        ],
      },
    ],
    ["DRAFT con 'approvedBy'", { status: "DRAFT", approvedBy: { $exists: true, $ne: null } }],
    // PD3-002 — invariante isActive: solo un PUBLISHED puede estar activo.
    ["DRAFT con 'isActive:true'", { status: "DRAFT", isActive: true }],
  ];

  for (const [label, query] of checks) {
    const n = await collection.countDocuments(query);
    if (n > 0) problems.push(`${n} producto(s) ${label}`);
  }

  if (validCategoryIds) {
    let invalidRefs = 0;
    const cursor = collection.find(
      { categories: { $exists: true, $ne: [] } },
      { projection: { categories: 1 } },
    );
    while (await cursor.hasNext()) {
      const d = await cursor.next();
      if ((d.categories || []).some((c) => !validCategoryIds.has(String(c)))) invalidRefs += 1;
    }
    if (invalidRefs > 0) problems.push(`${invalidRefs} producto(s) con referencia(s) de categoría inválida(s)`);
  }

  return problems;
}

// ─── Runner efectivo (abre/cierra conexión) — usado por el CLI ──────────────

async function loadCategoryIds() {
  const categoryCollection = mongoose.connection.collection("categories");
  const docs = await categoryCollection.find({}, { projection: { _id: 1 } }).toArray();
  return new Set(docs.map((c) => String(c._id)));
}

export async function runMigration({ dryRun = false, verify = false } = {}) {
  await mongoose.connect(env.mongoUri);
  const target = new URL(env.mongoUri);
  const products = ProductModel.collection;
  const mode = verify ? " (--verify)" : dryRun ? " (--dry-run)" : "";
  console.log(`[migrate] conectado a ${target.host}${target.pathname}${mode}`);
  console.log(`[migrate] colección de Product: "${products.collectionName}"`);

  const total = await products.countDocuments();
  const migrated = await products.countDocuments({
    categories: { $exists: true },
    status: { $exists: true },
  });
  const validCategoryIds = await loadCategoryIds();

  if (verify) {
    const problems = await verifyMigration(products, validCategoryIds);
    if (problems.length === 0) {
      console.log(`[migrate] VERIFICACIÓN OK — ${total} producto(s), sin inconsistencias.`);
    } else {
      console.error("[migrate] VERIFICACIÓN FALLIDA:");
      for (const p of problems) console.error(`  - ${p}`);
    }
    await mongoose.disconnect();
    return { ok: problems.length === 0, problems };
  }

  const fallbackAdmin = await UserModel.findOne({ role: "administrador" }).lean();
  const fallbackCreatedBy = fallbackAdmin ? String(fallbackAdmin._id) : null;
  if (!fallbackCreatedBy) {
    console.warn(
      "[migrate] ADVERTENCIA: no hay ningún usuario 'administrador'. Los productos " +
        "legacy sin 'createdBy' NO recibirán autor de respaldo y se reportarán.",
    );
  }

  const res = await migrateCollection({ products, validCategoryIds, fallbackCreatedBy, dryRun });

  console.log(`[migrate] total productos:        ${total}`);
  console.log(`[migrate] ya migrados:            ${migrated}`);
  console.log(`[migrate] pendientes de migrar:   ${res.summary.pending}`);
  console.log(`[migrate]   -> a estado DRAFT:    ${res.summary.toDraft}`);
  console.log(`[migrate]   sin categoría:        ${res.summary.noCategory}`);
  console.log(`[migrate]   categoría inválida:   ${res.summary.invalidCategory}`);
  console.log(`[migrate]   sin createdBy:        ${res.summary.noCreatedBy}`);

  if (res.planned === 0) {
    console.log("[migrate] nada que migrar.");
  } else if (dryRun) {
    console.table(
      res.plans.slice(0, 50).map((p) => ({
        slug: p.slug,
        status: p.set.status ?? "(sin cambio)",
        categories: p.set.categories ? p.set.categories.length : "(sin cambio)",
        noCategory: p.flags.noCategory,
        invalidCategory: p.flags.invalidCategory,
      })),
    );
    console.log(`[migrate] --dry-run: ${res.planned} documento(s) SERÍAN migrados. Nada se escribió.`);
  } else {
    console.log(`[migrate] migrados ${res.applied} de ${res.planned} documento(s).`);
    console.log("[migrate] siguiente paso OBLIGATORIO: node scripts/migrate-product-domain.js --verify");
  }

  await mongoose.disconnect();
  return res;
}

// ─── CLI ──────────────────────────────────────────────────────────────────
// Solo se ejecuta al invocar el script directamente (no al importarlo desde un test).
const invokedDirectly = process.argv[1] && process.argv[1].endsWith("migrate-product-domain.js");
if (invokedDirectly) {
  const dryRun = process.argv.includes("--dry-run");
  const verify = process.argv.includes("--verify");
  runMigration({ dryRun, verify })
    .then((res) => {
      console.log("[migrate] listo.");
      if (verify && res && res.ok === false) process.exit(1);
    })
    .catch(async (err) => {
      console.error("[migrate] error:", err.message);
      await mongoose.disconnect().catch(() => {});
      process.exit(1);
    });
}
