import CartModel from "../models/cart.model.js";

const dbCreateCart = async (cart) => {
    return await CartModel.create(cart);
};

const dbGetCarts = async () => {
    return await CartModel.find()
        .populate("userId")
        .populate("products.productId");
};

const dbGetCartById = async (id) => {
    return await CartModel.findById(id)
        .populate("userId")
        .populate("products.productId");
};

const dbUpdateCartById = async (id, cartUpdate) => {
    return await CartModel.findByIdAndUpdate(
        id,
        cartUpdate,
        { new: true }
    );
};

const dbDeleteCartById = async (id) => {
    return await CartModel.findByIdAndDelete(id);
};

export {
    dbCreateCart,
    dbGetCarts,
    dbGetCartById,
    dbUpdateCartById,
    dbDeleteCartById
};