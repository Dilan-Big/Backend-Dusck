import { 
    dbCreateCategory,
    dbGetCategory
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
            msg: "Ocurrio un Error al obtener la categoria"
        });
    }
}

const getCategory = async (req, res) => {
    try {
        const data = await dbGetCategory();
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



export {
    createCategory,
    getCategory
}