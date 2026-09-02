/**
 * Seed de DESARROLLO LOCAL para el runtime audit del Admin Panel.
 *
 * Crea las 4 cuentas de rol reales + un catálogo mínimo (categorías y productos
 * que cubren todos los niveles de stock). NO es dato de producción: son fixtures
 * para poder probar login, guards y CRUD contra Mongo local.
 *
 * Contraseñas: NUNCA en el código. Se leen de variables de entorno (.env local,
 * cubierto por .gitignore):
 *   SEED_ADMIN_PASSWORD, SEED_MANAGER_PASSWORD, SEED_EDITOR_PASSWORD,
 *   SEED_SUBSCRIBER_PASSWORD
 * Para desarrollo puedes poner el mismo valor en las cuatro.
 *
 * Seguridad:
 *  - REHÚSA ejecutarse si MONGO_URI no apunta a localhost/127.0.0.1 (evita
 *    sembrar en Atlas). Override explícito: SEED_ALLOW_REMOTE=1
 *  - Idempotente: upsert por email / slug. Re-ejecutar no duplica.
 *  - `--fresh` borra SOLO los fixtures de este seed (lista fija de emails/slugs).
 *    Nunca hace dropDatabase() ni borra por criterios amplios.
 *  - No se invoca desde el arranque del backend (index.js no lo importa).
 *
 * Uso:   node scripts/seed.js
 *        node scripts/seed.js --fresh
 */

import mongoose from 'mongoose';

// Importa env.config.js -> ejecuta `import 'dotenv/config'` y carga el .env local,
// dejando disponibles las SEED_*_PASSWORD en process.env.
import { env } from '../src/config/env.config.js';
import { encryptedPassword } from '../src/helpers/bycryp.helper.js';

import UserModel from '../src/models/user.model.js';
import CategoryModel from '../src/models/category.model.js';
import ProductModel from '../src/models/product.model.js';

const FRESH = process.argv.includes('--fresh');

// --- Guard: solo Mongo local ------------------------------------------------

function assertLocal(uri) {
  if (process.env.SEED_ALLOW_REMOTE === '1') {
    console.warn('[seed] SEED_ALLOW_REMOTE=1 -> se omite la comprobación de host local.');
    return;
  }
  let host = '';
  try {
    host = new URL(uri).hostname;
  } catch {
    host = '';
  }
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (!local) {
    console.error(
      `[seed] MONGO_URI no apunta a localhost (host: "${host || 'desconocido'}"). ` +
        `Abortado para no sembrar en un entorno remoto. ` +
        `Override explícito: SEED_ALLOW_REMOTE=1 node scripts/seed.js`,
    );
    process.exit(1);
  }
}

// --- Contraseñas desde entorno ---------------------------------------------

function readPassword(varName) {
  const value = process.env[varName];
  if (!value || value.trim() === '') {
    console.error(
      `[seed] Falta la variable de entorno ${varName}. ` +
        `Añádela a tu .env local (los nombres están en .env.example). ` +
        `Para desarrollo puedes usar el mismo valor en las cuatro SEED_*_PASSWORD.`,
    );
    process.exit(1);
  }
  return value;
}

// --- Fixtures --------------------------------------------------------------
// role: valores del enum real de user.model.js
// slug: patrón real ^[a-z0-9-]+$

const USERS = [
  { name: 'Admin Dusck',     nickname: 'admin_dusck',   email: 'admin@dusck.test',   role: 'administrador', status: true, passwordVar: 'SEED_ADMIN_PASSWORD' },
  { name: 'Shop Manager',    nickname: 'shop_manager1', email: 'manager@dusck.test', role: 'shop_manager',  status: true, passwordVar: 'SEED_MANAGER_PASSWORD' },
  { name: 'Editor Dusck',    nickname: 'editor_dusck',  email: 'editor@dusck.test',  role: 'editor',        status: true, passwordVar: 'SEED_EDITOR_PASSWORD' },
  { name: 'Cliente Prueba',  nickname: 'cliente1',      email: 'cliente@dusck.test', role: 'subscriber',    status: true, passwordVar: 'SEED_SUBSCRIBER_PASSWORD' },
];

const CATEGORIES = [
  { name: 'Camisetas',  slug: 'camisetas',  description: 'Basicos de algodon peinado.', isActive: true },
  { name: 'Pantalones', slug: 'pantalones', description: 'Cortes rectos y sastre.',      isActive: true },
  { name: 'Accesorios', slug: 'accesorios', description: 'Complementos de temporada.',   isActive: false },
];

// stock elegido para cubrir los niveles del panel: >5 ok / 1-5 bajo / <=0 agotado
const PRODUCTS = [
  { name: 'Camiseta Esencial Negra',   slug: 'camiseta-esencial-negra',  categorySlug: 'camisetas',  price: 89000,  stock: 25, isActive: true,
    description: 'Camiseta de peso medio, cuello redondo.', images: [{ url: 'https://picsum.photos/seed/dusck-tee/600/800', isMain: true }] },
  { name: 'Camiseta Oversize Marfil',  slug: 'camiseta-oversize-marfil', categorySlug: 'camisetas',  price: 99000,  stock: 3,  isActive: true,
    description: 'Corte holgado, hombros caidos.', images: [{ url: 'https://picsum.photos/seed/dusck-tee2/600/800', isMain: true }] },
  { name: 'Pantalon Sastre Gris',      slug: 'pantalon-sastre-gris',     categorySlug: 'pantalones', price: 219000, stock: 0,  isActive: true,
    description: 'Pinzas frontales, caida fluida.', images: [] },
  { name: 'Pantalon Cargo (borrador)', slug: 'pantalon-cargo-borrador',  categorySlug: 'pantalones', price: 189000, stock: 12, isActive: false,
    description: 'Aun no publicado.', images: [{ url: 'https://picsum.photos/seed/dusck-cargo/600/800', isMain: true }] },
];

