// TALLAS Y STOCK POR TALLA — Checkout + inventario por variante.
//
// Cubre la propagación de la talla Producto -> Pedido -> descuento de stock por
// variante (`variants[].stock`) + agregado (`Product.stock`) -> cancelación /
// restitución a la variante correcta. El Editor (crear/editar stock por talla) y
// la autorización de escritura de stock ya están cubiertos por
// `product-fase5-variants.test.js` (se referencian al final de este archivo).
//
// BD APARTE: `db-dusck-order-variant-stock-test`. Sin Mongo -> suite `skip`.
//
// Ejecutar:  node --test tests/order-variant-stock.test.js   (o)   npm test

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";

import OrderModel from "../src/models/order.model.js";
import CounterModel from "../src/models/counter.model.js";
import ProductModel from "../src/models/product.model.js";
import CartModel from "../src/models/cart.model.js";
import { createOrder, ORDER_ERROR_CODES, operationIdFor } from "../src/services/order.service.js";
import { transitionOrderStatus } from "../src/services/order.workflow.service.js";

const TEST_DB_URI = "mongodb://127.0.0.1:27017/db-dusck-order-variant-stock-test";
let mongoAvailable = true;

test.before(async () => {
  try {
    await mongoose.connect(TEST_DB_URI, { serverSelectionTimeoutMS: 2000 });
    await mongoose.connection.dropDatabase();
    await Promise.all([OrderModel.init(), CounterModel.init(), ProductModel.init(), CartModel.init()]);
  } catch (err) {
    mongoAvailable = false;
    console.error(`[order-variant-stock] MongoDB no disponible, se omite la suite: ${err.name}`);
  }
});

test.beforeEach(async () => {
  if (mongoAvailable) {
    await Promise.all([
      OrderModel.deleteMany({}),
      CounterModel.deleteMany({}),
      ProductModel.deleteMany({}),
      CartModel.deleteMany({}),
    ]);
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

// --- fixtures --------------------------------------------------------

const makeProduct = (over = {}) =>
  ProductModel.create({
    name: over.name ?? "Camiseta Essential",
    slug: over.slug ?? `camiseta-${randomUUID().slice(0, 8)}`,
    description: "Algodón peinado",
    price: over.price ?? 50000,
    images: [{ url: "http://dusck.test/main.png", isMain: true }],
    variants: over.variants ?? [],
    stock: over.stock ?? 10,
    status: over.status ?? "PUBLISHED",
    isActive: over.isActive ?? true,
    createdBy: new mongoose.Types.ObjectId(),
  });

// Producto con tallas S/M/L/XL, stock por talla configurable.
const makeSizedProduct = (stocks = { S: 5, M: 10, L: 8, XL: 2 }, over = {}) =>
  makeProduct({
    ...over,
    variants: Object.entries(stocks).map(([size, stock], i) => ({
      sku: `SZ-${size}-${randomUUID().slice(0, 6)}`,
      color: "Negro",
      size,
      stock,
    })),
  });

const baseInput = (over = {}) => ({
  items: over.items ?? [{ productId: over.productId, quantity: over.quantity ?? 1, size: over.size }],
  customer: { recipientName: "Ana Gómez", phone: "3001234567", email: "ana@dusck.co" },
  shippingAddress: {
    department: "Antioquia",
    city: "Medellín",
    neighborhood: "Laureles",
    address: "Calle 12 # 34-56 apto 201",
  },
  userId: "userId" in over ? over.userId : null,
  source: "web",
  idempotencyKey: "idempotencyKey" in over ? over.idempotencyKey : randomUUID(),
});

const rejectsWithCode = async (fn, code) => {
  await assert.rejects(fn, (err) => {
    assert.equal(err.code, code, `esperaba ${code}, obtuvo ${err.code} (${err.message})`);
    return true;
  });
};

const productOf = (id) => ProductModel.findById(id).lean();
const variantStock = (prod, size) => prod.variants.find((v) => v.size === size).stock;

// ====================================================================
// 1 — Producto simple sigue comprándose igual (no regresión)
// ====================================================================

test("1 — producto simple: compra sin talla, descuenta Product.stock como siempre", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p = await makeProduct({ stock: 10 });
  const order = await createOrder(baseInput({ productId: p._id.toString(), quantity: 3 }));

  assert.equal(order.finalized, true);
  assert.equal(order.items[0].size, undefined, "un producto simple no lleva talla en el snapshot");
  assert.equal(order.requestedItems[0].size, undefined);
  assert.equal((await productOf(p._id)).stock, 7);
});

test("1b — producto simple: enviar una talla -> 422 (no maneja tallas)", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p = await makeProduct({ stock: 10 });
  await rejectsWithCode(
    () => createOrder(baseInput({ productId: p._id.toString(), quantity: 1, size: "M" })),
    ORDER_ERROR_CODES.INVALID_BUSINESS,
  );
  assert.equal((await productOf(p._id)).stock, 10, "stock intacto");
});

// ====================================================================
// 2 / 5 / 6 / 11 / 12 — Producto con variantes SE compra con talla válida
// ====================================================================

test("2/5/6/11/12 — compra con talla válida: variante y agregado bajan la cantidad pedida", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p = await makeSizedProduct({ S: 5, M: 10, L: 8, XL: 2 });
  const aggregateBefore = (await productOf(p._id)).stock; // 25

  const order = await createOrder(baseInput({ productId: p._id.toString(), quantity: 3, size: "M" }));

  assert.equal(order.finalized, true);
  assert.equal(order.items[0].size, "M", "la talla queda congelada en el snapshot");
  assert.equal(order.requestedItems[0].size, "M");

  const after = await productOf(p._id);
  assert.equal(variantStock(after, "M"), 7, "variante M: 10 - 3");
  assert.equal(after.stock, aggregateBefore - 3, "agregado: 25 - 3");
});

