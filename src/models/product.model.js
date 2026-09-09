import { Schema, model } from "mongoose";
import {
  PRODUCT_STATUS,
  PRODUCT_STATUSES,
  WORKFLOW_ACTIONS,
} from "../helpers/productWorkflow.helper.js";
import { STOCK_OP_STATE, STOCK_OP_STATES } from "../helpers/orderWorkflow.helper.js";

// FASE 1 — clasificación de cada imagen del producto. Ortogonal a `isMain`:
// `isMain` designa LA imagen principal (una sola); `type` clasifica el encuadre
// (catálogo/frontal = MAIN, foto con modelo = MODEL, detalle/textura = DETAIL).
// La imagen `isMain` SIEMPRE queda con `type: "MAIN"` (lo fuerza
// `normalizeProductImages` en el service). Ver §13 de la fase.
export const PRODUCT_IMAGE_TYPES = Object.freeze(["MAIN", "MODEL", "DETAIL"]);

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
    // F5-CLOSURE — talla OBLIGATORIA para toda variante nueva/actualizada
    // (decisión de negocio definitiva, ver F5-CLOSURE report). Productos sin
    // tallaje (accesorios) usan literalmente `size: "Única"` — NO se añade un
    // campo booleano nuevo (hasSize/requiresSize/etc.), es el mismo campo con
    // un valor convencional.
    //   `default:""` + el validador de abajo cubren OMITIDO/NULL/""/"   " con
    //   UN solo mecanismo: si el campo no llega, el default lo deja en "" y el
    //   validador lo rechaza igual que una cadena vacía explícita; `trim:true`
    //   normaliza "   " -> "" en el cast, ANTES de validar.
    //   Documentos LEGACY ya persistidos con talla vacía/ausente NO se tocan
    //   (no hay migración): siguen siendo legibles y editables en campos que
    //   no toquen `variants`; solo una escritura NUEVA que (re)persista esa
    //   variante queda bloqueada por este validador.
    size: {
      type: String,
      trim: true,
      default: "",
      maxlength: [20, "La talla no puede exceder los 20 caracteres"],
      validate: {
        validator: (v) => typeof v === "string" && v.trim().length > 0,
        message: 'La talla es obligatoria (usa "Única" si el producto no tiene tallaje)',
      },
    },
    // FASE 5 — entero obligatorio (mismo patrón que `StockOpSchema.qty` más
    // abajo): "3.5 unidades" no es una cantidad de inventario válida. `min:0`
    // ya existía desde FASE 3; el validador de entero es aditivo, nunca se
    // relajó nada existente.
    stock: {
      type: Number,
      min: [0, "El stock de la variante no puede ser negativo"],
      default: 0,
      validate: {
        validator: (v) => v === undefined || v === null || Number.isInteger(v),
        message: "El stock de la variante debe ser un número entero",
      },
    },
  },
  { versionKey: false },
);

