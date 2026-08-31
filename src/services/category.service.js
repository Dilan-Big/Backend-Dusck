import CategoryModel from "../models/category.model.js";

const dbCreateCategory = async (category) => {
    return await CategoryModel.create(category);
}

const dbGetCategories = async () => {
    return await CategoryModel.find();
}

const dbGetCategoryById = async (id) => {
    return await CategoryModel.findOne({_id: id});
}

// `categoryUpdate` YA viene filtrado por lista blanca desde el controller.
// Se envuelve SIEMPRE en $set para que ninguna clave del objeto pueda
// interpretarse como operador de actualizacion, y se activan los validadores
// del schema (enum, longitudes, match de slug, etc.).
const dbUpdateCategoryById = async (id, categoryUpdate) => {
    return await CategoryModel.findOneAndUpdate(
        { _id: id},
        { $set: categoryUpdate },
        { new: true, runValidators: true }
    );
}

const dbDeleteCategoryById = async (id) => {
    return await CategoryModel.findOneAndDelete(
        {_id: id}
    )
}

export {
    dbCreateCategory,
    dbGetCategories,
    dbGetCategoryById,
    dbUpdateCategoryById,
    dbDeleteCategoryById
}