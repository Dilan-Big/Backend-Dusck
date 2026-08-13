import { 
    dbGetOrCreateCartByUserId,
    dbUpdateCartByUserId
} from "../services/cart.service.js";

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
        
        if (!productId || quantity === undefined ) {
            return res.status(400).json({
                msg: 'Se necesita el productId y la cantidad para actualizar el carrito'
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


export {
    getMyCart,
    updateMyCart
}
