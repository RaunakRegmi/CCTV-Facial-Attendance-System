// src/firebase.js
import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyAw7L7AnY2QmJFbfjPYRE-TrtbIrTO0p6g",
  authDomain: "classroom-analytics-3d7b0.firebaseapp.com",
  projectId: "classroom-analytics-3d7b0",
  storageBucket: "classroom-analytics-3d7b0.firebasestorage.app",
  messagingSenderId: "349232554396",
  appId: "1:349232554396:web:0f8159e9046e135c32e859",
};

// Initialize Firebase and Firestore (no Cloud Storage: photos live in Firestore as Base64)
const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
