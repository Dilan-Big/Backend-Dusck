import {
    dbCreateCart,
    dbDeleteCartById,
    dbGetCartById,
    dbGetCarts,
    dbUpdateCartById
    
} from "../services/cart.service.js";

const createCart = async (req, res) => {

    try {

        const inputData = req.body;

        const data = await dbCreateCart(inputData);

        res.json({
            msg: "Se crea el carrito",
            data
        });

    } catch (error) {

        console.error(error);

        res.json({
            msg: "Ocurrió un error al crear el carrito"
        });

    }

};

const getCarts = async (req, res) => {

    try {

        const data = await dbGetCarts();

        res.json({
            msg: "Se obtiene el listado de carritos",
            data
        });

    } catch (error) {

        console.error(error);

        res.json({
            msg: "Ocurrió un error al obtener los carritos"
        });

    }

};

const getCartById = async (req, res) => {

    try {

        const id = req.params.id;

        const data = await dbGetCartById(id);

        res.json({
            msg: "Se obtiene un carrito por ID",
            data
        });

    } catch (error) {

        console.error(error);

        res.json({
            msg: "Ocurrió un error al obtener el carrito"
        });

    }

};

const updateCartById = async (req, res) => {

    try {

        const id = req.params.id;

        const inputData = req.body;

        const data = await dbUpdateCartById(id, inputData);

        res.json({
            msg: "Se actualiza el carrito",
            data
        });

    } catch (error) {

        console.error(error);

        res.json({
            msg: "Ocurrió un error al actualizar el carrito"
        });

    }

};

const deleteCartById = async (req, res) => {

    try {

        const id = req.params.id;

        const data = await dbDeleteCartById(id);

        res.json({
            msg: "Se elimina el carrito",
            data
        });

    } catch (error) {

        console.error(error);

        res.json({
            msg: "Ocurrió un error al eliminar el carrito"
        });

    }

};

export {
    createCart,
    getCarts,
    getCartById,
    updateCartById,
    deleteCartById
};