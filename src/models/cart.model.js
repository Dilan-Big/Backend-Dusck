import { Schema, model } from "mongoose";

const CartItemSchema = new Schema({
    productId: {
        type: Schema.Types.ObjectId,
        ref: "product",
        required: [true, "El producto es obligatorio"]
    },

    size: {
        type: String,
        required: [true, "La talla es obligatoria"],
        enum: ["XS", "S", "M", "L", "XL", "XXL"]
    },

    color: {
        type: String,
        required: [true, "El color es obligatorio"],
        trim: true
    },

    quantity: {
        type: Number,
        required: true,
        default: 1,
        min: [1, "La cantidad mínima es 1"]
    },

    price: {
        type: Number,
        required: [true, "El precio es obligatorio"],
        min: 0
    }

}, {
    _id: false
});

const CartSchema = new Schema({

    userId: {
        type: Schema.Types.ObjectId,
        ref: "user",
        required: [true, "El usuario es obligatorio"],
        unique: true
    },

    products: {
        type: [CartItemSchema],
        default: []
    },

    total: {
        type: Number,
        default: 0,
        min: 0
    }

}, {
    versionKey: false,
    timestamps: true
});

const CartModel = model("cart", CartSchema);

export default CartModel;