import UserModel from "../models/user.model.js";

const dbCreateUser = async (user) => {
    return await UserModel.create(user);
};

const dbGetUsers = async () => {
    return await UserModel.find();
}

export {dbCreateUser, dbGetUsers};