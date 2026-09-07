import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore"; // 1. Importar getFirestore

const firebaseConfig = {
  apiKey: "AIzaSyD3tRcWScSHTJs6NPMszI9L1wPEne0QTZw",
  authDomain: "north-services-ai.firebaseapp.com",
  projectId: "north-services-ai",
  storageBucket: "north-services-ai.firebasestorage.app",
  messagingSenderId: "668485822272",
  appId: "1:668485822272:web:4270954e8fb7f66ff63ca5",
  measurementId: "G-8H18LZZJJ0"
};

// Inicializar Firebase
const app = initializeApp(firebaseConfig);

// Exportar instancias de autenticación y base de datos
export const auth = getAuth(app);
export const db = getFirestore(app); // 2. Exportar la instancia de Firestore