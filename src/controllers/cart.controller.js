import { 
    dbGetOrCreateCartByUserId
} from "../services/cart.service.js";

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

// const updateCart = async (req, res) =>{
//     const { productId, quantity } = req.body;

//     try {

//         if( !productId || quantity === undefined ) {
//             return res.status(400).json({
//                 msg: 'Se necesita el productId y la cantidad para actualizar el carrito'
//             });
//         }

//         const data = await dbupdate
        
//     } catch (error) {
        
//     }
// }

export {
    getMyCart,
    // updateCart
}