// --- Upserts idempotentes -------------------------------------------------

async function upsertUser(u, plainPassword) {
  const existing = await UserModel.findOne({ email: u.email });
  if (existing) {
    existing.name = u.name;
    existing.nickname = u.nickname;
    existing.role = u.role;
    existing.status = u.status;
    existing.password = encryptedPassword(plainPassword); // re-hash: mantiene la pass del .env como fuente de verdad
    await existing.save();
    return { doc: existing, created: false };
  }
  const doc = await UserModel.create({
    name: u.name,
    nickname: u.nickname,
    email: u.email,
    role: u.role,
    status: u.status,
    password: encryptedPassword(plainPassword),
  });
  return { doc, created: true };
}

async function upsertCategory(c) {
  const before = await CategoryModel.exists({ slug: c.slug });
  const doc = await CategoryModel.findOneAndUpdate(
    { slug: c.slug },
    { $set: c },
    { returnDocument: 'after', upsert: true, runValidators: true, setDefaultsOnInsert: true },
  );
  return { doc, created: !before };
}

async function upsertProduct(p, categoryId, createdBy) {
  const { categorySlug, ...rest } = p;
  const before = await ProductModel.exists({ slug: p.slug });
  const doc = await ProductModel.findOneAndUpdate(
    { slug: p.slug },
    { $set: { ...rest, category: categoryId, createdBy } },
    { returnDocument: 'after', upsert: true, runValidators: true, setDefaultsOnInsert: true },
  );
  return { doc, created: !before };
}

// --- Run ----------------------------------------------------------------

async function main() {
  assertLocal(env.mongoUri);

  const passwords = Object.fromEntries(
    USERS.map((u) => [u.passwordVar, readPassword(u.passwordVar)]),
  );

  await mongoose.connect(env.mongoUri);
  const target = new URL(env.mongoUri);
  console.log(`[seed] conectado a ${target.host}${target.pathname}`);

  if (FRESH) {
    // Borra EXCLUSIVAMENTE los fixtures de este seed (listas fijas). Nunca dropDatabase.
    const emails = USERS.map((u) => u.email);
    const catSlugs = CATEGORIES.map((c) => c.slug);
    const prodSlugs = PRODUCTS.map((p) => p.slug);
    const dp = await ProductModel.deleteMany({ slug: { $in: prodSlugs } });
    const dc = await CategoryModel.deleteMany({ slug: { $in: catSlugs } });
    const du = await UserModel.deleteMany({ email: { $in: emails } });
    console.log(
      `[seed] --fresh: -${du.deletedCount} users, -${dc.deletedCount} categories, -${dp.deletedCount} products (solo fixtures)`,
    );
  }

  let usersCreated = 0;
  const usersByRole = {};
  for (const u of USERS) {
    const { doc, created } = await upsertUser(u, passwords[u.passwordVar]);
    usersByRole[u.role] = doc;
    usersCreated += created ? 1 : 0;
    console.log(`[seed] user  ${created ? 'creado ' : 'ok     '} ${u.role.padEnd(13)} ${u.email}`);
  }
  const adminId = usersByRole['administrador']._id;

  let catsCreated = 0;
  const catBySlug = {};
  for (const c of CATEGORIES) {
    const { doc, created } = await upsertCategory(c);
    catBySlug[c.slug] = doc;
    catsCreated += created ? 1 : 0;
    console.log(`[seed] cat   ${created ? 'creada ' : 'ok     '} ${c.slug.padEnd(12)} isActive:${c.isActive}`);
  }

  let prodsCreated = 0;
  for (const p of PRODUCTS) {
    const cat = catBySlug[p.categorySlug];
    const { doc, created } = await upsertProduct(p, cat._id, adminId);
    prodsCreated += created ? 1 : 0;
    console.log(
      `[seed] prod  ${created ? 'creado ' : 'ok     '} ${doc.slug.padEnd(28)} stock:${String(doc.stock).padStart(3)} isActive:${doc.isActive}`,
    );
  }

  const [nUsers, nCats, nProds] = await Promise.all([
    UserModel.countDocuments({ email: { $in: USERS.map((u) => u.email) } }),
    CategoryModel.countDocuments({ slug: { $in: CATEGORIES.map((c) => c.slug) } }),
    ProductModel.countDocuments({ slug: { $in: PRODUCTS.map((p) => p.slug) } }),
  ]);

  console.log('\n=== RESUMEN ===');
  console.log(`usuarios fixture en BD:   ${nUsers} (nuevos esta corrida: ${usersCreated})`);
  console.log(`categorias fixture en BD: ${nCats} (nuevas esta corrida: ${catsCreated})`);
  console.log(`productos fixture en BD:  ${nProds} (nuevos esta corrida: ${prodsCreated})`);
  console.table(USERS.map((u) => ({ rol: u.role, email: u.email, passwordVar: u.passwordVar })));

  await mongoose.disconnect();
  console.log('[seed] listo.');
}

main().catch(async (err) => {
  console.error('[seed] error:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
