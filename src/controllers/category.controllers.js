import { 
    dbCreateCategory,
    dbGetCategories,
    dbGetCategoryById,
    dbUpdateCategoryById,
    dbDeleteCategoryById
 } from "../services/category.service.js";


const createCategory = async (req, res) => {
    try {
        const inputData = req.body
        const data = await dbCreateCategory(inputData)
        res.json({
            msg: "se registra la categoria",
            data
        })
    } catch (error) {
        res.json({
            msg: "Ocurrio un Error al registrar una  categoria"
        });
    }
}

const getCategory = async (req, res) => {
    try {
        const data = await dbGetCategories();
        res.json({
            msg: "Se obtiene listado por categoria",
            data,
        });
    } catch (error) {
        console.error(error);
        res.json({
            msg: "Ocurrio un error al obtner la categoria"
        });
    }
}

const getCategoryById = async (req, res) => {
    try {
        const id = req.params.id;
        const data = await dbGetCategoryById(id);
        res.json({
            msg: "Se obtiene una categoria por ID",
            data
        });
    } catch (error) {
        console.error(error);
        res.json({
            msg: "Ocurrio un error al obtener la categoria por ID"
        });
    }

}

const updateCategoryById = async (req, res) => {
    try {
        const id = req.params.id;
        const inputData = req.body;
        const data = await dbUpdateCategoryById(id, inputData);
        res.json({
            msg: "Se actuliza categoria por ID",
            data
        });
    } catch (error) {
        console.error(error);
        res.json({
            msg: "Ocurrio un error al actualizar categoria por ID"
        });
    }
}

const deleteCategoryById = async (req, res) => {
    try {
        const id = req.params.id;
        const data = await dbDeleteCategoryById(id);
        res.json({
            msg: "Se elimina categoria por ID",
            data,
        });
    } catch (error) {
        console.error(error);
        res.json({
            msg: "Ocurrio un error al eliminar categoria"
        });
    }
}

export {
    createCategory,
    getCategory,
    getCategoryById,
    updateCategoryById,
    deleteCategoryById
}