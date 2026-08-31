// import ProductModel from "../models/product.models.js";
import ProductModel from "../models/product.model.js"

const dbCreateProduct = async (product) => {
    return await ProductModel.create(product);
};

const dbGetProduct = async () => {
    return await ProductModel.find();
};

const dbGetProductById = async (id) => {
    return await ProductModel.findOne({
        _id: id
    });
};

// `productUpdate` YA viene filtrado por lista blanca desde el controller.
// Se envuelve SIEMPRE en $set (ninguna clave se interpreta como operador) y se
// activan los validadores del schema (min de price/stock, match de slug, etc.).
const dbUpdateProductById = async (id, productUpdate) => {
    return await ProductModel.findOneAndUpdate(
        { _id: id },                       // Objeto de consulta
        { $set: productUpdate },           // Datos a actualizar (solo $set)
        { new: true, runValidators: true } // Documento actualizado + validacion
    );
};

const dbDeleteProductById = async (id) => {
    return await ProductModel.findOneAndDelete({
        _id: id
    });
};

export {
    dbCreateProduct,
    dbGetProduct,
    dbGetProductById,
    dbUpdateProductById,
    dbDeleteProductById
};