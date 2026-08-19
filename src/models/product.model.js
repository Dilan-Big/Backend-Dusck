import { Schema, model } from "mongoose";

const ProductSchema = new Schema({
    name: {
        type: String,
        required: [true, 'El nombre del producto es obligatorio'],
        trim: true,
        minlength: [2, 'El nombre debe tener al menos 2 caracteres'],
        maxlength: [100, 'El nombre no puede exceder los 100 caracteres']
    },
    slug: {
        type: String,
        required: [true, 'El slug es obligatorio'],
        unique: true,
        lowercase: true,
        trim: true,
        match: [/^[a-z0-9-]+$/, 'El slug solo puede contener letras minúsculas, números y guiones medios']
    },
    description: {
        type: String,
        trim: true,
        maxlength: [500, 'La descripción no puede exceder los 500 caracteres']
    },
    price: {
        type: Number,
        required: [true, 'El precio es obligatorio'],
        min: [0, 'El precio no puede ser negativo']
    },
    stock: {
        type: Number,
        required: [true, 'El stock es obligatorio'],
        min: [0, 'El stock no puede ser negativo']
    },
    // Estructura para el arreglo de imágenes con validadores y mensajes de error personalizados
    images: {
        type: [{
            url: {
                type: String,
                required: [true, 'La URL de la imagen es obligatoria']
            },
            isMain: {
                type: Boolean,
                default: false
            }
        }],
    },
    category: {
        type: Schema.Types.ObjectId,
        ref: 'category',  // Referencia a tu modelo de categoría
        required: [true, 'La categoría es obligatoria']
    },
    createdBy: {
        type: Schema.Types.ObjectId,
        ref: 'user',  // Referencia a tu modelo de usuario
        //required: [true, 'El creador del producto es obligatorio']
    },
    isActive: {
        type: Boolean,
        default: true
    }
}, {
    versionKey: false,
    timestamps: true
});

const ProductModel = model(
    'product_b',
    ProductSchema
);

export default ProductModel;