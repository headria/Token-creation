import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import helmet from "helmet";
import pumpfunRoutes from "./pumpfun/pumpfun.handler";
import { Router } from "express";
import launchlabRouter from "./raydium/router/launchlab.router";
import { NextFunction, Request, Response } from "express";
import { testConnection } from "./db/database";

dotenv.config();

const app = express();

app.use(helmet());

// Configure CORS with specific origins
const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(",") || [
  "http://localhost:3000",
];
app.use(
  cors({
    origin: allowedOrigins,
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// Parse JSON bodies
app.use(express.json());
// Parse URL-encoded bodies (for form data)
app.use(express.urlencoded({ extended: true }));

// --- Router Setup ---
const router = Router();
router.use("/api", launchlabRouter);
router.use("/api", pumpfunRoutes);
app.use(router);

app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error(err.stack);
  res.status(500).send("Something broke!");
});

// --- Server Startup Logic ---
const PORT = process.env.PORT || 3000;

const startServer = async () => {
  try {
    const isConnected = await testConnection();

    if (!isConnected) {
      console.error("Database connection failed. Server will not start.");
      process.exit(1); 
    }

    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
};

// Call the async function to start the server
startServer();
