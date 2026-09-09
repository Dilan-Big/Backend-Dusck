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

// TALLAS — ¿el producto maneja tallas? (tiene al menos una variante embebida).
const hasVariants = (product) =>
  !!product && Array.isArray(product.variants) && product.variants.length > 0;

// TALLAS — Resuelve la talla pedida contra las variantes REALES del producto
// (nunca contra un enum: coincidencia exacta con `variants[].size` tras trim).
// Devuelve:
//   { ok:true, size, availableStock }   talla válida -> `size` canónico (el del
//                                       producto) y el stock de ESA variante.
//   { ok:false, code }                  SIZE_REQUIRED | SIZE_INVALID | SIZE_AMBIGUOUS
//                                       | SIZE_NOT_APPLICABLE
//
// SIZE_AMBIGUOUS: la talla coincide con MÁS de una variante (matriz color×talla).
// Esos productos requieren además elegir color y quedan fuera de la compra en
// línea por ahora — igual que TODOS los productos con variantes antes de esta
// funcionalidad. NO es una regresión: es un límite de alcance documentado.
const resolveSizeSelection = (product, rawSize) => {
  const trimmed = typeof rawSize === "string" ? rawSize.trim() : "";

  if (!hasVariants(product)) {
    // Producto simple: NO acepta talla (defensa; el storefront no la envía).
    if (trimmed) return { ok: false, code: "SIZE_NOT_APPLICABLE" };
    return { ok: true, size: undefined, availableStock: product.stock };
  }

  if (!trimmed) return { ok: false, code: "SIZE_REQUIRED" };

  const matches = product.variants.filter(
    (v) => typeof v.size === "string" && v.size.trim() === trimmed,
  );
  if (matches.length === 0) return { ok: false, code: "SIZE_INVALID" };
  if (matches.length > 1) return { ok: false, code: "SIZE_AMBIGUOUS" };

  return { ok: true, size: matches[0].size.trim(), availableStock: matches[0].stock };
};

// TALLAS — mensaje + code de dominio para un fallo de `resolveSizeSelection`.
// `.code` lo mapea el controller a un status HTTP (400 datos / 404 no disponible).
const sizeError = (code, productName) => {
  const name = productName ? ` "${productName}"` : "";
  const map = {
    SIZE_REQUIRED: `Debes elegir una talla para${name || " el producto"}`,
    SIZE_INVALID: `La talla seleccionada no existe para${name || " el producto"}`,
    SIZE_AMBIGUOUS: `El producto${name} requiere además elegir color y no está disponible para compra en línea`,
    SIZE_NOT_APPLICABLE: `El producto${name} no maneja tallas`,
  };
  const err = new Error(map[code] || "La talla seleccionada no es válida");
  err.code = code;
  return err;
};

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

// TALLAS — Sub-filtro Mongo para localizar el item de una línea (productId + size).
//   producto simple  -> `{ productId, size: null }`  (matchea talla ausente o null)
//   producto c/talla -> `{ productId, size: <talla canónica> }`
// Así dos tallas del mismo producto son elementos DISTINTOS del array `items`.
const itemMatch = (productId, size) => (size ? { productId, size } : { productId, size: null });

// TALLAS — misma discriminación pero en memoria (sobre un item ya cargado).
const sameLine = (item, productId, size) =>
    item.productId.toString() === productId.toString() &&
    (size ? item.size === size : !item.size);

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

     // TALLAS — Resuelve la talla contra las variantes REALES del producto.
     //   · Al AGREGAR/INCREMENTAR (quantity > 0): un producto con variantes EXIGE
     //     una talla válida; el stock que se valida es el de ESA variante.
     //   · Al DISMINUIR/quitar (quantity <= 0): si se envía talla, se respeta
     //     para no tocar otra línea; si no, se cae al camino simple (compat con
     //     el borrado de un producto que dejó de estar publicado).
     let size;
     let availableStock = product.stock;
     if (quantity > 0) {
        const sel = resolveSizeSelection(product, inputData.size);
        if (!sel.ok) throw sizeError(sel.code, product.name);
        size = sel.size;
        availableStock = sel.availableStock;
     } else if (typeof inputData.size === 'string' && inputData.size.trim()) {
        size = inputData.size.trim();
     }

     if (quantity > 0) {
        const existingCart = await CartModel.findOne({ _id: id, items: { $elemMatch: itemMatch(productId, size) } });
        const currentItem = existingCart?.items.find((i) => sameLine(i, productId, size));
        const currentQuantity = currentItem ? currentItem.quantity : 0;

        if (currentQuantity + quantity > availableStock) {
            const label = size ? `"${product.name}" (talla ${size})` : `"${product.name}"`;
            throw new Error(`solo hay ${availableStock} unidades disponibles de ${label}`);
        }
     }

     // 1. Intentamos SUMAR la cantidad si esa línea (productId + size) YA existe
     let updateCart = await CartModel.findOneAndUpdate(
        { _id: id, items: { $elemMatch: itemMatch(productId, size) } },
        { $inc: {'items.$.quantity': quantity}},
        { returnDocument: 'after', runValidators: true }
     );

     if (updateCart) {
         // 2. La línea existía: revisamos la cantidad resultante
         const item = updateCart.items.find((i) => sameLine(i, productId, size));

         if (item && item.quantity <= 0) {
            // Si quedó en 0 o menos, eliminamos ESA línea (nunca las otras tallas)
            updateCart = await CartModel.findOneAndUpdate(
                { _id: id},
                { $pull: { items: itemMatch(productId, size) } },
                { returnDocument: 'after' }
            )
         }
     } else {
        // 3. La línea NO existía en el carrito: la agregamos como nueva (solo si quantity > 0)
        if(quantity > 0) {
            updateCart = await CartModel.findOneAndUpdate(
                { _id: id},
                { $push: {items: { productId, quantity, ...(size ? { size } : {}) } } },
                {returnDocument: 'after', runValidators: true }
            );
        } else {
             // Si mandan cantidad <= 0 para una línea que no existe, no hay nada que hacer
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
// TALLAS — `size` OPCIONAL: con talla se quita solo ESA línea (productId + size);
// sin talla se conserva el comportamiento previo (quita todas las líneas de ese
// producto — útil para un producto que dejó de estar publicado o para un
// producto simple).
const dbRemoveCartItem = async (id, productId, size) => {
    const trimmedSize = typeof size === 'string' && size.trim() ? size.trim() : undefined;
    const pull = trimmedSize ? { productId, size: trimmedSize } : { productId };
    const updateCart = await CartModel.findOneAndUpdate(
        { _id: id},
        { $pull: {items: pull } },
        { returnDocument: 'after' }
    );

    if( !updateCart ) return null;

    return await updateCart.populate(CART_POPULATE_CLIENT);
}
//Eliminar un prodcuto por ID
const dbRemoveCartItemByUserId = async (userId, productId, size ) => {
    const cart = await dbGetOrCreateCartByUserId(userId);
    return await dbRemoveCartItem(cart._id, productId, size);
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