// --- stockOps[] — LEDGER de operaciones de inventario (F4.3-B-R2.2) -----
// AUTORIDAD de la mutación de inventario del checkout, CO-LOCALIZADA con `stock`
// en el mismo documento para que "descontar stock" y "registrar la operación"
// sean UNA sola escritura atómica (imposible con el ledger previo en Order, que
// vivía en otro documento). `order.service.js` y un futuro reaper consultan aquí
// —NO en `Order.stockAdjustments`, que es solo advisory— para saber si el stock
// de una línea de pedido se movió y si ya fue restituido.
//
//   id             `${order._id}:${productId}` — determinístico, reconstruible en
//                  recovery. Una sola operación por (orden, producto): `normalizeItems`
//                  colapsa los productos duplicados ANTES de generar el id.
//   qty            unidades retiradas de `stock` por esta operación (todo-o-nada
//                  por línea). Inmutable. La compensación restaura EXACTAMENTE este
//                  valor (autoridad = el documento, no el caller).
//   state          decremented -> compensated (terminal). El `$inc +qty` y el
//                  cambio de estado ocurren en la MISMA operación atómica
//                  (update pipeline) — cierra la ventana "state cambiado / stock
//                  sin restaurar".
//   at             instante (commit) del decremento.
//   compensatedAt  (solo auditoría) instante de la restitución; no participa en
//                  ninguna decisión de lógica.
//
// Poda: SIEMPRE tras `Order.finalized === true` (nunca antes, nunca solo por
// edad). Sin índice: el lookup va siempre acotado por `_id` del producto.
const StockOpSchema = new Schema(
  {
    id: {
      type: String,
      required: [true, "Cada operación de stock necesita un identificador"],
      trim: true,
    },
    qty: {
      type: Number,
      required: [true, "Cada operación de stock necesita una cantidad"],
      min: [1, "La cantidad de la operación de stock debe ser al menos 1"],
      validate: {
        validator: Number.isInteger,
        message: "La cantidad de la operación de stock debe ser un número entero",
      },
    },
    // TALLAS — talla de la variante que esta operación movió, cuando el producto
    // tiene variantes. Opcional (ausente == producto simple, mismo camino de
    // inventario de siempre sobre `Product.stock`). La compensación
    // (`compensateProductOp`, update pipeline) LEE este valor del propio registro
    // para saber a qué `variants[].stock` devolver `qty` — nunca lo recibe del
    // caller (misma autoridad-en-el-documento que `qty`).
    size: {
      type: String,
      trim: true,
    },
    state: {
      type: String,
      enum: {
        values: STOCK_OP_STATES,
        message: "El estado de la operación de stock no es válido",
      },
      default: STOCK_OP_STATE.DECREMENTED,
    },
    at: { type: Date, default: Date.now },
    // Solo auditoría: cuándo se restituyó el stock. No se lee para ninguna decisión.
    compensatedAt: { type: Date, default: null },
  },
  { _id: false },
);

