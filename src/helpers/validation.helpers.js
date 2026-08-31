// Validadores de tipo para los "bordes de confianza" (controllers).
// FASE 2 / S4: el objetivo NO es convertir todo a String, sino comprobar
// el tipo REAL antes de construir cualquier consulta/actualizacion Mongoose.

import mongoose from "mongoose";

// true solo si el valor es un string primitivo (no String object, no null).
const isPlainString = (value) => typeof value === "string";

// true si el valor es un string que ademas es un ObjectId de Mongo valido.
// Se exige string primero: mongoose.isValidObjectId acepta numbers, buffers,
// objetos de 12 bytes, etc. — aqui solo queremos el formato hex de 24 chars
// que envia el frontend.
const isValidObjectId = (value) =>
  isPlainString(value) && mongoose.Types.ObjectId.isValid(value) &&
  String(new mongoose.Types.ObjectId(value)) === value.toLowerCase();

// true si el valor es un entero finito (number primitivo).
const isFiniteInteger = (value) =>
  typeof value === "number" && Number.isInteger(value);

// Detecta claves que MongoDB interpretaria como operador ($...) o como path
// anidado (con punto). Recorre objetos y arrays de forma recursiva.
// Devuelve la primera clave sospechosa encontrada, o null si no hay ninguna.
const MAX_DEPTH = 20;

const findMongoOperatorKey = (value, depth = 0) => {
  if (depth > MAX_DEPTH) {
    // Estructura absurdamente anidada: la tratamos como sospechosa.
    return "<estructura demasiado anidada>";
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findMongoOperatorKey(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  // Solo nos interesan los objetos "plano". Strings, numbers, booleans y null
  // no pueden convertirse en operadores por si mismos.
  if (value === null || typeof value !== "object") return null;

  for (const key of Object.keys(value)) {
    if (key.startsWith("$")) return key;
    if (key.includes(".")) return key;

    const found = findMongoOperatorKey(value[key], depth + 1);
    if (found) return found;
  }

  return null;
};

// Copia hacia un objeto NUEVO unicamente las claves de `allowed` presentes en
// `source` (lista blanca por construccion). Lo que no esta en `allowed` nunca
// llega a la base de datos. No valida tipos: eso lo hace cada controller segun
// el campo.
const pickAllowed = (source = {}, allowed = []) => {
  const result = {};
  for (const key of allowed) {
    if (
      Object.prototype.hasOwnProperty.call(source, key) &&
      source[key] !== undefined
    ) {
      result[key] = source[key];
    }
  }
  return result;
};

export {
  isPlainString,
  isValidObjectId,
  isFiniteInteger,
  findMongoOperatorKey,
  pickAllowed,
};
