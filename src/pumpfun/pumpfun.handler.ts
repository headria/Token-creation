import express, { Request, Response, Router } from "express";
import multer from "multer";
import { TokenService } from "../pumpfun/tokenService";
import { TokenCreationRequest } from "../pumpfun/types/types";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });
const tokenService = new TokenService();

interface TokenRequest extends Request {
  body: TokenCreationRequest;
  file?: Express.Multer.File;
}

router.post(
  "/pumpfun/create-token",
  upload.single("image"),
  async (req: TokenRequest, res: Response) => {
    try {
      console.log('Create token request:', {
        ...req.body,
        mayhemMode: req.body.mayhemMode
      });

      const tokenData = {
        ...req.body,
        // Convert mayhemMode from string to boolean if it exists
        mayhemMode: true
      };

      if (req.file) {
        tokenData.imageBuffer = req.file.buffer;
        tokenData.imageFileName = req.file.originalname;
      }

      // Validate required fields
      if (
        !tokenData.name ||
        !tokenData.symbol ||
        !tokenData.creatorKeypair ||
        (!tokenData.uri && !tokenData.imageBuffer)
      ) {
        return res.status(400).json({
          error:
            "Missing required fields: name, symbol, creatorKeypair, and either uri or image file",
        });
      }

      // Validate string lengths
      if (tokenData.name.length > 32) {
        return res
          .status(400)
          .json({ error: "Name must be 32 characters or less" });
      }

      if (tokenData.symbol.length > 8) {
        return res
          .status(400)
          .json({ error: "Symbol must be 8 characters or less" });
      }

      if (tokenData.uri && tokenData.uri.length > 200) {
        return res
          .status(400)
          .json({ error: "URI must be 200 characters or less" });
      }

      // Validate and convert buyAmount if provided
      if (tokenData.buyAmount) {
        const buyAmountNum = Number(tokenData.buyAmount);
        if (isNaN(buyAmountNum) || buyAmountNum <= 0) {
          return res
            .status(400)
            .json({ error: "buyAmount must be a positive number" });
        }
        // Convert SOL to lamports
        if (tokenData.buyAmount > Number.MAX_SAFE_INTEGER) {
          return res.status(400).json({ error: "buyAmount is too large" });
        }
      }

      const result = await tokenService.createPumpFunToken(tokenData);

      if (result.success) {
        return res.json({ success: true, signature: result });
      } else {
        return res
          .status(500)
          .json({ error: result.error || "Token creation failed" });
      }
    } catch (error) {
      console.error("Error creating token:", error);
      return res.status(500).json({
        error: error instanceof Error ? error.message : "Server error",
      });
    }
  }
);

export default router;
