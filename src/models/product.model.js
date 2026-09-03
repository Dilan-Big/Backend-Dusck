import { Schema, model } from "mongoose";
import { PRODUCT_STATUS, PRODUCT_STATUSES } from "../helpers/productWorkflow.helper.js";

// FASE 3 — Product Domain + Editor Workflow.
//
// Evoluciona el catálogo CRUD básico hacia un dominio que soporta:
//   - múltiples categorías (HOMBRE/MUJER son categorías, no un campo `gender`);
//   - variantes embebidas (color/talla/SKU/stock);
//   - workflow editorial (status) SEPARADO de la activación operacional (isActive);
//   - trazabilidad mínima de quién hizo qué (createdBy/updatedBy/submittedBy/...).
//
// Ver "Product Domain Design Proposal" (aprobado) para la justificación de
// cada decisión: subdocumentos embebidos para variantes, stock derivado
// cuando hay variantes, SKU con índice único parcial, etc.

const VariantSchema = new Schema(
  {
    // No es `required` a nivel de schema: un DRAFT puede tener una variante
    // a medio llenar. Se exige en `collectSubmitReviewErrors` (submit-review).
    sku: {
      type: String,
      trim: true,
      default: "",
      maxlength: [40, "El SKU no puede exceder los 40 caracteres"],
    },
    color: {
      type: String,
      trim: true,
      default: "",
      maxlength: [40, "El color no puede exceder los 40 caracteres"],
    },
    // Talla es opcional: hay productos (accesorios) sin talla.
    size: {
      type: String,
      trim: true,
      default: "",
      maxlength: [20, "La talla no puede exceder los 20 caracteres"],
    },
    stock: {
      type: Number,
      min: [0, "El stock de la variante no puede ser negativo"],
      default: 0,
    },
  },
  { versionKey: false },
);

const ProductSchema = new Schema(
  {
    name: {
      type: String,
      required: [true, "El nombre del producto es obligatorio"],
      trim: true,
      minlength: [2, "El nombre debe tener al menos 2 caracteres"],
      maxlength: [100, "El nombre no puede exceder los 100 caracteres"],
    },
    slug: {
      type: String,
      required: [true, "El slug es obligatorio"],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^[a-z0-9-]+$/, "El slug solo puede contener letras minúsculas, números y guiones medios"],
    },
    description: {
      type: String,
      trim: true,
      maxlength: [500, "La descripción no puede exceder los 500 caracteres"],
    },
    price: {
      type: Number,
      min: [0, "El precio no puede ser negativo"],
      default: 0,
    },

    // --- Categorización: relación N:M real (Regla oficial: HOMBRE/MUJER son
    // categorías, nunca un campo `gender`/`audience`). No es `required` a nivel
    // de schema (un DRAFT puede no tener categoría todavía); se exige al menos
    // 1 en `collectSubmitReviewErrors`.
    categories: {
      type: [{ type: Schema.Types.ObjectId, ref: "category" }],
      default: [],
    },

    // --- Media (URLs por ahora; ver §13 del diseño: sin Cloudinary/S3 todavía)
    images: {
      type: [
        {
          url: { type: String, required: [true, "La URL de la imagen es obligatoria"] },
          isMain: { type: Boolean, default: false },
        },
      ],
      default: [],
    },

    // --- Variantes: subdocumentos embebidos (decisión arquitectónica, ver
    // Design Proposal §4). [] significa "producto simple, sin variantes".
    variants: {
      type: [VariantSchema],
      default: [],
    },

    // Fuente de verdad del stock SOLO cuando `variants` está vacío. Cuando hay
    // variantes, este campo es un AGREGADO DERIVADO (suma de variants[].stock),
    // recalculado automáticamente (ver hooks más abajo) para no romper el
    // Carrito existente (`cart.service.js` sigue leyendo `product.stock`).
    stock: {
      type: Number,
      min: [0, "El stock no puede ser negativo"],
      default: 0,
    },

    // --- Publicación: status (workflow editorial) e isActive (activación
    // operacional) son EJES INDEPENDIENTES (Regla crítica del dominio).
    status: {
      type: String,
      enum: PRODUCT_STATUSES,
      default: PRODUCT_STATUS.DRAFT,
    },
    // Default `false`: un producto recién creado (DRAFT) nunca nace "activo".
    // Antes el default era `true`; es un cambio de comportamiento deliberado
    // (ver Design Proposal §8/§18 — Breaking Change documentado).
    isActive: {
      type: Boolean,
      default: false,
    },

    // --- Trazabilidad del workflow. Todos se derivan de `req.user._id` en el
    // controller; NUNCA se aceptan desde el body del cliente.
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "user",
      required: [true, "El creador del producto es obligatorio"],
    },
    updatedBy: { type: Schema.Types.ObjectId, ref: "user" },
    submittedBy: { type: Schema.Types.ObjectId, ref: "user" },
    submittedAt: { type: Date },
    approvedBy: { type: Schema.Types.ObjectId, ref: "user" },
    approvedAt: { type: Date },
    rejectedBy: { type: Schema.Types.ObjectId, ref: "user" },
    rejectedAt: { type: Date },
    // Obligatorio de negocio (no de schema) cuando status === REJECTED; se
    // valida explícitamente en el controller de transición para poder dar un
    // mensaje 400 claro en vez de un ValidationError genérico.
    rejectionReason: {
      type: String,
      trim: true,
      maxlength: [500, "El motivo de rechazo no puede exceder los 500 caracteres"],
    },
    publishedBy: { type: Schema.Types.ObjectId, ref: "user" },
    publishedAt: { type: Date },
  },
  {
    versionKey: false,
    timestamps: true,
  },
);

