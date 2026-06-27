import CategoryModel from "../models/category.model.js";

const dbCreateCategory = async (category) => {
    return await CategoryModel.create(category);
}

const dbGetCategories = async () => {
    return await CategoryModel.find();
}

const dbGetCategoryById = async (id) => {
    return await CategoryModel.findOne({_id: id})
}

const dbUpdateCategoryById = async (id, categoryUpdate) => {
    return await CategoryModel.findOneAndUpdate(
        { _id: id},
        categoryUpdate,
        { new: true}
    );
}

export {
    dbCreateCategory,
    dbGetCategories,
    dbGetCategoryById,
    dbUpdateCategoryById
}