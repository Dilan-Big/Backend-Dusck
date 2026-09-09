// TALLAS — Carrito con identidad (productId + size) y validación de stock por
// variante. Nivel de servicio (`cart.service.js`), BD real APARTE:
// `db-dusck-cart-variant-test`. Sin Mongo -> suite `skip`.
//
// Ejecutar:  node --test tests/cart-variant.test.js   (o)   npm test

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";

import ProductModel from "../src/models/product.model.js";
import CartModel from "../src/models/cart.model.js";
import {
  dbUpdateCartByUserId,
  dbRemoveCartItemByUserId,
} from "../src/services/cart.service.js";

const TEST_DB_URI = "mongodb://127.0.0.1:27017/db-dusck-cart-variant-test";
let mongoAvailable = true;

test.before(async () => {
  try {
    await mongoose.connect(TEST_DB_URI, { serverSelectionTimeoutMS: 2000 });
    await mongoose.connection.dropDatabase();
    await Promise.all([ProductModel.init(), CartModel.init()]);
  } catch (err) {
    mongoAvailable = false;
    console.error(`[cart-variant] MongoDB no disponible, se omite la suite: ${err.name}`);
  }
});

test.beforeEach(async () => {
  if (mongoAvailable) {
    await Promise.all([ProductModel.deleteMany({}), CartModel.deleteMany({})]);
  }
});

