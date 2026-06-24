import UserModel from "../models/user.model.js";

const dbCreateUser = async (user) => {
    return await UserModel.create(user);
};

export {dbCreateUser};