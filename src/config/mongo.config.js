import mongoose from 'mongoose';

const LOCAL_STRING_CONNECTION = 'mongodb://localhost:27017/db-dusck';
const REMOTE_STRING_CONNECTION = 'mongodb+srv://DilanBigData:Dilan123**@cluster0.12fpeva.mongodb.net/db-dusck'

async function dbConection() {
  try {
    await mongoose.connect(REMOTE_STRING_CONNECTION);
    console.log('Connected to MongoDB Atlas');
  } catch (error) {
    console.error(error);
    console.error(`Connect Failed! :'(`);
  }

}

export default dbConection;