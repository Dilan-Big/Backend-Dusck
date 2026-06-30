import {
    dbCreateProduct,
    dbDeleteProductById,
    dbGetProductById,
    dbGetProducts,
    dbUpdateProductById
} from "../services/products.services.js";

const createProduct = async (req, res) => {

    try {

        const inputData = req.body;

        const data = await dbCreateProduct(inputData);

        res.json({
            msg: "Se registra un producto",
            data
        });

    } catch (error) {

        console.error(error);

        res.json({
            msg: "Ocurrió un error al registrar el producto"
        });

    }

};

const getProducts = async (req, res) => {

    try {

        const data = await dbGetProducts();

        res.json({
            msg: "Se obtiene el listado de productos",
            data
        });

    } catch (error) {

        console.error(error);

        res.json({
            msg: "Ocurrió un error al obtener la lista de productos"
        });

    }

};

const getProductById = async (req, res) => {

    try {

        const id = req.params.id;

        const data = await dbGetProductById(id);

        res.json({
            msg: "Se obtiene un producto por ID",
            data
        });

    } catch (error) {

        console.error(error);

        res.json({
            msg: "Ocurrió un error al obtener el producto por ID"
        });

    }

};

const updateProductById = async (req, res) => {

    try {

        const id = req.params.id;

        const inputData = req.body;

        const data = await dbUpdateProductById(id, inputData);

        res.json({
            msg: "Se actualiza un producto por ID",
            data
        });

    } catch (error) {

        console.error(error);

        res.json({
            msg: "Ocurrió un error al actualizar el producto"
        });

    }

};

const deleteProductById = async (req, res) => {

    try {

        const id = req.params.id;

        const data = await dbDeleteProductById(id);

        res.json({
            msg: "Se elimina un producto por ID",
            data
        });

    } catch (error) {

        console.error(error);

        res.json({
            msg: "Ocurrió un error al eliminar el producto"
        });

    }

};

export {
    createProduct,
    getProducts,
    getProductById,
    updateProductById,
    deleteProductById
};