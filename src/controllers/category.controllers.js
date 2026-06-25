import { dbCreateCategory } from "../services/category.service.js";


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

export {
    createCategory
}