// ====================================================================
// 3 — Producto con variantes SIN size -> rechazado
// ====================================================================

test("3 — producto con variantes sin talla -> 422 y sin tocar stock", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p = await makeSizedProduct();
  const before = await productOf(p._id);
  await rejectsWithCode(
    () => createOrder(baseInput({ productId: p._id.toString(), quantity: 1, size: undefined })),
    ORDER_ERROR_CODES.INVALID_BUSINESS,
  );
  const after = await productOf(p._id);
  assert.equal(after.stock, before.stock);
  assert.deepEqual(after.variants.map((v) => v.stock), before.variants.map((v) => v.stock));
  assert.equal(await OrderModel.countDocuments({}), 0, "ni skeleton");
});

// ====================================================================
// 4 — Size inexistente -> rechazado
// ====================================================================

test("4 — talla inexistente para el producto -> 422 (comparado contra variants[].size real)", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p = await makeSizedProduct({ S: 5, M: 10 }); // no hay XXL
  await rejectsWithCode(
    () => createOrder(baseInput({ productId: p._id.toString(), quantity: 1, size: "XXL" })),
    ORDER_ERROR_CODES.INVALID_BUSINESS,
  );
  assert.equal((await productOf(p._id)).stock, 15, "stock intacto");
});

// ====================================================================
// 7 — Stock insuficiente de la talla -> rechazado
// ====================================================================

test("7 — talla con stock insuficiente -> 409 y stock intacto", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p = await makeSizedProduct({ S: 5, M: 1, L: 8 });
  await rejectsWithCode(
    () => createOrder(baseInput({ productId: p._id.toString(), quantity: 2, size: "M" })),
    ORDER_ERROR_CODES.STOCK_CONFLICT,
  );
  const after = await productOf(p._id);
  assert.equal(variantStock(after, "M"), 1, "variante M intacta");
  assert.equal(after.stock, 14, "agregado intacto");
  assert.equal(await OrderModel.countDocuments({}), 0, "ni skeleton");
});

test("7b — talla agotada (stock 0) -> 409", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p = await makeSizedProduct({ S: 5, M: 0 });
  await rejectsWithCode(
    () => createOrder(baseInput({ productId: p._id.toString(), quantity: 1, size: "M" })),
    ORDER_ERROR_CODES.STOCK_CONFLICT,
  );
});

// ====================================================================
// 8 — Stock de M no afecta stock de L
// ====================================================================

