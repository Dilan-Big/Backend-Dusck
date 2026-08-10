
import { encryptedPassword } from "../helpers/bycryp.helper.js";
import {
  dbCreateUser,
  dbDeleteUserById,
  dbGetUserById,
  dbGetUsers,
  dbUpdateUserById,
} from "../services/user.service.js";


const createUser = async (req, res) => {
  try {
    const inputData = req.body;
    inputData.password = encryptedPassword(inputData.password)

        const data = await dbCreateUser(inputData)

        res.json({
            msg: "Se registra un usuario",
            data
        });
    } catch (error) {
        res.json({
            msg: "Ocurrio un error al obtener el usuario",
        })

    }
};

const getUser = async (req, res) => {
  try {
    const data = await dbGetUsers();
    res.json({
      msg: "Se obtiene el listado de usuarios",
      data,
    });
  } catch (error) {
    console.error(error);
    res.json({
      msg: "Ocurrio un error a obtener la lista de usuarios",
    });
  }
};

const getUserById = async (req, res) => {
  try {
    const id = req.params.id;
    const data = await dbGetUserById(id);
    res.json({
      msg: "Se obtiene un usuario por id",
      data,
    });
  } catch (error) {
    console.error(error);
    res.json({
      msg: "Ocurrio un error a obtener el usuario por ID",
    });
  }
};

const updateUserById = async (req, res) => {
  try {
    const id = req.params.id;
    const inputData = req.body;
    const data = await dbUpdateUserById(id, inputData);
    res.json({
      msg: "Se actualiza usuario po ID",
      data,
    });
  } catch (error) {
    console.error(error);
    res.json({
      msg: "Ocurio un error al actualizar usuario por ID",
    });
  }
};

const deleteUserById = async (req, res) => {
  try {
    const id = req.params.id;
    const data = await dbDeleteUserById(id);
    res.json({
      msg: "Se elimina usuario por ID",
      data,
    });
  } catch (error) {
    console.error(error);
    res.json({
      msg: "Ocurrio un error al eliminiar usuario",
    });
  }
};

export { createUser, getUser, getUserById, updateUserById, deleteUserById };
