import ProductModel from "../models/products.models.js";

const dbCreateProduct = async (product) => {
    return await ProductModel.create(product);
};

const dbGetProducts = async () => {
    return await ProductModel.find();
};

const dbGetProductById = async (id) => {
    return await ProductModel.findOne({
        _id: id
    });
};

const dbUpdateProductById = async (id, productUpdate) => {
    return await ProductModel.findOneAndUpdate(
        { _id: id },       // Objeto de consulta
        productUpdate,     // Datos a actualizar
        { new: true }      // Devuelve el documento actualizado
    );
};

const dbDeleteProductById = async (id) => {
    return await ProductModel.findOneAndDelete({
        _id: id
    });
};

export {
    dbCreateProduct,
    dbGetProducts,
    dbGetProductById,
    dbUpdateProductById,
    dbDeleteProductById
};