import { Schema, model } from "mongoose";

const CartItemSchema = new Schema(
    {
        productId: {
            type: Schema.Types.ObjectId,
            ref: "product_b",
            required: [true, "El carrito necesita un producto"]
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