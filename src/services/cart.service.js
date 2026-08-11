import CartModel from "../models/cart.model.js";

const dbGetCart = async (userId) => {
   return CartModel.findOneAndUpdate(
    { userId },                                 // Objeto de consulta
    { $setOnInsert: { userId, items: [] } },    // Datos a actualizar
    { returnDocument: 'after', upsert: true, runValidators: true }
   );
    
}

export {
    dbGetCart
}