// Índice único PARCIAL sobre `variants.sku`: solo se exige unicidad cuando el
// SKU es una cadena no vacía. Así un DRAFT con variantes a medio llenar
// (sku: "") nunca choca con otro DRAFT en el mismo estado. MongoDB indexa
// cada elemento del array (multikey), así que esto además impide DOS
// variantes con el mismo SKU dentro del MISMO producto, no solo entre
// productos distintos. Es la SEGUNDA línea de defensa: la primera es la
// validación explícita en `product.services.js` (assertNoDuplicateSkus),
// que da un 409 semántico antes de tocar Mongo.
ProductSchema.index(
  { "variants.sku": 1 },
  {
    unique: true,
    partialFilterExpression: { "variants.sku": { $type: "string", $gt: "" } },
  },
);

ProductSchema.index({ categories: 1 });
ProductSchema.index({ status: 1, isActive: 1 });

// Mantiene `stock` como agregado derivado cuando el producto tiene variantes.
// Cubre el camino de escritura `ProductModel.create()` (dispara `save`).
//
// Mongoose 9 / Kareem: los hooks `pre` ya NO reciben un callback `next` (estilo
// promesa/async-only) — continuar es simplemente retornar (o no lanzar).
ProductSchema.pre("save", function () {
  if (this.variants && this.variants.length > 0) {
    this.stock = this.variants.reduce((sum, v) => sum + (Number(v.stock) || 0), 0);
  }
});

// Cubre el camino de escritura `findOneAndUpdate` (usado por los services de
// producto), que NO dispara hooks de `save`.
ProductSchema.pre("findOneAndUpdate", function () {
  const update = this.getUpdate() || {};
  const target = update.$set || update;
  if (Array.isArray(target.variants) && target.variants.length > 0) {
    target.stock = target.variants.reduce((sum, v) => sum + (Number(v.stock) || 0), 0);
    if (update.$set) {
      update.$set = target;
    } else {
      this.setUpdate(target);
    }
  }
});

const ProductModel = model("product_b", ProductSchema);

export default ProductModel;