test.after(async () => {
  if (mongoAvailable) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

const skipIfNoMongo = (t) => {
  if (!mongoAvailable) t.skip("MongoDB no disponible");
  return !mongoAvailable;
};

const makeProduct = (over = {}) =>
  ProductModel.create({
    name: over.name ?? "Camiseta Essential",
    slug: over.slug ?? `camiseta-${randomUUID().slice(0, 8)}`,
    description: "x",
    price: 50000,
    images: [{ url: "http://dusck.test/m.png", isMain: true }],
    variants: over.variants ?? [],
    stock: over.stock ?? 10,
    status: "PUBLISHED",
    isActive: true,
    createdBy: new mongoose.Types.ObjectId(),
  });

const sized = (stocks) =>
  makeProduct({
    variants: Object.entries(stocks).map(([size, stock]) => ({
      sku: `SZ-${size}-${randomUUID().slice(0, 6)}`,
      color: "Negro",
      size,
      stock,
    })),
  });

const uid = () => new mongoose.Types.ObjectId().toString();
const lineOf = (cart, productId, size) =>
  cart.items.find(
    (i) => (i.productId._id || i.productId).toString() === productId.toString() && (size ? i.size === size : !i.size),
  );

// ====================================================================
// Producto simple — sin cambios de comportamiento
// ====================================================================

test("simple: agrega sin talla y valida contra Product.stock (igual que siempre)", async (t) => {
  if (skipIfNoMongo(t)) return;
  const u = uid();
  const p = await makeProduct({ stock: 5 });
  const cart = await dbUpdateCartByUserId(u, { productId: p._id.toString(), quantity: 2 });
  const item = lineOf(cart, p._id);
  assert.equal(item.quantity, 2);
  assert.equal(item.size, undefined);
});

test("simple: enviar talla a un producto sin variantes -> error SIZE_NOT_APPLICABLE", async (t) => {
  if (skipIfNoMongo(t)) return;
  const u = uid();
  const p = await makeProduct({ stock: 5 });
  await assert.rejects(
    () => dbUpdateCartByUserId(u, { productId: p._id.toString(), quantity: 1, size: "M" }),
    (err) => err.code === "SIZE_NOT_APPLICABLE",
  );
});

// ====================================================================
// Producto con variantes — talla obligatoria + stock por variante
// ====================================================================

test("variantes: agregar sin talla -> SIZE_REQUIRED", async (t) => {
  if (skipIfNoMongo(t)) return;
  const u = uid();
  const p = await sized({ S: 5, M: 10 });
  await assert.rejects(
    () => dbUpdateCartByUserId(u, { productId: p._id.toString(), quantity: 1 }),
    (err) => err.code === "SIZE_REQUIRED",
  );
});

test("variantes: talla inexistente -> SIZE_INVALID", async (t) => {
  if (skipIfNoMongo(t)) return;
  const u = uid();
  const p = await sized({ S: 5, M: 10 });
  await assert.rejects(
    () => dbUpdateCartByUserId(u, { productId: p._id.toString(), quantity: 1, size: "XXL" }),
    (err) => err.code === "SIZE_INVALID",
  );
});

test("variantes: la validación de stock usa el stock de ESA variante, no el agregado", async (t) => {
  if (skipIfNoMongo(t)) return;
  const u = uid();
  const p = await sized({ S: 2, M: 10 }); // agregado 12
  // pedir 3 de S (solo hay 2) debe fallar aunque el agregado (12) lo permitiría
  await assert.rejects(
    () => dbUpdateCartByUserId(u, { productId: p._id.toString(), quantity: 3, size: "S" }),
    (err) => /2 unidades disponibles/.test(err.message),
  );
});

// ====================================================================
// 9 — Dos tallas del mismo producto coexisten como líneas independientes
// ====================================================================

test("9 — M×2 y L×1 del mismo producto son DOS líneas, no se fusionan", async (t) => {
  if (skipIfNoMongo(t)) return;
  const u = uid();
  const p = await sized({ S: 5, M: 10, L: 8 });
  const id = p._id.toString();

  await dbUpdateCartByUserId(u, { productId: id, quantity: 2, size: "M" });
  const cart = await dbUpdateCartByUserId(u, { productId: id, quantity: 1, size: "L" });

  assert.equal(cart.items.length, 2);
  assert.equal(lineOf(cart, p._id, "M").quantity, 2);
  assert.equal(lineOf(cart, p._id, "L").quantity, 1);
});

test("9b — incrementar la talla M no toca la línea L", async (t) => {
  if (skipIfNoMongo(t)) return;
  const u = uid();
  const p = await sized({ M: 10, L: 8 });
  const id = p._id.toString();
  await dbUpdateCartByUserId(u, { productId: id, quantity: 1, size: "M" });
  await dbUpdateCartByUserId(u, { productId: id, quantity: 1, size: "L" });
  const cart = await dbUpdateCartByUserId(u, { productId: id, quantity: 2, size: "M" });

  assert.equal(cart.items.length, 2);
  assert.equal(lineOf(cart, p._id, "M").quantity, 3);
  assert.equal(lineOf(cart, p._id, "L").quantity, 1);
});

test("9c — quitar la línea M deja intacta la línea L", async (t) => {
  if (skipIfNoMongo(t)) return;
  const u = uid();
  const p = await sized({ M: 10, L: 8 });
  const id = p._id.toString();
  await dbUpdateCartByUserId(u, { productId: id, quantity: 2, size: "M" });
  await dbUpdateCartByUserId(u, { productId: id, quantity: 1, size: "L" });

  const cart = await dbRemoveCartItemByUserId(u, id, "M");
  assert.equal(cart.items.length, 1);
  assert.equal(lineOf(cart, p._id, "L").quantity, 1);
  assert.equal(lineOf(cart, p._id, "M"), undefined);
});

test("9d — decrementar la talla M hasta 0 elimina solo esa línea", async (t) => {
  if (skipIfNoMongo(t)) return;
  const u = uid();
  const p = await sized({ M: 10, L: 8 });
  const id = p._id.toString();
  await dbUpdateCartByUserId(u, { productId: id, quantity: 1, size: "M" });
  await dbUpdateCartByUserId(u, { productId: id, quantity: 2, size: "L" });

  const cart = await dbUpdateCartByUserId(u, { productId: id, quantity: -1, size: "M" });
  assert.equal(cart.items.length, 1);
  assert.equal(lineOf(cart, p._id, "L").quantity, 2);
});

test("stock por talla en el carrito: sumar más que el stock de la variante -> rechazado", async (t) => {
  if (skipIfNoMongo(t)) return;
  const u = uid();
  const p = await sized({ M: 3 });
  const id = p._id.toString();
  await dbUpdateCartByUserId(u, { productId: id, quantity: 2, size: "M" });
  await assert.rejects(
    () => dbUpdateCartByUserId(u, { productId: id, quantity: 2, size: "M" }), // 2+2 > 3
    (err) => /3 unidades disponibles/.test(err.message),
  );
});

// ====================================================================
// Compatibilidad — item legado sin `size`
// ====================================================================

test("compat: un item legado { productId, quantity } (sin size) se trata como línea simple", async (t) => {
  if (skipIfNoMongo(t)) return;
  const u = new mongoose.Types.ObjectId();
  const p = await makeProduct({ stock: 10 });
  // Inserta un carrito "legado" directamente, sin el campo `size`.
  await CartModel.collection.insertOne({
    userId: u,
    items: [{ productId: p._id, quantity: 2 }],
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  // Incrementar ese mismo producto simple debe sumar sobre la línea existente.
  const cart = await dbUpdateCartByUserId(u.toString(), { productId: p._id.toString(), quantity: 1 });
  const item = lineOf(cart, p._id);
  assert.equal(item.quantity, 3, "sumó sobre la línea legada, no creó una nueva");
  assert.equal(cart.items.length, 1);
});
