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

// F7-C — Contrato PÚBLICO de Category, mismo principio que Product (Regla
// §24: el backend es la barrera real, nunca el filtro `.isActive` que ya
// hacían `basicos.ts`/`category-list.ts` en Angular como defensa adicional).
// Category no tiene campos administrativos que proteger hoy (sin
// `createdBy`/workflow/metadata interna), así que la única diferencia con
// `dbGetCategories()` es el filtro `isActive:true` — no hace falta una
// proyección de campos aparte.
// F7-CLOSURE — la decisión de servir el contrato público vs. el completo la
// toma `category.controllers.js` (`?all=true` + rol admin-capable, mismo gate
// que `getProduct`); estas dos consultas son solo las dos ramas de datos.
const PUBLIC_CATEGORY_FILTER = { isActive: true };

const dbGetPublicCategories = async () => {
    return await CategoryModel.find(PUBLIC_CATEGORY_FILTER);
}

const dbGetPublicCategoryById = async (id) => {
    return await CategoryModel.findOne({ _id: id, ...PUBLIC_CATEGORY_FILTER });
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
    dbGetPublicCategories,
    dbGetPublicCategoryById,
    dbUpdateCategoryById,
    dbDeleteCategoryById
}