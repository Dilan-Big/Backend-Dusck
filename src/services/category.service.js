import CategoryModel from "../models/category.model.js";

const dbCreateCategory = async (category) => {
    return await CategoryModel.create(category);
}

const dbGetCategory = async () => {
    return await CategoryModel.find();
}

const dbGetCategoryById = async (id) => {
    return await CategoryModel.findOne({_id: id})
}

export {
    dbCreateCategory,
    dbGetCategory,
    dbGetCategoryById
}