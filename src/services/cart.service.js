import CartModel from "../models/cart.model.js";
import ProductModel from "../models/product.model.js";
import { PRODUCT_STATUS } from "../helpers/productWorkflow.helper.js";

// PD-005 / PD-011 — `category` (singular) ya no existe en el modelo.
//
// PD2-003 — Dos proyecciones separadas:
//   CLIENT: lo que el drawer del subscriber necesita para pintar el item. NUNCA
//           incluye `status` (workflow interno) ni ninguna metadata editorial.
//   ADMIN : añade `status` para las vistas administrativas del carrito
//           (`GET /api/cart/admin`, `GET /api/cart/admin/:id`), que solo alcanza
//           un `administrador`.
const CART_POPULATE_CLIENT = { path: 'items.productId', select: 'name price images stock isActive' };
const CART_POPULATE_ADMIN = { path: 'items.productId', select: 'name price images stock isActive status' };

// PD-005 — Un producto solo es "comprable" (se puede AGREGAR o INCREMENTAR en
// el carrito) si está realmente publicado y activo. DRAFT / PENDING_REVIEW /
// APPROVED / REJECTED nunca; PUBLISHED+inactivo tampoco.
const isPurchasable = (product) =>
  !!product && product.status === PRODUCT_STATUS.PUBLISHED && product.isActive === true;

//Solo admin	Todos los carritos de todos los usuarios
const dbGetCart = async () => {
    return await CartModel.find().populate(CART_POPULATE_ADMIN);
}
// Busca el carrito del usuario por userId; si no existe, lo crea automáticamente
const dbGetOrCreateCartByUserId = async (userId) => {
   return await CartModel.findOneAndUpdate(
    { userId },                                 // Objeto de consulta
    { $setOnInsert: { userId, items: [] } },    // Datos a actualizar
    { returnDocument: 'after', upsert: true, runValidators: true }
   ).populate(CART_POPULATE_CLIENT);

}

// Actualiza un producto (suma/resta cantidad) dentro de un carrito específico por su _id
const dbUpdateCart = async (id, inputData) => {
    const { productId, quantity } = inputData;

     // 0. Validamos existencia y stock disponible del producto ANTES de tocar el carrito.
     const product = await ProductModel.findById(productId);

     if (!product) {
        throw new Error('El producto que intentaste agregar no existe en el sistema ')
     }

     // PD-005 — Solo se puede AGREGAR / INCREMENTAR (`quantity > 0`) un producto
     // publicado y activo. `quantity < 0` (disminuir) y la eliminación de items
     // NO se tocan: `quantity` sigue siendo un delta con signo, y un producto
     // que dejó de estar publicado debe poder quitarse del carrito igualmente.
     if (quantity > 0 && !isPurchasable(product)) {
        const err = new Error('El producto no está disponible');
        err.code = 'PRODUCT_NOT_PURCHASABLE';
        throw err;
     }

     if (quantity > 0) {
        const existingCart = await CartModel.findOne({_id: id, 'items.productId': productId });
        const currentItem = existingCart?.items.find(i => i.productId.toString() === productId.toString());
        const currentQuantity = currentItem ? currentItem.quantity : 0;

        if (currentQuantity + quantity > product.stock) {
            throw new Error(`solo hay ${product.stock} unidades disponibles de "${product.name}"`);
        }
     }
     
     // 1. Intentamos SUMAR la cantidad si el producto YA existe en el carrito
     let updateCart = await CartModel.findOneAndUpdate(
        { _id: id, 'items.productId': productId},
        { $inc: {'items.$.quantity': quantity}},
        { returnDocument: 'after', runValidators: true }
     );

     if (updateCart) {
         // 2. El producto existía: revisamos la cantidad resultante
         const item = updateCart.items.find(i => i.productId.toString() === productId.toString());

         if (item && item.quantity <= 0) {
            // Si quedó en 0 o menos, lo eliminamos del carrito
            updateCart = await CartModel.findOneAndUpdate(
                { _id: id},
                { $pull: { items: {productId } } },
                { returnDocument: 'after' }
            )
         } 
     } else {
        // 3. El producto NO existía en el carrito: lo agregamos como nuevo (solo si quantity > 0)
        if(quantity > 0) {
            updateCart = await CartModel.findOneAndUpdate(
                { _id: id},
                { $push: {items: { productId, quantity } } },
                {returnDocument: 'after', runValidators: true }
            );
        } else {
             // Si mandan cantidad <= 0 para un producto que no existe, no hay nada que hacer
             updateCart = await CartModel.findById(id);
        }
     }

     // 4. Repoblamos antes de devolver: el front siempre necesita nombre/precio/imagen,
    // no solo el ObjectId crudo.
    return await updateCart.populate(CART_POPULATE_CLIENT);
}
// Resuelve el _id del carrito del usuario y delega la actualización a dbUpdateCart
const dbUpdateCartByUserId = async (userId, inputData) => {
    const cart = await dbGetOrCreateCartByUserId(userId);
    return await dbUpdateCart(cart._id, inputData);
}


// Elimina un producto del carrito por completo, sin importar la cantidad que tuviera.
const dbRemoveCartItem = async (id, productId) => {
    const updateCart = await CartModel.findOneAndUpdate(
        { _id: id},
        { $pull: {items: {productId } } },
        { returnDocument: 'after' }
    );
    
    if( !updateCart ) return null;

    return await updateCart.populate(CART_POPULATE_CLIENT);
}
//Eliminar un prodcuto por ID
const dbRemoveCartItemByUserId = async (userId, productId ) => {
    const cart = await dbGetOrCreateCartByUserId(userId);
    return await dbRemoveCartItem(cart._id, productId);
}

//Elimina un carrito por su _id
const dbDeleteCart = async (id) => {
    return await CartModel.findOneAndDelete({_id: id });
}
//Elimina el carrito propio del usuario logueado
const dbDeleteCartByUserId = async (userId) => {
    return await CartModel.findOneAndDelete({userId})
}


// Busca un carrito por su _id de Mongo (uso admin)
const dbGetCartById = async (id) => {
    return await CartModel.findOne({ _id: id }).populate(CART_POPULATE_ADMIN);
}

export {
    dbGetCart,
    dbGetOrCreateCartByUserId,
    dbUpdateCart,
    dbUpdateCartByUserId,
    dbRemoveCartItem,
    dbRemoveCartItemByUserId,
    dbDeleteCart,
    dbDeleteCartByUserId,
    dbGetCartById
}