test("8 — comprar talla M no toca el stock de L ni de las demás", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p = await makeSizedProduct({ S: 5, M: 10, L: 8, XL: 2 });
  await createOrder(baseInput({ productId: p._id.toString(), quantity: 4, size: "M" }));

  const after = await productOf(p._id);
  assert.equal(variantStock(after, "S"), 5);
  assert.equal(variantStock(after, "M"), 6);
  assert.equal(variantStock(after, "L"), 8);
  assert.equal(variantStock(after, "XL"), 2);
  assert.equal(after.stock, 21, "agregado: 25 - 4");
});

// ====================================================================
// 10 — normalizeItems NO mezcla tallas
// ====================================================================

test("10 — dos líneas del mismo producto en tallas distintas -> DOS ítems, dos ops de stock", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p = await makeSizedProduct({ S: 5, M: 10, L: 8, XL: 2 });
  const id = p._id.toString();
  const order = await createOrder(
    baseInput({
      items: [
        { productId: id, quantity: 2, size: "M" },
        { productId: id, quantity: 1, size: "L" },
      ],
    }),
  );

  assert.equal(order.items.length, 2, "no se fusionan");
  const bySize = Object.fromEntries(order.items.map((it) => [it.size, it.quantity]));
  assert.deepEqual(bySize, { M: 2, L: 1 });

  const after = await productOf(p._id);
  // Que M baje 2 Y L baje 1 demuestra que los `operationId` de ambas líneas son
  // DISTINTOS: si hubieran colisionado, el guard de idempotencia
  // (`stockOps.id: { $ne: operationId }`) habría bloqueado el 2º decremento.
  assert.equal(variantStock(after, "M"), 8);
  assert.equal(variantStock(after, "L"), 7);
  assert.equal(after.stock, 22, "agregado: 25 - 3");
  // (los stockOps se podan tras finalizar — C-B — así que no se inspeccionan aquí)
  assert.notEqual(
    operationIdFor(order._id, p._id, "M"),
    operationIdFor(order._id, p._id, "L"),
    "operationId por talla es único",
  );
});

test("10b — mismas talla+producto en dos líneas SÍ se suman (M×2 + M×3 = M×5)", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p = await makeSizedProduct({ M: 20 });
  const id = p._id.toString();
  const order = await createOrder(
    baseInput({
      items: [
        { productId: id, quantity: 2, size: "M" },
        { productId: id, quantity: 3, size: "M" },
      ],
    }),
  );
  assert.equal(order.items.length, 1);
  assert.equal(order.items[0].quantity, 5);
  assert.equal(variantStock(await productOf(p._id), "M"), 15);
});

// ====================================================================
// 13 — Cancelación devuelve stock a la variante correcta
// ====================================================================

test("13 — cancelar un pedido con talla: restituye a variants[].size correcta + agregado", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p = await makeSizedProduct({ S: 5, M: 10, L: 8, XL: 2 });
  const order = await createOrder(baseInput({ productId: p._id.toString(), quantity: 3, size: "M" }));

  const mid = await productOf(p._id);
  assert.equal(variantStock(mid, "M"), 7);
  assert.equal(mid.stock, 22);

  const admin = { _id: new mongoose.Types.ObjectId(), role: "administrador" };
  const res = await transitionOrderStatus({
    orderId: order._id,
    toStatus: "cancelled",
    actor: admin,
    note: "cliente canceló",
  });
  assert.equal(res.ok, true);

  const after = await productOf(p._id);
  assert.equal(variantStock(after, "M"), 10, "M restituida");
  assert.equal(variantStock(after, "S"), 5, "S sin tocar");
  assert.equal(variantStock(after, "L"), 8, "L sin tocar");
  assert.equal(after.stock, 25, "agregado restituido");

  // restitución idempotente: una sola op :cancel para (orden, producto, talla)
  const cancelOps = after.stockOps.filter((o) => o.id.endsWith(":cancel"));
  assert.equal(cancelOps.length, 1);
  assert.equal(cancelOps[0].qty, 3);
  assert.equal(cancelOps[0].size, "M");
});

