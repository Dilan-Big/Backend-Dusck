import UserModel from "../models/user.model.js";

// Elimina el hash de password antes de devolver un usuario en una respuesta HTTP.
const sanitizeUser = (userDoc) => {
    if (! userDoc) return userDoc;
    const user = typeof userDoc.toObject === "function" ? userDoc.toObject() : { ...userDoc };
    delete user.password;
    return user;
}

const dbCreateUser = async (user) => {
    return sanitizeUser(await UserModel.create(user));
}

const dbGetUsers = async () => {
    return await UserModel.find().select("-password");
}

const dbGetUserById = async (id) => {
    return await UserModel.findOne({
        _id: id
    }).select("-password")
}

const dbGetUserByIdEmail = async (email) => {
    return await UserModel.findOne({
        email
    })
}

const dbUpdateUserById = async (id, userUpdate) => {
    return sanitizeUser(await UserModel.findOneAndUpdate(
        { _id: id }, // objeto de consulta
        userUpdate, // datos para actualizar
        { new: true, runValidators: true } // devuelve datos actualizados y valida el schema (enum de role, etc.)
    ));
}

const dbDeleteUserById = async (id) => {
    return sanitizeUser(await UserModel.findOneAndDelete(
        {_id: id}
    ))
}


export {
    dbCreateUser,
    dbGetUsers,
    dbGetUserById,
    dbUpdateUserById,
    dbDeleteUserById,
    dbGetUserByIdEmail
};
