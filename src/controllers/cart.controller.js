import { 
    dbGetCart
} from "../services/cart.service.js";

const getCart = async (req, res) => {
  try {
    const userId = req.payload._id;
    const cart = await dbGetCart(userId);

    res.status(201).json({
      msg: "carrito creado correctamnete",
      cart,
    });
  } catch (error) {
    res.status(500).json({
        msg: "Error al crerar el carrito",
        error: error.msg
    });
  }
};

export {
    getCart
}
