import { Schema, model } from "mongoose";

const CartItemSchema = new Schema(
    {
        productId: {
            type: Schema.Types.ObjectId,
            ref: "product_b",
            required: [true, "El carrito necesita un producto"]
        },

        // TALLAS — talla seleccionada para un producto CON variantes. OPCIONAL:
        // un producto simple (variants: []) nunca la lleva y su línea se
        // comporta exactamente igual que antes de esta funcionalidad. NO es un
        // `variantId` ni una estructura de variantes nueva: es el mismo valor
        // de texto libre que ya vive en `product_b.variants[].size` (S/M/L/XL o
        // "Única"). La identidad de una línea del carrito es (productId + size):
        // dos tallas del mismo producto son dos líneas independientes, nunca se
        // fusionan. Items legados sin este campo siguen siendo válidos
        // (`size` ausente == producto simple).
        size: {
            type: String,
            trim: true,
            maxlength: [20, "La talla no puede exceder los 20 caracteres"]
        },

        quantity: {
            type: Number,
            required: [true, "Se necesita la cantidad de productos"],
            min: [1, "La cantidad mínima es 1"]
        }
    },
    {
        _id: false
    }
);

const CartSchema = new Schema(
    {
        userId: {
            type: Schema.Types.ObjectId,
            ref: "user",
            unique: true,
            required: [true, "El usuario es obligatorio"]
        },

        items: {
            type: [CartItemSchema],
            default: []
        }
    },
    {
        versionKey: false,
        timestamps: true
    }
);

const CartModel = model("cart", CartSchema);

export default CartModel;