import CategoryModel from "../models/category.model.js";

const dbCreateCategory = async (category) => {
    return await CategoryModel.create(category);
}

export {
    dbCreateCategory
}