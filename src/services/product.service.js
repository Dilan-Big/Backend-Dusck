import ProductModel from "../models/product.model.js"

const dbcreateProduct = async (product) => {
    return await ProductModel.create(product);
}

const dbGetProduct = async () => {
    return await ProductModel.find();
}

const dbGetProductById = async (id) => {
    return await ProductModel.findOne({_id: id});
}

export {
    dbcreateProduct,
    dbGetProduct
}