// FASE 2 / S4 — Tests unitarios (sin base de datos).
// Ejecutar: npm test   (usa el runner nativo de Node, sin dependencias nuevas).
//
// Cubren:
//   - la defensa global guardNoSqlInjection sobre req.body
//   - los validadores de tipo (helpers/validation.helpers.js)
//   - el rechazo TEMPRANO en los controllers (defensa en profundidad):
//     el ataque no "falla por casualidad", se corta antes de tocar Mongoose.

import test from "node:test";
import assert from "node:assert/strict";

import { guardNoSqlInjection } from "../src/middleware/mongoSanitize.middleware.js";
import {
  isPlainString,
  isValidObjectId,
  isFiniteInteger,
  findMongoOperatorKey,
  pickAllowed,
} from "../src/helpers/validation.helpers.js";
import { CATEGORY_UPDATABLE_FIELDS } from "../src/config/global.config.js";
import { PRODUCT_ALL_UPDATABLE_FIELDS } from "../src/helpers/productWorkflow.helper.js";
import { loginUser } from "../src/controllers/auth.controllers.js";
import { updateMyCart } from "../src/controllers/cart.controller.js";
import { updateCategoryById } from "../src/controllers/category.controllers.js";
import { updateProductById } from "../src/controllers/product.controllers.js";

// --- helpers de test -------------------------------------------------------

const mockRes = () => {
  const res = { statusCode: 200, body: undefined, ended: false };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    res.body = payload;
    res.ended = true;
    return res;
  };
  return res;
};

const runGuard = (body) => {
  const req = { body, method: "POST", originalUrl: "/api/test" };
  const res = mockRes();
  let nextCalled = false;
  guardNoSqlInjection(req, res, () => {
    nextCalled = true;
  });
  return { res, nextCalled };
};

const VALID_OID = "507f1f77bcf86cd799439011";

// --- guardNoSqlInjection: RECHAZA operadores / paths -----------------------

test("guard: rechaza { email: { $ne: null } } con 400", () => {
  const { res, nextCalled } = runGuard({ email: { $ne: null }, password: "x" });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 400);
});

test("guard: rechaza $gt, $regex, $where, $or a cualquier profundidad", () => {
  for (const body of [
    { email: { $gt: "" } },
    { email: { $regex: ".*" } },
    { $where: "1==1" },
    { filtro: { $or: [{ a: 1 }] } },
    { a: { b: { c: { $ne: 1 } } } }, // anidado profundo
    { items: [{ productId: { $in: [1, 2] } }] }, // dentro de un array
  ]) {
    const { res, nextCalled } = runGuard(body);
    assert.equal(nextCalled, false, `deberia rechazar: ${JSON.stringify(body)}`);
    assert.equal(res.statusCode, 400);
  }
});

test("guard: rechaza operadores de actualizacion ($set, $unset, $rename, $inc)", () => {
  for (const body of [
    { $set: { role: "administrador" } },
    { $unset: { price: 1 } },
    { $rename: { slug: "name" } },
    { $inc: { stock: 999 } },
  ]) {
    const { res, nextCalled } = runGuard(body);
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 400);
  }
});

test("guard: rechaza claves con punto (paths anidados)", () => {
  const { res, nextCalled } = runGuard({ "items.0.quantity": 5 });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 400);
});

// --- guardNoSqlInjection: PERMITE payloads legitimos ----------------------

test("guard: permite un login normal", () => {
  const { res, nextCalled } = runGuard({
    email: "user@dusck.com",
    password: "secret123",
  });
  assert.equal(nextCalled, true);
  assert.equal(res.ended, false);
});

test("guard: NO rechaza un valor de texto que contiene '$' o '.'", () => {
  const { nextCalled } = runGuard({
    name: "Producto $pecial 2.0",
    description: "Cuesta $10.99 en la web dusck.com",
  });
  assert.equal(nextCalled, true);
});

test("guard: permite estructuras anidadas legitimas (product images / body vacio)", () => {
  assert.equal(runGuard({}).nextCalled, true);
  assert.equal(
    runGuard({
      name: "Camiseta",
      price: 20,
      images: [{ url: "http://x/y.png", isMain: true }],
    }).nextCalled,
    true
  );
});

// --- validadores de tipo -------------------------------------------------

test("isPlainString solo acepta strings primitivos", () => {
  assert.equal(isPlainString("hola"), true);
  assert.equal(isPlainString(""), true);
  assert.equal(isPlainString(5), false);
  assert.equal(isPlainString(null), false);
  assert.equal(isPlainString({ $ne: null }), false);
  assert.equal(isPlainString(["a"]), false);
});

test("isValidObjectId exige string con formato ObjectId", () => {
  assert.equal(isValidObjectId(VALID_OID), true);
  assert.equal(isValidObjectId("no-es-un-id"), false);
  assert.equal(isValidObjectId(123), false);
  assert.equal(isValidObjectId({ $ne: null }), false);
  assert.equal(isValidObjectId(null), false);
});

