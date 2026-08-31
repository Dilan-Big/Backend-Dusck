import {
    dbDeleteCartByUserId,
    dbGetCart,
    dbGetOrCreateCartByUserId,
    dbRemoveCartItemByUserId,
    dbUpdateCartByUserId,
    dbGetCartById,
    dbDeleteCart
} from "../services/cart.service.js";
import { isValidObjectId, isFiniteInteger } from "../helpers/validation.helpers.js";

// FASE 2 / S4: tope de unidades por peticion. `quantity` es un delta con signo
// (el frontend envia -1 para restar, +1 para sumar). Acotamos el rango para
// evitar abuso sin romper el contrato existente del carrito.
const MAX_CART_DELTA = 100;

// Devuelve el carrito del usuario autenticado, creandolo si aun no existe.
const getMyCart = async (req, res) => {
  try {
    const userId = req.payload._id;
    const data = await dbGetOrCreateCartByUserId(userId)

    res.status(200).json({
      msg: "carrito creado correctamnete",
      cart: data
    });
  } catch (error) {
    res.status(500).json({
        msg: "Error al crerar el carrito",
        error: error.message
    });
  }
};

// Suma o resta la cantidad de un producto en tu carrito (delta positivo o negativo).
const updateMyCart = async (req, res) => {
    try {
        const userId = req.payload._id;
        const { productId, quantity } = req.body;

        // FASE 2 / S4: se valida el TIPO real antes de tocar la base de datos.
        // productId debe ser un ObjectId (string) valido; un objeto como
        // { "$ne": null } se rechaza aqui y nunca llega a findById/findOne.
        if (!isValidObjectId(productId)) {
            return res.status(400).json({
                msg: 'El productId no es válido'
            });
        }

        // quantity es un delta ENTERO finito con signo, acotado en rango.
        // No se hace Number(quantity): primero se comprueba el tipo.
        if (!isFiniteInteger(quantity) || quantity === 0 ||
            Math.abs(quantity) > MAX_CART_DELTA) {
            return res.status(400).json({
                msg: 'La cantidad debe ser un número entero distinto de cero'
            });
        }

        const data = await dbUpdateCartByUserId(userId, { productId, quantity });
         res.status(200).json({
            msg: 'Se actualizó tu carrito exitosamente',
            data: data
         })
    } catch (error) {
        console.error(error);

        if(error.message.includes('no existe en el sistema') || error.message.includes('unidades disponobles')) {
            return res.status(400).json({
                msg: error.message
            });
        }

        if (error.name === 'castError') {
            return res.status(400).json({
                msg: 'El formato del ID del producto es inválido para la base de datos'
            });
        }

        if (error.name === 'validationError') {
            const errorDetails = {};

            Object.entries(error.errors).forEach(([field,errObj]) => {
                errorDetails[field] = errObj.message;
            });

            return res.status(400).json({
                msg: 'Error de validación en propiedades del carrito',
                errors: errorDetails
            });
        }

        res.status(500).json({
            msg:'No se pudo actualizar el carrito'
        });
    }
};

// Elimina un producto de tu carrito por completo (sin importar la cantidad que tuviera).
const removeMyCartItem = async (req, res) => {
    try {
        const userId = req.payload._id;
        const { productId } = req.params;

        // FASE 2 / S4 y REGLA 8: ObjectId valido antes de consultar.
        if (!isValidObjectId(productId)) {
            return res.status(400).json({
                msg: 'El productId no es válido'
            });
        }

        const data = await dbRemoveCartItemByUserId(userId, productId);
        
        res.status(200).json({
            msg: 'Se eliminó el producto de tu carrito exitosamente',
            data: data
        });

    } catch (error) {
        console.error(error);

        if (error.name === 'castError') {
            return res.status(400).json({
                msg: 'El formato del ID del producto es inválido para la base de datos'
            });
        }

        res.status(500).json({
            msg: 'No se puede eliminar el carrito'
        })
    }
}

//Elimina tu carrito por completo (ej. tras finalizar una compra).
const deleteMyCart = async (req, res ) => {
    try {
        const userId = req.payload._id;
        const data = await dbDeleteCartByUserId(userId);

        if (!data) {
            throw  new Error('No tienes un carrito registrado en el sistema ');
        }

        res.status(200).json({
            msg: 'Tu carrito se elimino correctamente ',
            data: data
        });
    } catch (error) {
        console.error(error);

        if(error.message.includes('No tienes un carrito registrado ') ) {
            return res.status(400).json({
                msg:error.message
            });
        }
        
        res.status(500).json({
            msg: 'No se pudo eliminar su carrito '
        })
    }
}

//Lista todos los carritos del sistema (solo admin)
const getCart = async (req, res ) => {
    try {
        const data = await dbGetCart();
        if (data.length === 0) {
            throw new Error('No se encontro el carrito registrado en el sistems');
        }

        res.status(200).json({
            msg:'Se han listado los carritos exitosamente',
            data: data
        })
    } catch (error) {
        console.error(error);

        if (error.message.includes('No se encontro carritos registrados en el sistema')) {
            return res.status(404).json({
                msg: error.message
            }); 
        }
         res.status(500).json({
            msg: 'No se pudo obtener el listado de carrito'
         });
    }
}


// Busca un carrito por _id (params); si no existe, error 404 (uso admin)
const getCartById = async (req, res) => {
    try {
        const id = req.params.id;

        // FASE 2 / S4 y REGLA 8: ObjectId valido -> 400 controlado, no 500.
        if (!isValidObjectId(id)) {
            return res.status(400).json({
                msg: 'El ID del carrito no es válido'
            });
        }

        const data = await dbGetCartById(id);

        if (!data) {
            throw new Error('El carrito solicitado no existe en el sistema');
        }

        res.status(200).json({
            msg: 'Se encontró el carrito exitosamente',
            data: data
        });

    } catch (error) {
        console.error(error);

        if (error.message.includes('El carrito solicitado no existe')) {
            return res.status(404).json({
                msg: error.message
            });
        }

        if (error.name === 'CastError') {
            return res.status(400).json({
                msg: 'El formato del ID de carrito provisto es inválido para la base de datos'
            });
        }

        res.status(500).json({
            msg: 'No se pudo obtener el carrito'
        });
    }
};

// Elimina un carrito por _id, validando antes que exista (uso admin)
const deleteCart = async (req, res) => {
    try {
        const id = req.params.id;

        // FASE 2 / S4 y REGLA 8: ObjectId valido -> 400 controlado, no 500.
        if (!isValidObjectId(id)) {
            return res.status(400).json({
                msg: 'El ID del carrito no es válido'
            });
        }

        const existingCart = await dbGetCartById(id);

        if (!existingCart) {
            throw new Error('El carrito que deseas eliminar no existe en el sistema');
        }

        const data = await dbDeleteCart(id);

        res.status(200).json({
            msg: 'El carrito se eliminó exitosamente',
            data: data
        });

    } catch (error) {
        console.error(error);

        if (error.message.includes('El carrito que deseas eliminar no existe')) {
            return res.status(404).json({
                msg: error.message
            });
        }

        if (error.name === 'CastError') {
            return res.status(400).json({
                msg: 'El formato del ID de carrito provisto es inválido para la base de datos'
            });
        }

        res.status(500).json({
            msg: 'No se pudo eliminar el carrito'
        });
    }
};


export {
    getMyCart,
    updateMyCart,
    removeMyCartItem,
    deleteMyCart,
    getCart,
    getCartById,
    deleteCart
}
