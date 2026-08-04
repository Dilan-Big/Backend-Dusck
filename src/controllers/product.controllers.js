import {
  dbcreateProduct,
  dbDeleteProductById,
  dbGetProduct,
  dbGetProductById,
  dbUpdateProductById,
} from "../services/product.service.js";
import mongoose from "mongoose";

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
      data,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      msg: "Error al obtener los productos",
    });
  }
};

const getProductById = async (req, res) => {
  try {
    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        msg: "El ID del producto no es válido",
      });
    }
    const data = await dbGetProductById(id);
    if (!data) {
      return res.status(404).json({
        msg: "El producto no se encuentra registrado",
      });
    }
    res.json({
      msg: "Producto obtenido exitosamente",
      data,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      msg: "Error al obtener el producto",
    });
  }
};

const updateProductById = async (req, res) => {
  try {
    const id = req.params.id;
    const inputData = req.body;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        msg: "El ID del producto no es válido",
      });
    }
  const data = await dbUpdateProductById(id, inputData);
    if (!data) {
      return res.status(404).json({
        msg: "El producto no se encuentra registrado",
      });
    }
    res.json({
      msg: "Producto actualizado exitosamente",
      data,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      msg: "Error al actualizar el producto",
    });
  }
};

const deleteProductById = async (req, res) => {
try {
    const id = req.params.id;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({
      msg: "El ID del producto no es válido"
    });
  }
  const data = await dbDeleteProductById(id);
  if (!data) {
    return res.status(404).json({
      msg: "El producto no se encuentra registrado"
    })
  }
  res.json({
    msg: "Producto eliminado exitosamente",
    data
  })
} catch (error) {
      console.error(error);
    res.status(500).json({
      msg: "Error al eliminar el producto",
    });
  }
}


export { createProduct, getProduct, getProductById, updateProductById, deleteProductById };