test("isFiniteInteger rechaza decimales, NaN, Infinity, strings y objetos", () => {
  assert.equal(isFiniteInteger(3), true);
  assert.equal(isFiniteInteger(-2), true);
  assert.equal(isFiniteInteger(0), true);
  assert.equal(isFiniteInteger(1.5), false);
  assert.equal(isFiniteInteger(NaN), false);
  assert.equal(isFiniteInteger(Infinity), false);
  assert.equal(isFiniteInteger("3"), false);
  assert.equal(isFiniteInteger({ $gt: 0 }), false);
});

test("findMongoOperatorKey devuelve la clave ofensiva o null", () => {
  assert.equal(findMongoOperatorKey({ a: 1, b: "x" }), null);
  assert.equal(findMongoOperatorKey({ a: { $ne: 1 } }), "$ne");
  assert.equal(findMongoOperatorKey({ "x.y": 1 }), "x.y");
  assert.equal(findMongoOperatorKey("solo-texto-$"), null);
});

// --- allowlist: mass assignment ----------------------------------------

test("pickAllowed descarta campos no permitidos (mass assignment)", () => {
  const out = pickAllowed(
    { name: "X", price: 10, createdBy: "hack", isActive: false, __proto__: {} },
    PRODUCT_ALL_UPDATABLE_FIELDS
  );
  assert.deepEqual(Object.keys(out).sort(), ["isActive", "name", "price"]);
  assert.equal("createdBy" in out, false);
});

test("pickAllowed descarta operadores de actualizacion como claves", () => {
  const out = pickAllowed(
    { $unset: { price: 1 }, $set: { role: "administrador" }, name: "ok" },
    CATEGORY_UPDATABLE_FIELDS
  );
  assert.deepEqual(out, { name: "ok" });
});

// --- controllers: rechazo TEMPRANO (defensa en profundidad) -------------
// Se llaman directamente, simulando que el guard global fue esquivado.
// Deben cortar ANTES de llamar a la capa de servicio / Mongoose.

test("loginUser: email objeto -> 400 y NO autentica (sin tocar la BD)", async () => {
  const req = { body: { email: { $ne: null }, password: "loquesea" } };
  const res = mockRes();
  await loginUser(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.token, undefined);
});

test("loginUser: password objeto -> 400", async () => {
  const req = { body: { email: "a@b.com", password: { $ne: null } } };
  const res = mockRes();
  await loginUser(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.token, undefined);
});

test("updateMyCart: productId objeto -> 400 (sin tocar la BD)", async () => {
  const req = {
    payload: { _id: VALID_OID },
    body: { productId: { $ne: null }, quantity: 1 },
  };
  const res = mockRes();
  await updateMyCart(req, res);
  assert.equal(res.statusCode, 400);
});

test("updateMyCart: quantity objeto / decimal / fuera de rango -> 400", async () => {
  for (const quantity of [{ $gt: 0 }, 1.5, 0, 999, -999, "2"]) {
    const req = {
      payload: { _id: VALID_OID },
      body: { productId: VALID_OID, quantity },
    };
    const res = mockRes();
    await updateMyCart(req, res);
    assert.equal(res.statusCode, 400, `quantity=${JSON.stringify(quantity)}`);
  }
});

test("cart delta: -1 y +1 son enteros validos dentro de rango (contrato del carrito)", () => {
  // El frontend envia -1 para restar una unidad. La validacion de tipo del
  // controller es: entero finito, distinto de cero, |delta| <= 100.
  const isValidDelta = (q) => isFiniteInteger(q) && q !== 0 && Math.abs(q) <= 100;
  assert.equal(isValidDelta(-1), true);
  assert.equal(isValidDelta(1), true);
  assert.equal(isValidDelta(0), false);
  assert.equal(isValidDelta(1.5), false);
  assert.equal(isValidDelta(101), false);
  assert.equal(isValidDelta({ $gt: 0 }), false);
});

test("updateCategoryById: body con $unset -> 400, no llega a Mongoose", async () => {
  const req = { params: { id: VALID_OID }, body: { $unset: { name: 1 } } };
  const res = mockRes();
  await updateCategoryById(req, res);
  assert.equal(res.statusCode, 400);
});

test("updateCategoryById: id invalido -> 400", async () => {
  const req = { params: { id: "xxx" }, body: { name: "ok" } };
  const res = mockRes();
  await updateCategoryById(req, res);
  assert.equal(res.statusCode, 400);
});

test("updateProductById: body solo con $inc / campos no permitidos -> 400", async () => {
  for (const body of [{ $inc: { stock: 10 } }, { createdBy: "x" }, { foo: 1 }]) {
    const req = { params: { id: VALID_OID }, body };
    const res = mockRes();
    await updateProductById(req, res);
    assert.equal(res.statusCode, 400, JSON.stringify(body));
  }
});