// --- workflowHistory[] — bitácora append-only del ciclo editorial (FASE 1) --
// Registra CADA transición de `status`: qué acción, desde/hacia qué estado,
// quién y cuándo, y el comentario asociado (obligatorio en REJECTED y
// CHANGES_REQUESTED). Es la fuente histórica COMPLETA; `rejectionReason` se
// conserva solo como espejo del último rechazo (compat de contrato).
// El controller de transición la puebla con `$push` en la MISMA escritura
// atómica del cambio de estado. Nunca se acepta desde el body del cliente.
const WorkflowHistoryEntrySchema = new Schema(
  {
    action: {
      type: String,
      required: [true, "Cada entrada del historial necesita una acción"],
      enum: {
        values: WORKFLOW_ACTIONS,
        message: "La acción del historial de workflow no es válida",
      },
    },
    fromStatus: {
      type: String,
      enum: { values: PRODUCT_STATUSES, message: "El estado de origen del historial no es válido" },
    },
    toStatus: {
      type: String,
      required: [true, "Cada entrada del historial necesita un estado destino"],
      enum: { values: PRODUCT_STATUSES, message: "El estado destino del historial no es válido" },
    },
    by: { type: Schema.Types.ObjectId, ref: "user" },
    at: { type: Date, default: Date.now },
    comment: {
      type: String,
      trim: true,
      maxlength: [500, "El comentario del historial no puede exceder los 500 caracteres"],
    },
  },
  { _id: false, versionKey: false },
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

    // --- Contenido editorial largo (FASE 1). Todos OPCIONALES a nivel de
    // schema (un DRAFT puede no tenerlos y los productos legados siguen siendo
    // válidos). `collectSubmitReviewErrors` los exige para ENVIAR A REVISIÓN.
    details: {
      type: String,
      trim: true,
      maxlength: [2000, "Los detalles no pueden exceder los 2000 caracteres"],
      default: "",
    },
    shippingInfo: {
      type: String,
      trim: true,
      maxlength: [2000, "La información de envíos no puede exceder los 2000 caracteres"],
      default: "",
    },
    returnsInfo: {
      type: String,
      trim: true,
      maxlength: [2000, "La información de cambios y devoluciones no puede exceder los 2000 caracteres"],
      default: "",
    },

    // --- Información del modelo (FASE 1). Estructurada, NO texto libre dentro
    // de `description`. `heightCm` es SIEMPRE numérico y en centímetros — la
    // presentación "1.87 m" es responsabilidad del frontend. Ambos opcionales:
    // no todo producto lleva foto de modelo.
    modelInfo: {
      size: {
        type: String,
        trim: true,
        maxlength: [20, "La talla del modelo no puede exceder los 20 caracteres"],
        default: "",
      },
      heightCm: {
        type: Number,
        min: [50, "La altura del modelo (cm) es demasiado baja"],
        max: [260, "La altura del modelo (cm) es demasiado alta"],
        validate: {
          validator: (v) => v === undefined || v === null || Number.isInteger(v),
          message: "La altura del modelo debe ser un número entero de centímetros",
        },
      },
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

    // --- Media (URLs por ahora; sin Cloudinary/S3/multer todavía — eso es
    // FASE 4). FASE 1 añade `type` / `order` / `alt` a cada imagen SIN romper
    // `url` ni `isMain`. `_id` lo genera Mongoose (identificador de subdoc).
    // Los objetos legados `{ url, isMain }` siguen siendo válidos: `type`,
    // `order` y `alt` toman su `default` al leerse.
    //
    // F1-CLOSURE-1: `type: "MAIN"` <=> `isMain: true` (sincronizados por
    // `normalizeProductImages` en cada escritura). El `default: "MAIN"` mantiene
    // coherente al doc legado de UNA imagen `{ url, isMain:true }` en LECTURA;
    // en cualquier ESCRITURA la normalización degrada a "DETAIL" toda imagen
    // "MAIN" que no sea la principal.
    images: {
      type: [
        {
          url: { type: String, required: [true, "La URL de la imagen es obligatoria"] },
          isMain: { type: Boolean, default: false },
          type: {
            type: String,
            enum: {
              values: PRODUCT_IMAGE_TYPES,
              message: "El tipo de imagen debe ser MAIN, MODEL o DETAIL",
            },
            default: "MAIN",
          },
          order: {
            type: Number,
            default: 0,
            min: [0, "El orden de la imagen no puede ser negativo"],
          },
          alt: {
            type: String,
            trim: true,
            maxlength: [160, "El texto alternativo no puede exceder los 160 caracteres"],
            default: "",
          },
          // FASE 4 — identificador del asset en Cloudinary (`result.public_id`).
          // Solo lo escribe el backend (POST /product/:id/images), NUNCA el
          // cliente: `dbUpdateProductById` descarta cualquier `publicId` que
          // llegue en el body y lo reconstruye por coincidencia de `url` contra
          // lo ya persistido (ver product.services.js). "" en imágenes legadas
          // pegadas por URL manual (nunca pasaron por Cloudinary) — no hay nada
          // que borrar en Cloudinary para esas.
          publicId: {
            type: String,
            trim: true,
            default: "",
          },
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

    // Ledger de operaciones de inventario del checkout (F4.3-B-R2.2). Ver
    // `StockOpSchema` arriba. Autoridad de la mutación de stock; poblado y podado
    // por `order.service.js`. Vacío en productos que nunca han entrado a un
    // checkout y en documentos legados (compat vía `default: []`).
    stockOps: {
      type: [StockOpSchema],
      default: [],
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

    // --- Bitácora append-only del ciclo editorial (FASE 1). Ver
    // `WorkflowHistoryEntrySchema` arriba. La puebla EXCLUSIVAMENTE el
    // controller de transición (`$push` atómico); nunca el body del cliente.
    // `default: []` -> documentos legados son válidos sin historial.
    workflowHistory: {
      type: [WorkflowHistoryEntrySchema],
      default: [],
    },
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

// FASE 1 — §13 / F1-CLOSURE-1: UNA sola fuente lógica de la imagen principal.
// `type: "MAIN"` <=> `isMain: true` (equivalentes y SINCRONIZADOS: exactamente
// uno). "MODEL" / "DETAIL" clasifican el resto. Normaliza el array IN PLACE.
//
// Criterio DETERMINISTA de selección de la principal (cuando hay imágenes):
//   1. la PRIMERA imagen con `isMain === true`;
//   2. si ninguna está marcada -> la PRIMERA imagen del array (posición 0).
// NO se usa el campo `order` (metadata editable por el editor, no autoridad):
// la posición del array es lo que ya consume el frontend (`images[0]`).
//
// Contrato garantizado tras normalizar (array con ≥1 imagen no nula):
//   · exactamente UNA imagen con `isMain: true`;
//   · esa imagen con `type: "MAIN"` (gana `isMain` ante `isMain:true`+`type:"DETAIL"`);
//   · TODAS las demás con `isMain: false` y `type ∈ {"MODEL","DETAIL"}` — nunca
//     "MAIN": una NO-principal que venga (o defaultee) a "MAIN" se degrada a
//     "DETAIL" (bucket genérico no-principal).
//   · un `type` explícito "MODEL"/"DETAIL" en una NO-principal se respeta.
//
// Funciona con subdocumentos Mongoose (hook `save`) y con objetos planos del
// payload de `findOneAndUpdate`.
export function normalizeProductImages(images) {
  if (!Array.isArray(images) || images.length === 0) return;
  let mainIdx = images.findIndex((img) => img && img.isMain === true);
  if (mainIdx === -1) mainIdx = images.findIndex((img) => !!img);
  if (mainIdx === -1) return; // array sólo con huecos (null/undefined): nada que promover
  images.forEach((img, i) => {
    if (!img) return;
    if (i === mainIdx) {
      img.isMain = true;
      img.type = "MAIN";
    } else {
      img.isMain = false;
      // Ninguna NO-principal puede quedar con "MAIN" (ni por default ni por
      // conflicto). "MODEL"/"DETAIL" explícitos se conservan.
      if (img.type == null || img.type === "MAIN") img.type = "DETAIL";
    }
  });
}

// Mantiene `stock` como agregado derivado cuando el producto tiene variantes,
// y normaliza la imagen principal. Cubre el camino de escritura
// `ProductModel.create()` (dispara `save`).
//
// Mongoose 9 / Kareem: los hooks `pre` ya NO reciben un callback `next` (estilo
// promesa/async-only) — continuar es simplemente retornar (o no lanzar).
ProductSchema.pre("save", function () {
  if (this.variants && this.variants.length > 0) {
    this.stock = this.variants.reduce((sum, v) => sum + (Number(v.stock) || 0), 0);
  }
  if (this.isModified("images")) {
    normalizeProductImages(this.images);
  }
});

// Cubre el camino de escritura `findOneAndUpdate` (usado por los services de
// producto), que NO dispara hooks de `save`. NO recalcula `stock` por sí mismo
// (el checkout usa `$inc`/`$push` sin `variants`/`images`, y este hook los
// ignora — comportamiento verificado en product-inventory-ops).
ProductSchema.pre("findOneAndUpdate", function () {
  const update = this.getUpdate() || {};
  const target = update.$set || update;
  let touched = false;
  if (Array.isArray(target.variants) && target.variants.length > 0) {
    target.stock = target.variants.reduce((sum, v) => sum + (Number(v.stock) || 0), 0);
    touched = true;
  }
  if (Array.isArray(target.images)) {
    normalizeProductImages(target.images);
    touched = true;
  }
  if (touched) {
    if (update.$set) {
      update.$set = target;
    } else {
      this.setUpdate(target);
    }
  }
});

const ProductModel = model("product_b", ProductSchema);

export default ProductModel;
