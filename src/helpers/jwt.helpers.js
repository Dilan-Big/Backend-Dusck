import jwt from "jsonwebtoken";

const generarToken = (payload) => {
  return jwt.sign(payload, "jhvyt76", { expiresIn: "7d" });
};

const validateToken = (token) => {
  try {
    return jwt.verify(token, "jhvyt76");
  } catch (error) {
    console.error(error);
    return null;
  }
};

export { generarToken, validateToken };
