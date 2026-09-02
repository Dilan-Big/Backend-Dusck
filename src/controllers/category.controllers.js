import {
    dbCreateCategory,
    dbGetCategories,
    dbGetCategoryById,
    dbUpdateCategoryById,
    dbDeleteCategoryById
 } from "../services/category.service.js";
import { CATEGORY_UPDATABLE_FIELDS } from "../config/global.config.js";
import { isValidObjectId, pickAllowed } from "../helpers/validation.helpers.js";
import { sendWriteError } from "../helpers/writeError.helper.js";


const createCategory = async (req, res) => {
    try {
        const inputData = req.body
        const data = await dbCreateCategory(inputData)
        res.json({
            msg: "se registra la categoria",
            data
        })
    } catch (error) {
        return sendWriteError(res, error, "categoria");
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
        console.error(`Error al listar categorias -> ${error && error.name}`);
        res.status(500).json({
            msg: "Ocurrio un error al obtner la categoria"
        });
    }
}

const getCategoryById = async (req, res) => {
    try {
        const id = req.params.id;
        if (!isValidObjectId(id)) {
            return res.status(400).json({ msg: "El ID de la categoría no es válido" });
        }
        const data = await dbGetCategoryById(id);
        res.json({
            msg: "Se obtiene una categoria por ID",
            data
        });
    } catch (error) {
        console.error(`Error al obtener categoria por ID -> ${error && error.name}`);
        res.status(500).json({
            msg: "Ocurrio un error al obtener la categoria por ID"
        });
    }

}

const updateCategoryById = async (req, res) => {
    try {
        const id = req.params.id;

        // FASE 2 / S4 y REGLA 8: el ID debe ser un ObjectId valido.
        if (!isValidObjectId(id)) {
            return res.status(400).json({
                msg: "El ID de la categoría no es válido"
            });
        }

        // FASE 2 / S4: lista blanca por construccion. El cliente NO controla
        // que campos ni que operadores llegan a la actualizacion. Cualquier
        // clave fuera de CATEGORY_UPDATABLE_FIELDS (incluidos $set, $unset,
        // $rename, etc.) se descarta aqui.
        const safePayload = pickAllowed(req.body, CATEGORY_UPDATABLE_FIELDS);

        if (Object.keys(safePayload).length === 0) {
            return res.status(400).json({
                msg: "No se enviaron campos válidos para actualizar"
            });
        }

        const data = await dbUpdateCategoryById(id, safePayload);

        if (!data) {
            return res.status(404).json({
                msg: "La categoría no se encuentra registrada"
            });
        }

        res.json({
            msg: "Se actuliza categoria por ID",
            data
        });
    } catch (error) {
        return sendWriteError(res, error, "categoria");
    }
}

const deleteCategoryById = async (req, res) => {
    try {
        const id = req.params.id;
        if (!isValidObjectId(id)) {
            return res.status(400).json({ msg: "El ID de la categoría no es válido" });
        }
        const data = await dbDeleteCategoryById(id);
        res.json({
            msg: "Se elimina categoria por ID",
            data,
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({
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