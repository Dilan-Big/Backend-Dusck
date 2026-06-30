import UserModel from "../models/user.model.js";

const dbCreateUser = async (user) => {
    return await UserModel.create(user);
};

const dbGetUsers = async () => {
    return await UserModel.find();
}

const dbGetUserById = async (id) => {
    return await UserModel.findOne({
        _id: id
    })
}

const dbGetUserByEmail = async (email) => {
    return await UserModel.findOne(
        {
            email
        }
    )
}

const dbUpdateUserById = async (id, userUpdate) => {
    return await UserModel.findOneAndUpdate(
        { _id: id }, // objeto de consulta
        userUpdate, // datos para actualizar
        { new: true} // devolvera datos actualizados
    );
}

const dbDeleteUserById = async (id) => {
    return await UserModel.findOneAndDelete(
        {_id: id}
    )
}

export { dbCreateUser, dbGetUsers, dbGetUserById, dbUpdateUserById, dbDeleteUserById, dbGetUserByEmail };