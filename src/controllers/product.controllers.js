import { dbcreateProduct, dbGetProduct } from "../services/product.service.js";

const createProduct = async (req, res) => {
  try {
    const inputData = req.body;
    const data = await dbcreateProduct(inputData);
    res.json({
      msg: "Producto creado exitosamente",
      data,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      msg: "Error al crear el producto",
    });
  }
};

const getProduct = async (req, res) => {
    try {
        const data = await dbGetProduct();
        res.json({
            msg: "Productos obtenidos exitosamente",
            data
        })
    } catch (error) {
        console.error(error);
        res.status(500).json({
            msg: "Error al obtener los productos"
        });
    }
}

export { createProduct, getProduct };