test("13b — cancelar es idempotente: re-ejecutar restock no duplica la devolución", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p = await makeSizedProduct({ M: 10 });
  const order = await createOrder(baseInput({ productId: p._id.toString(), quantity: 2, size: "M" }));
  const admin = { _id: new mongoose.Types.ObjectId(), role: "administrador" };
  await transitionOrderStatus({ orderId: order._id, toStatus: "cancelled", actor: admin, note: "x" });

  const { restockOrderInventory } = await import("../src/services/order.workflow.service.js");
  const fresh = await OrderModel.findById(order._id);
  await restockOrderInventory(fresh);
  await restockOrderInventory(fresh);

  assert.equal(variantStock(await productOf(p._id), "M"), 10, "restituida EXACTAMENTE una vez");
});

// ====================================================================
// 14 — Idempotencia sigue funcionando (con talla)
// ====================================================================

test("14 — idempotencia con talla: retry misma key -> misma orden, sin re-descontar la variante", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p = await makeSizedProduct({ M: 10 });
  const input = baseInput({ productId: p._id.toString(), quantity: 2, size: "M" });

  const first = await createOrder(input);
  const second = await createOrder(input);

  assert.equal(String(first._id), String(second._id));
  assert.equal(await OrderModel.countDocuments({}), 1);
  assert.equal(variantStock(await productOf(p._id), "M"), 8, "descontado UNA vez");
});

test("14b — concurrencia sobre la última unidad de una talla: una crea, una 409, variante nunca < 0", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p = await makeSizedProduct({ M: 1, L: 5 });
  const mk = () => createOrder(baseInput({ productId: p._id.toString(), quantity: 1, size: "M" }));
  const results = await Promise.allSettled([mk(), mk()]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);
  const after = await productOf(p._id);
  assert.equal(variantStock(after, "M"), 0, "nunca negativo");
  assert.equal(variantStock(after, "L"), 5, "L intacta");
});

// ====================================================================
// Compensación en línea (rollback multi-línea con tallas)
// ====================================================================

test("rollback — si una talla posterior no tiene stock, se restituyen las anteriores (variante + agregado)", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p = await makeSizedProduct({ S: 5, M: 10, L: 0 });
  const id = p._id.toString();
  await rejectsWithCode(
    () =>
      createOrder(
        baseInput({
          items: [
            { productId: id, quantity: 2, size: "S" },
            { productId: id, quantity: 2, size: "M" },
            { productId: id, quantity: 1, size: "L" }, // falla
          ],
        }),
      ),
    ORDER_ERROR_CODES.STOCK_CONFLICT,
  );
  const after = await productOf(p._id);
  assert.equal(variantStock(after, "S"), 5, "S restituida");
  assert.equal(variantStock(after, "M"), 10, "M restituida");
  assert.equal(variantStock(after, "L"), 0);
  assert.equal(after.stock, 15, "agregado restituido (5+10+0)");
  assert.equal(await OrderModel.countDocuments({}), 0, "skeleton eliminado");
});

// ====================================================================
// Matriz color×talla: fuera de alcance (documentado, NO es regresión)
// ====================================================================

test("scope — talla que coincide con >1 variante (matriz color×talla) -> 422 (requiere color)", async (t) => {
  if (skipIfNoMongo(t)) return;
  const p = await makeProduct({
    variants: [
      { sku: `A-${randomUUID().slice(0, 6)}`, color: "Negro", size: "M", stock: 5 },
      { sku: `B-${randomUUID().slice(0, 6)}`, color: "Blanco", size: "M", stock: 5 },
    ],
  });
  await rejectsWithCode(
    () => createOrder(baseInput({ productId: p._id.toString(), quantity: 1, size: "M" })),
    ORDER_ERROR_CODES.INVALID_BUSINESS,
  );
  const after = await productOf(p._id);
  assert.deepEqual(after.variants.map((v) => v.stock), [5, 5], "stock intacto");
});

// ====================================================================
// 16 / 17 — Editor: crear/editar stock por talla y autorización de escritura.
// Cubierto de forma EXHAUSTIVA en tests/product-fase5-variants.test.js:
//   · "F5 validation: variante válida (sku+color+talla+stock) se acepta y persiste"
//   · "F5 validation: stock negativo en variante se rechaza (creación / edición vía PATCH)"
//   · "F5 validation: stock decimal en variante se rechaza"
//   · "F5 security: editor AJENO no puede modificar variantes ... (403)"
//   · "F5 security: subscriber ... (403)"  (rol sin permiso de escritura de stock)
// No se duplican aquí para no divergir de esa suite.
// ====================================================================
