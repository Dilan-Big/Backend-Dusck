import { Schema, model } from "mongoose";

// FASE 4.3-A — Estructura persistente para secuencias atómicas.
//
// Sirve para generar `Order.orderNumber` (DUSCK-AAAA-NNNNNN) sin colisiones:
// un documento por clave (p. ej. `_id: "order-2026"`) cuyo `seq` se incrementa
// con un `findOneAndUpdate({ $inc: { seq: 1 } }, { upsert: true, new: true })`
// atómico — el mismo patrón de atomicidad que ya usa el workflow de Product.
//
// ALCANCE F4.3-A: SOLO el modelo/estructura. El SERVICIO generador
// (`getNextOrderNumber` o equivalente) NO se implementa en esta fase; llega en
// F4.3-B junto con `POST /api/orders`.

const CounterSchema = new Schema(
  {
    // Clave de la secuencia, provista por quien la consume (no autogenerada).
    // Ej.: "order-2026". Es un String a propósito (no ObjectId).
    _id: {
      type: String,
      required: [true, "La clave del contador es obligatoria"],
      trim: true,
    },

    // Último valor entregado. Arranca en 0; el primer $inc devuelve 1.
    seq: {
      type: Number,
      required: true,
      default: 0,
      min: [0, "La secuencia no puede ser negativa"],
    },
  },
  {
    versionKey: false,
    timestamps: true,
  },
);

const CounterModel = model("counter", CounterSchema);

export default CounterModel;
